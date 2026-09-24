const { splitShellWords } = require('../parser/dockerfileParser');

/**
 * Bir başlatma komutundan (package.json script'i veya Dockerfile CMD/ENTRYPOINT) Node entry dosyasını çıkarır.
 *
 * Döner (biri):
 *   { kind: 'entry', file, runner, command }            — `node server.js`, `nodemon app.js` ...
 *   { kind: 'ssr', framework, command }                 — `next start`, `nuxt start`, `node .output/server/index.mjs`
 *   { kind: 'unsupported', reason, command }            — ts-node, pm2 ecosystem, `node -e` ...
 *   { kind: 'unknown', command }                        — tanınmayan komut
 */

// Değer alan node bayrakları (değer ayrı kelime olarak gelebilir).
const NODE_FLAGS_WITH_VALUE = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--title',
  '--max-old-space-size', '--stack-size', '--conditions', '-C', '--input-type'
]);
const NODE_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
const WRAPPERS = new Set(['cross-env', 'env', 'exec', 'npx', 'dumb-init', 'tini', 'nice']);
const WATCHERS = new Set(['nodemon', 'node-dev', 'supervisor', 'forever', 'pm2', 'pm2-runtime']);
const TS_RUNNERS = new Set(['ts-node', 'ts-node-dev', 'tsx', 'ts-node-esm', 'babel-node']);
const OTHER_RUNTIMES = new Set(['bun', 'deno']);
const SSR_CLIS = { next: 'next', nuxt: 'nuxt', nuxi: 'nuxt' };
const SHELLS = new Set(['sh', 'bash', '/bin/sh', '/bin/bash', 'ash', '/bin/ash']);
const MAX_SCRIPT_DEPTH = 5;

/**
 * @param {string|string[]} command kabuk metni veya exec-form argüman dizisi
 * @param {{ scripts?: Record<string,string> }} ctx npm/yarn script'lerini çözmek için
 */
function analyzeCommand(command, ctx = {}, depth = 0) {
  const text = Array.isArray(command) ? command.join(' ') : command;
  if (depth > MAX_SCRIPT_DEPTH) {
    return { kind: 'unsupported', reason: 'npm script\'leri çok derin iç içe çağrılıyor', command: text };
  }

  const segments = Array.isArray(command) ? [command] : splitSegments(command).map(splitShellWords);

  // Son segment genellikle asıl sunucuyu başlatır (`npm run build && node dist/index.js`).
  for (let i = segments.length - 1; i >= 0; i--) {
    const result = analyzeWords(segments[i], ctx, depth);
    if (result.kind !== 'unknown') return { ...result, command: result.command || text };
  }
  return { kind: 'unknown', command: text };
}

function splitSegments(text) {
  return text.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(s => s.trim());
}

function analyzeWords(words, ctx, depth) {
  let i = 0;
  // VAR=value önekleri ve sarmalayıcılar (cross-env NODE_ENV=production node x)
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (WRAPPERS.has(w)) { i++; continue; }
    if (w === 'dotenv') {
      const sep = words.indexOf('--', i);
      i = sep === -1 ? words.length : sep + 1;
      continue;
    }
    break;
  }
  const rest = words.slice(i);
  if (!rest.length) return { kind: 'unknown' };

  const runner = baseName(rest[0]);
  const args = rest.slice(1);
  const joined = rest.join(' ');

  if (runner === 'node' || runner === 'node.exe') return analyzeNodeArgs(args, 'node', joined);

  if (WATCHERS.has(runner)) {
    const positional = args.filter(a => !a.startsWith('-') && a !== 'start');
    const target = positional[0];
    if (!target) return { kind: 'unknown' };
    if (/ecosystem|\.json$|\.ya?ml$|\.config\.[cm]?js$/.test(target)) {
      return { kind: 'unsupported', reason: `${runner} ecosystem dosyası (${target}) desteklenmiyor — doğrudan entry dosyasını --entry ile verin`, command: joined };
    }
    return classifyFile(target, runner, joined);
  }

  if (TS_RUNNERS.has(runner)) {
    return { kind: 'unsupported', reason: `TypeScript kaynak kodu ${runner} ile doğrudan çalıştırılıyor — derlenmiş JS çıktısını --entry ile verin (örn. --entry dist/index.js)`, command: joined };
  }
  if (OTHER_RUNTIMES.has(runner)) {
    return { kind: 'unsupported', reason: `${runner} runtime'ı desteklenmiyor, sadece Node.js`, command: joined };
  }

  if (SSR_CLIS[runner]) {
    if (['start', 'preview'].includes(args[0]) || args.length === 0) return { kind: 'ssr', framework: SSR_CLIS[runner], command: joined };
    return { kind: 'unknown' };
  }

  if (runner === 'npm' || runner === 'yarn' || runner === 'pnpm') {
    const scriptName = resolveScriptName(runner, args);
    if (!scriptName) return { kind: 'unknown' };
    const script = ctx.scripts && ctx.scripts[scriptName];
    if (!script) {
      return { kind: 'unsupported', reason: `"${runner} ${args.join(' ')}" komutu package.json'da olmayan "${scriptName}" script'ini çağırıyor`, command: joined };
    }
    return analyzeCommand(script, ctx, depth + 1);
  }

  if (SHELLS.has(runner)) {
    const cIdx = args.indexOf('-c');
    if (cIdx !== -1 && args[cIdx + 1]) return analyzeCommand(args[cIdx + 1], ctx, depth + 1);
    return { kind: 'unknown' };
  }

  return { kind: 'unknown' };
}

function analyzeNodeArgs(args, runner, joined) {
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (NODE_EVAL_FLAGS.has(a) || /^--(eval|print)=/.test(a)) {
      return { kind: 'unsupported', reason: 'node -e/--eval ile satır içi kod çalıştırılıyor, entry dosyası yok', command: joined };
    }
    if (NODE_FLAGS_WITH_VALUE.has(a)) { j++; continue; }
    if (a.startsWith('-')) continue;
    return classifyFile(a, runner, joined);
  }
  return { kind: 'unknown' };
}

function classifyFile(file, runner, joined) {
  const normalized = file.replace(/\\/g, '/');
  if (/(^|\/)\.output\/server\/index\.mjs$/.test(normalized)) return { kind: 'ssr', framework: 'nuxt', command: joined };
  if (/(^|\/)\.next\/standalone\/server\.js$/.test(normalized)) return { kind: 'ssr', framework: 'next', command: joined };
  if (/\.(ts|mts|cts)$/.test(normalized)) {
    return { kind: 'unsupported', reason: `Entry bir TypeScript dosyası (${file}) — derlenmiş JS çıktısını --entry ile verin`, command: joined };
  }
  return { kind: 'entry', file: normalized, runner, command: joined };
}

function resolveScriptName(runner, args) {
  const positional = args.filter(a => !a.startsWith('-'));
  if (!positional.length) return runner === 'npm' ? null : 'start';
  if (positional[0] === 'run' || positional[0] === 'run-script') return positional[1] || null;
  if (['start', 'stop', 'test', 'restart'].includes(positional[0])) return positional[0];
  // `yarn serve`, `pnpm serve` script kısayolu; npm'de alt komut olmadan script çağrılamaz.
  return runner === 'npm' ? null : positional[0];
}

function baseName(word) {
  return word.replace(/\\/g, '/').split('/').pop();
}

module.exports = { analyzeCommand };
