const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const archiver = require('archiver');
const { PROJECT_ROOT } = require('../utils/paths');
const { writeIcon } = require('./icon');

const TEMPLATES = path.join(PROJECT_ROOT, 'templates');
const INIT_TARGET = '/docker-entrypoint-initdb.d';

/** Klasör/uygulama adı: Windows'ta geçersiz karakterler temizlenir. */
function sanitizeAppName(name) {
  const cleaned = String(name || '').replace(/^@[^/]+\//, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned || 'app';
}

/** LOCALAPPDATA klasörü ve named pipe için güvenli kimlik. */
function toAppId(name) {
  return sanitizeAppName(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

/**
 * Compose DB servisinin /docker-entrypoint-initdb.d bind mount'larından .sql dosyalarını toplar.
 * @returns {{ files: string[], warnings: string[] }}
 */
function collectInitScripts(svc, projectDir) {
  const files = [];
  const warnings = [];
  for (const vol of svc.volumes || []) {
    let source;
    let target;
    if (typeof vol === 'string') {
      const m = /^(.+?):(\/[^:]*)(?::[a-zA-Z,]+)?$/.exec(vol);
      if (!m) continue;
      [, source, target] = m;
    } else if (vol && vol.type === 'bind') {
      source = vol.source;
      target = vol.target;
    } else {
      continue;
    }
    if (!target || !(target === INIT_TARGET || target.startsWith(`${INIT_TARGET}/`))) continue;
    if (!/^[.~/]|^[A-Za-z]:/.test(source)) continue; // named volume

    const abs = path.resolve(projectDir, source);
    if (!fs.existsSync(abs)) {
      warnings.push(`${svc.name}: init script kaynağı bulunamadı: ${source}`);
      continue;
    }
    const candidates = fs.statSync(abs).isDirectory() ? fs.readdirSync(abs).map(f => path.join(abs, f)) : [abs];
    for (const file of candidates) {
      if (!fs.statSync(file).isFile()) continue;
      const name = path.basename(file);
      if (/\.sql$/i.test(name) && svc.dbType !== 'mongo' && svc.dbType !== 'redis') files.push(file);
      else warnings.push(`${svc.name}: init script ${name} atlandı (sadece .sql destekleniyor${/\.sh$/.test(name) ? '; kabuk script\'leri Windows\'ta çalıştırılmaz' : ''})`);
    }
  }
  return { files, warnings };
}

function containerPort(svc, defaultPort) {
  if (svc.ports && svc.ports.length) return svc.ports[0].container;
  if (svc.expose && svc.expose.length) return svc.expose[0];
  return defaultPort;
}

function refsOf(service) {
  return (service && service.remaps ? service.remaps : [])
    .filter(r => r.kind && r.targets && r.targets.length)
    .map(r => ({ key: r.key, kind: r.kind, targets: r.targets }));
}

function renderTemplate(file, vars) {
  let text = fs.readFileSync(path.join(TEMPLATES, file), 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(v);
  return text.replace(/\r?\n/g, '\r\n');
}

/**
 * Portable klasörü tamamlar: config/app.json, init script'leri, bat dosyaları, OKUBENI.txt.
 * (launcher.exe, app.exe, deps/ ve node_modules/ önceki adımlarda outDir'e yazılmış olmalı.)
 */
function writePackage({ outDir, appName, appId, compose, webService, nodeApp, preflight, depsMapping, manifest, tool, frontendService }) {
  const warnings = [];
  const services = [];
  for (const pf of preflight.services) {
    const svc = compose.dependencyServices.find(s => s.name === pf.service);
    let initDir = null;
    const init = collectInitScripts(svc, compose.projectDir);
    warnings.push(...init.warnings);
    if (init.files.length) {
      initDir = `init/${svc.name}`;
      fs.mkdirSync(path.join(outDir, initDir), { recursive: true });
      init.files.forEach(f => fs.copyFileSync(f, path.join(outDir, initDir, path.basename(f))));
    }
    if (svc.command && svc.dbType !== 'redis') {
      warnings.push(`${svc.name}: compose "command" alanı ${svc.dbType} için uygulanmıyor`);
    }
    const external = pf.status === 'external';
    services.push({
      name: svc.name,
      type: svc.dbType,
      engine: external ? pf.engine : null,
      series: pf.series,
      version: external ? `${pf.engine} (harici)` : pf.manifestEntry.version,
      deps: external ? null : depsMapping[svc.name],
      port: containerPort(svc, manifest[svc.dbType].default_port),
      env: svc.environment,
      command: svc.dbType === 'redis' && !external ? svc.command : null,
      initDir,
      dependsOn: svc.dependsOn
    });
  }

  const config = {
    schema: 1,
    appName,
    appId,
    buildId: `${new Date().toISOString()}-${crypto.randomBytes(4).toString('hex')}`,
    tool,
    openBrowser: true,
    app: { ...nodeApp.app, service: webService.name },
    frontend: nodeApp.frontend ? { ...nodeApp.frontend, service: frontendService ? frontendService.name : null } : null,
    services,
    envRefs: {
      app: refsOf(webService),
      frontend: refsOf(frontendService)
    }
  };

  fs.mkdirSync(path.join(outDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'config', 'app.json'), JSON.stringify(config, null, 2));

  const envLines = Object.entries(nodeApp.app.env).map(([k, v]) => `# ${k}=${v}`);
  fs.writeFileSync(
    path.join(outDir, 'config', '.env.template'),
    [
      '# Bu dosyayı config\\.env olarak kopyalayın ve değiştirmek istediğiniz satırların başındaki # işaretini kaldırın.',
      '# config\\.env içindeki değerler build sırasında gömülen değerlerin üzerine yazılır.',
      '# Not: Veritabanı bağlantı adresleri launcher tarafından otomatik yönetilir (port çakışmasında güncellenir).',
      '',
      ...envLines,
      ''
    ].join('\r\n')
  );

  const vars = { APP_NAME: appName, APP_ID: appId };
  fs.writeFileSync(path.join(outDir, 'Başlat.bat'), renderTemplate('start.template.bat', vars));
  fs.writeFileSync(path.join(outDir, 'Durdur.bat'), renderTemplate('stop.template.bat', vars));

  const port = (config.frontend || config.app).port;
  const serviceLines = [
    `  Uygulama: ${config.app.exe} (port ${config.app.port})`,
    ...(config.frontend ? [`  Frontend: ${config.frontend.exe} (port ${config.frontend.port})`] : []),
    ...services.map(s => `  ${s.name}: ${s.type} ${s.version} (port ${s.port})`)
  ];
  const readme = renderTemplate('readme.template.txt', {
    ...vars,
    BUILD_DATE: new Date().toISOString().slice(0, 10),
    APP_URL: `http://localhost:${port}/`,
    SERVICES: serviceLines.join('\r\n')
  });
  fs.writeFileSync(path.join(outDir, 'OKUBENI.txt'), `﻿${readme}`);

  const icon = writeIcon(path.join(outDir, 'icon.ico'), appName, [webService.build.context, compose.projectDir]);

  return { config, warnings, icon };
}

/** Klasörü `<outDir>.zip` olarak sıkıştırır. */
function zipDirectory(dir, zipPath) {
  return new Promise((resolve, reject) => {
    fs.rmSync(zipPath, { force: true });
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve(archive.pointer()));
    archive.on('warning', err => (err.code === 'ENOENT' ? null : reject(err)));
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(dir, path.basename(dir));
    archive.finalize();
  });
}

/** Masaüstüne Başlat.bat kısayolu (WScript.Shell). */
function createDesktopShortcut(outDir, appName) {
  const target = path.join(outDir, 'Başlat.bat');
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '${appName.replace(/'/g, "''")}.lnk'))`,
    `$lnk.TargetPath = '${target.replace(/'/g, "''")}'`,
    `$lnk.WorkingDirectory = '${outDir.replace(/'/g, "''")}'`,
    `$lnk.IconLocation = '${path.join(outDir, 'icon.ico').replace(/'/g, "''")},0'`,
    '$lnk.Save()'
  ].join('; ');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error(`Masaüstü kısayolu oluşturulamadı: ${(res.stderr || res.stdout || '').trim()}`);
}

module.exports = { writePackage, zipDirectory, createDesktopShortcut, sanitizeAppName, toAppId, collectInitScripts };
