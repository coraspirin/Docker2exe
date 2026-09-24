const fs = require('fs');
const path = require('path');
const { runNpm, installArgs } = require('./npm');

/**
 * Frontend tespiti ve derlemesi.
 *
 * Dockerfile'daki Linux'a özgü adımlar (multi-stage, apk add, sh script) taklit edilmez. Bunun yerine
 * alt klasörlerdeki (client/, frontend/, ui/, web/) ayrı package.json + scripts.build aranır ve
 * `npm --prefix <dizin> run build` ile derlenir.
 */

const FRONTEND_DIRS = ['client', 'frontend', 'ui', 'web'];
const SPA_OUTPUT_DIRS = ['dist', 'build', 'out'];
const SSR_DEPS = { next: 'next', nuxt: 'nuxt', '@sveltejs/kit': 'sveltekit' };

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function ssrFrameworkOf(pkg) {
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const key = Object.keys(SSR_DEPS).find(d => deps[d]);
  if (key) return SSR_DEPS[key];
  const start = (pkg.scripts && pkg.scripts.start) || '';
  if (/\bnext start\b/.test(start)) return 'next';
  if (/\bnuxt start\b|\.output\/server\/index\.mjs/.test(start)) return 'nuxt';
  return null;
}

/**
 * Backend klasöründe (ve proje kökünde) derlenmesi gereken frontend alt klasörünü bulur.
 * @returns {{ dir: string, kind: 'spa'|'ssr', framework: string|null, candidates: string[] } | null}
 */
function detectFrontendDir(appDir, projectDir) {
  const roots = [...new Set([appDir, projectDir])];
  const found = [];
  for (const root of roots) {
    for (const name of FRONTEND_DIRS) {
      const dir = path.join(root, name);
      if (dir === appDir) continue;
      const pkg = readPkg(dir);
      if (pkg && pkg.scripts && pkg.scripts.build) found.push({ dir, pkg });
    }
  }
  if (!found.length) return null;
  const first = found[0];
  const framework = ssrFrameworkOf(first.pkg);
  return { dir: first.dir, kind: framework ? 'ssr' : 'spa', framework, candidates: found.map(f => f.dir) };
}

/** Frontend bağımlılıklarını (dev dahil — derleme araçları devDependencies'te) kurar ve build eder. */
async function installAndBuild(dir, logFile) {
  await runNpm(installArgs(dir, { production: false }), { cwd: dir, logFile });
  await runNpm(['--prefix', dir, 'run', 'build'], { cwd: dir, logFile });
}

/** SPA build çıktı klasörünü bulur (index.html içeren dist/build/out). */
function findSpaOutput(dir) {
  for (const name of SPA_OUTPUT_DIRS) {
    const out = path.join(dir, name);
    if (fs.existsSync(path.join(out, 'index.html'))) return out;
  }
  for (const name of SPA_OUTPUT_DIRS) {
    const out = path.join(dir, name);
    if (fs.existsSync(out) && fs.statSync(out).isDirectory()) return out;
  }
  return null;
}

/**
 * Backend kodunda express.static(...) hedeflerini bulur.
 * Döner: [{ dir: <mutlak yol>, file: <kaynak dosya> }]
 *   express.static('public')                          → cwd'ye (appDir) göre
 *   express.static(path.join(__dirname, '../client/dist')) → dosyanın klasörüne göre
 */
function findStaticTargets(appDir, files) {
  const targets = [];
  const literal = /express\.static\(\s*(['"`])([^'"`$]+)\1/g;
  const joined = /express\.static\(\s*path\.(?:join|resolve)\(\s*__dirname\s*,([^)]*)\)/g;
  for (const file of files) {
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let m;
    literal.lastIndex = 0;
    while ((m = literal.exec(src))) targets.push({ dir: path.resolve(appDir, m[2]), file });
    joined.lastIndex = 0;
    while ((m = joined.exec(src))) {
      const parts = [...m[1].matchAll(/(['"`])([^'"`$]*)\1/g)].map(x => x[2]);
      if (parts.length) targets.push({ dir: path.resolve(path.dirname(file), ...parts), file });
    }
  }
  return targets;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * SPA'yı derler ve çıktıyı Express'in static klasörüne yerleştirir.
 *
 * Monorepo (server/ + client/ kardeş klasörler): express.static(path.join(__dirname, '../client/dist'))
 * gibi backend klasörü dışını gösteren hedefler desteklenir; çıktı proje kökü içinde kaldığı sürece
 * pakete aynı göreli konumda eklenir (`external: true`).
 *
 * @returns {{ output: string, placedAt: string|null, external: boolean, warnings: string[] }}
 */
async function buildSpa(frontend, appDir, sourceFiles, logFile, projectDir = appDir) {
  const warnings = [];
  await installAndBuild(frontend.dir, logFile);
  const output = findSpaOutput(frontend.dir);
  if (!output) {
    throw new Error(`Frontend build'i (${path.relative(projectDir, frontend.dir) || frontend.dir}) çıktı klasörü üretmedi (${SPA_OUTPUT_DIRS.join('/')} bulunamadı)`);
  }
  const external = !isInside(appDir, output);
  if (external && !isInside(projectDir, output)) {
    throw new Error(`Frontend çıktısı (${output}) proje klasörünün dışında; paketlenemez`);
  }

  const targets = findStaticTargets(appDir, sourceFiles);
  const serving = targets.find(t => isInside(t.dir, output) || isInside(output, t.dir));
  if (serving) return { output, placedAt: output, external, warnings };

  const candidates = targets.filter(t => isInside(projectDir, t.dir));
  if (candidates.length === 1) {
    fs.mkdirSync(candidates[0].dir, { recursive: true });
    fs.cpSync(output, candidates[0].dir, { recursive: true });
    return { output, placedAt: candidates[0].dir, external: !isInside(appDir, candidates[0].dir), warnings };
  }
  if (candidates.length > 1) {
    warnings.push(`Birden fazla express.static hedefi var (${candidates.map(t => path.relative(projectDir, t.dir)).join(', ')}); frontend çıktısı olduğu yerde bırakıldı`);
  } else {
    warnings.push(`Frontend derlendi (${path.relative(projectDir, output)}) ama backend kodunda express.static bulunamadı; çıktı olduğu yerde bırakıldı`);
  }
  return { output, placedAt: null, external, warnings };
}

/**
 * SSR uygulamasını derler ve standalone sunucu çıktısını doğrular.
 * Standalone mod açık değilse config dosyasına dokunulmaz, build durur.
 *
 * @returns {{ root: string, entry: string, esm: boolean }} root: pakete kopyalanacak klasör, entry: root'a göre giriş
 */
async function buildSsr(dir, framework, logFile) {
  if (framework === 'next') {
    const configFile = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']
      .map(f => path.join(dir, f))
      .find(f => fs.existsSync(f));
    const content = configFile ? fs.readFileSync(configFile, 'utf8') : '';
    if (!/output\s*:\s*['"`]standalone['"`]/.test(content)) {
      throw new Error(
        `SSR framework (Next.js) tespit edildi ama standalone çıktı modu aktif değil. ` +
          `Lütfen ${configFile ? path.basename(configFile) : 'next.config.js'} dosyasına output: 'standalone' ekleyin ve tekrar deneyin (${dir})`
      );
    }
    await installAndBuild(dir, logFile);
    const root = path.join(dir, '.next', 'standalone');
    const server = findFile(root, 'server.js');
    if (!server) throw new Error(`Next.js build'i .next/standalone/server.js üretmedi (${dir})`);
    // Next dokümantasyonu: static ve public klasörleri standalone'a elle kopyalanmalı.
    const serverDir = path.dirname(server);
    if (fs.existsSync(path.join(dir, '.next', 'static'))) fs.cpSync(path.join(dir, '.next', 'static'), path.join(serverDir, '.next', 'static'), { recursive: true });
    if (fs.existsSync(path.join(dir, 'public'))) fs.cpSync(path.join(dir, 'public'), path.join(serverDir, 'public'), { recursive: true });
    return { root, entry: path.relative(root, server), esm: false };
  }

  if (framework === 'nuxt') {
    await installAndBuild(dir, logFile);
    const root = path.join(dir, '.output');
    const entry = path.join(root, 'server', 'index.mjs');
    if (!fs.existsSync(entry)) {
      throw new Error(`Nuxt build'i .output/server/index.mjs üretmedi; Nitro preset'inin "node-server" olduğundan emin olun (${dir})`);
    }
    return { root, entry: path.relative(root, entry), esm: true };
  }

  if (framework === 'sveltekit') {
    const pkg = readPkg(dir) || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (!deps['@sveltejs/adapter-node']) {
      throw new Error(`SvelteKit tespit edildi ama @sveltejs/adapter-node kullanılmıyor; standalone Node sunucusu için adapter-node gerekli (${dir})`);
    }
    await installAndBuild(dir, logFile);
    const entry = path.join(dir, 'build', 'index.js');
    if (!fs.existsSync(entry)) throw new Error(`SvelteKit build'i build/index.js üretmedi (${dir})`);
    // adapter-node çıktısı çalışmak için production node_modules ister
    await runNpm(['prune', '--omit=dev'], { cwd: dir, logFile });
    return { root: dir, entry: path.relative(dir, entry), esm: (pkg.type === 'module') };
  }

  throw new Error(`Desteklenmeyen SSR framework: ${framework}`);
}

function findFile(root, name) {
  if (!fs.existsSync(root)) return null;
  const direct = path.join(root, name);
  if (fs.existsSync(direct)) return direct;
  // monorepo'da standalone çıktısı alt klasörde olabilir (örn. standalone/apps/web/server.js)
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === name) return full;
    }
  }
  return null;
}

module.exports = { detectFrontendDir, buildSpa, buildSsr, findStaticTargets, findSpaOutput, ssrFrameworkOf };
