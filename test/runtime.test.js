const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteEnvPorts, companionPortKey } = require('../runtime/lib/envRewrite');
const { encodeBson, decodeBson } = require('../runtime/lib/wire');
const { orderServices, logNameFor } = require('../runtime/lib/order');
const { sqlString, sqlIdent } = require('../runtime/lib/engines');

// --- dinamik port sonrası env yeniden yazımı ---

test('URL içindeki port güncellenir, taşınmayan servis dokunulmaz', () => {
  const env = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/app', REDIS_URL: 'redis://127.0.0.1:6379' };
  const refs = [
    { key: 'DATABASE_URL', kind: 'url', targets: [{ service: 'db', port: 5432 }] },
    { key: 'REDIS_URL', kind: 'url', targets: [{ service: 'cache', port: 6379 }] }
  ];
  const { env: out, notes } = rewriteEnvPorts(env, refs, { db: { from: 5432, to: 5433 }, cache: { from: 6379, to: 6379 } });
  assert.equal(out.DATABASE_URL, 'postgres://u:p@127.0.0.1:5433/app');
  assert.equal(out.REDIS_URL, 'redis://127.0.0.1:6379');
  assert.equal(notes.length, 1);
});

test('portsuz URL\'ye yeni port eklenir', () => {
  const { env } = rewriteEnvPorts(
    { MONGO_URL: 'mongodb://127.0.0.1/app' },
    [{ key: 'MONGO_URL', kind: 'url', targets: [{ service: 'm', port: null }] }],
    { m: { from: 27017, to: 27018 } }
  );
  assert.equal(env.MONGO_URL, 'mongodb://127.0.0.1:27018/app');
});

test('host değişkeninde eşlik eden port değişkeni güncellenir', () => {
  const { env, notes } = rewriteEnvPorts(
    { DB_HOST: '127.0.0.1', DB_PORT: '5432', PGHOST: '127.0.0.1' },
    [
      { key: 'DB_HOST', kind: 'host', targets: [{ service: 'db', port: null }] },
      { key: 'PGHOST', kind: 'host', targets: [{ service: 'db', port: null }] }
    ],
    { db: { from: 5432, to: 5440 } }
  );
  assert.equal(env.DB_PORT, '5440');
  assert.ok(notes.some(n => n.startsWith('UYARI') && n.includes('PGPORT')));
});

test('host:port biçimli değer', () => {
  const { env } = rewriteEnvPorts(
    { REDIS_ADDR: '127.0.0.1:6379' },
    [{ key: 'REDIS_ADDR', kind: 'host', targets: [{ service: 'cache', port: 6379 }] }],
    { cache: { from: 6379, to: 6380 } }
  );
  assert.equal(env.REDIS_ADDR, '127.0.0.1:6380');
});

test('companionPortKey', () => {
  assert.equal(companionPortKey('DB_HOST'), 'DB_PORT');
  assert.equal(companionPortKey('PGHOST'), 'PGPORT');
  assert.equal(companionPortKey('REDIS_HOSTNAME'), 'REDIS_PORT');
  assert.equal(companionPortKey('DATABASE_URL'), null);
});

// --- BSON ---

test('BSON encode/decode gidiş-dönüş', () => {
  const doc = { a: 1, b: 2.5, s: 'çğü', t: true, n: null, arr: [1, 'x', { k: 'v' }], bin: Buffer.from('abc'), big: 2 ** 40 };
  const back = decodeBson(encodeBson(doc));
  assert.deepEqual({ ...back, bin: back.bin.toString() }, { ...doc, bin: 'abc' });
});

// --- servis sırası ---

test('orderServices depends_on sırasına uyar ve döngüyü yakalar', () => {
  const s = (name, dependsOn = []) => ({ name, dependsOn, type: 'postgres' });
  assert.deepEqual(orderServices([s('a', ['b']), s('b'), s('c', ['a', 'api'])]).map(x => x.name), ['b', 'a', 'c']);
  assert.throws(() => orderServices([s('a', ['b']), s('b', ['a'])]), /döngüsel/);
});

test('logNameFor: aynı tipten birden fazla servis varsa servis adı eklenir', () => {
  const services = [{ name: 'main', type: 'postgres' }, { name: 'audit', type: 'postgres' }, { name: 'c', type: 'redis' }];
  assert.equal(logNameFor(services[0], services), 'postgres-main.log');
  assert.equal(logNameFor(services[2], services), 'redis.log');
});

test('SQL kaçışları', () => {
  assert.equal(sqlString("a'b\\c"), "'a\\'b\\\\c'");
  assert.equal(sqlIdent('my`db'), '`my``db`');
});
