const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  parseCompose,
  parseImage,
  normalizePort,
  normalizeKeyValue,
  normalizeDependsOn,
  ComposeError
} = require('../src/parser/composeParser');
const { makeProject, removeProject } = require('./helpers');

function withProject(files, fn, env = {}) {
  const dir = makeProject(files);
  try {
    return fn(parseCompose(dir, { env }), dir);
  } finally {
    removeProject(dir);
  }
}

// --- Compose dosyası bulma ---

test('compose dosyası yoksa hata', () => {
  const dir = makeProject({ 'package.json': '{}' });
  try {
    assert.throws(() => parseCompose(dir, { env: {} }), ComposeError);
  } finally {
    removeProject(dir);
  }
});

test('compose.yaml alternatif ismi bulunur', () => {
  withProject({ 'compose.yaml': 'services:\n  web:\n    build: .\n' }, result => {
    assert.equal(path.basename(result.composePath), 'compose.yaml');
    assert.equal(result.webService.name, 'web');
  });
});

test('services tanımı yoksa hata', () => {
  const dir = makeProject({ 'docker-compose.yml': 'version: "3"\n' });
  try {
    assert.throws(() => parseCompose(dir, { env: {} }), /services/);
  } finally {
    removeProject(dir);
  }
});

// --- environment ---

test('environment array formatı; değerde = olsa bile ilk = den bölünür', () => {
  assert.deepEqual(normalizeKeyValue(['A=1', 'URL=postgres://h/db?a=b&c=d', 'EMPTY=']), {
    A: '1',
    URL: 'postgres://h/db?a=b&c=d',
    EMPTY: ''
  });
});

test('environment object formatı; sayı/bool string olur', () => {
  assert.deepEqual(normalizeKeyValue({ A: 1, B: true, C: 'x', D: null }), { A: '1', B: 'true', C: 'x', D: null });
});

test('değersiz environment anahtarı kabuk ortamından alınır, yoksa eksik raporlanır', () => {
  const compose = `
services:
  web:
    build: .
    environment:
      - FROM_SHELL
      - NOT_SET
  worker:
    build: ./worker
    environment:
      OBJ_NULL:
`;
  withProject({ 'docker-compose.yml': compose }, result => {
    const web = result.raw.find(s => s.name === 'web');
    assert.deepEqual(web.environment, { FROM_SHELL: 'shell-value' });
    const names = result.report.missingVariables.map(m => m.name).sort();
    assert.deepEqual(names, ['NOT_SET', 'OBJ_NULL']);
  }, { FROM_SHELL: 'shell-value' });
});

// --- depends_on ---

test('depends_on array ve object formatı', () => {
  assert.deepEqual(normalizeDependsOn(['db', 'cache']).map(d => d.service), ['db', 'cache']);
  assert.deepEqual(normalizeDependsOn({ db: { condition: 'service_healthy' }, cache: null }), [
    { service: 'db', condition: 'service_healthy' },
    { service: 'cache', condition: 'service_started' }
  ]);
  assert.deepEqual(normalizeDependsOn(undefined), []);
});

// --- build ---

test('build string ve object formatı', () => {
  const compose = `
services:
  a:
    build: ./app
  b:
    build:
      context: ./other
      dockerfile: Dockerfile.prod
  c:
    image: nginx:1.27
`;
  withProject({ 'docker-compose.yml': compose }, (result, dir) => {
    const [a, b, c] = result.raw;
    assert.equal(a.build.context, path.join(dir, 'app'));
    assert.equal(a.build.dockerfile, path.join(dir, 'app', 'Dockerfile'));
    assert.equal(b.build.context, path.join(dir, 'other'));
    assert.equal(b.build.dockerfile, path.join(dir, 'other', 'Dockerfile.prod'));
    assert.equal(c.build, null);
    assert.equal(result.webService.name, 'a');
    assert.ok(result.report.warnings.some(w => w.includes('Birden fazla build')));
    assert.ok(result.report.warnings.some(w => w.includes('"c" servisi')));
  });
});

test('uzak build context desteklenmez', () => {
  const dir = makeProject({ 'docker-compose.yml': 'services:\n  a:\n    build: https://github.com/u/r.git\n' });
  try {
    assert.throws(() => parseCompose(dir, { env: {} }), /uzak bir kaynak/);
  } finally {
    removeProject(dir);
  }
});

// --- ports ---

test('port kısa söz dizimleri', () => {
  assert.deepEqual(normalizePort('3000', 's'), { hostIp: null, host: 3000, container: 3000, protocol: 'tcp' });
  assert.deepEqual(normalizePort('8080:3000', 's'), { hostIp: null, host: 8080, container: 3000, protocol: 'tcp' });
  assert.deepEqual(normalizePort('127.0.0.1:8080:3000', 's'), { hostIp: '127.0.0.1', host: 8080, container: 3000, protocol: 'tcp' });
  assert.deepEqual(normalizePort('53:53/udp', 's'), { hostIp: null, host: 53, container: 53, protocol: 'udp' });
  assert.deepEqual(normalizePort('[::1]:8080:3000', 's'), { hostIp: '::1', host: 8080, container: 3000, protocol: 'tcp' });
  assert.deepEqual(normalizePort(3000, 's'), { hostIp: null, host: 3000, container: 3000, protocol: 'tcp' });
});

test('port uzun söz dizimi (published string olabilir)', () => {
  assert.deepEqual(normalizePort({ target: 3000, published: '8080' }, 's'), { hostIp: null, host: 8080, container: 3000, protocol: 'tcp' });
  assert.deepEqual(normalizePort({ target: 6379 }, 's'), { hostIp: null, host: 6379, container: 6379, protocol: 'tcp' });
});

test('port aralığı ve geçersiz port hata verir', () => {
  assert.throws(() => normalizePort('3000-3005:3000-3005', 's'), /aralığı/);
  assert.throws(() => normalizePort('abc', 's'), /geçersiz port/);
  assert.throws(() => normalizePort('70000', 's'), /geçersiz port/);
});

// --- DB tespiti ---

test('DB image tespiti tam eşleşmeyle yapılır', () => {
  assert.deepEqual(parseImage('postgres:15-alpine'), { dbType: 'postgres', repository: 'postgres', tag: '15-alpine' });
  assert.deepEqual(parseImage('docker.io/library/redis:7.2.4-bookworm'), { dbType: 'redis', repository: 'redis', tag: '7.2.4-bookworm' });
  assert.equal(parseImage('bitnami/postgresql:16').dbType, 'postgres');
  assert.equal(parseImage('localhost:5000/mariadb:11').dbType, 'mariadb');
  assert.equal(parseImage('mongo').tag, null);
  assert.equal(parseImage('mongo@sha256:abc').tag, null);
  assert.equal(parseImage('mongo-express:latest').dbType, null);
  assert.equal(parseImage('redis-commander').dbType, null);
  assert.equal(parseImage('postgrest/postgrest').dbType, null);
});

test('DB benzeri ama desteklenmeyen image uyarı üretir', () => {
  withProject({ 'docker-compose.yml': 'services:\n  gis:\n    image: postgis/postgis:16-3.4\n' }, result => {
    assert.equal(result.dependencyServices.length, 0);
    assert.ok(result.report.warnings.some(w => w.includes('DB\'ye benziyor')));
  });
});

// --- interpolasyon + env_file ---

test('.env interpolasyonu, kabuk ortamı .env üzerine yazar, tanımsız değişken raporlanır', () => {
  const compose = `
services:
  web:
    build: .
    image: \${IMAGE_NAME:-myapp}
    environment:
      A: \${FROM_DOTENV}
      B: \${OVERRIDDEN}
      C: pre-\${UNDEFINED_VAR}-post
`;
  withProject(
    { 'docker-compose.yml': compose, '.env': 'FROM_DOTENV=dotenv\nOVERRIDDEN=dotenv\n' },
    result => {
      assert.deepEqual(result.webService.environment, { A: 'dotenv', B: 'shell', C: 'pre--post' });
      assert.equal(result.webService.image, 'myapp');
      assert.deepEqual(result.report.missingVariables, [
        { name: 'UNDEFINED_VAR', locations: ['services.web.environment.C'] }
      ]);
    },
    { OVERRIDDEN: 'shell' }
  );
});

test(':? ile zorunlu değişken tanımsızsa parse durur', () => {
  const dir = makeProject({ 'docker-compose.yml': 'services:\n  web:\n    build: .\n    environment:\n      K: ${REQ:?REQ gerekli}\n' });
  try {
    assert.throws(() => parseCompose(dir, { env: {} }), /REQ gerekli/);
  } finally {
    removeProject(dir);
  }
});

test('env_file yüklenir, environment env_file üzerine yazar', () => {
  const compose = `
services:
  web:
    build: .
    env_file:
      - ./a.env
      - path: ./optional.env
        required: false
    environment:
      SHARED: from-environment
`;
  withProject(
    { 'docker-compose.yml': compose, 'a.env': 'SHARED=from-file\nONLY_FILE=x\nREF=${FROM_DOTENV}\n', '.env': 'FROM_DOTENV=y\n' },
    result => {
      assert.deepEqual(result.webService.environment, { SHARED: 'from-environment', ONLY_FILE: 'x', REF: 'y' });
    }
  );
});

test('zorunlu env_file yoksa hata', () => {
  const dir = makeProject({ 'docker-compose.yml': 'services:\n  web:\n    build: .\n    env_file: missing.env\n' });
  try {
    assert.throws(() => parseCompose(dir, { env: {} }), /env_file/);
  } finally {
    removeProject(dir);
  }
});

// --- remap ---

test('resolvedEnvironment servis adlarını 127.0.0.1 e çevirir, environment korunur', () => {
  const compose = `
services:
  web:
    build: .
    environment:
      DATABASE_URL: postgres://u:pw@db:5432/app
      REDIS_HOST: redis
      MONGO_URI: mongodb://docs-alias:27017/x
      PUBLIC_URL: https://example.com
  db:
    image: postgres:16
    container_name: my-pg
  redis:
    image: redis:7
  mongo:
    image: mongo:7
    networks:
      backend:
        aliases: [docs-alias]
`;
  withProject({ 'docker-compose.yml': compose }, result => {
    const web = result.webService;
    assert.equal(web.environment.DATABASE_URL, 'postgres://u:pw@db:5432/app');
    assert.deepEqual(web.resolvedEnvironment, {
      DATABASE_URL: 'postgres://u:pw@127.0.0.1:5432/app',
      REDIS_HOST: '127.0.0.1',
      MONGO_URI: 'mongodb://127.0.0.1:27017/x',
      PUBLIC_URL: 'https://example.com'
    });
    assert.deepEqual(result.report.remaps.map(r => r.key), ['DATABASE_URL', 'REDIS_HOST', 'MONGO_URI']);
    assert.equal(result.report.remaps[0].before, 'postgres://u:****@db:5432/app');
    assert.deepEqual(result.dependencyServices.map(s => s.dbType), ['postgres', 'redis', 'mongo']);
  });
});

// --- uçtan uca fixture ---

test('full-stack fixture', () => {
  const dir = path.join(__dirname, 'fixtures', 'full-stack');
  const result = parseCompose(dir, { env: {} });

  assert.equal(result.webService.name, 'web');
  assert.deepEqual(result.webService.ports, [{ hostIp: null, host: 3000, container: 3000, protocol: 'tcp' }]);
  assert.deepEqual(result.webService.dependsOn, ['db', 'cache']);
  assert.equal(result.webService.environment.NODE_ENV, 'production');
  assert.equal(
    result.webService.resolvedEnvironment.DATABASE_URL,
    'postgres://app:s3cr=t#1@127.0.0.1:5432/defter?sslmode=disable'
  );
  assert.equal(result.webService.resolvedEnvironment.REDIS_URL, 'redis://127.0.0.1:6379/0');

  const db = result.dependencyServices.find(s => s.name === 'db');
  assert.equal(db.imageTag, '15-alpine');
  assert.deepEqual(db.environment, { POSTGRES_USER: 'app', POSTGRES_DB: 'defter', POSTGRES_PASSWORD: 's3cr=t#1' });

  assert.deepEqual(result.otherServices.map(s => s.name), ['adminer']);
  assert.deepEqual(result.report.missingVariables.map(m => m.name), ['SMTP_PASSWORD']);
});
