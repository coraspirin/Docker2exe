const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { cacheDir, PROJECT_ROOT } = require('../utils/paths');
const { compileWithPkg } = require('./pkgCompiler');

const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');

function hashRuntime(nodeMajor) {
  const hash = crypto.createHash('sha256');
  const pkgVersion = require('@yao-pkg/pkg/package.json').version;
  hash.update(`pkg:${pkgVersion};node:${nodeMajor}`);
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) hash.update(e.name).update(fs.readFileSync(full));
    }
  };
  walk(RUNTIME_DIR);
  return hash.digest('hex').slice(0, 16);
}

/**
 * runtime/ altındaki bir giriş dosyasını (launcher.js, ssr-loader.js) pkg ile derler.
 * Sonuç runtime kaynak kodu + pkg sürümü + Node hedefiyle cache'lenir.
 * @returns {Promise<string>} exe yolu (cache'te)
 */
async function compileRuntimeExe(name, nodeMajor, { logFile } = {}) {
  const dir = path.join(cacheDir(), 'runtime-exe');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, `${name}-node${nodeMajor}-${hashRuntime(nodeMajor)}.exe`);
  if (fs.existsSync(exe)) return exe;

  const configFile = path.join(os.tmpdir(), `d2e-${name}-pkg-${process.pid}.json`);
  fs.writeFileSync(configFile, JSON.stringify({ name, pkg: {} }));
  try {
    const tmpOut = exe.replace(/.exe$/, '.partial.exe'); // pkg, .exe ile bitmeyen çıktılara .exe ekler
    await compileWithPkg({ entry: path.join(RUNTIME_DIR, `${name}.js`), configFile, output: tmpOut, nodeMajor, logFile, cwd: RUNTIME_DIR });
    fs.renameSync(tmpOut, exe);
    // Aynı exe'nin eski runtime sürümlerini temizle
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${name}-node${nodeMajor}-`) && path.join(dir, f) !== exe) fs.rmSync(path.join(dir, f), { force: true });
    }
  } finally {
    fs.rmSync(configFile, { force: true });
  }
  return exe;
}

module.exports = { compileRuntimeExe };
