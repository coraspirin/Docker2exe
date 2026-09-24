/**
 * Dinamik port ataması sonrası uygulama ortam değişkenlerini günceller.
 *
 * refs: build sırasında hostRemap'in kaydettiği değişiklikler
 *   [{ key, kind: 'url'|'host', targets: [{ service, port: number|null }] }]
 * moves: { <servis>: { from: <tercih edilen port>, to: <atanan port> } }
 *
 * Döner: { env, notes: string[] } — notes, launcher.log'a yazılacak açıklamalar.
 */
function rewriteEnvPorts(env, refs, moves) {
  const out = { ...env };
  const notes = [];

  for (const ref of refs) {
    const value = out[ref.key];
    if (typeof value !== 'string') continue;

    for (const target of ref.targets) {
      const move = moves[target.service];
      if (!move || move.from === move.to) continue;

      if (ref.kind === 'url') {
        out[ref.key] = rewriteUrlPort(out[ref.key], target, move);
        if (out[ref.key] !== value) notes.push(`${ref.key}: ${target.service} portu ${move.from} → ${move.to}`);
        continue;
      }

      // Düz host değeri: `127.0.0.1:5432` biçimi veya eşlik eden *_PORT değişkeni
      if (target.port !== null) {
        out[ref.key] = out[ref.key].replace(new RegExp(`127\\.0\\.0\\.1:${move.from}(?!\\d)`), `127.0.0.1:${move.to}`);
        notes.push(`${ref.key}: ${target.service} portu ${move.from} → ${move.to}`);
        continue;
      }
      const portKey = companionPortKey(ref.key);
      if (portKey && out[portKey] !== undefined) {
        if (String(out[portKey]) === String(move.from)) {
          out[portKey] = String(move.to);
          notes.push(`${portKey}: ${target.service} portu ${move.from} → ${move.to}`);
        } else {
          notes.push(`UYARI: ${portKey}=${out[portKey]} beklenen ${move.from} değil, değiştirilmedi`);
        }
      } else {
        notes.push(`UYARI: ${ref.key} ${target.service} servisini gösteriyor ama eşlik eden port değişkeni (${portKey || '?'}) yok; uygulama varsayılan portu (${move.from}) kullanırsa bağlanamaz`);
      }
    }
  }
  return { env: out, notes };
}

function rewriteUrlPort(value, target, move) {
  if (target.port !== null) {
    return value.replace(new RegExp(`127\\.0\\.0\\.1:${move.from}(?![0-9])`), `127.0.0.1:${move.to}`);
  }
  // URL'de port yazılmamış (şemanın varsayılanı) → açıkça ekle
  return value.replace(/127\.0\.0\.1(?=[/?#,]|$)/, `127.0.0.1:${move.to}`);
}

/** DB_HOST → DB_PORT, PGHOST → PGPORT, REDIS_HOSTNAME → REDIS_PORT, MYSQL_SERVER → MYSQL_PORT */
function companionPortKey(key) {
  const m = /^(.*?)(HOSTNAME|HOST|SERVER|ADDRESS|ADDR)$/i.exec(key);
  if (!m) return null;
  const upper = m[2] === m[2].toUpperCase();
  return `${m[1]}${upper ? 'PORT' : 'port'}`;
}

module.exports = { rewriteEnvPorts, companionPortKey };
