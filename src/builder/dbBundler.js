const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { cacheDir } = require('../utils/paths');
const { downloadVerified, sha256File } = require('./downloader');

const CACHE_WARN_BYTES = 5 * 1024 ** 3;
const META_FILE = 'd2e-cache.json';

// Windows 10 1803+ ile gelen bsdtar: zip'i açar, `..`/mutlak yol içeren girdileri varsayılan olarak reddeder.
function systemTar() {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (!fs.existsSync(tar)) {
    throw new Error(`Sistem tar.exe bulunamadı (${tar}); Windows 10 1803 veya üstü gerekli`);
  }
  return tar;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(cmd)} ${args.join(' ')} başarısız (çıkış kodu ${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * Binary zip'inin cache'te bulunmasını sağlar. Cache'teki dosya da her kullanımda SHA256 ile doğrulanır.
 * @returns {Promise<string>} zip yolu
 */
async function ensureCached({ dbType, series, entry }, { offline = false, insecure = false, log = () => {}, onProgress } = {}) {
  const dir = path.join(cacheDir(), dbType, series);
  const fileName = decodeURIComponent(new URL(entry.url).pathname.split('/').pop());
  const zipPath = path.join(dir, fileName);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(zipPath)) {
    const actual = await sha256File(zipPath);
    if (actual === entry.sha256.toLowerCase()) {
      touchMeta(dir, entry);
      return zipPath;
    }
    log(`Cache'teki ${fileName} bozuk (SHA256 uyuşmuyor), siliniyor`);
    fs.rmSync(zipPath, { force: true });
  }

  if (offline) {
    throw new Error(`--offline: ${dbType} ${series} (${fileName}) cache'te yok. Önce ağ bağlantısıyla bir build çalıştırın.`);
  }
  if (insecure) {
    log('⚠ TLS doğrulaması atlanıyor (--insecure), bu güvenli değildir; mümkünse NODE_EXTRA_CA_CERTS kullanın. SHA256 kontrolü yine yapılıyor.');
  }
  await downloadVerified({ url: entry.url, dest: zipPath, sha256: entry.sha256, insecure, onProgress });
  touchMeta(dir, entry);
  return zipPath;
}

function touchMeta(dir, entry) {
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify({ version: entry.version || null, url: entry.url, lastUsed: new Date().toISOString() }, null, 2));
}

/** Zip'in tek bir kök klasörü varsa adını döner (`pgsql`, `mongodb-win32-x86_64-windows-7.0.43` ...). */
async function zipRoot(zipPath) {
  const listing = await run(systemTar(), ['-tf', zipPath]);
  const roots = new Set(listing.split(/\r?\n/).filter(Boolean).map(l => l.split('/')[0]));
  return roots.size === 1 ? [...roots][0] : null;
}

/**
 * Zip'i hedef klasöre açar. layout.include verilmişse sadece o yollar (kök klasöre göre) çıkarılır;
 * pgAdmin, dokümantasyon, header'lar gibi çalışma zamanında gereksiz dosyalar pakete girmez;
 * layout.exclude kalıpları (debug sembolleri *.pdb, statik *.lib ...) hiç çıkarılmaz.
 */
async function extractZip(zipPath, destDir, layout = {}) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const root = await zipRoot(zipPath);
  const include = layout.include || [];
  const args = ['-xf', zipPath, '-C', destDir];
  for (const pattern of layout.exclude || []) args.push('--exclude', pattern);
  if (root) args.push('--strip-components', '1');
  for (const p of include) args.push(root ? `${root}/${p}` : p);
  await run(systemTar(), args);
  const missing = include.filter(p => !fs.existsSync(path.join(destDir, p)));
  if (missing.length && missing.length === include.length) {
    throw new Error(`${path.basename(zipPath)} beklenen dosyaları içermiyor (${missing.join(', ')}); manifest layout'unu kontrol edin`);
  }
}

/**
 * Pre-flight'tan geçen DB servislerinin binary'lerini `<outDir>/deps/<tip>-<seri>/` altına koyar.
 * Aynı tip+seriyi kullanan servisler binary'yi paylaşır (veri klasörleri ayrıdır).
 *
 * @returns {Promise<Record<string, string>>} servis adı → deps altındaki göreli klasör
 */
async function bundleDatabases(preflightServices, manifest, outDir, opts = {}) {
  const byKey = new Map();
  for (const s of preflightServices) {
    if (s.status === 'external') continue;
    const key = `${s.dbType}-${s.series}`;
    if (!byKey.has(key)) byKey.set(key, { dbType: s.dbType, series: s.series, entry: s.manifestEntry, services: [] });
    byKey.get(key).services.push(s.service);
  }

  const mapping = {};
  for (const [key, item] of byKey) {
    const zipPath = await ensureCached(item, { ...opts, onProgress: opts.onProgress && ((r, t) => opts.onProgress(key, r, t)) });
    if (opts.onExtract) opts.onExtract(key);
    await extractZip(zipPath, path.join(outDir, 'deps', key), manifest[item.dbType].layout);
    for (const name of item.services) mapping[name] = `deps/${key}`;
  }
  return mapping;
}

// --- Cache yönetimi ---

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function cacheSize() {
  return dirSize(cacheDir());
}

/** Cache boyutu eşiği aşıyorsa bilgilendirici uyarı metni döner (otomatik silme yapılmaz). */
function cacheSizeWarning(limit = CACHE_WARN_BYTES) {
  const size = cacheSize();
  if (size <= limit) return null;
  return `Cache boyutu ${formatBytes(size)}'a ulaştı (${cacheDir()}), \`docker2exe clean-cache\` ile temizleyebilirsiniz`;
}

/**
 * @param {{ keepLatest?: boolean }} opts keepLatest: her DB tipi için en son kullanılan seriyi tutar
 * @returns {{ removed: string[], kept: string[], freedBytes: number }}
 */
function cleanCache({ keepLatest = false } = {}) {
  const root = cacheDir();
  const removed = [];
  const kept = [];
  let freedBytes = 0;
  if (!fs.existsSync(root)) return { removed, kept, freedBytes };

  for (const type of fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory())) {
    const typeDir = path.join(root, type.name);
    const seriesDirs = fs.readdirSync(typeDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
      const dir = path.join(typeDir, e.name);
      let lastUsed = 0;
      try {
        lastUsed = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')).lastUsed) || 0;
      } catch {
        lastUsed = fs.statSync(dir).mtimeMs;
      }
      return { dir, label: `${type.name}/${e.name}`, lastUsed };
    });
    seriesDirs.sort((a, b) => b.lastUsed - a.lastUsed);
    seriesDirs.forEach((s, i) => {
      if (keepLatest && i === 0) {
        kept.push(s.label);
        return;
      }
      freedBytes += dirSize(s.dir);
      fs.rmSync(s.dir, { recursive: true, force: true });
      removed.push(s.label);
    });
    if (!keepLatest) fs.rmSync(typeDir, { recursive: true, force: true });
  }
  return { removed, kept, freedBytes };
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

module.exports = { ensureCached, extractZip, bundleDatabases, cacheSize, cacheSizeWarning, cleanCache, formatBytes, systemTar };
