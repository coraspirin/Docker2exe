const fs = require('fs');
const path = require('path');

/**
 * .env formatındaki metni parse eder (Docker Compose'un kabul ettiği alt küme):
 * - `#` ile başlayan satırlar ve boş satırlar atlanır
 * - opsiyonel `export ` öneki
 * - çift tırnaklı değerlerde \n, \t, \" kaçışları; tek tırnaklı değerler olduğu gibi
 * - tırnaksız değerlerde ` #` sonrası satır içi yorum kabul edilir
 */
function parseDotenv(content) {
  const result = {};
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.replace(/^export\s+/, '');
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      const end = findClosingQuote(value, '"');
      value = value
        .slice(1, end === -1 ? undefined : end)
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = value.slice(1, end === -1 ? undefined : end);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    result[key] = value;
  }
  return result;
}

function findClosingQuote(value, quote) {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === '\\') { i++; continue; }
    if (value[i] === quote) return i;
  }
  return -1;
}

function loadDotenvFile(filePath) {
  return parseDotenv(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Compose `env_file` alanını normalize eder: string, string[] veya {path, required}[].
 * Döner: [{ path: <mutlak yol>, required: boolean }]
 */
function normalizeEnvFileEntries(envFile, baseDir) {
  if (!envFile) return [];
  const list = Array.isArray(envFile) ? envFile : [envFile];
  return list.map(entry => {
    if (typeof entry === 'string') {
      return { path: path.resolve(baseDir, entry), required: true };
    }
    if (entry && typeof entry.path === 'string') {
      return { path: path.resolve(baseDir, entry.path), required: entry.required !== false };
    }
    throw new Error(`Geçersiz env_file girdisi: ${JSON.stringify(entry)}`);
  });
}

module.exports = { parseDotenv, loadDotenvFile, normalizeEnvFileEntries };
