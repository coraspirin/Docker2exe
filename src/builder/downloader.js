const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { ProxyAgent } = require('proxy-agent');

const MAX_REDIRECTS = 10;
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
]);

class DownloadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
  }
}

/**
 * Dosyayı indirir, akış sırasında SHA256 hesaplar ve beklenen değerle karşılaştırır.
 * Önce `<dest>.partial`'a yazılır; doğrulama başarılıysa `dest`'e taşınır, değilse silinir.
 *
 * Proxy: HTTP_PROXY/HTTPS_PROXY/NO_PROXY ortam değişkenleri proxy-agent ile otomatik kullanılır.
 * insecure: TLS doğrulaması SADECE bu isteğin agent'ında kapatılır (process-wide değil).
 *
 * @param {{ url: string, dest: string, sha256: string, insecure?: boolean, onProgress?: (received:number, total:number|null) => void }} opts
 */
async function downloadVerified({ url, dest, sha256, insecure = false, onProgress }) {
  const partial = `${dest}.partial`;
  const agent = new ProxyAgent(insecure ? { rejectUnauthorized: false } : {});
  try {
    const actual = await fetchToFile(url, partial, agent, onProgress);
    if (actual.toLowerCase() !== sha256.toLowerCase()) {
      throw new DownloadError(
        `SHA256 doğrulaması başarısız: ${url}\n    beklenen: ${sha256}\n    gelen:    ${actual}\n` +
          '    Dosya cache\'e yazılmadı. İndirme bozulmuş veya kaynak değişmiş olabilir; manifest girdisini kontrol edin.',
        'CHECKSUM_MISMATCH'
      );
    }
    fs.renameSync(partial, dest);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err instanceof DownloadError ? err : wrapNetworkError(err, url, insecure);
  } finally {
    agent.destroy();
  }
}

function fetchToFile(url, file, agent, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { agent, headers: { 'User-Agent': 'docker2exe' }, timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new DownloadError(`Çok fazla yönlendirme: ${url}`, 'TOO_MANY_REDIRECTS'));
        const next = new URL(res.headers.location, url).href;
        return resolve(fetchToFile(next, file, agent, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new DownloadError(`İndirme başarısız (HTTP ${res.statusCode}): ${url}`, `HTTP_${res.statusCode}`));
      }

      const total = Number(res.headers['content-length']) || null;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(file);
      let received = 0;
      res.on('data', chunk => {
        hash.update(chunk);
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(out);
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        if (total !== null && received !== total) {
          return reject(new DownloadError(`İndirme yarıda kaldı (${received}/${total} bayt): ${url}`, 'INCOMPLETE'));
        }
        resolve(hash.digest('hex'));
      });
    });
    req.on('timeout', () => req.destroy(new DownloadError(`Bağlantı zaman aşımı: ${url}`, 'TIMEOUT')));
    req.on('error', reject);
  });
}

/** Kurumsal SSL inspection (Zscaler vb.) hatalarında kullanıcıya doğru çözüm yolunu gösterir. */
function wrapNetworkError(err, url, insecure) {
  const code = err.code || (err.cause && err.cause.code);
  if (TLS_ERROR_CODES.has(code)) {
    const extraCa = process.env.NODE_EXTRA_CA_CERTS;
    const lines = [`TLS sertifika doğrulaması başarısız (${code}): ${url}`];
    if (extraCa) {
      lines.push(`    NODE_EXTRA_CA_CERTS tanımlı (${extraCa}) ama bu sertifika zinciri doğrulanamadı; dosyanın kurumsal kök sertifikayı (PEM) içerdiğini kontrol edin.`);
    } else {
      lines.push('    Kurumsal ağlarda (Zscaler, Cisco Umbrella vb. SSL inspection) bu beklenen bir durumdur.');
      lines.push('    Doğru çözüm: kurumsal kök sertifikayı PEM olarak dışa aktarıp NODE_EXTRA_CA_CERTS ortam değişkeniyle tanımlayın:');
      lines.push('      set NODE_EXTRA_CA_CERTS=C:\\path\\to\\corporate-root.pem');
    }
    if (!insecure) lines.push('    Son çare: --insecure (sadece DB binary indirmelerinde TLS doğrulamasını atlar, SHA256 kontrolü yine yapılır).');
    return new DownloadError(lines.join('\n'), code);
  }
  return new DownloadError(`İndirme hatası (${code || err.message}): ${url}\n    Proxy gerekiyorsa HTTPS_PROXY ortam değişkenini tanımlayın.`, code);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', c => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

module.exports = { downloadVerified, sha256File, DownloadError, TLS_ERROR_CODES };
