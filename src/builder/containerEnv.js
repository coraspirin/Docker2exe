const fs = require('fs');
const path = require('path');

// Launcher bu yer tutucuları başlatma anında gerçek yollarla değiştirir (bkz. runtime/launcher.js expandPlaceholders)
const DATA_PLACEHOLDER = '${D2E_DATA_DIR}';
const INSTALL_PLACEHOLDER = '${D2E_INSTALL_DIR}';
// Base image'lerin kendi ortamı; Windows'ta anlamsız
const SKIP_KEYS = new Set(['PATH', 'HOME', 'NODE_VERSION', 'YARN_VERSION', 'HOSTNAME']);
const CONTAINER_PATH_RE = /^\/[^\s:;]*$/;

/**
 * Docker'da uygulamanın gördüğü ortam: Dockerfile ENV + compose environment (compose önceliklidir).
 * Container yolu olan değerler pakete eşlenir:
 *   - volume altındaki yollar (compose named volume / Dockerfile VOLUME) → ${D2E_DATA_DIR}/volumes/<ad>/...
 *     (%LOCALAPPDATA%\<app>\data; paket güncellense de veri korunur)
 *   - imaj içindeki yollar (WORKDIR'a göre) → ${D2E_INSTALL_DIR}/app/... (pakette varsa)
 *   - eşlenemeyenler çıkarılır; uygulama kendi varsayılanını kullanır
 *
 * @param {{ workdir: string, env: object, volumes: string[] }|null} container Dockerfile son stage bilgisi
 * @param {object} webService composeParser servisi (resolvedEnvironment, volumes)
 * @param {string} appCwd pakette uygulamanın klasörü (app veya app/server)
 * @param {string} outDir paket klasörü (eşlenen yolların varlık kontrolü için)
 */
function buildContainerEnv(container, webService, appCwd, outDir) {
  const infos = [];
  const warnings = [];
  const dockerEnv = container ? container.env || {} : {};
  const composeEnv = webService.resolvedEnvironment || {};
  const env = {};
  for (const [k, v] of Object.entries(dockerEnv)) if (!SKIP_KEYS.has(k)) env[k] = v;
  Object.assign(env, composeEnv);

  const volumes = collectVolumes(container, webService, warnings);
  const imageRoot = container ? imageRootFor(container.workdir, appCwd) : null;

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !CONTAINER_PATH_RE.test(value) || value === '/' || key === 'PORT') continue;
    const volume = volumes.find(v => value === v.target || value.startsWith(`${v.target}/`));
    if (volume) {
      const rest = value.slice(volume.target.length);
      env[key] = `${DATA_PLACEHOLDER}/volumes/${volume.name}${rest}`;
      infos.push(`${key}=${value} → veri klasörü (volumes/${volume.name}${rest})`);
      continue;
    }
    const pkgRel = imageRoot && mapImagePath(value, imageRoot);
    if (pkgRel && fs.existsSync(path.join(outDir, pkgRel))) {
      env[key] = `${INSTALL_PLACEHOLDER}/${pkgRel}`;
      infos.push(`${key}=${value} → paket içi ${pkgRel}`);
      continue;
    }
    // Compose'da açıkça verilmiş bir değer de olsa Windows'ta geçersiz; kaldırılıp uygulamanın varsayılanına bırakılır
    delete env[key];
    warnings.push(`${key}=${value} container yolu pakette karşılığı olmadığı için kaldırıldı; uygulama kendi varsayılanını kullanacak (gerekirse config\\.env ile verin)`);
  }
  return { env, infos, warnings };
}

/** compose named volume'ları + Dockerfile VOLUME'ları; bind mount'lar veri klasörüne taşınmaz. */
function collectVolumes(container, webService, warnings) {
  const out = [];
  const add = (target, name) => {
    if (!target || out.some(v => v.target === target)) return;
    out.push({ target: target.replace(/\/+$/, '') || '/', name: slug(name || target) });
  };
  for (const v of webService.volumes || []) {
    let source = null;
    let target = null;
    let type = null;
    if (typeof v === 'string') {
      const parts = v.split(':');
      const idx = parts.map((p, i) => (p.startsWith('/') ? i : -1)).filter(i => i > 0 || parts.length === 1).pop();
      if (idx === undefined || idx === -1) continue;
      target = parts[idx];
      source = parts.slice(0, idx).join(':') || null;
      type = source && /^[.~/]|^[A-Za-z]:/.test(source) ? 'bind' : 'volume';
    } else if (v && typeof v === 'object') {
      ({ source = null, target = null, type = 'volume' } = v);
    }
    if (!target) continue;
    if (type === 'bind') {
      warnings.push(`Bind mount (${source}:${target}) pakete taşınmadı; bu yoldaki dosyalar Windows'ta bulunmayacak`);
      continue;
    }
    add(target, source);
  }
  for (const target of (container && container.volumes) || []) add(target, null);
  return out.sort((a, b) => b.target.length - a.target.length);
}

/**
 * Container'daki uygulama kökü: WORKDIR /app/server ↔ paket app/server ise /app ↔ app.
 * WORKDIR paketteki alt yolla bitmiyorsa WORKDIR'ın kendisi uygulama köküne eşlenir.
 */
function imageRootFor(workdir, appCwd) {
  const sub = appCwd.split('/').slice(1); // 'app/server' → ['server']
  const wd = workdir.split('/').filter(Boolean);
  if (sub.length && wd.length >= sub.length && wd.slice(-sub.length).join('/') === sub.join('/')) {
    return { container: '/' + wd.slice(0, -sub.length).join('/'), pkg: 'app' };
  }
  return { container: workdir, pkg: appCwd };
}

function mapImagePath(value, root) {
  const base = root.container === '/' ? '' : root.container;
  if (value === base) return root.pkg;
  if (!value.startsWith(`${base}/`)) return null;
  return `${root.pkg}${value.slice(base.length)}`;
}

function slug(s) {
  return String(s).replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'root';
}

module.exports = { buildContainerEnv, DATA_PLACEHOLDER, INSTALL_PLACEHOLDER };
