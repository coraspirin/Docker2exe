#!/usr/bin/env node
/**
 * docker2exe aracının kendisini tek dosya dist/docker2exe.exe olarak paketler (npm run build:exe).
 *
 * İçerik: resmi Node.js Windows dağıtımı (npm dahil) + araç kodu + production node_modules.
 * Konsol SFX stub'ı ilk çalıştırmada bunları %LOCALAPPDATA%\docker2exe\tool\<hash> altına açar ve
 * `node.exe app\src\cli.js <argümanlar>` çalıştırır. Araç böylece gerçek dosya sisteminde çalışır
 * (npm, pkg ve koffi pkg snapshot'ı içinden çalıştırılamadığı için araç pkg ile derlenmez).
 *
 * Kullanım: node scripts/build-tool-exe.js [--node <sürüm>] [--out <klasör>]
 *   --node  gömülecek Node sürümü (varsayılan: bu script'i çalıştıran Node, örn. 26.1.0)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { downloadVerified, sha256File } = require('../src/builder/downloader');
const { runNpm } = require('../src/builder/npm');
const { compileStub, assembleSfx, zipContents, shortHash } = require('../src/packager/sfx');
const { writeIcon } = require('../src/packager/icon');
const { formatBytes } = require('../src/builder/dbBundler');
const { cacheDir, PROJECT_ROOT } = require('../src/utils/paths');
const pkg = require('../package.json');

const APP_FILES = ['package.json', 'package-lock.json', 'src', 'runtime', 'templates', 'manifests'];

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function log(msg) {
  console.log(`• ${msg}`);
}

/** nodejs.org'dan node-v<ver>-win-x64.zip'i SHASUMS256.txt ile doğrulayarak cache'e indirir. */
async function ensureNodeDist(version) {
  const name = `node-v${version}-win-x64`;
  const dir = path.join(cacheDir(), 'node-dist');
  const zip = path.join(dir, `${name}.zip`);
  fs.mkdirSync(dir, { recursive: true });

  const sumsUrl = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
  const res = await fetch(sumsUrl);
  if (!res.ok) throw new Error(`${sumsUrl} alınamadı (HTTP ${res.status}); --node ile geçerli bir sürüm verin`);
  const line = (await res.text()).split('\n').find(l => l.trim().endsWith(` ${name}.zip`));
  if (!line) throw new Error(`SHASUMS256.txt içinde ${name}.zip yok`);
  const sha256 = line.trim().split(/\s+/)[0];

  if (fs.existsSync(zip) && (await sha256File(zip)) === sha256) return { zip, name };
  log(`Node ${version} indiriliyor`);
  await downloadVerified({ url: `https://nodejs.org/dist/v${version}/${name}.zip`, dest: zip, sha256 });
  return { zip, name };
}

async function main() {
  const nodeVersion = argValue('--node', process.versions.node).replace(/^v/, '');
  if (Number(nodeVersion.split('.')[0]) < 22) throw new Error('docker2exe Node ≥22 gerektirir');
  const outDir = path.resolve(argValue('--out', path.join(PROJECT_ROOT, 'dist')));
  const staging = path.join(outDir, '.staging');
  const payload = path.join(outDir, '.payload.zip');
  const output = path.join(outDir, 'docker2exe.exe');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  try {
    const { zip, name } = await ensureNodeDist(nodeVersion);
    log(`Node ${nodeVersion} açılıyor`);
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const res = spawnSync(tar, ['-xf', zip, '-C', staging], { encoding: 'utf8', windowsHide: true });
    if (res.status !== 0) throw new Error(`Node zip açılamadı: ${res.stderr || res.error}`);
    fs.renameSync(path.join(staging, name), path.join(staging, 'node'));

    log('Araç dosyaları kopyalanıyor');
    const appDir = path.join(staging, 'app');
    for (const f of APP_FILES) fs.cpSync(path.join(PROJECT_ROOT, f), path.join(appDir, f), { recursive: true });

    log('Production bağımlılıkları kuruluyor (npm ci --omit=dev)');
    await runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: appDir });

    log('Payload sıkıştırılıyor');
    await zipContents(staging, payload);

    log('SFX stub derleniyor');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd2e-tool-'));
    try {
      const icon = path.join(tmp, 'icon.ico');
      writeIcon(icon, 'docker2exe', []);
      const stub = path.join(tmp, 'stub.exe');
      await compileStub({ gui: false, output: stub, icon, title: 'docker2exe', version: pkg.version });
      const size = await assembleSfx({
        stub,
        zip: payload,
        output,
        meta: {
          name: 'docker2exe',
          id: 'docker2exe',
          root: 'docker2exe\\tool',
          version: await shortHash(payload),
          exe: 'node\\node.exe',
          args: '"{dir}\\app\\src\\cli.js"'
        }
      });
      console.log(`\n✔ ${output} (${formatBytes(size)}, Node ${nodeVersion}, docker2exe ${pkg.version})`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(payload, { force: true });
  }
}

main().catch(err => {
  console.error(`\n✖ ${err.message}`);
  process.exitCode = 1;
});
