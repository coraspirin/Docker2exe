const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

/** Port 127.0.0.1 üzerinde dinlenebilir mi? */
function isPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

/** Tercih edilen porttan başlayarak (ve `taken` dışında) ilk boş portu bulur. */
async function findFreePort(preferred, taken = new Set(), maxTries = 100) {
  for (let p = preferred; p < preferred + maxTries && p <= 65535; p++) {
    if (taken.has(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error(`${preferred}-${preferred + maxTries} aralığında boş port bulunamadı`);
}

/**
 * Uzun ömürlü süreç başlatır; stdout/stderr log dosyasına eklenir.
 * windowsHide: konsol penceresi açılmaz.
 */
function spawnLogged(exe, args, { cwd, env, logFile }) {
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\r\n===== ${new Date().toISOString()} ${exe} ${args.join(' ')} =====\r\n`);
  const child = spawn(exe, args, { cwd, env, stdio: ['ignore', fd, fd], windowsHide: true });
  child.once('exit', () => { try { fs.closeSync(fd); } catch { /* */ } });
  child.once('error', () => { try { fs.closeSync(fd); } catch { /* */ } });
  return child;
}

/**
 * Kısa süreli araç çalıştırır (initdb, pg_ctl, mysql ...). Çıktı hem log'a yazılır hem döndürülür.
 * @returns {Promise<{ code: number, output: string }>}
 */
function runTool(exe, args, { cwd, env, logFile, input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let output = '';
    const onData = d => { output += d; };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${exe} ${timeoutMs / 1000} sn içinde bitmedi`));
    }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    let finished = false;
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (logFile) {
        try {
          fs.appendFileSync(logFile, `\r\n===== ${new Date().toISOString()} ${exe} ${args.join(' ')} (çıkış: ${code}) =====\r\n${output}`);
        } catch {
          // Log yazılamaması aracın sonucunu değiştirmez; çıktı yine döndürülür.
        }
      }
      resolve({ code, output });
    };
    // `close` tüm stdio kapanınca gelir; `pg_ctl start` gibi arka plan süreci başlatan araçlarda
    // alt süreç pipe'ı miras aldığı için hiç gelmeyebilir. Bu yüzden `exit` sonrası kısa bir süre beklenir.
    child.on('close', code => finish(code));
    child.on('exit', code => setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      finish(code);
    }, 500));
    if (input) {
      child.stdin.on('error', () => { /* süreç erken kapandıysa */ });
      child.stdin.end(input);
    }
  });
}

/** Süreç ağacını sonlandırır (taskkill /T /F). */
function killTree(pid) {
  return new Promise(resolve => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** HTTP GET; herhangi bir HTTP yanıtı (404/500 dahil) sunucunun ayakta olduğunu gösterir. */
function httpProbe(port, pathName = '/', timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout: timeoutMs }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
    req.on('error', reject);
  });
}

/**
 * `probe` true dönene kadar dener. `alive()` false dönerse (süreç öldüyse) hemen hata verir.
 * Sessiz retry değil: süre dolunca son hata ile birlikte net hata fırlatılır.
 */
async function waitFor(probe, { timeoutMs, intervalMs = 500, alive = () => true, what }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error(`${what}: süreç sağlık kontrolü sırasında sonlandı`);
    try {
      if (await probe()) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${what}: ${Math.round(timeoutMs / 1000)} sn içinde yanıt vermedi${lastError ? ` (son hata: ${lastError.message})` : ''}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { isPortFree, findFreePort, spawnLogged, runTool, killTree, isPidAlive, httpProbe, waitFor, sleep };
