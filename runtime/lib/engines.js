/**
 * DB motorları. Her motor:
 *   init(ctx)      — boş veri klasörünü hazırlar (initdb, --initialize ...); sunucu henüz çalışmıyor
 *   start(ctx)     — sunucuyu başlatır; { isAlive(), pid } döner
 *   health(ctx)    — sunucu gerçekten yanıt veriyor mu (sadece port açık olması yetmez)
 *   postInit(ctx)  — ilk kurulumda, sunucu çalışırken: kullanıcı/DB oluşturma, init script'leri
 *   stop(ctx, h)   — graceful kapatma; zaman aşımında süreç ağacı öldürülür
 *
 * ctx: { svc, binDir, dataDir, port, logFile, log, tmpDir, initDir }
 * svc.env: compose'daki DB servis ortamı (POSTGRES_PASSWORD, MYSQL_DATABASE ...)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnLogged, runTool, killTree, isPidAlive, waitFor, sleep } = require('./proc');
const { mongoCommand, MongoConnection, redisCommand, mysqlHandshake } = require('./wire');

const STOP_TIMEOUT_MS = 30000;

function exe(ctx, ...parts) {
  return path.join(ctx.binDir, ...parts);
}

function childHandle(child) {
  let exited = false;
  child.once('exit', () => { exited = true; });
  return { pid: child.pid, child, isAlive: () => !exited };
}

async function waitExit(handle, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!handle.isAlive()) return true;
    await sleep(300);
  }
  return !handle.isAlive();
}

async function stopOrKill(ctx, handle, graceful) {
  try {
    await graceful();
  } catch (err) {
    ctx.log.warn(`${ctx.svc.name}: graceful kapatma komutu başarısız: ${err.message}`);
  }
  if (await waitExit(handle, STOP_TIMEOUT_MS)) return;
  ctx.log.warn(`${ctx.svc.name}: ${STOP_TIMEOUT_MS / 1000} sn içinde kapanmadı, süreç sonlandırılıyor`);
  await killTree(handle.pid);
}

function initScripts(ctx) {
  if (!ctx.initDir || !fs.existsSync(ctx.initDir)) return [];
  return fs.readdirSync(ctx.initDir).filter(f => f.toLowerCase().endsWith('.sql')).sort().map(f => path.join(ctx.initDir, f));
}

function assertOk(result, what) {
  if (result.code !== 0) {
    const tail = result.output.trim().split(/\r?\n/).slice(-15).join('\n    ');
    throw new Error(`${what} başarısız (çıkış kodu ${result.code}):\n    ${tail}`);
  }
}

// ---------------------------------------------------------------- PostgreSQL

const postgres = {
  tools: ctx => ({
    initdb: exe(ctx, 'bin', 'initdb.exe'),
    pgCtl: exe(ctx, 'bin', 'pg_ctl.exe'),
    isReady: exe(ctx, 'bin', 'pg_isready.exe'),
    createdb: exe(ctx, 'bin', 'createdb.exe'),
    psql: exe(ctx, 'bin', 'psql.exe')
  }),

  credentials(ctx) {
    const env = ctx.svc.env;
    const user = env.POSTGRES_USER || 'postgres';
    return { user, password: env.POSTGRES_PASSWORD || '', db: env.POSTGRES_DB || user };
  },

  clientEnv(ctx) {
    const { password } = postgres.credentials(ctx);
    return { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '5' };
  },

  async init(ctx) {
    const t = postgres.tools(ctx);
    const env = ctx.svc.env;
    const { user, password } = postgres.credentials(ctx);
    const auth = env.POSTGRES_HOST_AUTH_METHOD || (password ? 'scram-sha-256' : null);
    if (!auth) {
      throw new Error('POSTGRES_PASSWORD tanımlı değil (Docker imajı da bu durumda başlamaz). Compose ortamına POSTGRES_PASSWORD veya POSTGRES_HOST_AUTH_METHOD=trust ekleyin');
    }
    const args = ['-D', ctx.dataDir, '-U', user, '-E', 'UTF8', '--no-locale', '-A', auth];
    let pwfile = null;
    if (password) {
      pwfile = path.join(ctx.tmpDir, `pw-${crypto.randomBytes(6).toString('hex')}`);
      fs.writeFileSync(pwfile, password, { mode: 0o600 });
      args.push('--pwfile', pwfile);
    }
    if (env.POSTGRES_INITDB_ARGS) args.push(...env.POSTGRES_INITDB_ARGS.split(/\s+/).filter(Boolean));
    try {
      assertOk(await runTool(t.initdb, args, { logFile: ctx.toolLog, timeoutMs: 180000 }), 'initdb');
    } finally {
      if (pwfile) fs.rmSync(pwfile, { force: true });
    }
  },

  // pg_ctl kullanılır: Yönetici olarak çalışılsa bile pg_ctl postgres'i kısıtlı token ile başlatır.
  async start(ctx) {
    const t = postgres.tools(ctx);
    const res = await runTool(t.pgCtl, [
      'start', '-D', ctx.dataDir, '-l', ctx.logFile, '-w', '-t', '60',
      '-o', `-p ${ctx.port} -c listen_addresses=127.0.0.1`
    ], { timeoutMs: 90000 });
    if (res.code !== 0) {
      const hint = ctx.elevated
        ? 'PostgreSQL güvenlik kısıtı nedeniyle uygulama Yönetici haklarıyla çalıştırılamaz, lütfen standart kullanıcı olarak başlatın.'
        : `Ayrıntılar: ${ctx.logFile}`;
      throw new Error(`pg_ctl start başarısız (çıkış kodu ${res.code}): ${res.output.trim()}\n    ${hint}`);
    }
    const pidFile = path.join(ctx.dataDir, 'postmaster.pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').split(/\r?\n/)[0]);
    return { pid, isAlive: () => isPidAlive(pid) };
  },

  async health(ctx) {
    const t = postgres.tools(ctx);
    const res = await runTool(t.isReady, ['-h', '127.0.0.1', '-p', String(ctx.port), '-t', '2'], { timeoutMs: 10000 });
    return res.code === 0;
  },

  async postInit(ctx) {
    const t = postgres.tools(ctx);
    const { user, db } = postgres.credentials(ctx);
    const conn = ['-h', '127.0.0.1', '-p', String(ctx.port), '-U', user];
    const env = postgres.clientEnv(ctx);
    if (db !== 'postgres') {
      assertOk(await runTool(t.createdb, [...conn, db], { env, logFile: ctx.toolLog }), `createdb ${db}`);
    }
    for (const file of initScripts(ctx)) {
      ctx.log.info(`${ctx.svc.name}: init script çalıştırılıyor: ${path.basename(file)}`);
      assertOk(await runTool(t.psql, [...conn, '-d', db, '-v', 'ON_ERROR_STOP=1', '-f', file], { env, logFile: ctx.toolLog, timeoutMs: 600000 }), `psql ${path.basename(file)}`);
    }
  },

  async stop(ctx, handle) {
    const t = postgres.tools(ctx);
    await stopOrKill(ctx, handle, async () => {
      const res = await runTool(t.pgCtl, ['stop', '-D', ctx.dataDir, '-m', 'fast', '-w', '-t', '30'], { timeoutMs: 45000 });
      if (res.code !== 0) throw new Error(res.output.trim());
    });
  }
};

// ---------------------------------------------------------------- Redis

const redis = {
  userArgs(ctx) {
    let cmd = ctx.svc.command;
    if (!cmd) return [];
    if (typeof cmd === 'string') cmd = cmd.split(/\s+/).filter(Boolean);
    if (cmd[0] && /redis-server$/.test(cmd[0])) cmd = cmd.slice(1);
    // Konteyner içi config dosyası yolları Windows'ta yok; sadece --opsiyon değer biçimleri aktarılır.
    return cmd[0] && !cmd[0].startsWith('--') ? cmd.slice(1) : cmd;
  },

  password(ctx) {
    const args = redis.userArgs(ctx);
    const i = args.indexOf('--requirepass');
    return i !== -1 ? args[i + 1] : null;
  },

  async init(ctx) {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
  },

  async start(ctx) {
    // Sonradan verilen argümanlar önceliklidir: port/bind/dir her zaman launcher'ın değerleri olur.
    const args = [...redis.userArgs(ctx), '--port', String(ctx.port), '--bind', '127.0.0.1', '--dir', ctx.dataDir, '--daemonize', 'no'];
    const child = spawnLogged(exe(ctx, 'redis-server.exe'), args, { cwd: ctx.dataDir, logFile: ctx.logFile, env: process.env });
    return childHandle(child);
  },

  async health(ctx) {
    const reply = await redisCommand(ctx.port, 'PING');
    return reply === '+PONG' || reply.startsWith('-NOAUTH') || reply.startsWith('-ERR AUTH');
  },

  async postInit() {},

  async stop(ctx, handle) {
    await stopOrKill(ctx, handle, async () => {
      const pass = redis.password(ctx);
      const env = { ...process.env };
      if (pass) env.REDISCLI_AUTH = pass;
      await runTool(exe(ctx, 'redis-cli.exe'), ['-h', '127.0.0.1', '-p', String(ctx.port), 'shutdown'], { env, timeoutMs: 20000 });
    });
  }
};

// ---------------------------------------------------------------- MongoDB

const mongo = {
  rootUser(ctx) {
    const env = ctx.svc.env;
    return env.MONGO_INITDB_ROOT_USERNAME ? { user: env.MONGO_INITDB_ROOT_USERNAME, password: env.MONGO_INITDB_ROOT_PASSWORD || '' } : null;
  },

  async init(ctx) {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
  },

  async start(ctx) {
    const args = ['--dbpath', ctx.dataDir, '--port', String(ctx.port), '--bind_ip', '127.0.0.1'];
    if (mongo.rootUser(ctx)) args.push('--auth');
    return childHandle(spawnLogged(exe(ctx, 'bin', 'mongod.exe'), args, { cwd: ctx.dataDir, logFile: ctx.logFile, env: process.env }));
  },

  async health(ctx) {
    const res = await mongoCommand(ctx.port, { ping: 1, $db: 'admin' });
    return res.ok === 1;
  },

  // --auth açıkken henüz kullanıcı yoksa localhost exception ile ilk kullanıcı oluşturulabilir.
  async postInit(ctx) {
    const root = mongo.rootUser(ctx);
    if (!root) return;
    const res = await mongoCommand(ctx.port, {
      createUser: root.user,
      pwd: root.password,
      roles: [{ role: 'root', db: 'admin' }],
      $db: 'admin'
    }, 10000);
    if (res.ok !== 1) throw new Error(`MongoDB root kullanıcısı oluşturulamadı: ${res.errmsg || JSON.stringify(res)}`);
    if (initScripts(ctx).length || (ctx.initDir && fs.existsSync(ctx.initDir))) {
      ctx.log.warn(`${ctx.svc.name}: MongoDB init script'leri (mongosh gerektirir) çalıştırılmadı`);
    }
  },

  async stop(ctx, handle) {
    await stopOrKill(ctx, handle, async () => {
      const conn = await MongoConnection.open(ctx.port);
      try {
        const root = mongo.rootUser(ctx);
        if (root) await conn.authenticate(root.user, root.password);
        const res = await conn.command({ shutdown: 1, $db: 'admin' });
        if (res.ok !== 1) throw new Error(res.errmsg || 'shutdown reddedildi');
      } catch (err) {
        // Başarılı shutdown'da sunucu bağlantıyı kapatır/sıfırlar.
        if (err.message !== 'bağlantı kapandı' && err.code !== 'ECONNRESET') throw err;
      } finally {
        conn.close();
      }
    });
  }
};

// ---------------------------------------------------------------- MySQL / MariaDB

function sqlString(v) {
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
function sqlIdent(v) {
  return `\`${String(v).replace(/`/g, '``')}\``;
}

function mysqlFamily(variant) {
  const pick = (env, ...keys) => {
    for (const k of keys) if (env[k] !== undefined && env[k] !== '') return env[k];
    return undefined;
  };

  const self = {
    serverExe(ctx) {
      if (variant === 'mariadb' && fs.existsSync(exe(ctx, 'bin', 'mariadbd.exe'))) return exe(ctx, 'bin', 'mariadbd.exe');
      return exe(ctx, 'bin', 'mysqld.exe');
    },
    clientExe(ctx) {
      if (variant === 'mariadb' && fs.existsSync(exe(ctx, 'bin', 'mariadb.exe'))) return exe(ctx, 'bin', 'mariadb.exe');
      return exe(ctx, 'bin', 'mysql.exe');
    },
    adminExe(ctx) {
      if (variant === 'mariadb' && fs.existsSync(exe(ctx, 'bin', 'mariadb-admin.exe'))) return exe(ctx, 'bin', 'mariadb-admin.exe');
      return exe(ctx, 'bin', 'mysqladmin.exe');
    },

    settings(ctx) {
      const env = ctx.svc.env;
      const m = variant === 'mariadb' ? ['MARIADB_', 'MYSQL_'] : ['MYSQL_'];
      const get = suffix => pick(env, ...m.map(p => p + suffix));
      let rootPassword = get('ROOT_PASSWORD');
      const allowEmpty = get('ALLOW_EMPTY_PASSWORD') || pick(env, 'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD');
      const random = get('RANDOM_ROOT_PASSWORD');
      return {
        rootPassword,
        allowEmpty: Boolean(allowEmpty),
        random: Boolean(random),
        database: get('DATABASE'),
        user: get('USER'),
        password: get('PASSWORD')
      };
    },

    /** Şifreyi komut satırında göstermemek için geçici [client] option dosyası. Döner: yol */
    clientOptions(ctx, password) {
      const file = path.join(ctx.tmpDir, `my-${crypto.randomBytes(6).toString('hex')}.cnf`);
      const lines = ['[client]', 'user=root', 'host=127.0.0.1', `port=${ctx.port}`, 'protocol=TCP'];
      if (password) lines.push(`password="${password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      fs.writeFileSync(file, lines.join('\r\n') + '\r\n', { mode: 0o600 });
      return file;
    },

    async withClient(ctx, password, fn) {
      const opt = self.clientOptions(ctx, password);
      try {
        return await fn(`--defaults-extra-file=${opt}`);
      } finally {
        fs.rmSync(opt, { force: true });
      }
    },

    async init(ctx) {
      const s = self.settings(ctx);
      if (!s.rootPassword && !s.allowEmpty && !s.random) {
        throw new Error(`${variant === 'mariadb' ? 'MARIADB_ROOT_PASSWORD/' : ''}MYSQL_ROOT_PASSWORD tanımlı değil (Docker imajı da bu durumda başlamaz)`);
      }
      if (variant === 'mysql') {
        fs.mkdirSync(path.dirname(ctx.dataDir), { recursive: true });
        assertOk(await runTool(self.serverExe(ctx), [
          '--no-defaults', '--initialize-insecure', `--basedir=${ctx.binDir}`, `--datadir=${ctx.dataDir}`, '--console'
        ], { logFile: ctx.toolLog, timeoutMs: 300000 }), 'mysqld --initialize-insecure');
      } else {
        const installer = fs.existsSync(exe(ctx, 'bin', 'mariadb-install-db.exe'))
          ? exe(ctx, 'bin', 'mariadb-install-db.exe')
          : exe(ctx, 'bin', 'mysql_install_db.exe');
        assertOk(await runTool(installer, [`--datadir=${ctx.dataDir}`, `--port=${ctx.port}`], { logFile: ctx.toolLog, timeoutMs: 300000 }), path.basename(installer));
      }
    },

    async start(ctx) {
      const args = [];
      const ini = path.join(ctx.dataDir, 'my.ini');
      if (variant === 'mariadb' && fs.existsSync(ini)) args.push(`--defaults-file=${ini}`);
      else args.push('--no-defaults');
      args.push(`--basedir=${ctx.binDir}`, `--datadir=${ctx.dataDir}`, `--port=${ctx.port}`, '--bind-address=127.0.0.1', '--console');
      if (variant === 'mysql') args.push('--mysqlx=OFF');
      return childHandle(spawnLogged(self.serverExe(ctx), args, { cwd: ctx.dataDir, logFile: ctx.logFile, env: process.env }));
    },

    async health(ctx) {
      const hs = await mysqlHandshake(ctx.port);
      return Boolean(hs.protocol || hs.error);
    },

    async postInit(ctx) {
      const s = self.settings(ctx);
      let rootPassword = s.rootPassword || '';
      if (!rootPassword && s.random) {
        rootPassword = crypto.randomBytes(18).toString('base64url');
        ctx.log.warn(`${ctx.svc.name}: rastgele root şifresi üretildi: ${rootPassword}`);
      }
      const sql = [];
      sql.push(`CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY ${sqlString(rootPassword)};`);
      sql.push(`GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;`);
      sql.push(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${sqlString(rootPassword)};`);
      if (s.database) sql.push(`CREATE DATABASE IF NOT EXISTS ${sqlIdent(s.database)};`);
      if (s.user && s.user !== 'root') {
        sql.push(`CREATE USER IF NOT EXISTS ${sqlString(s.user)}@'%' IDENTIFIED BY ${sqlString(s.password || '')};`);
        if (s.database) sql.push(`GRANT ALL PRIVILEGES ON ${sqlIdent(s.database)}.* TO ${sqlString(s.user)}@'%';`);
      }
      sql.push('FLUSH PRIVILEGES;');

      // İlk bağlantı şifresiz root ile (initialize-insecure / install-db varsayılanı)
      await self.withClient(ctx, '', async opt => {
        assertOk(await runTool(self.clientExe(ctx), [opt], { input: sql.join('\n'), logFile: ctx.logFile }), 'kullanıcı/veritabanı oluşturma');
      });

      for (const file of initScripts(ctx)) {
        ctx.log.info(`${ctx.svc.name}: init script çalıştırılıyor: ${path.basename(file)}`);
        await self.withClient(ctx, rootPassword, async opt => {
          const args = [opt];
          if (s.database) args.push(s.database);
          assertOk(await runTool(self.clientExe(ctx), args, { input: fs.readFileSync(file), logFile: ctx.toolLog, timeoutMs: 600000 }), `init script ${path.basename(file)}`);
        });
      }
    },

    async stop(ctx, handle) {
      const s = self.settings(ctx);
      await stopOrKill(ctx, handle, () =>
        self.withClient(ctx, s.rootPassword || '', async opt => {
          const res = await runTool(self.adminExe(ctx), [opt, 'shutdown'], { timeoutMs: 30000 });
          if (res.code !== 0) throw new Error(res.output.trim());
        })
      );
    }
  };
  return self;
}

// ---------------------------------------------------------------- Memurai (harici)

/**
 * Hedef makinede Windows servisi olarak kurulu Memurai (Redis uyumlu). Lisansı yeniden dağıtıma izin
 * vermediği için pakete gömülmez; launcher başlatmaz/durdurmaz, sadece çalıştığını doğrular.
 */
const memurai = {
  external: true,
  async init() {},
  async start(ctx) {
    const res = await runTool('sc.exe', ['query', 'Memurai'], { timeoutMs: 10000 });
    if (/1060/.test(res.output) || res.code === 1060) {
      throw new Error("Memurai servisi bu makinede kurulu değil (--redis-engine memurai ile paketlendi). Memurai'yi kurun veya paketi --redis-engine redis-windows ile yeniden oluşturun");
    }
    if (!/RUNNING/.test(res.output)) {
      throw new Error('Memurai servisi kurulu ama çalışmıyor. Hizmetler (services.msc) üzerinden "Memurai" servisini başlatın');
    }
    return { pid: null, isAlive: () => true };
  },
  async health(ctx) {
    return redis.health(ctx);
  },
  async postInit() {},
  async stop() {}
};

const ENGINES = {
  postgres,
  redis,
  memurai,
  mongo,
  mysql: mysqlFamily('mysql'),
  mariadb: mysqlFamily('mariadb')
};

async function healthCheck(engine, ctx, handle, timeoutMs = 30000) {
  await waitFor(() => engine.health(ctx), {
    timeoutMs,
    alive: () => handle.isAlive(),
    what: `${ctx.svc.name} (${ctx.svc.type}) sağlık kontrolü`
  });
}

module.exports = { ENGINES, healthCheck, sqlString, sqlIdent };
