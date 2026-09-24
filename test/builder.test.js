const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { classifyAddon, readPe } = require('../src/builder/nativeModules');
const { koffiNativePath } = require('../src/builder/launcherGen');
const { downloadVerified } = require('../src/builder/downloader');
const { cleanCache, ensureCached, extractZip } = require('../src/builder/dbBundler');
const { findStaticTargets, detectFrontendDir, ssrFrameworkOf, buildSsr } = require('../src/builder/frontendBuilder');
const { sanitizeAppName, toAppId, collectInitScripts, zipDirectory } = require('../src/packager/portablePackager');
const { makeProject, removeProject } = require('./helpers');

// --- native modüller ---

test('koffi.node N-API olarak sınıflandırılır; PE olmayan dosya null döner', () => {
  const koffi = koffiNativePath();
  assert.ok(koffi, 'koffi native bulunamadı');
  assert.deepEqual(classifyAddon(koffi), { kind: 'napi' });
  assert.equal(readPe(Buffer.from('not a pe file at all, just text......................................')), null);
});

// --- indirme + SHA256 ---

function serve(body) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/file.zip' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('downloadVerified: yönlendirme izlenir, SHA256 doğrulanır; uyuşmazlıkta dosya bırakılmaz', async () => {
  const body = crypto.randomBytes(50000);
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const srv = await serve(body);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2e-dl-'));
  const url = `http://127.0.0.1:${srv.address().port}/redirect`;
  try {
    const dest = path.join(dir, 'ok.zip');
    await downloadVerified({ url, dest, sha256: sha });
    assert.equal(fs.readFileSync(dest).length, body.length);

    const bad = path.join(dir, 'bad.zip');
    await assert.rejects(downloadVerified({ url, dest: bad, sha256: 'f'.repeat(64) }), /SHA256 doğrulaması başarısız/);
    assert.equal(fs.existsSync(bad), false);
    assert.equal(fs.existsSync(`${bad}.partial`), false);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- cache ---

function withToolHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'd2e-home-'));
  const prev = process.env.DOCKER2EXE_HOME;
  process.env.DOCKER2EXE_HOME = home;
  const done = () => {
    if (prev === undefined) delete process.env.DOCKER2EXE_HOME;
    else process.env.DOCKER2EXE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  };
  return Promise.resolve(fn(home)).finally(done);
}

test('ensureCached --offline: cache\'te yoksa net hata', () =>
  withToolHome(async () => {
    await assert.rejects(
      ensureCached({ dbType: 'postgres', series: '16', entry: { url: 'https://x/pg.zip', sha256: 'a'.repeat(64) } }, { offline: true }),
      /--offline.*cache'te yok/
    );
  }));

test('cleanCache: --keep-latest her tip için en son kullanılanı tutar', () =>
  withToolHome(home => {
    const mk = (type, series, lastUsed) => {
      const dir = path.join(home, 'cache', type, series);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'x.zip'), 'data');
      fs.writeFileSync(path.join(dir, 'd2e-cache.json'), JSON.stringify({ lastUsed }));
    };
    mk('postgres', '15', '2026-01-01T00:00:00Z');
    mk('postgres', '16', '2026-06-01T00:00:00Z');
    mk('redis', '7', '2026-02-01T00:00:00Z');
    const r = cleanCache({ keepLatest: true });
    assert.deepEqual(r.kept.sort(), ['postgres/16', 'redis/7']);
    assert.deepEqual(r.removed, ['postgres/15']);
    const all = cleanCache();
    assert.equal(all.removed.length, 2);
    assert.equal(fs.readdirSync(path.join(home, 'cache')).length, 0);
  }));

test('extractZip: kök klasör atlanır, include/exclude uygulanır', async () => {
  const src = makeProject({ 'pkg/bin/a.exe': 'a', 'pkg/bin/a.pdb': 'debug', 'pkg/doc/x.txt': 'doc', 'pkg/share/s.txt': 's' });
  const zip = path.join(os.tmpdir(), `d2e-z-${process.pid}.zip`);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'd2e-x-'));
  try {
    await zipDirectory(path.join(src, 'pkg'), zip);
    await extractZip(zip, dest, { include: ['bin', 'share'], exclude: ['*.pdb'] });
    assert.deepEqual(fs.readdirSync(dest).sort(), ['bin', 'share']);
    assert.deepEqual(fs.readdirSync(path.join(dest, 'bin')), ['a.exe']);
  } finally {
    removeProject(src);
    fs.rmSync(zip, { force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

// --- frontend ---

test('findStaticTargets: literal ve __dirname tabanlı express.static', () => {
  const dir = makeProject({
    'server.js': "app.use(express.static('public'));\napp.use('/a', express.static(path.join(__dirname, '../web', 'dist')));",
    'src/x.js': "app.use(express.static(path.resolve(__dirname, 'assets')))"
  });
  try {
    const targets = findStaticTargets(dir, [path.join(dir, 'server.js'), path.join(dir, 'src', 'x.js')]).map(t => path.relative(dir, t.dir));
    assert.deepEqual(targets, ['public', path.join('..', 'web', 'dist'), path.join('src', 'assets')]);
  } finally {
    removeProject(dir);
  }
});

test('detectFrontendDir ve SSR tespiti', () => {
  const dir = makeProject({
    'package.json': '{}',
    'client/package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
    'ui/package.json': JSON.stringify({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15' } })
  });
  try {
    const fe = detectFrontendDir(dir, dir);
    assert.equal(path.basename(fe.dir), 'client');
    assert.equal(fe.kind, 'spa');
    assert.equal(fe.candidates.length, 2);
    assert.equal(ssrFrameworkOf({ scripts: { start: 'nuxt start' } }), 'nuxt');
  } finally {
    removeProject(dir);
  }
});

test('Next.js standalone modu kapalıysa config\'e dokunulmadan hata', async () => {
  const dir = makeProject({ 'package.json': '{}', 'next.config.js': 'module.exports = { reactStrictMode: true };' });
  try {
    await assert.rejects(buildSsr(dir, 'next'), /output: 'standalone' ekleyin/);
    assert.equal(fs.readFileSync(path.join(dir, 'next.config.js'), 'utf8'), 'module.exports = { reactStrictMode: true };');
  } finally {
    removeProject(dir);
  }
});

// --- paketleme ---

test('uygulama adı ve kimliği temizlenir', () => {
  assert.equal(sanitizeAppName('@acme/defter:v2'), 'defter-v2');
  assert.equal(toAppId('Harcama Takibi'), 'harcama-takibi');
});

test('collectInitScripts: sadece .sql alınır, .sh atlanır, named volume yok sayılır', () => {
  const dir = makeProject({ 'db/01.sql': 'select 1;', 'db/02.sh': 'echo', 'seed.sql': 'select 2;' });
  try {
    const svc = {
      name: 'db',
      dbType: 'postgres',
      volumes: ['pgdata:/var/lib/postgresql/data', './db:/docker-entrypoint-initdb.d', { type: 'bind', source: './seed.sql', target: '/docker-entrypoint-initdb.d/99-seed.sql' }]
    };
    const r = collectInitScripts(svc, dir);
    assert.deepEqual(r.files.map(f => path.basename(f)), ['01.sql', 'seed.sql']);
    assert.match(r.warnings[0], /02\.sh atlandı/);
  } finally {
    removeProject(dir);
  }
});

// --- ikon ---

const { generateIcon, initialOf, writeIcon } = require('../src/packager/icon');

test('ikon: PNG girdili geçerli ICO, Türkçe baş harf eşlemesi, projedeki favicon önceliği', () => {
  const ico = generateIcon('Şirket');
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 4);
  const off = ico.readUInt32LE(6 + 12);
  assert.equal(ico.subarray(off, off + 4).toString('latin1'), '\x89PNG');
  assert.equal(initialOf('çay'), 'C');
  assert.equal(initialOf('--'), 'A');

  const dir = makeProject({ 'public/favicon.ico': Buffer.from([0, 0, 1, 0, 0, 0]) });
  try {
    const out = path.join(dir, 'icon.ico');
    assert.equal(writeIcon(out, 'x', [dir]).source, 'project');
    fs.rmSync(path.join(dir, 'public', 'favicon.ico'));
    assert.equal(writeIcon(out, 'x', [dir]).source, 'generated');
  } finally {
    removeProject(dir);
  }
});

// --- konsolsuz launcher ---

const { setGuiSubsystem } = require('../src/builder/launcherGen');

test('setGuiSubsystem: PE subsystem CONSOLE → WINDOWS_GUI, diğer baytlar değişmez', () => {
  const src = process.execPath; // node.exe bir CONSOLE uygulaması
  const copy = path.join(os.tmpdir(), `d2e-gui-${process.pid}.exe`);
  fs.copyFileSync(src, copy);
  try {
    setGuiSubsystem(copy);
    const a = fs.readFileSync(src);
    const b = fs.readFileSync(copy);
    const off = a.readUInt32LE(0x3c) + 24 + 68;
    assert.equal(a.readUInt16LE(off), 3);
    assert.equal(b.readUInt16LE(off), 2);
    b.writeUInt16LE(3, off);
    assert.ok(a.equals(b));
    setGuiSubsystem(copy); // idempotent
  } finally {
    fs.rmSync(copy, { force: true });
  }
});
