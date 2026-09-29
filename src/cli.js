#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Command, Option } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const { createTempWorkspace } = require('./utils/tempWorkspace');
const { resolveLocalSource } = require('./sources/localSource');
const { resolveGithubSource } = require('./sources/githubSource');
const { parseCompose } = require('./parser/composeParser');
const { detectStack } = require('./detector/stackDetector');
const { loadManifest, parseOverrides, resolveVersions } = require('./compatibility/versionResolver');
const { bundleDatabases, cacheSizeWarning, cleanCache, formatBytes } = require('./builder/dbBundler');
const { buildNodeApp } = require('./builder/nodeBuilder');
const { generateLauncher } = require('./builder/launcherGen');
const { PKG_NODE_TARGETS } = require('./builder/pkgCompiler');
const { writePackage, zipDirectory, createDesktopShortcut, sanitizeAppName, toAppId } = require('./packager/portablePackager');
const { createAppExe } = require('./packager/sfx');
const { cacheDir } = require('./utils/paths');
const report = require('./utils/report');
const pkg = require('../package.json');

class PreflightError extends Error {}

function collect(value, previous) {
  return [...previous, value];
}

function parsePortOption(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port geçerli bir port olmalı: "${value}"`);
  return n;
}

function parseNodeTarget(value) {
  const n = Number(String(value).replace(/^node/i, ''));
  if (!PKG_NODE_TARGETS.includes(n)) throw new Error(`--node-target desteklenen değerlerden biri olmalı: ${PKG_NODE_TARGETS.join(', ')}`);
  return n;
}

function readPackageName(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')).name || null;
  } catch {
    return null;
  }
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

/** Önceki build çıktısını sadece docker2exe'nin ürettiği bir klasörse siler. */
function prepareOutputDir(outDir) {
  if (fs.existsSync(outDir)) {
    const ours = fs.existsSync(path.join(outDir, 'config', 'app.json')) || fs.readdirSync(outDir).length === 0;
    if (!ours) throw new Error(`Çıktı klasörü zaten var ve docker2exe çıktısına benzemiyor, silinmedi: ${outDir}`);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/** Konumsal kaynak argümanı: GitHub URL'i veya yerel klasör. */
function applySourceArgument(source, opts) {
  if (!source) return opts;
  if (opts.path || opts.github) throw new Error('Kaynak hem konumsal argüman hem --path/--github ile verilemez');
  const cleaned = source.trim().replace(/^"+|"+$/g, ''); // `"C:\Proje Klasörü\"` → sondaki kaçmış tırnak
  return /^(https?:\/\/|git@)/i.test(cleaned) ? { ...opts, github: cleaned } : { ...opts, path: cleaned };
}

/** docker2exe.exe Explorer'dan argümansız açıldığında proje klasörünü sorar (sürükle-bırak da olur). */
async function promptSource() {
  const readline = require('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.bold(`docker2exe ${pkg.version}`) + ' — Docker Compose projesini Windows exe paketine dönüştürür\n');
    const answer = await rl.question('Proje klasörünü buraya sürükleyin (veya yolunu / GitHub URL\'ini yazın) ve Enter\'a basın:\n> ');
    return answer.trim() || null;
  } finally {
    rl.close();
  }
}

const FORMAT_ALIASES = {
  exe: ['exe'],
  '1': ['exe'],
  klasor: ['folder'],
  'klasör': ['folder'],
  folder: ['folder'],
  '2': ['folder'],
  zip: ['zip'],
  '3': ['zip'],
  hepsi: ['exe', 'folder', 'zip'],
  all: ['exe', 'folder', 'zip'],
  '4': ['exe', 'folder', 'zip']
};

/** "exe,zip" / "1,3" / "hepsi" → { exe, folder, zip }. */
function parseFormats(value) {
  const tokens = String(value).toLowerCase().split(/[\s,;+]+/).filter(Boolean);
  if (!tokens.length) throw new Error('Çıktı türü boş');
  const formats = { exe: false, folder: false, zip: false };
  for (const t of tokens) {
    const kinds = FORMAT_ALIASES[t];
    if (!kinds) throw new Error(`Bilinmeyen çıktı türü: "${t}" (geçerli: exe, klasor, zip, hepsi)`);
    kinds.forEach(k => { formats[k] = true; });
  }
  return formats;
}

/** Build başlamadan önce hangi çıktıların üretileceğini sorar (Enter → sadece exe). */
async function promptFormats() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator](); // satırları kuyruklar: soru yazılmadan gelen giriş kaybolmaz
  try {
    console.log(chalk.bold('\nÇıktı türü'));
    console.log(`  1) Tek exe  ${chalk.gray('— hedef makineye tek dosya kopyalanır, çift tıklayınca çalışır (önerilen)')}`);
    console.log(`  2) Klasör   ${chalk.gray('— Başlat.bat / Durdur.bat ile taşınabilir klasör')}`);
    console.log(`  3) Zip      ${chalk.gray('— klasörün zip\'i')}`);
    console.log(`  4) Hepsi`);
    for (;;) {
      process.stdout.write('Seçiminiz (birden fazlası için virgülle, örn. 1,3) [1]: ');
      const { value, done } = await lines.next();
      if (done) return parseFormats('1'); // giriş kapandı → varsayılan
      const answer = value.trim();
      try {
        return parseFormats(answer || '1');
      } catch (err) {
        console.log(chalk.yellow(`  ${err.message}`));
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * Çıktı türleri: --format verildiyse o; --no-zip/--no-exe verildiyse kalanlar; hiçbiri yoksa etkileşimli
 * terminalde build öncesinde sorulur, değilse (CI, yönlendirilmiş çıktı) hepsi üretilir.
 */
function resolveFormats(opts) {
  if (opts.format) {
    if (opts.zip === false || opts.exe === false) throw new Error('--format ile --no-zip/--no-exe birlikte kullanılamaz');
    return { formats: parseFormats(opts.format), ask: false };
  }
  const explicit = opts.zip === false || opts.exe === false;
  const ask = !explicit && !opts.json && !opts.check && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return { formats: { exe: opts.exe !== false, folder: true, zip: opts.zip !== false }, ask };
}

async function buildCommand(opts) {
  // Ağ/disk işlemlerinden önce tüm bayrakları doğrula.
  if (!!opts.path === !!opts.github) {
    throw new Error('Tam olarak bir kaynak belirtin: --path <klasör> veya --github <url>');
  }
  if (!opts.github && (opts.branch || opts.token)) {
    throw new Error('--branch ve --token sadece --github ile kullanılabilir');
  }
  const port = opts.port !== undefined ? parsePortOption(opts.port) : undefined;
  const nodeTarget = opts.nodeTarget !== undefined ? parseNodeTarget(opts.nodeTarget) : undefined;
  const overrides = parseOverrides(opts);
  const REDIS_ENGINES = ['redis-windows', 'memurai'];
  if (!REDIS_ENGINES.includes(opts.redisEngine)) {
    throw new Error(`--redis-engine şunlardan biri olmalı: ${REDIS_ENGINES.join(', ')}`);
  }
  const externalEngines = opts.redisEngine === 'memurai' ? { redis: 'memurai' } : {};
  let { formats, ask: askFormats } = resolveFormats(opts);
  const manifest = loadManifest();
  const interactive = !opts.json && process.stderr.isTTY;

  const workspace = await createTempWorkspace();
  const spinner = ora({ isEnabled: interactive });
  const step = text => {
    if (spinner.isSpinning) spinner.succeed();
    spinner.start(text);
  };
  try {
    // ------------------------------------------------------------ kaynak + pre-flight
    step(opts.github ? `Repo klonlanıyor: ${opts.github}` : `Kaynak kopyalanıyor: ${opts.path}`);
    const source = opts.github
      ? await resolveGithubSource(opts.github, workspace, { branch: opts.branch, token: opts.token })
      : await resolveLocalSource(opts.path, workspace);

    step('Compose dosyası parse ediliyor');
    const compose = parseCompose(source.projectDir, { service: opts.service });

    step('Uygulama ve DB uyumluluğu kontrol ediliyor');
    const findings = { errors: [], warnings: [...compose.report.warnings], infos: [] };
    let stack = null;
    if (compose.webService) {
      stack = detectStack(compose.webService, { entry: opts.entry, port, rootDir: compose.projectDir });
      if (!stack.packageJson) {
        const nodeServices = compose.buildServices
          .filter(s => s !== compose.webService && fs.existsSync(path.join(s.build.context, 'package.json')))
          .map(s => s.name);
        stack.errors.push(
          nodeServices.length
            ? `package.json içeren build servisleri: ${nodeServices.join(', ')} → --service <ad> ile seçin`
            : 'Compose\'daki hiçbir build servisinde package.json yok; bu araç sadece Node.js uygulamalarını paketler'
        );
      }
      if (stack.node && nodeTarget) {
        if (stack.node.source === 'varsayılan') stack.warnings = stack.warnings.filter(w => !w.startsWith('Node versiyonu tespit edilemedi'));
        stack.node = { ...stack.node, major: nodeTarget, source: 'cli (--node-target)' };
      } else if (stack.node && !PKG_NODE_TARGETS.includes(stack.node.major)) {
        stack.errors.push(`Node ${stack.node.major} (${stack.node.source}) için paketleme hedefi yok (desteklenen: ${PKG_NODE_TARGETS.join(', ')}) → --node-target <major> ile açıkça seçin`);
      }
      findings.errors.push(...stack.errors);
      findings.warnings.push(...stack.warnings);
      findings.infos.push(...stack.infos);
    } else {
      findings.errors.push('Web servisi bulunamadı: compose içinde "build" alanı olan (DB olmayan) bir servis yok');
    }
    const preflight = resolveVersions(compose.dependencyServices, manifest, overrides, { externalEngines });
    findings.errors.push(...preflight.errors);
    findings.warnings.push(...preflight.warnings);
    findings.infos.push(...preflight.infos);
    if (findings.errors.length) spinner.fail('Pre-flight kontrolü başarısız');
    else spinner.succeed('Pre-flight kontrolü tamamlandı');

    if (opts.json) {
      const out = { compose: report.toPublicJson(compose), stack, preflight, findings };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } else {
      report.printComposeSummary(compose, { origin: source.origin });
      if (stack) report.printStackSummary(stack);
      report.printPreflight(preflight);
      report.printFindings(findings);
    }
    if (findings.errors.length) {
      throw new PreflightError(`Pre-flight kontrolünde ${findings.errors.length} hata var — build durduruldu`);
    }
    if (opts.check || opts.json) return;
    // Pre-flight geçtikten sonra, uzun build başlamadan sorulur.
    if (askFormats) formats = await promptFormats();

    // ------------------------------------------------------------ build
    // Uygulama alt klasördeyse (server/) proje adı kökteki package.json'dan gelir ("defterim-server" değil "defterim")
    const contextPkgName = stack.appDir !== compose.webService.build.context ? readPackageName(compose.webService.build.context) : null;
    const appName = sanitizeAppName(opts.name || contextPkgName || stack.packageJson.name || path.basename(source.origin).replace(/\.git$/, ''));
    const appId = toAppId(appName);
    const outRoot = path.resolve(opts.out || 'build-output');
    const outDir = path.join(outRoot, appName);
    const staging = `${outDir}.partial`;
    fs.mkdirSync(outRoot, { recursive: true });
    prepareOutputDir(outDir);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const logFile = path.join(outRoot, `${appName}.build.log`);
    fs.writeFileSync(logFile, `docker2exe ${pkg.version} build — ${new Date().toISOString()}\nKaynak: ${source.origin}\n`);
    const buildWarnings = [];

    console.log(chalk.bold(`\nBuild: ${appName}`) + chalk.gray(`  (log: ${logFile})`));

    let depsMapping = {};
    if (preflight.services.length) {
      step('DB binary\'leri hazırlanıyor');
      depsMapping = await bundleDatabases(preflight.services, manifest, staging, {
        offline: opts.offline,
        insecure: opts.insecure,
        log: msg => {
          spinner.stop();
          console.log(chalk.yellow(`  ${msg}`));
          spinner.start();
        },
        onProgress: (key, received, total) => {
          spinner.text = `DB binary indiriliyor: ${key} ${formatBytes(received)}${total ? ` / ${formatBytes(total)} (%${Math.floor((received / total) * 100)})` : ''}`;
        },
        onExtract: key => { spinner.text = `DB binary açılıyor: ${key}`; }
      });
    }

    const nodeApp = await buildNodeApp({
      compose,
      webService: compose.webService,
      stack,
      outDir: staging,
      nodeMajor: stack.node.major,
      logFile,
      step
    });
    buildWarnings.push(...nodeApp.warnings);

    step('launcher.exe hazırlanıyor (Job Object self-test)');
    await generateLauncher(staging, { logFile });

    step('Paket oluşturuluyor');
    const pkgResult = writePackage({
      outDir: staging,
      appName,
      appId,
      compose,
      webService: compose.webService,
      nodeApp,
      preflight,
      depsMapping,
      manifest,
      tool: `docker2exe ${pkg.version}`,
      frontendService: nodeApp.frontendService
    });
    buildWarnings.push(...pkgResult.warnings);
    nodeApp.infos.push(pkgResult.icon.source === 'project'
      ? `icon.ico projedeki favicon'dan alındı (${path.relative(compose.projectDir, pkgResult.icon.from)})`
      : 'icon.ico uygulama adının baş harfiyle üretildi (projede favicon.ico yok)');
    fs.renameSync(staging, outDir);

    // Klasör her zaman üretilir (zip ve exe ondan yapılır); seçilmediyse sonda silinir.
    let zipPath = null;
    if (formats.zip || formats.exe) {
      step('Zip oluşturuluyor');
      zipPath = formats.zip ? `${outDir}.zip` : path.join(workspace.dir, `${appName}.zip`);
      await zipDirectory(outDir, zipPath);
    }
    let exePath = null;
    if (formats.exe) {
      // Zip, tek dosya exe'nin payload'ı olarak yeniden kullanılır (tekrar sıkıştırılmaz); kök klasör açılırken soyulur.
      step('Tek dosya exe oluşturuluyor');
      exePath = `${outDir}.exe`;
      await createAppExe({
        zip: zipPath,
        strip: `${path.basename(outDir)}/`,
        output: exePath,
        appName,
        appId,
        icon: path.join(outDir, 'icon.ico'),
        version: pkg.version,
        logFile
      });
      if (!formats.zip) {
        fs.rmSync(zipPath, { force: true });
        zipPath = null;
      }
    }
    const folderSize = formats.folder ? dirSize(outDir) : 0;
    if (!formats.folder) fs.rmSync(outDir, { recursive: true, force: true });
    if (opts.desktopShortcut) {
      if (formats.folder || exePath) {
        step('Masaüstü kısayolu oluşturuluyor');
        createDesktopShortcut(formats.folder ? path.join(outDir, 'Başlat.bat') : exePath, appName);
      } else {
        buildWarnings.push('--desktop-shortcut: sadece zip üretildiği için kısayol oluşturulmadı');
      }
    }
    spinner.succeed('Build tamamlandı');

    // ------------------------------------------------------------ özet
    if (nodeApp.infos.length) {
      console.log('');
      nodeApp.infos.forEach(i => console.log(chalk.gray(`  • ${i}`)));
    }
    if (buildWarnings.length) {
      console.log(chalk.yellow.bold(`\nBuild uyarıları (${buildWarnings.length})`));
      buildWarnings.forEach(w => console.log(chalk.yellow(`  ⚠ ${w}`)));
    }
    console.log('');
    if (exePath) console.log(chalk.green.bold('✔ Tek exe: ') + exePath + chalk.gray(` (${formatBytes(fs.statSync(exePath).size)})`));
    if (formats.folder) console.log(chalk.green.bold('✔ Klasör:  ') + outDir + chalk.gray(` (${formatBytes(folderSize)})`));
    if (zipPath) console.log(chalk.green.bold('✔ Zip:     ') + zipPath + chalk.gray(` (${formatBytes(fs.statSync(zipPath).size)})`));
    if (exePath || formats.folder) console.log(chalk.gray(`  Başlatmak için: ${exePath || path.join(outDir, 'Başlat.bat')}`));
    else console.log(chalk.gray(`  Zip'i açıp içindeki Başlat.bat'ı çalıştırın`));
    const cacheWarning = cacheSizeWarning();
    if (cacheWarning) console.log(chalk.yellow(`\nℹ ${cacheWarning}`));
  } catch (err) {
    if (spinner.isSpinning) spinner.fail();
    throw err;
  } finally {
    await workspace.cleanup();
  }
}

async function cleanCacheCommand(opts) {
  const result = cleanCache({ keepLatest: Boolean(opts.keepLatest) });
  if (!result.removed.length && !result.kept.length) {
    console.log(`Cache boş: ${cacheDir()}`);
    return;
  }
  result.removed.forEach(r => console.log(chalk.gray(`  silindi: ${r}`)));
  result.kept.forEach(k => console.log(chalk.gray(`  tutuldu: ${k}`)));
  console.log(chalk.green(`✔ ${formatBytes(result.freedBytes)} boşaltıldı (${cacheDir()})`));
}

function addBuildOptions(cmd) {
  return cmd
    .argument('[kaynak]', 'proje klasörü veya GitHub URL\'i (--path/--github yerine)')
    .option('--path <klasör>', 'yerel proje klasörü')
    .option('--github <url>', 'GitHub repo URL\'i')
    .option('--branch <ad>', 'klonlanacak branch (sadece --github)')
    .addOption(new Option('--token <pat>', 'private repo için GitHub PAT (sadece --github)').env('GITHUB_TOKEN'))
    .option('--service <ad>', 'web servisi olarak kullanılacak compose servisi (birden fazla build\'li servis varsa)')
    .option('--entry <dosya>', 'uygulama entry dosyası (otomatik tespit başarısızsa)')
    .option('--port <n>', 'uygulama portu (otomatik tespit başarısızsa)')
    .option('--node-target <major>', `paketlenecek Node sürümü (${PKG_NODE_TARGETS.join(', ')})`)
    .option('--db-version <servis=versiyon>', 'DB servisinin versiyonu (latest/tag\'siz image için, tekrarlanabilir)', collect, [])
    .option('--pg-version <versiyon>', 'tüm postgres servisleri için versiyon')
    .option('--redis-version <versiyon>', 'tüm redis servisleri için versiyon')
    .option('--mongo-version <versiyon>', 'tüm mongo servisleri için versiyon (örn. 7.0)')
    .option('--mysql-version <versiyon>', 'tüm mysql servisleri için versiyon (örn. 8.4)')
    .option('--mariadb-version <versiyon>', 'tüm mariadb servisleri için versiyon (örn. 11.4)')
    .option('--redis-engine <motor>', 'redis-windows (pakete gömülür) | memurai (hedef makinede kurulu Memurai servisi kullanılır)', 'redis-windows')
    .option('--name <ad>', 'uygulama/klasör adı (varsayılan: package.json name)')
    .option('--out <klasör>', 'çıktı klasörü', 'build-output')
    .option('--offline', 'DB binary\'lerini sadece cache\'ten kullan (ağa çıkma)')
    .option('--insecure', 'DB binary indirmelerinde TLS doğrulamasını atla (son çare; SHA256 yine kontrol edilir)')
    .option('--format <türler>', 'çıktı türleri: exe, klasor, zip veya hepsi (virgülle, örn. exe,zip); verilmezse build öncesinde sorulur')
    .option('--no-zip', 'zip oluşturma (sormadan)')
    .option('--no-exe', 'tek dosya <uygulama>.exe oluşturma (sormadan)')
    .option('--desktop-shortcut', 'masaüstüne Başlat kısayolu oluştur')
    .option('--check', 'sadece pre-flight kontrolü yap, build etme')
    .option('--json', 'pre-flight sonucunu JSON olarak yaz (build etmez)');
}

function run(argv) {
  const program = new Command();
  addBuildOptions(program)
    .name('docker2exe')
    .usage('<proje-klasörü | github-url> [seçenekler]')
    .description('Docker Compose tabanlı Node.js web uygulamalarını portable Windows paketine (klasör + zip + tek exe) dönüştürür')
    .version(pkg.version)
    .enablePositionalOptions() // alt komuttan sonraki bayraklar alt komuta ait (kök de aynı bayrakları tanımlıyor)
    .action(async (source, opts) => {
      if (!source && !opts.path && !opts.github) {
        if (process.env.D2E_OWN_CONSOLE !== '1' || !process.stdin.isTTY) return program.help();
        source = await promptSource();
        if (!source) throw new Error('Proje klasörü verilmedi');
      }
      return buildCommand(applySourceArgument(source, opts));
    });

  addBuildOptions(program.command('build'))
    .description('Kaynağı çözümle ve paketle (docker2exe <kaynak> ile aynı)')
    .action((source, opts) => buildCommand(applySourceArgument(source, opts)));

  program
    .command('clean-cache')
    .description('DB binary cache\'ini temizle')
    .option('--keep-latest', 'her DB tipi için en son kullanılan versiyonu tut')
    .action(cleanCacheCommand);

  return program.parseAsync(argv);
}

if (require.main === module) {
  run(process.argv).catch(err => {
    const label = err instanceof PreflightError ? 'Durduruldu' : 'Hata';
    console.error(chalk.red(`\n✖ ${label}: ${err.message}`));
    if (process.env.DOCKER2EXE_DEBUG && err.stack) console.error(chalk.gray(err.stack));
    process.exitCode = 1;
  });
}

module.exports = { run, applySourceArgument, parseFormats, resolveFormats, promptFormats };
