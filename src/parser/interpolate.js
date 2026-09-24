/**
 * Docker Compose değişken interpolasyonu.
 *
 * Desteklenen söz dizimi:
 *   $VAR, ${VAR}             → değer; tanımsızsa boş string + missing kaydı
 *   ${VAR:-default}          → VAR tanımsız veya boşsa default
 *   ${VAR-default}           → VAR tanımsızsa default
 *   ${VAR:?hata}             → VAR tanımsız veya boşsa hata fırlatır
 *   ${VAR?hata}              → VAR tanımsızsa hata fırlatır
 *   ${VAR:+alt}, ${VAR+alt}  → VAR tanımlıysa (ve boş değilse) alt, değilse boş
 *   $$                       → literal $
 *
 * Default değerlerin içinde iç içe interpolasyon desteklenir: ${A:-${B}}
 */

class InterpolationError extends Error {
  constructor(message, location) {
    super(location ? `${message} (konum: ${location})` : message);
    this.name = 'InterpolationError';
    this.location = location;
  }
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * @param {string} input
 * @param {Record<string,string>} vars
 * @param {{ location?: string, missing?: Array<{name:string, location?:string}> }} ctx
 */
function interpolateString(input, vars, ctx = {}) {
  let out = '';
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (ch !== '$') {
      out += ch;
      i++;
      continue;
    }

    const next = input[i + 1];
    if (next === '$') {
      out += '$';
      i += 2;
      continue;
    }

    if (next === '{') {
      const end = findBraceEnd(input, i + 2);
      if (end === -1) {
        throw new InterpolationError(`Kapanmamış değişken ifadesi: "${input.slice(i)}"`, ctx.location);
      }
      out += resolveBraced(input.slice(i + 2, end), vars, ctx);
      i = end + 1;
      continue;
    }

    const match = NAME_RE.exec(input.slice(i + 1));
    if (match) {
      out += lookup(match[0], vars, ctx);
      i += 1 + match[0].length;
      continue;
    }

    // Tek başına `$` (örn. "fiyat 5$") literal kalır.
    out += '$';
    i++;
  }
  return out;
}

function findBraceEnd(input, start) {
  let depth = 1;
  for (let j = start; j < input.length; j++) {
    if (input[j] === '$' && input[j + 1] === '{') {
      depth++;
      j++;
    } else if (input[j] === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function resolveBraced(expr, vars, ctx) {
  const match = NAME_RE.exec(expr);
  if (!match) {
    throw new InterpolationError(`Geçersiz değişken ifadesi: "\${${expr}}"`, ctx.location);
  }
  const name = match[0];
  const rest = expr.slice(name.length);
  if (rest === '') return lookup(name, vars, ctx);

  const op = /^(:-|-|:\?|\?|:\+|\+)/.exec(rest);
  if (!op) {
    throw new InterpolationError(`Desteklenmeyen değişken operatörü: "\${${expr}}"`, ctx.location);
  }
  const arg = rest.slice(op[0].length);
  const defined = Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null;
  const value = defined ? String(vars[name]) : undefined;
  const nonEmpty = defined && value !== '';

  switch (op[0]) {
    case ':-':
      return nonEmpty ? value : interpolateString(arg, vars, ctx);
    case '-':
      return defined ? value : interpolateString(arg, vars, ctx);
    case ':?':
      if (!nonEmpty) {
        throw new InterpolationError(`Zorunlu değişken tanımsız veya boş: ${name}${arg ? ` — ${arg}` : ''}`, ctx.location);
      }
      return value;
    case '?':
      if (!defined) {
        throw new InterpolationError(`Zorunlu değişken tanımsız: ${name}${arg ? ` — ${arg}` : ''}`, ctx.location);
      }
      return value;
    case ':+':
      return nonEmpty ? interpolateString(arg, vars, ctx) : '';
    case '+':
      return defined ? interpolateString(arg, vars, ctx) : '';
    default:
      throw new InterpolationError(`Desteklenmeyen operatör: ${op[0]}`, ctx.location);
  }
}

function lookup(name, vars, ctx) {
  if (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null) {
    return String(vars[name]);
  }
  if (ctx.missing) ctx.missing.push({ name, location: ctx.location });
  return '';
}

/**
 * Parse edilmiş YAML ağacındaki tüm string değerleri (anahtarlar hariç) interpolate eder.
 * Yeni bir ağaç döner, girdiyi değiştirmez.
 */
function interpolateTree(node, vars, ctx = {}, pathParts = []) {
  const location = pathParts.join('.');
  if (typeof node === 'string') {
    return interpolateString(node, vars, { ...ctx, location });
  }
  if (Array.isArray(node)) {
    // `KEY=value` biçimindeki liste elemanlarında konum olarak indeks yerine anahtar adı gösterilir.
    return node.map((item, idx) => {
      const keyMatch = typeof item === 'string' ? /^([A-Za-z_][A-Za-z0-9_.-]*)=/.exec(item) : null;
      return interpolateTree(item, vars, ctx, [...pathParts, keyMatch ? keyMatch[1] : String(idx)]);
    });
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = interpolateTree(value, vars, ctx, [...pathParts, key]);
    }
    return out;
  }
  return node;
}

module.exports = { interpolateString, interpolateTree, InterpolationError };
