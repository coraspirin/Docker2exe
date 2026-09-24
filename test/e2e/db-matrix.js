#!/usr/bin/env node
/**
 * Manifest'teki DB versiyonlarını gerçek binary'lerle uçtan uca doğrular:
 *   indir (SHA256) → aç → init → start → sağlık → postInit (kullanıcı/DB) → kimlik bilgisiyle bağlan → graceful stop
 *
 * Kullanım:
 *   node test/e2e/db-matrix.js                 # tüm versiyonlar
 *   node test/e2e/db-matrix.js postgres:16 redis
 *   node test/e2e/db-matrix.js --mark          # başarılı olanları manifest'te tested=true yap
 *
 * npm test'e dahil değildir (indirme ve süre gerektirir).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadManifest, DEFAULT_MANIFEST_PATH } = require('../../src/compatibility/versionResolver');
const { ensureCached, extractZip } = require('../../src/builder/dbBundler');
const { ENGINES, healthCheck } = require('../../runtime/lib/engines');
const { MongoConnection } = require('../../runtime/lib/wire');
const { runTool, findFreePort } = require('../../runtime/lib/proc');

const CREDS = {
  postgres: { POSTGRES_USER: 'matrix', POSTGRES_PASSWORD: 'm@trix-pw#1', POSTGRES_DB: 'matrixdb' },
  redis: {},
  mongo: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'rootpw' },
  mysql: { MYSQL_ROOT_PASSWORD: 'rootpw', MYSQL_DATABASE: 'matrixdb', MYSQL_USER: 'matrix', MYSQL_PASSWORD: "m'pw" },
  mariadb: { MARIADB_ROOT_PASSWORD: 'rootpw', MARIADB_DATABASE: 'matrixdb', MARIADB_USER: 'matrix', MARIADB_PASSWORD: "m'pw" }
};

/** Oluşturulan kullanıcıyla gerçekten bağlanılabildiğini doğrular. */
async function verifyCredentials(type, ctx) {
  const bin = (...p) => path.join(ctx.binDir, ...p);
  if (type === 'postgres') {
    const r = await runTool(bin('bin', 'psql.exe'), ['-h', '127.0.0.1', '-p', String(ctx.port), '-U', 'matrix', '-d', 'matrixdb', '-tAc', 'select current_user'], {
      env: { ...process.env, PGPASSWORD: CREDS.postgres.POSTGRES_PASSWORD }
    });
    if (r.output.trim() !== 'matrix') throw new Error(`psql: ${r.output.trim()}`);
    return 'psql matrix@matrixdb';
  }
  if (type === 'redis') {
    const r = await runTool(bin('redis-cli.exe'), ['-h', '127.0.0.1', '-p', String(ctx.port), 'set', 'k', 'v'], { env: { ...process.env, REDISCLI_AUTH: 'redispw' } });
    if (!/OK/.test(r.output)) throw new Error(`redis-cli: ${r.output.trim()}`);
    const noAuth = await runTool(bin('redis-cli.exe'), ['-h', '127.0.0.1', '-p', String(ctx.port), 'get', 'k']);
    if (!/NOAUTH/.test(noAuth.output)) throw new Error('requirepass uygulanmadı');
    return 'redis-cli AUTH + requirepass';
  }
  if (type === 'mongo') {
    const conn = await MongoConnection.open(ctx.port);
    try {
      const denied = await conn.command({ listDatabases: 1, $db: 'admin' });
      if (denied.ok === 1) throw new Error('--auth uygulanmadı');
      await conn.authenticate('root', 'rootpw');
      const res = await conn.command({ listDatabases: 1, $db: 'admin' });
      if (res.ok !== 1) throw new Error(res.errmsg);
    } finally {
      conn.close();
    }
    return 'SCRAM-SHA-256 root';
  }
  // mysql / mariadb
  const client = type === 'mariadb' && fs.existsSync(bin('bin', 'mariadb.exe')) ? bin('bin', 'mariadb.exe') : bin('bin', 'mysql.exe');
  const opt = path.join(ctx.tmpDir, 'matrix.cnf');
  fs.writeFileSync(opt, `[client]\r\nuser=matrix\r\npassword="m'pw"\r\nhost=127.0.0.1\r\nport=${ctx.port}\r\nprotocol=TCP\r\n`);
  try {
    const r = await runTool(client, [`--defaults-extra-file=${opt}`, 'matrixdb', '-N', '-e', 'select current_user()']);
    if (!/matrix@/.test(r.output)) throw new Error(`${path.basename(client)}: ${r.output.trim()}`);
  } finally {
    fs.rmSync(opt, { force: true });
  }
  return `${path.basename(client)} matrix@%`;
}

async function runOne(manifest, type, series, workDir) {
  const def = manifest[type];
  const entry = def.versions[series];
  const log = { info: () => {}, warn: m => warnings.push(m), error: m => warnings.push(m) };
  const warnings = [];
  const zip = await ensureCached({ dbType: type, series, entry });
  const binDir = path.join(workDir, 'bin', `${type}-${series}`);
  await extractZip(zip, binDir, def.layout);

  const svcDir = path.join(workDir, 'data', `${type}-${series}`);
  fs.mkdirSync(svcDir, { recursive: true });
  const tmpDir = path.join(workDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const port = await findFreePort(def.default_port + 100);
  const svc = {
    name: `${type}-${series}`,
    type,
    env: CREDS[type],
    command: type === 'redis' ? 'redis-server --appendonly yes --requirepass redispw' : null
  };
  const ctx = {
    svc, port, binDir, tmpDir,
    dataDir: path.join(svcDir, 'db'),
    logFile: path.join(workDir, `${type}-${series}.log`),
    toolLog: path.join(workDir, `${type}-${series}-tools.log`),
    log, initDir: null, elevated: false
  };
  const engine = ENGINES[type];
  await engine.init(ctx);
  const handle = await engine.start(ctx);
  try {
    await healthCheck(engine, ctx, handle, 60000);
    await engine.postInit(ctx);
    const how = await verifyCredentials(type, ctx);
    return { how, handle, ctx, engine, warnings };
  } catch (err) {
    await engine.stop(ctx, handle).catch(() => {});
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mark = args.includes('--mark');
  const filters = args.filter(a => !a.startsWith('--'));
  const manifest = loadManifest();
  const targets = [];
  for (const [type, def] of Object.entries(manifest)) {
    if (type.startsWith('_')) continue;
    for (const series of [...def.supported_majors, ...def.experimental_majors]) {
      if (filters.length && !filters.some(f => f === type || f === `${type}:${series}`)) continue;
      targets.push([type, series]);
    }
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2e-matrix-'));
  const results = [];
  for (const [type, series] of targets) {
    const label = `${type} ${series} (${manifest[type].versions[series].version})`;
    const t0 = Date.now();
    process.stdout.write(`${label.padEnd(28)} `);
    try {
      const r = await runOne(manifest, type, series, workDir);
      await r.engine.stop(r.ctx, r.handle);
      const killed = r.warnings.filter(w => /sonlandırılıyor|başarısız/.test(w));
      if (killed.length) throw new Error(`graceful kapatma başarısız: ${killed.join('; ')}`);
      results.push({ type, series, ok: true });
      console.log(`✔ ${r.how}, graceful stop  (${((Date.now() - t0) / 1000).toFixed(0)} sn)`);
    } catch (err) {
      results.push({ type, series, ok: false });
      console.log(`✖ ${err.message.split('\n')[0]}`);
    }
  }
  fs.rmSync(workDir, { recursive: true, force: true });

  if (mark) {
    let text = fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8');
    for (const r of results.filter(x => x.ok)) {
      const version = manifest[r.type].versions[r.series].version.replace(/\./g, '\\.');
      text = text.replace(new RegExp(`("version": "${version}"[^}]*"tested": )false`), '$1true');
    }
    fs.writeFileSync(DEFAULT_MANIFEST_PATH, text);
    console.log('manifest güncellendi');
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} başarılı`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
