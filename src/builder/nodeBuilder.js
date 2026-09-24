const fs = require('fs');
const path = require('path');
const { runNpm, installArgs } = require('./npm');
const { compileWithPkg } = require('./pkgCompiler');
const { compileRuntimeExe } = require('./runtimeExe');
const { analyzeNativeModules } = require('./nativeModules');
const { detectFrontendDir, buildSpa, buildSsr, ssrFrameworkOf } = require('./frontendBuilder');

const SQLITE_PACKAGES = ['sqlite3', 'better-sqlite3', 'sqlite', '@libsql/client', 'libsql', 'sql.js'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', '.vscode', '.idea', 'coverage', '.nyc_output']);
// Uygulamanın kendi JS dosyaları `scripts` olarak derlenir. node_modules'taki JS dosyaları ise asset olarak da
// eklenir: bazı paketler (örn. socket.io istemci bundle'ı) .js dosyalarını require değil fs ile okuyup sunar.
const ASSET_EXCLUDE_EXT = new Set(['.ts', '.mts', '.cts', '.tsx', '.jsx', '.map', '.md', '.markdown', '.node']);
const OWN_SCRIPT_EXT = new Set(['.js', '.cjs', '.mjs']);
const SCRIPT_EXT = new Set(['.js', '.cjs', '.mjs']);

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Klasördeki dosyaları (göreli, posix) listeler. skip(relDir) true ise alt klasöre girilmez. */
function listFiles(root, { skipDir = () => false, keep = () => true } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skipDir(childRel, e.name)) stack.push(childRel);
      } else if (keep(childRel, e.name)) {
        out.push(childRel);
      }
    }
  }
  return out.sort();
}

/**
 * Web servisini derler: frontend (varsa) → npm install → (gerekirse) npm run build → native modül analizi
 * → pkg ile app.exe. SSR uygulamaları için frontend.exe/app.exe bir yükleyicidir (bkz. runtime/ssr-loader.js).
 *
 * @returns {Promise<{ app: object, frontend: object|null, warnings: string[], infos: string[], native: object[] }>}
 */
async function buildNodeApp({ compose, webService, stack, outDir, nodeMajor, logFile, step = () => {} }) {
  const appDir = webService.build.context;
  const warnings = [];
  const infos = [];

  // Web servisinin kendisi SSR ise (örn. sadece Next.js) backend yoktur.
  if (stack.entry.kind === 'ssr') {
    step(`SSR uygulaması derleniyor (${stack.entry.framework})`);
    const ssr = await buildSsr(appDir, stack.entry.framework, logFile);
    const app = await packageSsr(ssr, 'app', outDir, nodeMajor, logFile, {
      port: stack.port.value,
      env: webService.resolvedEnvironment
    });
    return { app, frontend: null, frontendService: null, warnings, infos, native: [] };
  }

  // Compose'da ayrı bir SSR frontend servisi (build'li, Next/Nuxt bağımlılıklı) varsa, o klasör alt klasör
  // taramasında tekrar ele alınmaz: port ve ortam değişkenleri compose tanımından gelir.
  const ssrService = compose.buildServices.find(s => s !== webService && ssrFrameworkOf(readPkg(s.build.context)));
  let frontendDir = detectFrontendDir(appDir, compose.projectDir);
  if (frontendDir && ssrService && path.resolve(frontendDir.dir) === path.resolve(ssrService.build.context)) {
    const rest = frontendDir.candidates.filter(d => path.resolve(d) !== path.resolve(ssrService.build.context));
    frontendDir = rest.length ? detectFrontendDirFrom(rest) : null;
  }
  const frontendDirs = frontendDir ? frontendDir.candidates : [];
  let frontend = null;
  let frontendService = null;
  // Backend klasörü dışında kalan (monorepo) frontend çıktıları: pakete proje köküne göre aynı konumda eklenir.
  const externalAssetDirs = [];

  // 1) Frontend (backend'den önce)
  if (frontendDir) {
    if (frontendDir.candidates.length > 1) {
      warnings.push(`Birden fazla frontend klasörü bulundu (${frontendDir.candidates.map(d => path.relative(compose.projectDir, d)).join(', ')}); sadece ${path.relative(compose.projectDir, frontendDir.dir)} derlendi`);
    }
    if (frontendDir.kind === 'spa') {
      step(`Frontend derleniyor (${path.relative(compose.projectDir, frontendDir.dir)})`);
      const sources = backendSourceFiles(appDir, frontendDirs).map(f => path.join(appDir, f));
      const spa = await buildSpa(frontendDir, appDir, sources, logFile, compose.projectDir);
      warnings.push(...spa.warnings);
      const rel = p => path.relative(compose.projectDir, p);
      infos.push(`Frontend çıktısı: ${rel(spa.output)}${spa.placedAt && spa.placedAt !== spa.output ? ` → ${rel(spa.placedAt)}` : ''}${spa.external ? ' (backend klasörü dışında, monorepo düzeni korunarak paketlendi)' : ''}`);
      if (spa.external) externalAssetDirs.push(spa.placedAt || spa.output);
    } else {
      step(`SSR frontend derleniyor (${frontendDir.framework})`);
      const ssr = await buildSsr(frontendDir.dir, frontendDir.framework, logFile);
      frontend = await packageSsr(ssr, 'frontend', outDir, nodeMajor, logFile, {
        port: stack.port.value === 3000 ? 3001 : 3000,
        env: {}
      });
      infos.push(`SSR frontend (${frontendDir.framework}) ayrı frontend.exe olarak paketlendi; tarayıcı frontend portunu açacak`);
    }
  }

  if (!frontend) {
    if (ssrService) {
      const framework = ssrFrameworkOf(readPkg(ssrService.build.context));
      step(`SSR frontend servisi derleniyor (${ssrService.name}, ${framework})`);
      const ssr = await buildSsr(ssrService.build.context, framework, logFile);
      const port = ssrService.ports.length ? ssrService.ports[0].container : (stack.port.value === 3000 ? 3001 : 3000);
      frontend = await packageSsr(ssr, 'frontend', outDir, nodeMajor, logFile, { port, env: ssrService.resolvedEnvironment });
      frontendService = ssrService;
      infos.push(`Compose servisi "${ssrService.name}" (${framework}) frontend.exe olarak paketlendi`);
    }
  }

  // 2) Backend bağımlılıkları
  const needsBuild = Boolean(stack.entry.producedByBuild);
  step(needsBuild ? 'Bağımlılıklar kuruluyor (build için dev dahil)' : 'Production bağımlılıkları kuruluyor');
  await runNpm(installArgs(appDir, { production: !needsBuild }), { cwd: appDir, logFile });
  if (needsBuild) {
    step('npm run build');
    await runNpm(['run', 'build'], { cwd: appDir, logFile });
    if (!fs.existsSync(path.join(appDir, stack.entry.file))) {
      throw new Error(`npm run build tamamlandı ama entry dosyası oluşmadı: ${stack.entry.file}`);
    }
    await runNpm(['prune', '--omit=dev'], { cwd: appDir, logFile });
  }

  // 3) Native modüller
  step('Native modüller analiz ediliyor');
  const native = analyzeNativeModules(appDir, nodeMajor);
  warnings.push(...native.warnings);
  if (native.errors.length) {
    throw new Error(`Native modül ABI kontrolü başarısız:\n  ${native.errors.join('\n  ')}`);
  }
  const nodeModules = path.join(appDir, 'node_modules');
  const externalRel = native.externalDirs.map(d => toPosix(path.relative(nodeModules, d)));
  for (const rel of externalRel) {
    fs.cpSync(path.join(nodeModules, rel), path.join(outDir, 'node_modules', rel), { recursive: true });
  }
  if (native.packages.length) {
    infos.push(`Native modüller snapshot dışında tutuldu (${native.packages.map(p => `${p.name}: ${[...new Set(p.addons.map(a => (a.kind === 'napi' ? 'N-API' : `ABI ${a.abi}`)))].join('/')}`).join(', ')}) → node_modules/ (${externalRel.length} paket)`);
  }

  // 4) SQLite
  const pkg = readPkg(appDir) || {};
  const sqliteDeps = SQLITE_PACKAGES.filter(p => (pkg.dependencies || {})[p]);
  if (sqliteDeps.length) {
    warnings.push(`SQLite tespit edildi (${sqliteDeps.join(', ')}), uygulamanızın DB yolunu process.env.SQLITE_DB_PATH üzerinden okuduğundan emin olun, aksi halde uygulama yazma denemesinde çökecektir`);
  }
  if (pkg.type === 'module' || /\.mjs$/.test(stack.entry.file)) {
    warnings.push('Uygulama ES module (type: module); pkg ESM desteği sınırlıdır — paketlenmiş uygulamayı mutlaka test edin');
  }

  // 5) pkg ile app.exe
  step('app.exe derleniyor (pkg)');
  const ownScripts = backendSourceFiles(appDir, frontendDirs);
  const assets = listFiles(appDir, {
    skipDir: (rel, name) => name === '.git' || name === '.github' || externalRel.some(e => rel === `node_modules/${e}`) || isFrontendNodeModules(rel, appDir, frontendDirs),
    keep: (rel, name) => {
      const ext = path.extname(name).toLowerCase();
      if (ASSET_EXCLUDE_EXT.has(ext) || name.endsWith('.d.ts')) return false;
      if (OWN_SCRIPT_EXT.has(ext) && !rel.startsWith('node_modules/')) return false; // scripts ile derleniyor
      return !/^(license|licence|readme|changelog|history)(\..*)?$/i.test(name) && !rel.startsWith('.d2e-');
    }
  });
  for (const dir of externalAssetDirs) {
    for (const f of listFiles(dir)) assets.push(toPosix(path.relative(appDir, path.join(dir, f))));
  }
  const configFile = path.join(appDir, '.d2e-pkg.json');
  fs.writeFileSync(configFile, JSON.stringify({
    name: pkg.name || 'app',
    pkg: {
      scripts: ownScripts,
      assets,
      ignore: externalRel.map(r => `**/node_modules/${r}/**`)
    }
  }, null, 2));
  const compiled = await compileWithPkg({
    entry: path.join(appDir, stack.entry.file),
    configFile,
    output: path.join(outDir, 'app.exe'),
    nodeMajor,
    logFile,
    cwd: appDir
  });
  if (compiled.warnings.length) infos.push(`pkg ${compiled.warnings.length} uyarı üretti (ayrıntı: build.log)`);

  // 6) Çalışma klasörü: cwd'ye göreli dosya erişimleri (express.static('public'), fs.readFileSync('config.json')) için
  // Monorepo düzeninde (server/ + client/) göreli yollar korunur: app/<backend>/ + app/<frontend çıktısı>/
  step('Uygulama dosyaları kopyalanıyor');
  const appRel = externalAssetDirs.length ? toPosix(path.relative(compose.projectDir, appDir)) : '';
  const appCwd = appRel ? `app/${appRel}` : 'app';
  for (const dir of externalAssetDirs) {
    fs.cpSync(dir, path.join(outDir, 'app', path.relative(compose.projectDir, dir)), { recursive: true });
  }
  fs.cpSync(appDir, path.join(outDir, appCwd), {
    recursive: true,
    filter: src => {
      const rel = toPosix(path.relative(appDir, src));
      if (!rel) return true;
      const top = rel.split('/')[0];
      if (top === 'node_modules' || top === '.git' || rel === '.d2e-pkg.json') return false;
      return !isFrontendNodeModules(rel, appDir, frontendDirs);
    }
  });

  return {
    app: {
      exe: 'app.exe',
      cwd: appCwd,
      port: stack.port.value,
      nodePath: externalRel.length ? 'node_modules' : null,
      sqlite: sqliteDeps.length > 0,
      healthPath: '/',
      env: webService.resolvedEnvironment
    },
    frontend,
    frontendService,
    warnings,
    infos,
    native: native.packages.map(p => ({ name: p.name, kinds: [...new Set(p.addons.map(a => a.kind))] }))
  };
}

/** detectFrontendDir sonucunu verilen aday klasör listesinden yeniden kurar. */
function detectFrontendDirFrom(candidates) {
  const dir = candidates[0];
  const framework = ssrFrameworkOf(readPkg(dir));
  return { dir, kind: framework ? 'ssr' : 'spa', framework, candidates };
}

function isFrontendNodeModules(rel, appDir, frontendDirs) {
  return frontendDirs.some(fd => {
    const fdRel = toPosix(path.relative(appDir, fd));
    return !fdRel.startsWith('..') && (rel === `${fdRel}/node_modules` || rel.startsWith(`${fdRel}/node_modules/`));
  });
}

/** Backend'in kendi JS dosyaları (node_modules ve frontend kaynak klasörleri hariç). */
function backendSourceFiles(appDir, frontendDirs) {
  const frontendRels = frontendDirs.map(fd => toPosix(path.relative(appDir, fd))).filter(r => !r.startsWith('..'));
  return listFiles(appDir, {
    skipDir: (rel, name) => SKIP_DIRS.has(name) || frontendRels.includes(rel),
    keep: (rel, name) =>
      SCRIPT_EXT.has(path.extname(name)) && !/\.(test|spec)\.[cm]?js$/.test(name) && !/(^|\/)(test|tests|__tests__)\//.test(rel)
  });
}

/**
 * SSR çıktısını pakete koyar: <role>-server/ klasörü + yükleyici exe.
 */
async function packageSsr(ssr, role, outDir, nodeMajor, logFile, { port, env }) {
  const serverDir = `${role}-server`;
  fs.cpSync(ssr.root, path.join(outDir, serverDir), { recursive: true });
  const loader = await compileRuntimeExe('ssr-loader', nodeMajor, { logFile });
  fs.copyFileSync(loader, path.join(outDir, `${role}.exe`));
  return {
    exe: `${role}.exe`,
    cwd: serverDir,
    port,
    nodePath: null,
    sqlite: false,
    healthPath: '/',
    env: {
      NODE_ENV: 'production',
      ...env,
      HOSTNAME: '127.0.0.1',
      D2E_SSR_DIR: serverDir,
      D2E_SSR_ENTRY: toPosix(ssr.entry),
      D2E_SSR_ESM: ssr.esm ? '1' : '0'
    }
  };
}

module.exports = { buildNodeApp, backendSourceFiles, listFiles };
