const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * npm'i shell olmadan, mevcut Node ile çalıştırır (npm-cli.js). Windows'ta npm.cmd'yi
 * shell:false ile başlatmak Node 20.12+ sonrası EINVAL verdiği için bu yol tercih edilir.
 */
function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  return candidates.find(p => /npm-cli\.js$/.test(p) && fs.existsSync(p)) || null;
}

/**
 * Çalışan Node'un klasörü PATH'in başına eklenmiş ortam: npm script'leri (`node install.js`, `npm run build`)
 * PATH'teki node'u çağırır; docker2exe.exe kendi gömülü Node'uyla, PATH'te Node olmayan makinede de çalışır.
 */
function envWithOwnNode(base = process.env) {
  const env = { ...base };
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = [path.dirname(process.execPath), env[key]].filter(Boolean).join(path.delimiter);
  return env;
}

/**
 * @returns {Promise<string>} birleşik çıktı
 */
function runNpm(args, { cwd, logFile, env } = {}) {
  const cli = npmCliPath();
  const [cmd, fullArgs, shell] = cli ? [process.execPath, [cli, ...args], false] : ['npm', args, true];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, fullArgs, {
      cwd,
      env: { ...envWithOwnNode(), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', ...env },
      shell,
      windowsHide: true
    });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (logFile) fs.appendFileSync(logFile, `\n$ npm ${args.join(' ')}  (cwd: ${cwd})\n${output}\n[çıkış kodu ${code}]\n`);
      if (code === 0) return resolve(output);
      const tail = output.trim().split(/\r?\n/).slice(-20).join('\n    ');
      reject(new Error(`npm ${args.join(' ')} başarısız (çıkış kodu ${code}, klasör: ${cwd}):\n    ${tail}${logFile ? `\n    Tam çıktı: ${logFile}` : ''}`));
    });
  });
}

/** Lock dosyası varsa `npm ci`, yoksa `npm install`. */
function installArgs(dir, { production }) {
  const hasLock = fs.existsSync(path.join(dir, 'package-lock.json')) || fs.existsSync(path.join(dir, 'npm-shrinkwrap.json'));
  const args = [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund'];
  if (production) args.push('--omit=dev');
  return args;
}

module.exports = { runNpm, installArgs, npmCliPath, envWithOwnNode };
