const fs = require('fs');

/**
 * Dockerfile'dan sadece statik bilgi çıkarır; RUN adımları vb. hiçbir şekilde yorumlanmaz/taklit edilmez.
 * Multi-stage build'lerde çalışma zamanını belirleyen SON stage esas alınır.
 *
 * Döner: {
 *   stages: [{ name, baseImage, rootImage }],
 *   final: { baseImage, rootImage, workdir, cmd, entrypoint, expose: number[], env: {} }
 * }
 * cmd/entrypoint: { form: 'exec'|'shell', args: string[], raw?: string } | null
 */
function parseDockerfile(filePath) {
  return parseDockerfileContent(fs.readFileSync(filePath, 'utf8'));
}

function parseDockerfileContent(content) {
  const instructions = toInstructions(content);
  const args = {};
  const stages = [];
  let current = null;

  for (const { keyword, value } of instructions) {
    if (keyword === 'ARG' && !current) {
      // FROM öncesi global ARG'lar sadece FROM satırında kullanılabilir.
      Object.assign(args, parseKeyValues(value, true));
      continue;
    }
    if (keyword === 'FROM') {
      const parts = value.split(/\s+/).filter(p => !p.startsWith('--'));
      const baseImage = substitute(parts[0], args);
      const asIdx = parts.findIndex(p => p.toLowerCase() === 'as');
      const parent = stages.find(s => s.name && s.name === baseImage);
      current = {
        name: asIdx !== -1 ? parts[asIdx + 1] : null,
        baseImage,
        // Stage zinciri (`FROM base`) takip edilerek ulaşılan gerçek dış image.
        rootImage: parent ? parent.rootImage : baseImage,
        // `FROM builder` gibi önceki stage'den türeyen stage'ler onun ayarlarını devralır.
        workdir: parent ? parent.workdir : '/',
        cmd: parent ? parent.cmd : null,
        entrypoint: parent ? parent.entrypoint : null,
        expose: parent ? [...parent.expose] : [],
        env: parent ? { ...parent.env } : {}
      };
      stages.push(current);
      continue;
    }
    if (!current) continue;

    const vars = { ...args, ...current.env };
    switch (keyword) {
      case 'ARG':
        Object.assign(args, parseKeyValues(value, true));
        break;
      case 'ENV':
        Object.assign(current.env, parseKeyValues(substitute(value, vars), false));
        break;
      case 'WORKDIR': {
        const dir = substitute(stripQuotes(value), vars);
        current.workdir = dir.startsWith('/') ? dir : joinPosix(current.workdir, dir);
        break;
      }
      case 'EXPOSE':
        for (const token of substitute(value, vars).split(/\s+/).filter(Boolean)) {
          const port = Number(token.split('/')[0]);
          if (Number.isInteger(port)) current.expose.push(port);
        }
        break;
      case 'CMD':
        current.cmd = parseCommand(value);
        break;
      case 'ENTRYPOINT':
        current.entrypoint = parseCommand(value);
        // Docker davranışı: ENTRYPOINT tanımlanınca üst image'den gelen CMD sıfırlanır.
        current.cmd = null;
        break;
      default:
        break;
    }
  }

  const final = stages[stages.length - 1] || null;
  return {
    stages: stages.map(s => ({ name: s.name, baseImage: s.baseImage, rootImage: s.rootImage })),
    final: final && {
      baseImage: final.baseImage,
      rootImage: final.rootImage,
      workdir: final.workdir,
      cmd: final.cmd,
      entrypoint: final.entrypoint,
      expose: final.expose,
      env: final.env
    }
  };
}

/** Satır devamı (`\`), yorumlar ve boş satırları işleyip `{keyword, value}` listesi üretir. */
function toInstructions(content) {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  const result = [];
  let buffer = '';

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!buffer && (trimmed === '' || trimmed.startsWith('#'))) continue;
    if (buffer && trimmed.startsWith('#')) continue;

    if (trimmed.endsWith('\\')) {
      buffer += trimmed.slice(0, -1) + ' ';
      continue;
    }
    const full = (buffer + trimmed).trim();
    buffer = '';
    if (!full) continue;

    const match = /^(\S+)\s*(.*)$/s.exec(full);
    result.push({ keyword: match[1].toUpperCase(), value: match[2].trim() });
  }
  if (buffer.trim()) {
    const match = /^(\S+)\s*(.*)$/s.exec(buffer.trim());
    result.push({ keyword: match[1].toUpperCase(), value: match[2].trim() });
  }
  return result;
}

/** CMD/ENTRYPOINT: JSON dizisi (exec form) veya düz metin (shell form). */
function parseCommand(value) {
  if (value.startsWith('[')) {
    try {
      const args = JSON.parse(value);
      if (Array.isArray(args) && args.every(a => typeof a === 'string')) {
        return { form: 'exec', args };
      }
    } catch {
      // Geçersiz JSON: Docker da bunu shell form olarak çalıştırır.
    }
  }
  return { form: 'shell', args: splitShellWords(value), raw: value };
}

/** Basit kabuk kelime bölme: tek/çift tırnak ve ters bölü kaçışı desteklenir. */
function splitShellWords(input) {
  const words = [];
  let current = '';
  let quote = null;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) words.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) words.push(current);
  return words;
}

/** `ENV A=1 B="x y"`, eski `ENV A 1` ve `ARG A[=default]` biçimleri. */
function parseKeyValues(value, isArg) {
  const out = {};
  if (!isArg && !/^\S+=/.test(value)) {
    const [key, ...rest] = value.split(/\s+/);
    out[key] = rest.join(' ');
    return out;
  }
  for (const word of splitShellWords(value)) {
    const eq = word.indexOf('=');
    if (eq === -1) {
      if (isArg) out[word] = undefined;
    } else {
      out[word.slice(0, eq)] = word.slice(eq + 1);
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

function substitute(value, vars) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced, def, bare) => {
    const name = braced || bare;
    if (vars[name] !== undefined && vars[name] !== '') return vars[name];
    return def !== undefined ? def : m;
  });
}

function stripQuotes(value) {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function joinPosix(base, rel) {
  const parts = `${base}/${rel}`.split('/');
  const stack = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return '/' + stack.join('/');
}

module.exports = { parseDockerfile, parseDockerfileContent, splitShellWords, joinPosix };
