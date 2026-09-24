const test = require('node:test');
const assert = require('node:assert/strict');
const { remapEnvironment, maskSecrets } = require('../src/parser/hostRemap');

const hosts = ['db', 'cache', 'mongo', 'Search'];

test('URL içindeki servis adı 127.0.0.1 olur, port ve path korunur', () => {
  const { env, changes } = remapEnvironment({ DATABASE_URL: 'postgres://u:p@db:5432/app?ssl=false' }, hosts);
  assert.equal(env.DATABASE_URL, 'postgres://u:p@127.0.0.1:5432/app?ssl=false');
  assert.equal(changes.length, 1);
});

test('şifrede @ olsa bile host doğru bulunur', () => {
  const { env } = remapEnvironment({ DATABASE_URL: 'postgres://u:p@ss@db/app' }, hosts);
  assert.equal(env.DATABASE_URL, 'postgres://u:p@ss@127.0.0.1/app');
});

test('şifrede encode edilmemiş # ve ? olsa bile host doğru bulunur', () => {
  const { env } = remapEnvironment({ DATABASE_URL: 'postgres://u:a#b?c@db:5432/app?x=1' }, hosts);
  assert.equal(env.DATABASE_URL, 'postgres://u:a#b?c@127.0.0.1:5432/app?x=1');
  assert.equal(maskSecrets(env.DATABASE_URL), 'postgres://u:****@127.0.0.1:5432/app?x=1');
});

test('anahtar adından bağımsız olarak URL değerleri taranır', () => {
  const { env } = remapEnvironment({ CACHE: 'redis://cache:6379' }, hosts);
  assert.equal(env.CACHE, 'redis://127.0.0.1:6379');
});

test('host anahtarlarında düz değerler yeniden yazılır', () => {
  const { env } = remapEnvironment(
    { REDIS_HOST: 'cache', PGHOST: 'db', DB_ADDR: 'db:5432', SEARCH_HOSTNAME: 'search' },
    hosts
  );
  assert.deepEqual(env, { REDIS_HOST: '127.0.0.1', PGHOST: '127.0.0.1', DB_ADDR: '127.0.0.1:5432', SEARCH_HOSTNAME: '127.0.0.1' });
});

test('host anahtarı olmayan düz değerlere dokunulmaz', () => {
  const { env, changes } = remapEnvironment({ POSTGRES_DB: 'db', APP_NAME: 'cache' }, hosts);
  assert.deepEqual(env, { POSTGRES_DB: 'db', APP_NAME: 'cache' });
  assert.equal(changes.length, 0);
});

test('servis adı olmayan hostlar ve kısmi eşleşmeler korunur', () => {
  const { env } = remapEnvironment(
    { API_URL: 'https://api.example.com', DB_HOST: 'db.internal', OTHER_URL: 'http://dbx:80' },
    hosts
  );
  assert.deepEqual(env, { API_URL: 'https://api.example.com', DB_HOST: 'db.internal', OTHER_URL: 'http://dbx:80' });
});

test('değişiklik kaydı hedef servisi ve portu içerir (alias → servis eşlemesi)', () => {
  const hostMap = new Map([['db', 'db'], ['pg-alias', 'db'], ['cache', 'cache']]);
  const { changes } = remapEnvironment({ DATABASE_URL: 'postgres://pg-alias/app', REDIS_HOST: 'cache:6380' }, hostMap);
  assert.deepEqual(changes.map(c => [c.key, c.kind, c.targets]), [
    ['DATABASE_URL', 'url', [{ service: 'db', port: null }]],
    ['REDIS_HOST', 'host', [{ service: 'cache', port: 6380 }]]
  ]);
});

test('çoklu host (replica set) listesi', () => {
  const { env } = remapEnvironment({ MONGO_URI: 'mongodb://u:p@mongo:27017,other:27018/app?replicaSet=rs0' }, hosts);
  assert.equal(env.MONGO_URI, 'mongodb://u:p@127.0.0.1:27017,other:27018/app?replicaSet=rs0');
});

test('mongodb+srv yeniden yazılmaz, uyarı üretilir', () => {
  const { env, changes, warnings } = remapEnvironment({ MONGO_URI: 'mongodb+srv://mongo/app' }, hosts);
  assert.equal(env.MONGO_URI, 'mongodb+srv://mongo/app');
  assert.equal(changes.length, 0);
  assert.equal(warnings.length, 1);
});

test('maskSecrets şifreyi gizler', () => {
  assert.equal(maskSecrets('postgres://u:p@ss@127.0.0.1/app'), 'postgres://u:****@127.0.0.1/app');
  assert.equal(maskSecrets('redis://127.0.0.1:6379'), 'redis://127.0.0.1:6379');
  assert.equal(maskSecrets('düz metin'), 'düz metin');
});
