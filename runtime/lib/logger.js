const fs = require('fs');
const path = require('path');

/** launcher.log + konsol. Satırlar zaman damgalı; dosya ekleme modunda açılır. */
function createLogger(logsDir) {
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, 'launcher.log');
  const fd = fs.openSync(file, 'a');

  const write = (level, msg) => {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    fs.writeSync(fd, line + '\r\n');
    const out = level === 'ERROR' ? console.error : console.log;
    out(level === 'INFO' ? msg : `[${level}] ${msg}`);
  };

  return {
    file,
    info: msg => write('INFO', msg),
    warn: msg => write('WARN', msg),
    error: msg => write('ERROR', msg),
    state: name => write('STATE', name),
    close: () => { try { fs.closeSync(fd); } catch { /* zaten kapalı */ } }
  };
}

module.exports = { createLogger };
