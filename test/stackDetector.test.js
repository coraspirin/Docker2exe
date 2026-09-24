const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { detectStack, satisfiesMajor, lowestMajor, DEFAULT_NODE_MAJOR } = require('../src/detector/stackDetector');
const { makeProject, removeProject } = require('./helpers');

function service(dir, extra = {}) {
  return {
    name: 'web',
    build: { context: dir, dockerfile: path.join(dir, 'Dockerfile'), dockerfileInline: null },
    ports: [],
    expose: [],
    resolvedEnvironment: {},
    ...extra
  };
}

function withStack(files, fn, { svc = {}, overrides = {} } = {}) {
  const dir = makeProject(files);
  try {
    return fn(detectStack(service(dir, svc), overrides), dir);
  } finally {
    removeProject(dir);
  }
}

const pkg = obj => JSON.stringify(obj);

// --- entry ---

test('entry: scripts.start öncelikli', () => {
  withStack(
    { 'package.json': pkg({ main: 'lib.js', scripts: { start: 'node server.js' } }), 'server.js': '', 'lib.js': '' },
    s => {
      assert.equal(s.entry.file, 'server.js');
      assert.equal(s.entry.source, 'package.json scripts.start');
      assert.deepEqual(s.errors, []);
    },
    { overrides: { port: 3000 } }
  );
});

test('entry: uzantısız ve klasör entry çözülür', () => {
  withStack({ 'package.json': pkg({ scripts: { start: 'node src' } }), 'src/index.js': '' }, s => {
    assert.equal(s.entry.file, 'src/index.js');
  });
});

test('entry: start yoksa main', () => {
  withStack({ 'package.json': pkg({ main: 'app.js' }), 'app.js': '' }, s => {
    assert.equal(s.entry.file, 'app.js');
    assert.equal(s.entry.source, 'package.json main');
  });
});

test('entry: start tanınmazsa Dockerfile CMD, WORKDIR yolu eşlenir', () => {
  withStack(
    {
      'package.json': pkg({ scripts: { start: './run.sh' } }),
      Dockerfile: 'FROM node:20\nWORKDIR /app\nCMD ["node", "/app/src/main.js"]\n',
      'src/main.js': ''
    },
    s => {
      assert.equal(s.entry.file, 'src/main.js');
      assert.equal(s.entry.source, 'Dockerfile CMD/ENTRYPOINT');
      assert.ok(s.infos.some(i => i.includes('scripts.start atlandı')));
    }
  );
});

test('entry: kabuk script ENTRYPOINT atlanır, CMD kullanılır', () => {
  withStack(
    {
      'package.json': pkg({}),
      Dockerfile: 'FROM node:20\nWORKDIR /app\nENTRYPOINT ["./docker-entrypoint.sh"]\nCMD ["node", "index.js"]\n',
      'index.js': ''
    },
    s => {
      assert.equal(s.entry.file, 'index.js');
      assert.ok(s.warnings.some(w => w.includes('docker-entrypoint.sh')));
    }
  );
});

test('entry: build çıktısı ise uyarı, build script yoksa hata', () => {
  withStack({ 'package.json': pkg({ scripts: { start: 'node dist/index.js', build: 'tsc' } }) }, s => {
    assert.equal(s.entry.producedByBuild, true);
    assert.deepEqual(s.errors, []);
    assert.ok(s.warnings.some(w => w.includes('npm run build')));
  }, { overrides: { port: 3000 } });
  withStack({ 'package.json': pkg({ scripts: { start: 'node dist/index.js' } }) }, s => {
    assert.equal(s.errors.length > 0, true);
  });
});

test('entry: hiçbir kaynak yoksa --entry isteyen hata', () => {
  withStack({ 'package.json': pkg({ scripts: { start: 'ts-node src/index.ts' } }) }, s => {
    assert.equal(s.entry, null);
    assert.match(s.errors[0], /--entry/);
    assert.match(s.errors[0], /TypeScript/);
  });
});

test('entry: --entry override', () => {
  withStack({ 'package.json': pkg({}), 'custom.js': '' }, s => {
    assert.equal(s.entry.file, 'custom.js');
    assert.equal(s.entry.source, 'cli');
  }, { overrides: { entry: 'custom.js' } });
});

test('entry: SSR start komutu', () => {
  withStack({ 'package.json': pkg({ scripts: { start: 'next start' }, dependencies: { next: '14' } }) }, s => {
    assert.equal(s.entry.kind, 'ssr');
    assert.equal(s.entry.framework, 'next');
    assert.equal(s.framework.ssr, 'next');
  });
});

test('package.json yoksa Node projesi değil hatası', () => {
  withStack({ Dockerfile: 'FROM python:3.12\n' }, s => {
    assert.match(s.errors[0], /Node\.js projesi değil.*python:3\.12/);
  });
});

// --- port ---

test('port: compose ports container portu', () => {
  withStack({ 'package.json': pkg({ main: 'a.js' }), 'a.js': '' }, s => {
    assert.deepEqual(s.port, { value: 3000, source: 'compose ports' });
  }, { svc: { ports: [{ host: 8080, container: 3000 }] } });
});

test('port: Dockerfile EXPOSE', () => {
  withStack({ 'package.json': pkg({ main: 'a.js' }), 'a.js': '', Dockerfile: 'FROM node:20\nEXPOSE 4000\n' }, s => {
    assert.deepEqual(s.port, { value: 4000, source: 'Dockerfile EXPOSE' });
  });
});

test('port: kodda process.env.PORT varsayılanı', () => {
  withStack(
    { 'package.json': pkg({ main: 'a.js' }), 'a.js': 'app.listen(process.env.PORT || 5050)' },
    s => assert.deepEqual(s.port, { value: 5050, source: 'kod (a.js)' })
  );
  withStack(
    { 'package.json': pkg({ main: 'a.js' }), 'a.js': '', 'src/config.js': 'const { PORT = 8081, HOST } = process.env;' },
    s => assert.equal(s.port.value, 8081)
  );
  withStack(
    { 'package.json': pkg({ main: 'a.js' }), 'a.js': 'const p = Number(process.env.PORT) ?? "7000"' },
    s => assert.equal(s.port.value, 7000)
  );
});

test('port: bulunamazsa ve çelişkili ise hata', () => {
  withStack({ 'package.json': pkg({ main: 'a.js' }), 'a.js': 'app.listen(3000)' }, s => {
    assert.equal(s.port, null);
    assert.ok(s.errors.some(e => e.includes('--port')));
  });
  withStack(
    { 'package.json': pkg({ main: 'a.js' }), 'a.js': '', 'x.js': 'process.env.PORT || 3000', 'y.js': 'process.env.PORT || 4000' },
    s => assert.ok(s.errors.some(e => e.includes('birden fazla PORT')))
  );
});

test('port: compose PORT env farklıysa uyarı', () => {
  withStack({ 'package.json': pkg({ main: 'a.js' }), 'a.js': '' }, s => {
    assert.ok(s.warnings.some(w => w.includes('PORT=8000')));
  }, { svc: { ports: [{ host: 3000, container: 3000 }], resolvedEnvironment: { PORT: '8000' } } });
});

// --- node versiyonu ---

test('node: Dockerfile FROM öncelikli, engines çelişkisi uyarı', () => {
  withStack(
    { 'package.json': pkg({ main: 'a.js', engines: { node: '>=22' } }), 'a.js': '', Dockerfile: 'FROM node:20-alpine AS b\nFROM b\n' },
    s => {
      assert.equal(s.node.major, 20);
      assert.ok(s.warnings.some(w => w.includes('engines.node')));
    }
  );
});

test('node: engines ve varsayılan', () => {
  withStack({ 'package.json': pkg({ main: 'a.js', engines: { node: '^20.10.0 || ^22' } }), 'a.js': '' }, s => {
    assert.deepEqual([s.node.major, s.node.source], [20, 'package.json engines.node']);
  });
  withStack({ 'package.json': pkg({ main: 'a.js' }), 'a.js': '' }, s => {
    assert.equal(s.node.major, DEFAULT_NODE_MAJOR);
    assert.ok(s.warnings.some(w => w.includes('varsayılan')));
  });
});

test('satisfiesMajor / lowestMajor', () => {
  assert.equal(satisfiesMajor('>=18', 20), true);
  assert.equal(satisfiesMajor('>=18 <20', 20), false);
  assert.equal(satisfiesMajor('^18 || ^20', 20), true);
  assert.equal(satisfiesMajor('20.x', 20), true);
  assert.equal(satisfiesMajor('lts/*', 20), null);
  assert.equal(lowestMajor('>=18.17.0'), 18);
  assert.equal(lowestMajor('20 || 22'), 20);
  assert.equal(lowestMajor('*'), null);
});

test('framework tespiti', () => {
  withStack({ 'package.json': pkg({ main: 'a.js', dependencies: { express: '4' } }), 'a.js': '' }, s => {
    assert.deepEqual(s.framework, { ssr: null, server: 'express' });
  });
});
