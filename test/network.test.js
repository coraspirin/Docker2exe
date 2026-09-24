const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { downloadVerified } = require('../src/builder/downloader');

const TLS_DIR = path.join(__dirname, 'fixtures', 'tls');
const BODY = crypto.randomBytes(20000);
const SHA = crypto.createHash('sha256').update(BODY).digest('hex');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'd2e-net-'));
}

// Kurumsal SSL inspection simülasyonu: güvenilmeyen (self-signed) sertifika
async function withTlsServer(fn) {
  const server = await listen(https.createServer(
    { key: fs.readFileSync(path.join(TLS_DIR, 'key.pem')), cert: fs.readFileSync(path.join(TLS_DIR, 'cert.pem')) },
    (req, res) => {
      res.writeHead(200, { 'Content-Length': BODY.length });
      res.end(BODY);
    }
  ));
  const dir = tmpDir();
  try {
    await fn(`https://127.0.0.1:${server.address().port}/pg.zip`, dir);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('güvenilmeyen sertifika: NODE_EXTRA_CA_CERTS ve --insecure önerisiyle net hata', () =>
  withTlsServer(async (url, dir) => {
    await assert.rejects(
      downloadVerified({ url, dest: path.join(dir, 'a.zip'), sha256: SHA }),
      err => /TLS sertifika doğrulaması başarısız/.test(err.message) && /NODE_EXTRA_CA_CERTS/.test(err.message) && /--insecure/.test(err.message)
    );
  }));

test('--insecure: sadece o indirme için TLS atlanır, SHA256 yine doğrulanır, process geneli etkilenmez', () =>
  withTlsServer(async (url, dir) => {
    await downloadVerified({ url, dest: path.join(dir, 'b.zip'), sha256: SHA, insecure: true });
    assert.equal(fs.readFileSync(path.join(dir, 'b.zip')).length, BODY.length);

    await assert.rejects(downloadVerified({ url, dest: path.join(dir, 'c.zip'), sha256: 'e'.repeat(64), insecure: true }), /SHA256/);

    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    await assert.rejects(
      new Promise((resolve, reject) => https.get(url, res => { res.resume(); resolve(); }).on('error', reject)),
      err => /self[- ]signed|unable to verify/i.test(err.message)
    );
  }));

test('NODE_EXTRA_CA_CERTS ile kurumsal kök sertifika tanımlanınca --insecure gerekmez', () =>
  withTlsServer(async (url, dir) => {
    const dest = path.join(dir, 'd.zip');
    const script = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'builder', 'downloader.js'))})
      .downloadVerified({ url: ${JSON.stringify(url)}, dest: ${JSON.stringify(dest)}, sha256: ${JSON.stringify(SHA)} })
      .then(() => console.log('ok'), e => { console.error(e.message); process.exit(1); })`;
    // Sunucu ana süreçte çalışırken çocuğu senkron başlatmak event loop'u bloklar; bu yüzden async spawn.
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, ['-e', script], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(TLS_DIR, 'cert.pem') }
      });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('close', code => resolve({ code, out }));
    });
    assert.equal(result.code, 0, result.out);
    assert.equal(fs.readFileSync(dest).length, BODY.length);
  }));

test('HTTP_PROXY ortam değişkeni otomatik kullanılır', async () => {
  const seen = [];
  const proxy = await listen(http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'Content-Length': BODY.length });
    res.end(BODY);
  }));
  const dir = tmpDir();
  const prev = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY };
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  delete process.env.NO_PROXY;
  try {
    // .invalid TLD asla çözülmez: indirme ancak proxy üzerinden başarılı olabilir.
    await downloadVerified({ url: 'http://d2e-proxy-test.invalid/pg.zip', dest: path.join(dir, 'p.zip'), sha256: SHA });
    assert.deepEqual(seen, ['http://d2e-proxy-test.invalid/pg.zip']);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    proxy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

