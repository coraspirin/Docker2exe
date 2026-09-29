const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const archiver = require('archiver');
const { PROJECT_ROOT } = require('../utils/paths');

const STUB_SOURCE = path.join(PROJECT_ROOT, 'runtime', 'sfx', 'Sfx.cs');
const MAGIC = 'D2ESFX01';
const TRAILER_SIZE = 4 + 8 + 8;
const META_KEYS = ['name', 'id', 'root', 'version', 'exe', 'args', 'strip'];

/** Windows 10/11 ile gelen .NET Framework 4.x C# derleyicisi. */
function findCsc() {
  const winDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidates = ['Framework64', 'Framework'].map(f => path.join(winDir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'));
  const csc = candidates.find(p => fs.existsSync(p));
  if (!csc) throw new Error(`.NET Framework 4 C# derleyicisi bulunamadı (${candidates[0]}); tek dosya exe üretilemiyor (--no-exe ile atlayın)`);
  return csc;
}

/** C# string literal'i (AssemblyInfo için). */
function csString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`;
}

/** "0.1.0" → "0.1.0.0" (AssemblyVersion sadece sayısal 4 parça kabul eder). */
function assemblyVersion(version) {
  const parts = String(version || '').split(/[.+-]/).map(p => parseInt(p, 10)).filter(n => Number.isInteger(n) && n >= 0 && n < 65535);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join('.');
}

function runCsc(args, logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(findCsc(), args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (logFile) fs.appendFileSync(logFile, `\n$ csc ${args.join(' ')}\n${out}\n[çıkış kodu ${code}]\n`);
      if (code === 0) resolve(out);
      else reject(new Error(`SFX stub derlenemedi (csc çıkış kodu ${code}):\n    ${out.trim().split(/\r?\n/).slice(-10).join('\n    ')}`));
    });
  });
}

/**
 * runtime/sfx/Sfx.cs'i derler. gui=true → konsolsuz (winexe) uygulama stub'ı, false → konsol aracı stub'ı.
 * @param {{ gui: boolean, output: string, icon?: string, title: string, product?: string, version?: string, logFile?: string }} opts
 */
async function compileStub({ gui, output, icon, title, product, version, logFile }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd2e-sfx-'));
  try {
    const info = path.join(tmp, 'AssemblyInfo.cs');
    fs.writeFileSync(info, [
      'using System.Reflection;',
      `[assembly: AssemblyTitle(${csString(title)})]`,
      `[assembly: AssemblyProduct(${csString(product || title)})]`,
      `[assembly: AssemblyDescription(${csString(`${title} (docker2exe)`)})]`,
      `[assembly: AssemblyFileVersion(${csString(assemblyVersion(version))})]`,
      `[assembly: AssemblyVersion(${csString(assemblyVersion(version))})]`,
      ''
    ].join('\r\n'), 'utf8');
    const args = [
      '/nologo', '/optimize+', '/platform:anycpu', '/codepage:65001',
      `/target:${gui ? 'winexe' : 'exe'}`,
      `/out:${output}`,
      '/r:System.Core.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll'
    ];
    if (gui) args.push('/define:GUI', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll');
    if (icon) args.push(`/win32icon:${icon}`);
    args.push(STUB_SOURCE, info);
    await runCsc(args, logFile);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** meta sözlüğünü trailer'a çevirir: [meta][int32 metaLen][int64 payloadLen][MAGIC]. */
function buildTrailer(meta, payloadLength) {
  for (const [k, v] of Object.entries(meta)) {
    if (!META_KEYS.includes(k)) throw new Error(`Bilinmeyen SFX meta alanı: ${k}`);
    if (/[\r\n]/.test(String(v))) throw new Error(`SFX meta alanı satır sonu içeremez: ${k}`);
  }
  const metaBuf = Buffer.from(Object.entries(meta).map(([k, v]) => `${k}=${v}`).join('\n'), 'utf8');
  const tail = Buffer.alloc(TRAILER_SIZE);
  tail.writeInt32LE(metaBuf.length, 0);
  tail.writeBigInt64LE(BigInt(payloadLength), 4);
  tail.write(MAGIC, 12, 'ascii');
  return Buffer.concat([metaBuf, tail]);
}

/** SFX exe'nin meta ve payload konumunu okur (testler ve doğrulama için). */
function readTrailer(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < TRAILER_SIZE) return null;
    const tail = Buffer.alloc(TRAILER_SIZE);
    fs.readSync(fd, tail, 0, TRAILER_SIZE, size - TRAILER_SIZE);
    if (tail.toString('ascii', 12) !== MAGIC) return null;
    const metaLength = tail.readInt32LE(0);
    const payloadLength = Number(tail.readBigInt64LE(4));
    const metaBuf = Buffer.alloc(metaLength);
    fs.readSync(fd, metaBuf, 0, metaLength, size - TRAILER_SIZE - metaLength);
    const meta = Object.fromEntries(metaBuf.toString('utf8').split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { meta, payloadLength, payloadOffset: size - TRAILER_SIZE - metaLength - payloadLength };
  } finally {
    fs.closeSync(fd);
  }
}

/** Dosyanın SHA256'sının ilk 12 hanesi: açılım klasörü adı (aynı içerik → aynı klasör, tekrar açılmaz). */
async function shortHash(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex').slice(0, 12);
}

/** stub + zip + trailer → output. */
async function assembleSfx({ stub, zip, meta, output }) {
  const payloadLength = fs.statSync(zip).size;
  const partial = `${output}.partial`;
  fs.rmSync(partial, { force: true });
  fs.copyFileSync(stub, partial);
  await pipeline(fs.createReadStream(zip), fs.createWriteStream(partial, { flags: 'a' }));
  fs.appendFileSync(partial, buildTrailer(meta, payloadLength));
  fs.rmSync(output, { force: true });
  fs.renameSync(partial, output);
  return fs.statSync(output).size;
}

/**
 * Klasör içeriğini kök seviyede (önek klasör olmadan) zipler.
 * @param {string} dir
 * @param {string} zipPath
 * @param {{ exclude?: (rel: string) => boolean }} [opts]
 */
function zipContents(dir, zipPath, { exclude } = {}) {
  return new Promise((resolve, reject) => {
    fs.rmSync(zipPath, { force: true });
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve(archive.pointer()));
    archive.on('warning', err => (err.code === 'ENOENT' ? null : reject(err)));
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(dir, false, entry => (exclude && exclude(entry.name) ? false : entry));
    archive.finalize();
  });
}

/**
 * Tek dosya uygulama exe'si: açıldığında %LOCALAPPDATA%\<appId>\app\<hash> altına açılır ve launcher.exe'yi başlatır.
 * Launcher'ın veri klasörü (%LOCALAPPDATA%\<appId>\data) klasör sürümüyle ortaktır.
 * @param {{ zip: string, strip: string, output: string, appName: string, appId: string, icon: string, version: string, logFile?: string }} opts
 */
async function createAppExe({ zip, strip, output, appName, appId, icon, version, logFile }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd2e-sfx-'));
  try {
    const stub = path.join(tmp, 'stub.exe');
    await compileStub({ gui: true, output: stub, icon, title: appName, version, logFile });
    return await assembleSfx({
      stub,
      zip,
      output,
      meta: { name: appName, id: appId, root: `${appId}\\app`, version: await shortHash(zip), exe: 'launcher.exe', strip }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { compileStub, buildTrailer, readTrailer, assembleSfx, zipContents, createAppExe, shortHash, assemblyVersion, findCsc };
