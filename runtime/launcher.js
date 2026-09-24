/**
 * docker2exe launcher — paketlenmiş uygulamanın orchestrator'ı (pkg ile launcher.exe olarak derlenir).
 *
 * INIT → EXTRACT → START_DEPS (+ HEALTH_CHECK) → START_APP → OPEN_BROWSER → RUNNING → SHUTTING_DOWN
 * Hata durumunda FAILED: hangi log dosyasına bakılacağı yazılır, sessiz retry yapılmaz.
 * launcher.exe konsolsuz (GUI subsystem) çalışır; kullanıcıya hatalar MessageBox ile gösterilir.
 *
 * Kullanım:
 *   launcher.exe            uygulamayı başlatır
 *   launcher.exe --stop     çalışan launcher'a graceful kapatma isteği gönderir (Durdur.bat)
 *   launcher.exe --config <app.json>   (geliştirme/test) farklı config ile çalıştırır
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createLogger } = require('./lib/logger');
const { attachKillOnCloseJob, isAdmin, showMessage } = require('./lib/win32');
const { ENGINES, healthCheck } = require('./lib/engines');
const { rewriteEnvPorts } = require('./lib/envRewrite');
const { orderServices, logNameFor } = require('./lib/order');
const { findFreePort, isPortFree, spawnLogged, killTree, httpProbe, waitFor, sleep } = require('./lib/proc');

const INIT_MARKER = '.d2e-init-complete';
const APP_HEALTH_TIMEOUT_MS = 60000;
const DB_HEALTH_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------- yardımcılar

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function resolvePaths() {
  const configPath = argValue('--config')
    ? path.resolve(argValue('--config'))
    : path.join(path.dirname(process.execPath), 'config', 'app.json');
  const installDir = path.dirname(path.dirname(configPath));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dataRoot = process.env.D2E_DATA_ROOT || path.join(localAppData, config.appId);
  return {
    config,
    installDir,
    dataRoot,
    logsDir: path.join(dataRoot, 'logs'),
    runtimeDir: path.join(dataRoot, 'runtime'),
    dataDir: path.join(dataRoot, 'data'),
    tmpDir: path.join(dataRoot, 'tmp'),
    pipe: `\\\\.\\pipe\\docker2exe-${config.appId}`
  };
}

/** Kullanıcının config/.env dosyası varsa (KEY=VALUE) build-time ortamın üzerine yazar. */
function readUserEnv(installDir) {
  const file = path.join(installDir, 'config', '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function writeDotenv(file, env) {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`);
  fs.writeFileSync(file, `# docker2exe tarafından her başlatmada yeniden üretilir\r\n${lines.join('\r\n')}\r\n`);
}

function openBrowser(url) {
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// ---------------------------------------------------------------- kontrol kanalı (named pipe)

function sendControl(pipe, command, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('zaman aşımı')); }, timeoutMs);
    socket.on('connect', () => socket.write(`${command}\n`));
    socket.on('data', d => { data += d; });
    socket.on('close', () => { clearTimeout(timer); resolve(data.trim()); });
    socket.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ---------------------------------------------------------------- launcher

class Launcher {
  constructor(paths) {
    this.p = paths;
    this.cfg = paths.config;
    this.log = createLogger(paths.logsDir);
    this.running = []; // { name, stop: async () => {}, isAlive }
    this.shuttingDown = false;
    this.state = null;
    this.url = null;
  }

  setState(name) {
    this.state = name;
    this.log.state(name);
  }

  async run() {
    this.log.info(`${this.cfg.appName} başlatılıyor (${this.cfg.tool || 'docker2exe'})`);
    this.log.info(`Veri: ${this.p.dataRoot}`);

    this.setState('INIT');
    await this.init();

    this.setState('EXTRACT');
    this.extractDeps();

    this.setState('START_DEPS');
    const moves = await this.startDeps();

    this.setState('START_APP');
    const appPort = await this.startNodeProcess('app', this.cfg.app, moves);
    let entryPort = appPort;
    if (this.cfg.frontend) {
      // Frontend, backend'e servis adıyla (örn. http://api:4000) bağlanıyorsa backend'in port değişikliği de yansıtılır.
      if (this.cfg.app.service) moves[this.cfg.app.service] = { from: this.cfg.app.port, to: appPort };
      entryPort = await this.startNodeProcess('frontend', this.cfg.frontend, moves, { BACKEND_PORT: String(appPort) });
    }

    this.url = `http://localhost:${entryPort}/`;
    this.setState('OPEN_BROWSER');
    if (this.cfg.openBrowser !== false && process.env.D2E_NO_BROWSER !== '1') openBrowser(this.url);
    this.log.info(`Uygulama hazır: ${this.url}`);

    this.setState('RUNNING');
    this.log.info('Durdurmak için Durdur.bat çalıştırın.');
  }

  async init() {
    for (const dir of [this.p.dataDir, this.p.runtimeDir, this.p.tmpDir]) fs.mkdirSync(dir, { recursive: true });

    // Öksüz süreç koruması — fallback yok.
    try {
      attachKillOnCloseJob(path.join(this.p.installDir, 'native'));
      this.log.info('Windows Job Object kuruldu (launcher kapanırsa tüm alt süreçler sonlandırılır)');
    } catch (err) {
      throw new Error(`Job Object kurulamadı, güvenli başlatma mümkün değil: ${err.message}`);
    }

    this.elevated = false;
    if (this.cfg.services.some(s => s.type === 'postgres')) {
      this.elevated = isAdmin(path.join(this.p.installDir, 'native'));
      if (this.elevated) {
        this.log.warn('Launcher Yönetici olarak çalışıyor; PostgreSQL pg_ctl ile kısıtlı token altında başlatılacak');
      }
    }

    await this.startControlServer();
  }

  /** deps/ altındaki binary'ler LOCALAPPDATA'ya kopyalanır (sürüm değişmedikçe bir kez). */
  extractDeps() {
    const keys = [...new Set(this.cfg.services.map(s => s.deps).filter(Boolean))];
    for (const rel of keys) {
      const src = path.join(this.p.installDir, rel);
      const dest = path.join(this.p.runtimeDir, rel);
      const marker = path.join(dest, '.d2e-version');
      const version = `${this.cfg.buildId}:${rel}`;
      if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === version) continue;
      this.log.info(`Binary'ler kopyalanıyor: ${rel}`);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
      fs.writeFileSync(marker, version);
    }
  }

  engineContext(svc, port) {
    const svcDir = path.join(this.p.dataDir, svc.name);
    return {
      svc,
      port,
      svcDir,
      binDir: svc.deps ? path.join(this.p.runtimeDir, svc.deps) : null,
      dataDir: path.join(svcDir, 'db'),
      logFile: path.join(this.p.logsDir, logNameFor(svc, this.cfg.services)),
      toolLog: this.log.file,
      log: this.log,
      tmpDir: this.p.tmpDir,
      initDir: svc.initDir ? path.join(this.p.installDir, svc.initDir) : null,
      elevated: this.elevated
    };
  }

  async startDeps() {
    const moves = {};
    const taken = new Set();
    for (const svc of orderServices(this.cfg.services)) {
      const engine = ENGINES[svc.engine || svc.type];
      if (!engine) throw new Error(`Bilinmeyen DB motoru: ${svc.engine || svc.type}`);

      // Harici servis (Memurai) launcher'a ait değil: kendi portunda çalışır, taşınmaz.
      const port = engine.external ? svc.port : await findFreePort(svc.port, taken);
      taken.add(port);
      if (port !== svc.port) {
        this.log.warn(`Port ${svc.port} kullanımda olduğu için ${svc.name} ${port} portuna yönlendirildi ve bağlantı string'i güncellendi`);
      }
      moves[svc.name] = { from: svc.port, to: port };

      const ctx = this.engineContext(svc, port);
      const marker = path.join(ctx.svcDir, INIT_MARKER);
      const needsInit = !fs.existsSync(marker);
      if (needsInit) {
        if (fs.existsSync(ctx.svcDir)) {
          this.log.warn(`${svc.name}: yarım kalmış kurulum bulundu, veri klasörü temizlenip kurulum baştan yapılıyor`);
          fs.rmSync(ctx.svcDir, { recursive: true, force: true });
        }
        fs.mkdirSync(ctx.svcDir, { recursive: true });
        this.log.info(`${svc.name}: ilk kurulum (${svc.type} ${svc.version})`);
        await engine.init(ctx);
      }

      this.log.info(`${svc.name}: başlatılıyor (${svc.type} ${svc.version}, port ${port})`);
      const handle = await engine.start(ctx);
      this.track(svc.name, handle, () => engine.stop(ctx, handle), ctx.logFile, true);

      this.setState(`HEALTH_CHECK ${svc.name}`);
      await healthCheck(engine, ctx, handle, DB_HEALTH_TIMEOUT_MS).catch(err => {
        throw new Error(`${err.message}\n    Ayrıntılar: ${ctx.logFile}`);
      });

      if (needsInit) {
        await engine.postInit(ctx);
        fs.writeFileSync(marker, new Date().toISOString());
        this.log.info(`${svc.name}: ilk kurulum tamamlandı`);
      }
      this.log.info(`${svc.name}: hazır`);
    }
    return moves;
  }

  async startNodeProcess(role, spec, moves, extraEnv = {}) {
    const userEnv = readUserEnv(this.p.installDir);
    const { env: rewritten, notes } = rewriteEnvPorts({ ...spec.env, ...userEnv }, this.cfg.envRefs[role] || [], moves);
    notes.forEach(n => (n.startsWith('UYARI') ? this.log.warn(n) : this.log.info(`Bağlantı güncellendi: ${n}`)));

    let port = spec.port;
    if (!(await isPortFree(port))) {
      port = await findFreePort(spec.port + 1);
      this.log.warn(`Port ${spec.port} kullanımda olduğu için ${role} ${port} portunda başlatılıyor (PORT ortam değişkeni ile)`);
    }

    const appEnv = { ...rewritten, ...extraEnv, PORT: String(port) };
    if (spec.nodePath) appEnv.NODE_PATH = path.join(this.p.installDir, spec.nodePath);
    if (spec.sqlite && !appEnv.SQLITE_DB_PATH) {
      const sqliteDir = path.join(this.p.dataDir, 'sqlite');
      fs.mkdirSync(sqliteDir, { recursive: true });
      appEnv.SQLITE_DB_PATH = sqliteDir;
    }
    writeDotenv(path.join(this.p.runtimeDir, `${role}.env`), appEnv);

    const logFile = path.join(this.p.logsDir, `${role}.log`);
    const exe = path.join(this.p.installDir, spec.exe);
    this.log.info(`${role}: başlatılıyor (${spec.exe}, port ${port})`);
    const child = spawnLogged(exe, spec.args || [], {
      cwd: path.join(this.p.installDir, spec.cwd || '.'),
      env: { ...process.env, ...appEnv },
      logFile
    });
    let exited = false;
    child.once('exit', () => { exited = true; });
    const handle = { pid: child.pid, child, isAlive: () => !exited };
    this.track(role, handle, async () => {
      if (!handle.isAlive()) return;
      await killTree(child.pid);
    }, logFile, false);

    this.setState(`HEALTH_CHECK ${role}`);
    await waitFor(async () => (await httpProbe(port, spec.healthPath || '/')) > 0, {
      timeoutMs: APP_HEALTH_TIMEOUT_MS,
      alive: handle.isAlive,
      what: `${role} HTTP sağlık kontrolü (port ${port})`
    }).catch(err => {
      throw new Error(`${err.message}\n    Ayrıntılar: ${logFile}`);
    });
    this.log.info(`${role}: hazır`);
    return port;
  }

  /** Süreci izler; beklenmedik çıkışta otomatik restart denenmez, her şey kapatılır. */
  track(name, handle, stop, logFile, isDb) {
    const entry = { name, handle, stop, logFile };
    this.running.push(entry);
    const onDeath = () => {
      if (this.shuttingDown) return;
      const what = isDb ? 'DB süreci' : 'Uygulama süreci';
      this.log.error(`${what} "${name}" beklenmedik şekilde kapandı. Otomatik yeniden başlatma yapılmaz (veri bütünlüğü). Ayrıntılar: ${logFile}`);
      this.log.error('Launcher\'ı yeniden başlatın. Sorun sürerse ilgili log dosyasını inceleyin.');
      entry.dead = true;
      this.failure = `${what} "${name}" beklenmedik şekilde kapandı.
Otomatik yeniden başlatma yapılmaz; uygulamayı yeniden başlatın.

Ayrıntılar: ${logFile}`;
      this.shutdown(1);
    };
    if (handle.child) {
      handle.child.once('exit', onDeath);
    } else {
      const timer = setInterval(() => {
        if (!handle.isAlive()) {
          clearInterval(timer);
          onDeath();
        }
      }, 2000);
      entry.timer = timer;
    }
  }

  async startControlServer() {
    // Tek örnek kontrolü: pipe'a bağlanılabiliyorsa başka bir launcher çalışıyor.
    try {
      const url = await sendControl(this.p.pipe, 'url', 3000);
      const err = new Error(`${this.cfg.appName} zaten çalışıyor${url ? `: ${url}` : ''}`);
      err.alreadyRunning = url || true;
      throw err;
    } catch (err) {
      if (err.alreadyRunning) throw err;
    }
    this.server = net.createServer(socket => {
      socket.on('data', async d => {
        const cmd = String(d).trim();
        if (cmd === 'url') {
          socket.end(this.url || '');
        } else if (cmd === 'stop') {
          this.log.info('Durdurma isteği alındı');
          await this.shutdown(0, { exit: false });
          socket.end('stopped');
          setTimeout(() => process.exit(0), 200);
        } else {
          socket.end('unknown');
        }
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.p.pipe, resolve);
    });
  }

  async shutdown(code, { exit = true } = {}) {
    if (this.shuttingDown) return this.shutdownPromise;
    this.shuttingDown = true;
    this.setState('SHUTTING_DOWN');
    this.shutdownPromise = (async () => {
      for (const entry of [...this.running].reverse()) {
        if (entry.timer) clearInterval(entry.timer);
        if (entry.dead || !entry.handle.isAlive()) continue;
        this.log.info(`${entry.name}: durduruluyor`);
        try {
          await entry.stop();
        } catch (err) {
          this.log.error(`${entry.name}: durdurulamadı: ${err.message}; süreç sonlandırılıyor`);
          await killTree(entry.handle.pid);
        }
      }
      this.log.info('Tüm servisler durduruldu');
      if (this.server) this.server.close();
      if (exit) {
        if (code !== 0 && this.failure) {
          showMessage(path.join(this.p.installDir, 'native'), `${this.failure}

Log klasörü: ${this.p.logsDir}`, `${this.cfg.appName} — hata`);
        }
        this.log.close();
        process.exit(code);
      }
    })();
    return this.shutdownPromise;
  }
}

/** Build sırasında çağrılır: paketlenen exe + koffi.node ile Job Object kurulabiliyor mu? */
function selfTest() {
  try {
    attachKillOnCloseJob(path.join(path.dirname(process.execPath), 'native'));
    console.log(`selftest ok (node ${process.version})`);
    process.exit(0);
  } catch (err) {
    console.error(`selftest başarısız: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  if (process.argv.includes('--selftest')) selfTest();
  const paths = resolvePaths();

  if (process.argv.includes('--stop')) {
    try {
      const reply = await sendControl(paths.pipe, 'stop');
      console.log(reply === 'stopped' ? `${paths.config.appName} durduruldu.` : `Beklenmeyen yanıt: ${reply}`);
      process.exit(reply === 'stopped' ? 0 : 1);
    } catch {
      console.log(`${paths.config.appName} çalışmıyor (kontrol kanalına bağlanılamadı).`);
      process.exit(2);
    }
  }

  const launcher = new Launcher(paths);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(sig, () => {
      launcher.log.info(`${sig} alındı`);
      launcher.shutdown(0);
    });
  }

  try {
    await launcher.run();
  } catch (err) {
    if (err.alreadyRunning) {
      launcher.log.info(err.message);
      if (typeof err.alreadyRunning === 'string') {
        if (process.env.D2E_NO_BROWSER !== '1') openBrowser(err.alreadyRunning);
      } else {
        showMessage(path.join(paths.installDir, 'native'), `${paths.config.appName} başlatılıyor, lütfen bekleyin.
Hazır olduğunda tarayıcı otomatik açılacak.`, paths.config.appName, 'info');
      }
      launcher.log.close();
      process.exit(0);
    }
    const failedAt = launcher.state;
    launcher.setState('FAILED');
    launcher.log.error(err.message);
    launcher.log.error(`Başlatma durduruldu (aşama: ${failedAt}). Log klasörü: ${paths.logsDir}`);
    launcher.failure = `Başlatma durduruldu (aşama: ${failedAt}).

${err.message}`;
    await launcher.shutdown(1);
  }
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

