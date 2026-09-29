const fs = require('fs');
const path = require('path');
const { parseDockerfile, parseDockerfileContent } = require('../parser/dockerfileParser');
const { analyzeCommand } = require('./commandAnalyzer');

// Node 20 Nisan 2026'da EOL oldu; hiçbir kaynaktan versiyon çıkmazsa (uyarıyla) bu kullanılır.
const DEFAULT_NODE_MAJOR = 22;
const ENTRY_EXTENSIONS = ['', '.js', '.cjs', '.mjs', '/index.js', '/index.cjs', '/index.mjs'];
const SCAN_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts']);
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output']);
const SCAN_MAX_FILES = 500;

const SSR_DEPENDENCIES = { next: 'next', nuxt: 'nuxt', '@sveltejs/kit': 'sveltekit', '@remix-run/serve': 'remix', astro: 'astro' };
const SERVER_DEPENDENCIES = { express: 'express', fastify: 'fastify', koa: 'koa', '@nestjs/core': 'nestjs', '@hapi/hapi': 'hapi' };

/**
 * Web servisinin entry point'ini, portunu, Node versiyonunu ve framework'ünü tespit eder.
 * Soru sorulmaz; tespit edilemeyen her şey `errors` listesine düşer (toplu pre-flight raporu için).
 *
 * @param {object} webService composeParser çıktısındaki servis
 * @param {{ entry?: string, port?: number, rootDir?: string }} overrides CLI'dan gelen açık değerler;
 *   rootDir: mesajlarda yolların göreli gösterileceği proje kökü (temp workspace)
 */
function detectStack(webService, overrides = {}) {
  const errors = [];
  const warnings = [];
  const infos = [];
  const dockerfile = safeDockerfile(webService, warnings);
  const appDir = resolveAppDir(webService.build.context, dockerfile);
  if (appDir !== webService.build.context) {
    infos.push(`Uygulama klasörü: ${displayPath(overrides.rootDir, appDir) || '.'} (Dockerfile WORKDIR ${dockerfile.final.workdir} bu klasörden kopyalanıyor)`);
  }

  const pkgPath = path.join(appDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    const hint = dockerfile && dockerfile.final ? ` (Dockerfile base image: ${dockerfile.final.rootImage})` : '';
    errors.push(`"${webService.name}" servisi bir Node.js projesi değil: ${displayPath(overrides.rootDir, pkgPath)} bulunamadı${hint}`);
    return { appDir, packageJson: null, entry: null, port: null, node: null, framework: null, errors, warnings, infos };
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    errors.push(`package.json parse edilemedi: ${err.message}`);
    return { appDir, packageJson: null, entry: null, port: null, node: null, framework: null, errors, warnings, infos };
  }

  const framework = detectFramework(pkg);
  const entry = detectEntry({ appDir, pkg, dockerfile, override: overrides.entry, errors, warnings, infos });
  const port = detectPort({ webService, dockerfile, appDir, entry, override: overrides.port, errors, warnings });
  const node = detectNodeVersion(pkg, dockerfile, warnings);

  if (framework.ssr && !(entry && entry.kind === 'ssr')) {
    warnings.push(`${framework.ssr} bağımlılığı var ama başlatma komutu SSR sunucusu değil — frontend build aşamasında ayrıca ele alınacak`);
  }

  const final = dockerfile && dockerfile.final;
  if (final && final.systemPackages && final.systemPackages.length) {
    warnings.push(`Dockerfile işletim sistemi paketleri kuruyor (${final.systemPackages.join(', ')}); bunlar Windows paketine dahil edilmez — bu paketlerin sağladığı komutları (örn. child_process ile çağrılan araçlar) kullanan özellikler hedef makinede kurulu değilse çalışmaz`);
  }
  return {
    appDir,
    container: final ? { workdir: final.workdir, env: final.env, volumes: final.volumes, copies: final.copies } : null,
    packageJson: { name: pkg.name || null, version: pkg.version || null },
    entry,
    port,
    node,
    framework,
    errors,
    warnings,
    infos
  };
}

function safeDockerfile(webService, warnings) {
  const { dockerfile, dockerfileInline } = webService.build;
  try {
    if (dockerfileInline) return parseDockerfileContent(dockerfileInline);
    if (dockerfile && fs.existsSync(dockerfile)) return parseDockerfile(dockerfile);
  } catch (err) {
    warnings.push(`Dockerfile okunamadı: ${err.message}`);
  }
  return null;
}

/**
 * Uygulamanın build context içindeki klasörü. Docker'da çalışan kod, son stage'de WORKDIR'a kopyalanan klasördür:
 * `COPY . .` → context kökü; `COPY server/package*.json ./` + `COPY server/ ./` (WORKDIR /app/server) → server/.
 * Kopyalanan klasörde package.json yoksa context kökü kullanılır.
 */
function resolveAppDir(context, dockerfile) {
  const final = dockerfile && dockerfile.final;
  if (!final || !final.copies) return context;
  for (const copy of final.copies) {
    if (copy.from || copy.dest !== final.workdir) continue;
    for (const src of copy.sources) {
      let dir = null;
      if (/(^|\/)package[^/]*\.json$/.test(src)) {
        dir = path.posix.dirname(src);
      } else if (!/[*?[]/.test(src)) {
        const full = path.resolve(context, src);
        if (fs.existsSync(full) && fs.statSync(full).isDirectory()) dir = src;
      }
      if (dir === null) continue;
      const candidate = path.resolve(context, dir);
      if (isInside(context, candidate) && fs.existsSync(path.join(candidate, 'package.json'))) {
        return candidate === path.resolve(context) ? context : candidate;
      }
    }
  }
  return context;
}

// --- Entry point ---

function detectEntry({ appDir, pkg, dockerfile, override, errors, warnings, infos }) {
  const hasBuildScript = Boolean(pkg.scripts && pkg.scripts.build);

  if (override) {
    const resolved = resolveEntryFile(appDir, override);
    if (!resolved && !hasBuildScript) {
      errors.push(`--entry ile verilen dosya bulunamadı: ${override}`);
      return null;
    }
    return finalizeEntry({ kind: 'entry', file: override, command: null }, 'cli', appDir, hasBuildScript, errors, warnings);
  }

  const candidates = [];
  if (pkg.scripts && pkg.scripts.start) {
    candidates.push({ source: 'package.json scripts.start', result: analyzeCommand(pkg.scripts.start, { scripts: pkg.scripts }) });
  }
  if (typeof pkg.main === 'string' && pkg.main) {
    candidates.push({ source: 'package.json main', result: { kind: 'entry', file: pkg.main, command: null } });
  }
  const dockerCmd = dockerfile && dockerfile.final && dockerfileCommand(dockerfile.final, warnings);
  if (dockerCmd) {
    const result = analyzeCommand(dockerCmd.form === 'exec' ? dockerCmd.args : dockerCmd.raw, { scripts: pkg.scripts || {} });
    candidates.push({ source: 'Dockerfile CMD/ENTRYPOINT', result: mapDockerPath(result, dockerfile.final.workdir) });
  }

  const skipped = [];
  for (const { source, result } of candidates) {
    if (result.kind === 'entry' || result.kind === 'ssr') {
      skipped.forEach(s => infos.push(s));
      return finalizeEntry(result, source, appDir, hasBuildScript, errors, warnings);
    }
    skipped.push(`${source} atlandı: ${result.kind === 'unsupported' ? result.reason : `komut tanınmadı ("${result.command}")`}`);
  }

  const detail = skipped.length ? `\n    ${skipped.join('\n    ')}` : ' (scripts.start, main ve Dockerfile CMD yok)';
  errors.push(`Entry point otomatik tespit edilemedi${detail}\n    → --entry <dosya> ile belirtin`);
  return null;
}

/** Docker tarafında çalışan komut: ENTRYPOINT + CMD. Kabuk script'i ENTRYPOINT'ler (docker-entrypoint.sh) atlanır. */
function dockerfileCommand(final, warnings) {
  const { entrypoint, cmd } = final;
  if (entrypoint && cmd && entrypoint.form === 'exec' && cmd.form === 'exec') {
    if (/\.sh$/.test(entrypoint.args[0] || '')) {
      warnings.push(`Dockerfile ENTRYPOINT bir kabuk script'i (${entrypoint.args[0]}); Windows'ta çalıştırılmayacak, sadece CMD değerlendirildi`);
      return cmd;
    }
    return { form: 'exec', args: [...entrypoint.args, ...cmd.args] };
  }
  return entrypoint || cmd;
}

/** Docker içindeki mutlak yolu (WORKDIR altı) build context'e göreli yola çevirir. */
function mapDockerPath(result, workdir) {
  if (result.kind !== 'entry' || !result.file.startsWith('/')) return result;
  const prefix = workdir.endsWith('/') ? workdir : `${workdir}/`;
  if (result.file.startsWith(prefix)) return { ...result, file: result.file.slice(prefix.length) };
  return { kind: 'unsupported', reason: `Dockerfile'daki entry yolu (${result.file}) WORKDIR (${workdir}) dışında; build context'e eşlenemiyor`, command: result.command };
}

function finalizeEntry(result, source, appDir, hasBuildScript, errors, warnings) {
  if (result.kind === 'ssr') {
    return { kind: 'ssr', framework: result.framework, file: null, source, command: result.command, exists: null };
  }
  const resolved = resolveEntryFile(appDir, result.file);
  const entry = {
    kind: 'entry',
    file: resolved ? toPosix(path.relative(appDir, resolved)) : toPosix(path.normalize(result.file)),
    source,
    command: result.command,
    exists: Boolean(resolved),
    producedByBuild: false
  };
  if (!resolved) {
    if (hasBuildScript) {
      entry.producedByBuild = true;
      warnings.push(`Entry dosyası (${entry.file}) kaynakta yok; "npm run build" çıktısı olduğu varsayılıyor — build sonrası doğrulanacak`);
    } else {
      errors.push(`Entry dosyası bulunamadı: ${entry.file} (kaynak: ${source}) ve package.json'da build script'i yok`);
    }
  }
  return entry;
}

function resolveEntryFile(appDir, file) {
  const base = path.resolve(appDir, file);
  if (!isInside(appDir, base)) return null;
  for (const ext of ENTRY_EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// --- Port ---

function detectPort({ webService, dockerfile, appDir, entry, override, errors, warnings }) {
  let port = null;

  if (override !== undefined && override !== null) {
    port = { value: override, source: 'cli' };
  } else if (webService.ports.length) {
    const containerPorts = [...new Set(webService.ports.map(p => p.container))];
    if (containerPorts.length > 1) {
      warnings.push(`Web servisi birden fazla port yayınlıyor (${containerPorts.join(', ')}); ${containerPorts[0]} uygulama portu kabul edildi — farklıysa --port kullanın`);
    }
    port = { value: containerPorts[0], source: 'compose ports' };
  } else if (webService.expose.length) {
    port = { value: webService.expose[0], source: 'compose expose' };
  } else if (dockerfile && dockerfile.final && dockerfile.final.expose.length) {
    port = { value: dockerfile.final.expose[0], source: 'Dockerfile EXPOSE' };
  } else {
    const scanned = scanCodeForPort(appDir, entry);
    if (scanned.values.length === 1) {
      port = { value: scanned.values[0], source: `kod (${scanned.files.join(', ')})` };
    } else if (scanned.values.length > 1) {
      errors.push(`Kodda birden fazla PORT varsayılanı bulundu (${scanned.values.join(', ')}); --port ile belirtin`);
      return null;
    }
  }

  if (!port) {
    errors.push('Uygulama portu tespit edilemedi (compose ports/expose, Dockerfile EXPOSE, kodda process.env.PORT varsayılanı yok) → --port <n> ile belirtin');
    return null;
  }

  const envPort = webService.resolvedEnvironment.PORT;
  if (envPort && Number(envPort) !== port.value) {
    warnings.push(`Compose ortamında PORT=${envPort} ama tespit edilen uygulama portu ${port.value} (${port.source}) — uygulama PORT değişkenini okuyorsa ${envPort} portunda dinleyecek`);
  }
  return port;
}

const PORT_PATTERNS = [
  /process\.env\.PORT\b[^;\n]{0,40}?(?:\|\||\?\?)\s*['"]?(\d{2,5})\b/g,
  /\{[^}]*\bPORT\s*=\s*['"]?(\d{2,5})\b[^}]*\}\s*=\s*process\.env\b/g
];

function scanCodeForPort(appDir, entry) {
  const files = [];
  if (entry && entry.kind === 'entry' && entry.exists) files.push(path.join(appDir, entry.file));
  const values = new Set();
  const matchedFiles = [];

  const scanFile = file => {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    let found = false;
    for (const re of PORT_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content))) {
        values.add(Number(m[1]));
        found = true;
      }
    }
    if (found) matchedFiles.push(toPosix(path.relative(appDir, file)));
  };

  files.forEach(scanFile);
  if (!values.size) walkSourceFiles(appDir).forEach(scanFile);
  return { values: [...values], files: matchedFiles };
}

function walkSourceFiles(root) {
  const result = [];
  const stack = [root];
  while (stack.length && result.length < SCAN_MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(path.join(dir, e.name));
      } else if (SCAN_EXTENSIONS.has(path.extname(e.name))) {
        result.push(path.join(dir, e.name));
      }
    }
  }
  return result;
}

// --- Node versiyonu ---

function detectNodeVersion(pkg, dockerfile, warnings) {
  const engines = pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node.trim() : null;
  const dockerMajor = dockerfile ? nodeMajorFromDockerfile(dockerfile) : null;

  if (dockerMajor) {
    if (engines && satisfiesMajor(engines, dockerMajor) === false) {
      warnings.push(`Dockerfile Node ${dockerMajor} kullanıyor ama package.json engines.node "${engines}" — Dockerfile esas alındı`);
    }
    return { major: dockerMajor, source: 'Dockerfile FROM', engines };
  }
  if (engines) {
    const major = lowestMajor(engines);
    if (major) return { major, source: 'package.json engines.node', engines };
    warnings.push(`package.json engines.node ("${engines}") yorumlanamadı`);
  }
  warnings.push(`Node versiyonu tespit edilemedi; varsayılan Node ${DEFAULT_NODE_MAJOR} kullanılacak`);
  return { major: DEFAULT_NODE_MAJOR, source: 'varsayılan', engines };
}

/** Node çalıştıran son stage'in base image'inden major çıkarır (`node:20-alpine` → 20). */
function nodeMajorFromDockerfile(dockerfile) {
  for (let i = dockerfile.stages.length - 1; i >= 0; i--) {
    const m = /^(?:[^/]+\/)*node:(\d+)/i.exec(dockerfile.stages[i].rootImage || '');
    if (m) return Number(m[1]);
  }
  return null;
}

/** engines aralığının izin verdiği en düşük major (`>=18` → 18, `^20.10` → 20, `18 || 20` → 18). */
function lowestMajor(range) {
  const majors = range
    .split('||')
    .map(part => /\d+/.exec(part))
    .filter(Boolean)
    .map(m => Number(m[0]));
  return majors.length ? Math.min(...majors) : null;
}

/**
 * Sadece major seviyesinde yaklaşık semver kontrolü. Yorumlanamazsa null döner (uyarı üretilmez).
 */
function satisfiesMajor(range, major) {
  const sets = range.split('||').map(s => s.trim()).filter(Boolean);
  if (!sets.length) return null;
  let understood = false;
  for (const set of sets) {
    const comparators = set.split(/\s+/).filter(Boolean);
    let ok = true;
    for (const c of comparators) {
      const m = /^(>=|<=|>|<|\^|~|=)?v?(\d+|x|\*)(?:\.[\dx*]+)*$/.exec(c);
      if (!m) return null;
      understood = true;
      if (m[2] === 'x' || m[2] === '*') continue;
      const n = Number(m[2]);
      const op = m[1] || '=';
      if (op === '>=' && !(major >= n)) ok = false;
      if (op === '>' && !(major > n || (major === n && /\.\d/.test(c)))) ok = false;
      if (op === '<=' && !(major <= n)) ok = false;
      if (op === '<' && !(major < n)) ok = false;
      if ((op === '^' || op === '~' || op === '=') && major !== n) ok = false;
    }
    if (ok) return true;
  }
  return understood ? false : null;
}

// --- Framework ---

function detectFramework(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const runtimeDeps = pkg.dependencies || {};
  const ssrKey = Object.keys(SSR_DEPENDENCIES).find(d => deps[d]);
  const serverKey = Object.keys(SERVER_DEPENDENCIES).find(d => runtimeDeps[d]);
  return {
    ssr: ssrKey ? SSR_DEPENDENCIES[ssrKey] : null,
    server: serverKey ? SERVER_DEPENDENCIES[serverKey] : null
  };
}

function displayPath(rootDir, p) {
  return rootDir ? toPosix(path.relative(rootDir, p)) : p;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

module.exports = { detectStack, satisfiesMajor, lowestMajor, DEFAULT_NODE_MAJOR };
