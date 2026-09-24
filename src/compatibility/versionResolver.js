const fs = require('fs');
const path = require('path');

const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', '..', 'manifests', 'db-manifest.json');

// CLI'daki tip bazlı kısayol bayrakları → manifest DB tipi
const TYPE_FLAGS = {
  pgVersion: 'postgres',
  redisVersion: 'redis',
  mongoVersion: 'mongo',
  mysqlVersion: 'mysql',
  mariadbVersion: 'mariadb'
};

function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`DB manifest okunamadı (${manifestPath}): ${err.message}`);
  }
  for (const [type, def] of Object.entries(manifest)) {
    if (type.startsWith('_')) continue;
    for (const key of ['supported_majors', 'eol_majors', 'experimental_majors']) {
      if (!Array.isArray(def[key])) throw new Error(`DB manifest geçersiz: ${type}.${key} bir dizi olmalı`);
      def[key] = def[key].map(String);
    }
    if (!def.versions || typeof def.versions !== 'object') throw new Error(`DB manifest geçersiz: ${type}.versions eksik`);
    def.series_granularity = def.series_granularity || 'major';
    def.aliases = def.aliases || {};
  }
  return manifest;
}

/**
 * Image tag'inden versiyon serisini çıkarır. Varyant sonekleri yok sayılır.
 *   major: `15-alpine` → '15', `7.2.4-bookworm` → '7'
 *   minor: `8.4.2` → '8.4', `8` → { majorOnly: '8' } (alias ile çözülür)
 * `latest`, `alpine`, tag yok → null.
 */
function parseSeries(tag, granularity = 'major') {
  if (!tag) return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:[.\-_]|$)/i.exec(String(tag));
  if (!m) return null;
  if (granularity === 'major') return { series: m[1] };
  if (m[2] === undefined) return { majorOnly: m[1] };
  return { series: `${m[1]}.${m[2]}` };
}

/** Geriye dönük uyumluluk: major sayısı. */
function parseMajor(tag) {
  const r = parseSeries(tag, 'major');
  return r ? Number(r.series) : null;
}

/**
 * CLI override'larını normalize eder (değerler string olarak tutulur, tip bazında resolve sırasında yorumlanır).
 * @returns {{ byService: Record<string, string>, byType: Record<string, string> }}
 */
function parseOverrides(opts = {}) {
  const byService = {};
  for (const item of opts.dbVersion || []) {
    const m = /^([^=]+)=v?(\d+(?:\.\d+)?)$/.exec(String(item).trim());
    if (!m) throw new Error(`--db-version değeri "<servis>=<versiyon>" biçiminde olmalı (örn. db=16 veya mysql=8.4): "${item}"`);
    byService[m[1]] = m[2];
  }
  const byType = {};
  for (const [flag, type] of Object.entries(TYPE_FLAGS)) {
    if (opts[flag] === undefined) continue;
    const m = /^v?(\d+(?:\.\d+)?)$/.exec(String(opts[flag]).trim());
    if (!m) throw new Error(`${flagName(flag)} bir versiyon serisi almalı (örn. 16 veya 8.4): "${opts[flag]}"`);
    byType[type] = m[1];
  }
  return { byService, byType };
}

/**
 * Tüm DB servisleri için toplu pre-flight kontrolü. İlk hatada durmaz; her servis için sonuç üretir.
 * options.externalEngines: { redis: 'memurai' } — o tip pakete gömülmez, hedef makinedeki kurulum kullanılır.
 * @returns {{ ok: boolean, services: Array<object>, errors: string[], warnings: string[], infos: string[] }}
 */
function resolveVersions(dependencyServices, manifest, overrides = { byService: {}, byType: {} }, options = {}) {
  const externalEngines = options.externalEngines || {};
  const errors = [];
  const warnings = [];
  const infos = [];
  const services = [];

  const knownNames = new Set(dependencyServices.map(s => s.name));
  for (const name of Object.keys(overrides.byService)) {
    if (!knownNames.has(name)) {
      errors.push(`--db-version "${name}" için DB servisi yok (DB servisleri: ${[...knownNames].join(', ') || '-'})`);
    }
  }
  const usedTypes = new Set(dependencyServices.map(s => s.dbType));
  for (const type of Object.keys(overrides.byType)) {
    if (!usedTypes.has(type)) errors.push(`${type} versiyonu verildi ama compose'da ${type} servisi yok`);
  }

  for (const svc of dependencyServices) {
    const result = externalEngines[svc.dbType]
      ? checkExternal(svc, externalEngines[svc.dbType])
      : checkService(svc, manifest, overrides);
    services.push(result);
    result.errors.forEach(e => errors.push(`[${svc.name}] ${e}`));
    result.warnings.forEach(w => warnings.push(`[${svc.name}] ${w}`));
    result.infos.forEach(i => infos.push(`[${svc.name}] ${i}`));
  }

  // Aynı tipte birden fazla servis: her biri kendi binary'si ve izole veri klasörüyle çalışır.
  const byType = groupBy(services, s => s.dbType);
  for (const [type, list] of Object.entries(byType)) {
    if (list.length < 2) continue;
    const desc = list.map(s => `${s.service}${s.series ? ` (v${s.series})` : ''} → data/${s.service}/`).join(', ');
    infos.push(`${list.length} ayrı ${type} servisi var; her biri izole çalışacak: ${desc}`);
  }

  return { ok: errors.length === 0, services, errors, warnings, infos };
}

/** Harici motor (örn. hedef makinede kurulu Memurai servisi): binary gömülmez, versiyon kontrolü yapılamaz. */
function checkExternal(svc, engine) {
  const warnings = [];
  const infos = [];
  infos.push(`${engine} kullanılacak: binary pakete gömülmez; hedef makinede ${engine} servisi kurulu ve çalışır olmalı (launcher sadece sağlık kontrolü yapar, başlatmaz/durdurmaz)`);
  const cmd = Array.isArray(svc.command) ? svc.command.join(' ') : String(svc.command || '');
  if (/--requirepass/.test(cmd)) {
    warnings.push(`compose'daki --requirepass ${engine}'a uygulanamaz; şifre ${engine} yapılandırmasından gelir ve uygulamanın bağlantı bilgisiyle aynı olmalı`);
  }
  warnings.push(`${engine} versiyonu hedef makinedeki kuruluma bağlı; image tag'i (${svc.imageTag || 'yok'}) ile uyumluluk doğrulanamaz`);
  return {
    service: svc.name, dbType: svc.dbType, image: svc.image, tag: svc.imageTag,
    series: null, seriesSource: null, status: 'external', engine, manifestEntry: null,
    errors: [], warnings, infos
  };
}

function checkService(svc, manifest, overrides) {
  const errors = [];
  const warnings = [];
  const infos = [];
  const result = {
    service: svc.name,
    dbType: svc.dbType,
    image: svc.image,
    tag: svc.imageTag,
    series: null,
    seriesSource: null,
    status: 'error',
    manifestEntry: null,
    errors,
    warnings,
    infos
  };

  const def = manifest[svc.dbType];
  if (!def || svc.dbType.startsWith('_')) {
    errors.push(`Manifest'te "${svc.dbType}" tanımı yok`);
    return result;
  }
  const granularity = def.series_granularity;

  // 1) Tag'den seri
  const fromTag = resolveSeries(parseSeries(svc.imageTag, granularity), def, svc.image, infos);
  if (fromTag && fromTag.error) {
    errors.push(fromTag.error + overrideHint(svc));
    return result;
  }

  // 2) CLI override
  const overrideRaw = overrides.byService[svc.name] ?? overrides.byType[svc.dbType];
  let fromOverride = null;
  if (overrideRaw !== undefined) {
    fromOverride = resolveSeries(parseSeries(overrideRaw, granularity), def, `CLI değeri ${overrideRaw}`, infos);
    if (!fromOverride || fromOverride.error) {
      errors.push(fromOverride ? fromOverride.error : `CLI versiyonu yorumlanamadı: ${overrideRaw}`);
      return result;
    }
  }

  if (!fromTag) {
    if (!fromOverride) {
      const why = !svc.imageTag ? 'tag belirtilmemiş' : `tag "${svc.imageTag}" versiyon içermiyor`;
      errors.push(`${svc.image}: ${why} — hedef versiyonu belirtin:${overrideHint(svc)}`);
      return result;
    }
    result.series = fromOverride.series;
    result.seriesSource = 'cli';
  } else {
    if (fromOverride && fromOverride.series !== fromTag.series) {
      errors.push(`Image tag'i v${fromTag.series} ama CLI'da v${fromOverride.series} verildi — çelişki; compose'daki tag'i veya bayrağı düzeltin`);
      return result;
    }
    result.series = fromTag.series;
    result.seriesSource = 'image tag';
  }

  const series = result.series;
  const supportedList = `desteklenen: ${def.supported_majors.join(', ') || '-'}${def.experimental_majors.length ? `; deneysel: ${def.experimental_majors.join(', ')}` : ''}`;

  if (def.eol_majors.includes(series)) {
    errors.push(`${svc.dbType} ${series} EOL (destek sonu) — ${supportedList}`);
    return result;
  }
  const experimental = def.experimental_majors.includes(series);
  if (!experimental && !def.supported_majors.includes(series)) {
    errors.push(`${svc.dbType} ${series} desteklenmiyor — ${supportedList}`);
    return result;
  }

  const entry = def.versions[series];
  if (!entry) {
    errors.push(`${svc.dbType} ${series} manifest'te destekleniyor ama binary tanımı (url/sha256) yok`);
    return result;
  }
  const placeholder = ['url', 'sha256'].filter(k => !entry[k] || /^<.*>$/.test(String(entry[k])));
  if (placeholder.length) {
    errors.push(`${svc.dbType} ${series} manifest girdisinde ${placeholder.join(' ve ')} doldurulmamış (yer tutucu)`);
    return result;
  }
  if (!/^[0-9a-f]{64}$/i.test(entry.sha256)) {
    errors.push(`${svc.dbType} ${series} manifest girdisindeki sha256 geçersiz`);
    return result;
  }

  result.manifestEntry = entry;
  if (experimental) {
    result.status = 'experimental';
    warnings.push(`${svc.dbType} ${series} deneysel: test edilmedi, teorik olarak uyumlu`);
  } else if (entry.tested === false) {
    result.status = 'experimental';
    warnings.push(`${svc.dbType} ${series} (${entry.version}) binary'si bu araçla henüz uçtan uca test edilmedi (manifest: tested=false)`);
  } else {
    result.status = 'ok';
  }
  return result;
}

/** parseSeries sonucunu alias'larla tamamlar. Döner: {series} | {error} | null */
function resolveSeries(parsed, def, label, infos) {
  if (!parsed) return null;
  if (parsed.series) return { series: parsed.series };
  const alias = def.aliases[parsed.majorOnly];
  if (!alias) {
    const known = Object.entries(def.aliases).map(([k, v]) => `${k}→${v}`).join(', ');
    return { error: `${label}: sadece major versiyon (${parsed.majorOnly}) içeriyor ve bu tip için seri (major.minor) gerekli${known ? ` (bilinen eşlemeler: ${known})` : ''}` };
  }
  infos.push(`${label}: "${parsed.majorOnly}" etiketi ${alias} serisi olarak yorumlandı (Docker Hub'daki güncel karşılığı)`);
  return { series: alias };
}

function overrideHint(svc) {
  const flag = Object.entries(TYPE_FLAGS).find(([, t]) => t === svc.dbType);
  return ` --db-version ${svc.name}=<versiyon>${flag ? ` veya ${flagName(flag[0])} <versiyon>` : ''}`;
}

function flagName(flag) {
  return `--${flag.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
}

function groupBy(list, keyFn) {
  const out = {};
  for (const item of list) (out[keyFn(item)] = out[keyFn(item)] || []).push(item);
  return out;
}

module.exports = { loadManifest, parseSeries, parseMajor, parseOverrides, resolveVersions, DEFAULT_MANIFEST_PATH };
