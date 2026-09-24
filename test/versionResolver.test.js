const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMajor, parseSeries, parseOverrides, resolveVersions, loadManifest } = require('../src/compatibility/versionResolver');

const sha = c => c.repeat(64);
const manifest = {
  postgres: {
    series_granularity: 'major',
    supported_majors: ['14', '15', '16'],
    eol_majors: ['12', '13'],
    experimental_majors: ['17'],
    aliases: {},
    versions: {
      15: { version: '15.19', url: 'https://x/pg15.zip', sha256: sha('a'), tested: true },
      16: { version: '16.15', url: 'https://x/pg16.zip', sha256: sha('b'), tested: false },
      17: { version: '17.11', url: 'https://x/pg17.zip', sha256: sha('c'), tested: false }
    }
  },
  redis: {
    series_granularity: 'major',
    supported_majors: ['7'],
    eol_majors: [],
    experimental_majors: [],
    aliases: {},
    versions: { 7: { url: '<url>', sha256: '<hash>', tested: true } }
  },
  mysql: {
    series_granularity: 'minor',
    supported_majors: ['8.4', '9.7'],
    eol_majors: ['8.0'],
    experimental_majors: [],
    aliases: { 8: '8.4' },
    versions: { 8.4: { version: '8.4.11', url: 'https://x/m.zip', sha256: sha('d'), tested: true } }
  }
};

const db = (name, dbType, image, tag) => ({ name, dbType, image, imageTag: tag });
const noOverrides = { byService: {}, byType: {} };

test('parseMajor / parseSeries', () => {
  assert.equal(parseMajor('15-alpine'), 15);
  assert.equal(parseMajor('7.2.4-bookworm'), 7);
  assert.equal(parseMajor('v16'), 16);
  assert.equal(parseMajor('16.2.0-debian-12-r5'), 16);
  assert.equal(parseMajor('latest'), null);
  assert.equal(parseMajor('alpine'), null);
  assert.equal(parseMajor(null), null);
  assert.deepEqual(parseSeries('8.4.2-oracle', 'minor'), { series: '8.4' });
  assert.deepEqual(parseSeries('8', 'minor'), { majorOnly: '8' });
  assert.deepEqual(parseSeries('8-oracle', 'minor'), { majorOnly: '8' });
  assert.deepEqual(parseSeries('16.4', 'major'), { series: '16' });
});

test('desteklenen ve test edilmiş versiyon', () => {
  const r = resolveVersions([db('db', 'postgres', 'postgres:15-alpine', '15-alpine')], manifest, noOverrides);
  assert.equal(r.ok, true);
  assert.equal(r.services[0].status, 'ok');
  assert.equal(r.services[0].series, '15');
});

test('minor granularity: seri, alias ve alias olmayan major', () => {
  const r = resolveVersions(
    [db('a', 'mysql', 'mysql:8.4.2', '8.4.2'), db('b', 'mysql', 'mysql:8', '8'), db('c', 'mysql', 'mysql:9', '9'), db('d', 'mysql', 'mysql:8.0', '8.0')],
    manifest,
    noOverrides
  );
  assert.deepEqual(r.services.map(s => s.series), ['8.4', '8.4', null, '8.0']);
  assert.match(r.infos[0], /\[b\].*8\.4 serisi/);
  assert.match(r.errors[0], /\[c\].*sadece major.*8→8\.4/);
  assert.match(r.errors[1], /\[d\].*EOL/);
});

test('latest/tag yok → hata ve override önerisi', () => {
  const r = resolveVersions(
    [db('db', 'postgres', 'postgres:latest', 'latest'), db('db2', 'postgres', 'postgres', null)],
    manifest,
    noOverrides
  );
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /--db-version db=<versiyon> veya --pg-version/);
});

test('override: servis bazlı tip bazlıdan önceliklidir, minor tipte alias uygulanır', () => {
  const r = resolveVersions(
    [db('a', 'postgres', 'postgres', null), db('b', 'postgres', 'postgres:latest', 'latest'), db('m', 'mysql', 'mysql:latest', 'latest')],
    manifest,
    { byService: { a: '16' }, byType: { postgres: '15', mysql: '8' } }
  );
  assert.deepEqual(r.services.map(s => [s.series, s.seriesSource]), [['16', 'cli'], ['15', 'cli'], ['8.4', 'cli']]);
});

test('override tag ile çelişirse hata', () => {
  const r = resolveVersions([db('db', 'postgres', 'postgres:15', '15')], manifest, { byService: { db: '16' }, byType: {} });
  assert.match(r.errors[0], /çelişki/);
});

test('EOL, desteklenmeyen, binary tanımı olmayan ve yer tutucu girdiler toplu raporlanır', () => {
  const r = resolveVersions(
    [
      db('old', 'postgres', 'postgres:12', '12'),
      db('future', 'postgres', 'postgres:99', '99'),
      db('nobin', 'postgres', 'postgres:14', '14'),
      db('cache', 'redis', 'redis:7', '7'),
      db('m', 'mongo', 'mongo:7', '7')
    ],
    manifest,
    noOverrides
  );
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 5);
  assert.match(r.errors[0], /\[old\].*EOL.*desteklenen: 14, 15, 16/);
  assert.match(r.errors[1], /\[future\].*desteklenmiyor/);
  assert.match(r.errors[2], /\[nobin\].*binary tanımı/);
  assert.match(r.errors[3], /\[cache\].*url ve sha256 doldurulmamış/);
  assert.match(r.errors[4], /\[m\].*Manifest'te "mongo" tanımı yok/);
});

test('deneysel ve tested=false uyarı verir ama build\'i durdurmaz', () => {
  const r = resolveVersions(
    [db('a', 'postgres', 'postgres:17', '17'), db('b', 'postgres', 'postgres:16', '16')],
    manifest,
    noOverrides
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.services.map(s => s.status), ['experimental', 'experimental']);
  assert.equal(r.warnings.length, 2);
});

test('aynı tipte birden fazla servis bilgi notu üretir', () => {
  const r = resolveVersions(
    [db('main', 'postgres', 'postgres:15', '15'), db('audit', 'postgres', 'postgres:16', '16')],
    manifest,
    noOverrides
  );
  assert.match(r.infos[0], /2 ayrı postgres.*main \(v15\) → data\/main\/.*audit \(v16\) → data\/audit\//);
});

test('kullanılmayan override hata verir', () => {
  const r = resolveVersions([], manifest, { byService: { ghost: '15' }, byType: { redis: '7' } });
  assert.equal(r.errors.length, 2);
});

test('parseOverrides', () => {
  assert.deepEqual(parseOverrides({ dbVersion: ['db=15', 'cache=v7', 'sql=8.4'], pgVersion: '16' }), {
    byService: { db: '15', cache: '7', sql: '8.4' },
    byType: { postgres: '16' }
  });
  assert.throws(() => parseOverrides({ dbVersion: ['db:15'] }), /servis>=<versiyon/);
  assert.throws(() => parseOverrides({ pgVersion: 'abc' }), /--pg-version/);
});

test('gerçek manifest: tüm girdiler geçerli url ve sha256 içerir', () => {
  const m = loadManifest();
  for (const [type, def] of Object.entries(m)) {
    if (type.startsWith('_')) continue;
    for (const s of [...def.supported_majors, ...def.experimental_majors]) {
      const e = def.versions[s];
      assert.ok(e, `${type} ${s} girdisi yok`);
      assert.match(e.url, /^https:\/\//, `${type} ${s} url`);
      assert.match(e.sha256, /^[0-9a-f]{64}$/, `${type} ${s} sha256`);
    }
    for (const target of Object.values(def.aliases)) assert.ok(def.versions[target], `${type} alias → ${target}`);
  }
});

test('harici motor (memurai): binary istenmez, uyarılar üretilir', () => {
  const r = resolveVersions(
    [{ name: 'cache', dbType: 'redis', image: 'redis:latest', imageTag: 'latest', command: 'redis-server --requirepass x' }],
    manifest,
    noOverrides,
    { externalEngines: { redis: 'memurai' } }
  );
  assert.equal(r.ok, true);
  assert.equal(r.services[0].status, 'external');
  assert.equal(r.warnings.length, 2);
  assert.match(r.infos[0], /memurai kullanılacak/);
});
