/**
 * Docker Compose servis adlarını (Docker'ın dahili DNS'i ile çözülen isimler) Windows'ta
 * erişilebilir loopback adresine yeniden yazar.
 *
 * - URL biçimli değerler (scheme://...) anahtar adından bağımsız taranır.
 * - Düz host değerleri (`db`, `db:5432`, `r1:6379,r2:6379`) sadece host içerdiği bilinen
 *   anahtarlarda (`*_HOST`, `*_URL`, `PGHOST` ...) yeniden yazılır.
 * - Port değiştirilmez; dinamik port yönlendirmesi launcher'ın sorumluluğundadır.
 */

const LOOPBACK = '127.0.0.1';

const HOST_KEY_RE = /(?:^|_)(?:URL|URI|DSN|HOST|HOSTS|HOSTNAME|SERVER|SERVERS|ADDR|ADDRESS|ENDPOINT|CONNECTION_STRING|CONN_STR)$/i;
const EXTRA_HOST_KEYS = new Set(['PGHOST', 'MONGOHOST', 'REDISHOST', 'MYSQLHOST']);

// Host'u DNS SRV kaydı ile çözen şemalar — host yeniden yazılamaz, sadece uyarı verilir.
const SRV_SCHEMES = new Set(['mongodb+srv']);

const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;

function isHostKey(key) {
  return HOST_KEY_RE.test(key) || EXTRA_HOST_KEYS.has(key.toUpperCase());
}

/**
 * @param {Record<string,string>} env
 * @param {Map<string,string>|Iterable<string>} serviceHosts compose içindeki DNS isimleri (servis adı, container_name,
 *   hostname, alias). Map verilirse isim → servis adı eşlemesi; aksi halde her isim kendi servisidir.
 * @returns {{ env: Record<string,string>, changes: Array<{key, before, after, kind: 'url'|'host', targets: Array<{service, port: number|null}>}>, warnings: string[] }}
 *   targets: değerin işaret ettiği servisler ve yazılı port (yoksa null) — launcher dinamik port atamasında bunu kullanır.
 */
function remapEnvironment(env, serviceHosts) {
  const hosts = new Map(
    serviceHosts instanceof Map
      ? [...serviceHosts].map(([h, svc]) => [h.toLowerCase(), svc])
      : [...serviceHosts].map(h => [h.toLowerCase(), h])
  );
  const result = {};
  const changes = [];
  const warnings = [];

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value === '') {
      result[key] = value;
      continue;
    }

    let rewritten = value;
    let kind = null;
    let targets = [];
    const urlMatch = URL_RE.exec(value);
    if (urlMatch) {
      const scheme = urlMatch[1].toLowerCase();
      const r = rewriteUrl(urlMatch[1], urlMatch[2], hosts);
      if (SRV_SCHEMES.has(scheme) && r.targets.length) {
        warnings.push(`${key}: "${scheme}://" DNS SRV kaydı gerektirir, servis adı yeniden yazılamaz — bağlantı string'ini "mongodb://" biçimine çevirmeniz gerekir`);
      } else {
        rewritten = r.value;
        kind = 'url';
        targets = r.targets;
      }
    } else if (isHostKey(key)) {
      const r = rewriteHostList(value, hosts);
      rewritten = r.value;
      kind = 'host';
      targets = r.targets;
    }

    result[key] = rewritten;
    if (rewritten !== value) changes.push({ key, before: value, after: rewritten, kind, targets });
  }

  return { env: result, changes, warnings };
}

/**
 * `scheme://` sonrasını userinfo / host listesi / kalan kısım olarak böler.
 * Şifreler pratikte encode edilmeden `@`, `#`, `?` içerebildiği için userinfo,
 * ilk `/`'den önceki SON `@`'e kadar kabul edilir.
 */
function splitUrlRest(rest) {
  const firstSlash = rest.indexOf('/');
  const head = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
  const at = head.lastIndexOf('@');
  const userinfo = at === -1 ? '' : rest.slice(0, at);
  const afterUser = at === -1 ? rest : rest.slice(at + 1);
  const hostEnd = afterUser.search(/[/?#]/);
  return {
    userinfo,
    hostPart: hostEnd === -1 ? afterUser : afterUser.slice(0, hostEnd),
    tail: hostEnd === -1 ? '' : afterUser.slice(hostEnd)
  };
}

function rewriteUrl(scheme, rest, hosts) {
  const { userinfo, hostPart, tail } = splitUrlRest(rest);
  const { value, targets } = rewriteHostList(hostPart, hosts);
  return { value: `${scheme}://${userinfo ? `${userinfo}@` : ''}${value}${tail}`, targets };
}

/** `host`, `host:port` veya virgülle ayrılmış listesini yeniden yazar. IPv6 literal'lere dokunmaz. */
function rewriteHostList(hostList, hosts) {
  const targets = [];
  const value = hostList
    .split(',')
    .map(entry => {
      const trimmed = entry.trim();
      if (trimmed.startsWith('[')) return entry;
      const colon = trimmed.indexOf(':');
      const host = colon === -1 ? trimmed : trimmed.slice(0, colon);
      const port = colon === -1 ? '' : trimmed.slice(colon);
      if (!hosts.has(host.toLowerCase())) return entry;
      const portNum = port ? Number(port.slice(1)) : null;
      targets.push({ service: hosts.get(host.toLowerCase()), port: Number.isInteger(portNum) ? portNum : null });
      return `${LOOPBACK}${port}`;
    })
    .join(',');
  return { value, targets };
}

/** Rapor çıktısı için URL'lerdeki şifreyi maskeler. */
function maskSecrets(value) {
  if (typeof value !== 'string') return value;
  const match = URL_RE.exec(value);
  if (!match) return value;
  const { userinfo, hostPart, tail } = splitUrlRest(match[2]);
  const colon = userinfo.indexOf(':');
  if (colon === -1) return value;
  return `${match[1]}://${userinfo.slice(0, colon)}:****@${hostPart}${tail}`;
}

module.exports = { remapEnvironment, maskSecrets, isHostKey, LOOPBACK };
