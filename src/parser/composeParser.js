const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { loadDotenvFile, normalizeEnvFileEntries } = require('./envLoader');
const { interpolateTree, interpolateString } = require('./interpolate');
const { remapEnvironment, maskSecrets } = require('./hostRemap');

const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

// Image repo adı (registry ve tag hariç) → DB tipi. Tam eşleşme; `includes` kullanılmaz,
// çünkü `mongo-express`, `redis-commander`, `postgrest` gibi araç image'leri DB değildir.
const KNOWN_DB_IMAGES = {
  postgres: 'postgres',
  postgresql: 'postgres',
  'bitnami/postgresql': 'postgres',
  redis: 'redis',
  'bitnami/redis': 'redis',
  mongo: 'mongo',
  'bitnami/mongodb': 'mongo',
  'mongodb/mongodb-community-server': 'mongo',
  mysql: 'mysql',
  'bitnami/mysql': 'mysql',
  mariadb: 'mariadb',
  'bitnami/mariadb': 'mariadb'
};
const DB_LOOKALIKE_RE = /postgres|postgis|timescale|redis|mongo|mysql|mariadb|percona/i;

class ComposeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ComposeError';
  }
}

/**
 * @param {string} projectDir
 * @param {{ env?: Record<string,string|undefined>, service?: string }} [options]
 *   env: interpolasyon için kabuk ortamı (varsayılan process.env); service: web servisi olarak seçilecek servis adı
 */
function parseCompose(projectDir, options = {}) {
  const composePath = findComposeFile(projectDir);
  if (!composePath) {
    throw new ComposeError(`Compose dosyası bulunamadı (${COMPOSE_CANDIDATES.join(', ')}): ${projectDir}`);
  }

  // Compose önceliği: kabuk ortamı > kök .env
  const dotenvPath = path.join(projectDir, '.env');
  const dotenv = fs.existsSync(dotenvPath) ? loadDotenvFile(dotenvPath) : {};
  const vars = { ...dotenv, ...pickDefined(options.env || process.env) };

  const raw = fs.readFileSync(composePath, 'utf8');
  let parsed;
  try {
    parsed = YAML.parse(raw, { merge: true });
  } catch (err) {
    throw new ComposeError(`${path.basename(composePath)} parse edilemedi: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.services || typeof parsed.services !== 'object') {
    throw new ComposeError(`${path.basename(composePath)} içinde "services" tanımı yok`);
  }

  const missing = [];
  const warnings = [];
  const doc = interpolateTree(parsed, vars, { missing });

  const serviceHosts = collectServiceHosts(doc.services);
  const dbLookalikes = new Set();

  const services = Object.entries(doc.services).map(([name, cfg]) => {
    cfg = cfg || {};
    const { dbType, repository, tag } = parseImage(cfg.image);
    if (cfg.image && !dbType && !cfg.build && DB_LOOKALIKE_RE.test(repository)) {
      dbLookalikes.add(name);
      warnings.push(`"${name}" servisi (${cfg.image}) DB'ye benziyor ama desteklenen image listesinde değil — pakete dahil edilmeyecek`);
    }

    const environment = buildEnvironment(name, cfg, projectDir, vars, missing);
    const remap = remapEnvironment(environment, serviceHosts);
    remap.warnings.forEach(w => warnings.push(`"${name}" servisi → ${w}`));

    return {
      name,
      image: cfg.image || null,
      dbType,
      imageTag: tag,
      build: normalizeBuild(name, cfg.build, projectDir),
      ports: (cfg.ports || []).map(p => normalizePort(p, name)),
      expose: (cfg.expose || []).map(e => Number(String(e).split('/')[0])),
      environment,
      resolvedEnvironment: remap.env,
      remaps: remap.changes,
      volumes: cfg.volumes || [],
      command: cfg.command === undefined || cfg.command === null ? null : cfg.command,
      dependsOn: normalizeDependsOn(cfg.depends_on).map(d => d.service),
      dependsOnDetail: normalizeDependsOn(cfg.depends_on),
      isDatabase: dbType !== null
    };
  });

  const buildServices = services.filter(s => s.build && !s.isDatabase);
  let webService = buildServices[0] || null;
  if (options.service) {
    webService = buildServices.find(s => s.name === options.service) || null;
    if (!webService) {
      const exists = services.some(s => s.name === options.service);
      throw new ComposeError(
        exists
          ? `"${options.service}" servisinin build alanı yok veya bir DB servisi; web servisi olarak seçilemez`
          : `"${options.service}" adında servis yok (servisler: ${services.map(s => s.name).join(', ')})`
      );
    }
  } else if (buildServices.length > 1) {
    warnings.push(
      `Birden fazla build edilen servis var (${buildServices.map(s => s.name).join(', ')}); web servisi olarak "${webService.name}" seçildi — farklıysa --service kullanın`
    );
  }
  const otherServices = services.filter(s => !s.build && !s.isDatabase);
  for (const s of otherServices.filter(o => !dbLookalikes.has(o.name))) {
    warnings.push(`"${s.name}" servisi (${s.image || 'image yok'}) desteklenen bir DB değil ve build alanı yok — pakete dahil edilmeyecek`);
  }

  return {
    projectDir,
    composePath,
    webService,
    buildServices,
    dependencyServices: services.filter(s => s.isDatabase),
    otherServices,
    raw: services,
    report: {
      missingVariables: dedupeMissing(missing),
      remaps: services.flatMap(s =>
        s.remaps.map(r => ({ service: s.name, key: r.key, before: maskSecrets(r.before), after: maskSecrets(r.after) }))
      ),
      warnings
    }
  };
}

function findComposeFile(dir) {
  for (const name of COMPOSE_CANDIDATES) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function pickDefined(env) {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
}

/** Docker'ın dahili DNS'inde çözülebilen tüm isimler → servis adı (servis adı, container_name, hostname, network alias'ları). */
function collectServiceHosts(services) {
  const hosts = new Map();
  for (const [name, cfg] of Object.entries(services)) {
    hosts.set(name, name);
    if (!cfg) continue;
    if (cfg.container_name) hosts.set(String(cfg.container_name), name);
    if (cfg.hostname) hosts.set(String(cfg.hostname), name);
    if (cfg.networks && !Array.isArray(cfg.networks)) {
      for (const net of Object.values(cfg.networks)) {
        (net && net.aliases ? net.aliases : []).forEach(a => hosts.set(String(a), name));
      }
    }
  }
  return hosts;
}

/**
 * Image referansını ayrıştırır: `docker.io/library/postgres:15-alpine` → repository `postgres`, tag `15-alpine`.
 * Digest (`@sha256:...`) varsa tag null döner.
 */
function parseImage(image) {
  if (!image) return { dbType: null, repository: null, tag: null };
  let ref = String(image).trim().toLowerCase();
  const digestIdx = ref.indexOf('@');
  if (digestIdx !== -1) ref = ref.slice(0, digestIdx);

  let tag = null;
  const lastColon = ref.lastIndexOf(':');
  if (lastColon > ref.lastIndexOf('/')) {
    tag = ref.slice(lastColon + 1);
    ref = ref.slice(0, lastColon);
  }

  const parts = ref.split('/');
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    parts.shift();
  }
  if (parts[0] === 'library') parts.shift();
  const repository = parts.join('/');

  return { dbType: KNOWN_DB_IMAGES[repository] || null, repository, tag };
}

function normalizeBuild(serviceName, build, projectDir) {
  if (!build) return null;
  const cfg = typeof build === 'string' ? { context: build } : build;
  const context = cfg.context || '.';
  if (/^(https?|git|ssh):\/\/|^git@|\.git(#.*)?$/.test(context)) {
    throw new ComposeError(`"${serviceName}" servisinin build.context değeri uzak bir kaynak (${context}); sadece yerel dizinler destekleniyor`);
  }
  const contextDir = path.resolve(projectDir, context);
  return {
    context: contextDir,
    dockerfile: cfg.dockerfile_inline ? null : path.resolve(contextDir, cfg.dockerfile || 'Dockerfile'),
    dockerfileInline: cfg.dockerfile_inline || null,
    target: cfg.target || null,
    args: normalizeKeyValue(cfg.args)
  };
}

/**
 * Kısa söz dizimi: "3000", "8080:3000", "127.0.0.1:8080:3000", "8080:3000/udp"
 * Uzun söz dizimi: { target, published, host_ip, protocol }
 */
function normalizePort(entry, serviceName) {
  if (typeof entry === 'number') {
    return { hostIp: null, host: entry, container: entry, protocol: 'tcp' };
  }
  if (typeof entry === 'string') {
    let spec = entry.trim();
    let protocol = 'tcp';
    const slash = spec.lastIndexOf('/');
    if (slash !== -1) {
      protocol = spec.slice(slash + 1);
      spec = spec.slice(0, slash);
    }

    let hostIp = null;
    const ipv6 = /^\[([^\]]+)\]:(.*)$/.exec(spec);
    if (ipv6) {
      hostIp = ipv6[1];
      spec = ipv6[2];
    }
    const parts = spec.split(':');
    if (!ipv6 && parts.length === 3) hostIp = parts.shift();
    if (parts.length > 2) throw new ComposeError(`"${serviceName}" servisinde geçersiz port tanımı: "${entry}"`);

    const [hostPart, containerPart] = parts.length === 2 ? parts : [parts[0], parts[0]];
    if (hostPart.includes('-') || containerPart.includes('-')) {
      throw new ComposeError(`"${serviceName}" servisinde port aralığı (${entry}) desteklenmiyor — tek port tanımı kullanın`);
    }
    return {
      hostIp,
      host: hostPart === '' ? toPort(containerPart, entry, serviceName) : toPort(hostPart, entry, serviceName),
      container: toPort(containerPart, entry, serviceName),
      protocol
    };
  }
  if (entry && typeof entry === 'object') {
    const container = toPort(entry.target, JSON.stringify(entry), serviceName);
    const published = entry.published === undefined || entry.published === null || entry.published === ''
      ? container
      : toPort(entry.published, JSON.stringify(entry), serviceName);
    return { hostIp: entry.host_ip || null, host: published, container, protocol: entry.protocol || 'tcp' };
  }
  throw new ComposeError(`"${serviceName}" servisinde tanınmayan port tanımı: ${JSON.stringify(entry)}`);
}

function toPort(value, original, serviceName) {
  const str = String(value).trim();
  if (str.includes('-')) {
    throw new ComposeError(`"${serviceName}" servisinde port aralığı (${original}) desteklenmiyor — tek port tanımı kullanın`);
  }
  const n = Number(str);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ComposeError(`"${serviceName}" servisinde geçersiz port: "${original}"`);
  }
  return n;
}

/** Array (`KEY=VAL`, `KEY`) veya object biçimini `{KEY: string|null}` biçimine çevirir; `=` sadece ilk geçtiği yerden bölünür. */
function normalizeKeyValue(input) {
  if (!input) return {};
  if (Array.isArray(input)) {
    const out = {};
    for (const item of input) {
      const str = String(item);
      const eq = str.indexOf('=');
      if (eq === -1) out[str] = null;
      else out[str.slice(0, eq)] = str.slice(eq + 1);
    }
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = v === null || v === undefined ? null : String(v);
  }
  return out;
}

/**
 * env_file (sırasıyla) + environment (üstüne yazar). Değersiz anahtarlar (`KEY` veya `KEY:`)
 * kabuk/.env ortamından alınır; orada da yoksa Compose gibi değişken hiç tanımlanmaz ve eksik olarak raporlanır.
 */
function buildEnvironment(serviceName, cfg, projectDir, vars, missing) {
  const result = {};

  for (const file of normalizeEnvFileEntries(cfg.env_file, projectDir)) {
    if (!fs.existsSync(file.path)) {
      if (file.required) {
        throw new ComposeError(`"${serviceName}" servisinin env_file dosyası bulunamadı: ${file.path}`);
      }
      continue;
    }
    const location = `services.${serviceName}.env_file(${path.basename(file.path)})`;
    for (const [k, v] of Object.entries(loadDotenvFile(file.path))) {
      result[k] = interpolateString(v, vars, { missing, location: `${location}.${k}` });
    }
  }

  for (const [k, v] of Object.entries(normalizeKeyValue(cfg.environment))) {
    if (v !== null) {
      result[k] = v;
    } else if (vars[k] !== undefined) {
      result[k] = String(vars[k]);
    } else {
      missing.push({ name: k, location: `services.${serviceName}.environment.${k}` });
    }
  }
  return result;
}

/** Array veya `{svc: {condition}}` biçimini `[{service, condition}]` biçimine çevirir. */
function normalizeDependsOn(dependsOn) {
  if (!dependsOn) return [];
  if (Array.isArray(dependsOn)) return dependsOn.map(s => ({ service: String(s), condition: 'service_started' }));
  return Object.entries(dependsOn).map(([service, cfg]) => ({
    service,
    condition: (cfg && cfg.condition) || 'service_started'
  }));
}

function dedupeMissing(missing) {
  const byName = new Map();
  for (const { name, location } of missing) {
    if (!byName.has(name)) byName.set(name, new Set());
    if (location) byName.get(name).add(location);
  }
  return [...byName.entries()].map(([name, locations]) => ({ name, locations: [...locations] }));
}

module.exports = {
  parseCompose,
  findComposeFile,
  parseImage,
  normalizePort,
  normalizeKeyValue,
  normalizeDependsOn,
  ComposeError
};
