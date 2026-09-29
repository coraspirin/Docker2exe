const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { buildTrailer, readTrailer, assembleSfx, compileStub, zipContents, shortHash, assemblyVersion, findCsc } = require('../src/packager/sfx');
const { zipDirectory } = require('../src/packager/portablePackager');
const { envWithOwnNode } = require('../src/builder/npm');
const { applySourceArgument, parseFormats, resolveFormats } = require('../src/cli');
const { makeProject, removeProject } = require('./helpers');

function hasCsc() {
  try {
    return Boolean(findCsc());
  } catch {
    return false;
  }
}

// --- trailer ---

test('trailer: meta ve payload konumu geri okunur', () => {
  const dir = makeProject({ 'stub.bin': 'STUB', 'payload.bin': 'PAYLOAD-123' });
  try {
    const file = path.join(dir, 'out.exe');
    const meta = { name: 'Uygulama Ş', id: 'uyg', root: 'uyg\\app', version: 'abc123', exe: 'launcher.exe', strip: 'Uygulama Ş/' };
    fs.writeFileSync(file, Buffer.concat([Buffer.from('STUB'), Buffer.from('PAYLOAD-123'), buildTrailer(meta, 11)]));
    const t = readTrailer(file);
    assert.deepEqual(t.meta, meta);
    assert.equal(t.payloadOffset, 4);
    assert.equal(t.payloadLength, 11);
  } finally {
    removeProject(dir);
  }
});

test('trailer: bilinmeyen alan ve satır sonu reddedilir; imzasız dosya null döner', () => {
  assert.throws(() => buildTrailer({ foo: 'x' }, 1), /Bilinmeyen/);
  assert.throws(() => buildTrailer({ name: 'a\nb' }, 1), /satır sonu/);
  const dir = makeProject({ 'x.exe': 'MZ sadece stub' });
  try {
    assert.equal(readTrailer(path.join(dir, 'x.exe')), null);
  } finally {
    removeProject(dir);
  }
});

test('assemblyVersion: sayısal 4 parçaya çevrilir', () => {
  assert.equal(assemblyVersion('0.1.0'), '0.1.0.0');
  assert.equal(assemblyVersion('1.2.3-beta.4'), '1.2.3.4');
  assert.equal(assemblyVersion(''), '0.0.0.0');
});

// --- CLI / ortam ---

test('applySourceArgument: klasör, GitHub URL, sondaki kaçmış tırnak, çakışma', () => {
  assert.deepEqual(applySourceArgument('C:\\Proje', {}), { path: 'C:\\Proje' });
  assert.deepEqual(applySourceArgument('C:\\Proje Klasörü"', {}), { path: 'C:\\Proje Klasörü' });
  assert.deepEqual(applySourceArgument('https://github.com/a/b', {}), { github: 'https://github.com/a/b' });
  assert.deepEqual(applySourceArgument(undefined, { path: 'x' }), { path: 'x' });
  assert.throws(() => applySourceArgument('C:\\a', { path: 'b' }), /hem konumsal/);
});

test('parseFormats / resolveFormats: çıktı türü seçimi', () => {
  assert.deepEqual(parseFormats('1,3'), { exe: true, folder: false, zip: true });
  assert.deepEqual(parseFormats('exe zip'), { exe: true, folder: false, zip: true });
  assert.deepEqual(parseFormats('Klasör'), { exe: false, folder: true, zip: false });
  assert.deepEqual(parseFormats('hepsi'), { exe: true, folder: true, zip: true });
  assert.throws(() => parseFormats('pdf'), /Bilinmeyen/);
  assert.throws(() => parseFormats(' , '), /boş/);
  assert.deepEqual(resolveFormats({ format: 'exe' }), { formats: { exe: true, folder: false, zip: false }, ask: false });
  assert.deepEqual(resolveFormats({ zip: false }), { formats: { exe: true, folder: true, zip: false }, ask: false });
  assert.equal(resolveFormats({ check: true }).ask, false);
  assert.throws(() => resolveFormats({ format: 'exe', zip: false }), /birlikte/);
});

test('envWithOwnNode: çalışan Node klasörü PATH\'in başına eklenir (anahtar büyük/küçük harfi korunur)', () => {
  const env = envWithOwnNode({ Path: 'C:\\x' });
  assert.equal(env.Path, `${path.dirname(process.execPath)};C:\\x`);
  assert.equal(env.PATH, undefined);
});

// --- gerçek stub (csc) ---

test('konsol SFX: ilk çalıştırmada açar, önek soyar, argüman + çıkış kodu aktarır, sonra tekrar açmaz', { skip: !hasCsc() && 'csc.exe yok' }, async () => {
  const dir = makeProject({ 'Uyg Ş/alt/Başlat.txt': 'merhaba' });
  const root = `docker2exe-test-${crypto.randomBytes(4).toString('hex')}`;
  const extractBase = path.join(process.env.LOCALAPPDATA, root);
  try {
    fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), path.join(dir, 'Uyg Ş', 'cmd.exe'));
    const zip = path.join(dir, 'p.zip');
    await zipDirectory(path.join(dir, 'Uyg Ş'), zip);
    const stub = path.join(dir, 'stub.exe');
    await compileStub({ gui: false, output: stub, title: 'test', version: '1.0.0' });
    const exe = path.join(dir, 't.exe');
    const version = await shortHash(zip);
    await assembleSfx({
      stub, zip, output: exe,
      meta: { name: 'test', id: root, root, version, exe: 'cmd.exe', args: '/c more < "{dir}/alt/Başlat.txt" &', strip: 'Uyg Ş/' }
    });

    const first = spawnSync(exe, ['exit', '7'], { encoding: 'utf8' });
    assert.equal(first.status, 7, first.stderr);
    assert.match(first.stdout, /merhaba/);
    const target = path.join(extractBase, version);
    assert.ok(fs.existsSync(path.join(target, '.d2e-sfx-complete')));
    assert.ok(fs.existsSync(path.join(target, 'alt', 'Başlat.txt')));

    // İkinci çalıştırma: açılmış dosya değiştirilirse değişiklik korunur (yeniden açılmadı)
    fs.writeFileSync(path.join(target, 'alt', 'Başlat.txt'), 'ikinci');
    const second = spawnSync(exe, ['exit', '3'], { encoding: 'utf8' });
    assert.equal(second.status, 3);
    assert.match(second.stdout, /ikinci/);

    // Yeni sürüm (farklı hash) açılınca eski sürüm klasörü silinir
    await assembleSfx({
      stub, zip, output: exe,
      meta: { name: 'test', id: root, root, version: 'yeni', exe: 'cmd.exe', args: '/c', strip: 'Uyg Ş/' }
    });
    assert.equal(spawnSync(exe, ['exit', '0']).status, 0);
    assert.deepEqual(fs.readdirSync(extractBase), ['yeni']);
  } finally {
    removeProject(dir);
    fs.rmSync(extractBase, { recursive: true, force: true });
  }
});

test('zipContents: kök seviyede zipler, exclude uygulanır', async () => {
  const dir = makeProject({ 'a.txt': 'a', 'alt/b.txt': 'b', 'alt/atla.log': 'x' });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'd2e-zip-'));
  try {
    const zip = path.join(out, 'c.zip');
    await zipContents(dir, zip, { exclude: rel => rel.endsWith('.log') });
    const list = spawnSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-tf', zip], { encoding: 'utf8' }).stdout;
    const names = list.split(/\r?\n/).filter(Boolean).sort();
    assert.ok(names.includes('a.txt'));
    assert.ok(names.includes('alt/b.txt'));
    assert.ok(!names.some(n => n.endsWith('atla.log')));
  } finally {
    removeProject(dir);
    fs.rmSync(out, { recursive: true, force: true });
  }
});
