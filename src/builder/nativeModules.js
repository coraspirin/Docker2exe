const fs = require('fs');
const path = require('path');

/**
 * Native Node eklentilerinin (.node) tespiti ve ABI kontrolü.
 *
 * pkg'nin snapshot dosya sistemi .node dosyalarını bellekten yükleyemediği için bu paketler snapshot'a
 * gömülmez; fiziksel olarak paketin yanındaki node_modules'a kopyalanır ve NODE_PATH ile bulunur.
 *
 * ABI tespiti PE (Windows DLL) başlığından yapılır:
 *  - `napi_register_module_v1` export'u → N-API (Node sürümünden bağımsız)
 *  - `node_register_module_v<N>` export'u → V8 ABI'ye bağlı, NODE_MODULE_VERSION = N
 *  - export yoksa: node.exe'den sadece napi_* / uv_* import ediyorsa N-API, aksi halde belirsiz
 */

// Bilinen native paketler (rapor için; tespit .node dosyalarından yapılır)
const KNOWN_NATIVE = ['bcrypt', 'sharp', 'sqlite3', 'better-sqlite3', 'canvas', 'argon2', 'bufferutil', 'utf-8-validate', 'node-sass', 'sodium-native', 'cpu-features', 'ssh2', 'oracledb', 'ibm_db', 'odbc', 'msnodesqlv8', 'node-hana-client', '@sap/hana-client', 'libxmljs', 'leveldown', 'usb', 'serialport', '@serialport/bindings-cpp', 'zeromq', 'kerberos', 'gc-stats'];

// pkg'nin desteklediği hedefler için NODE_MODULE_VERSION değerleri
const NODE_ABI = { 18: 108, 20: 115, 22: 127, 24: 137, 26: 147 };

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

/**
 * PE32+ dosyasının makine tipini, export ve (node.exe'den) import isimlerini okur.
 * PE değilse null döner.
 */
function readPe(buf) {
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return null; // 'PE\0\0'
  const machine = buf.readUInt16LE(peOff + 4);
  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const opt = peOff + 24;
  const magic = buf.readUInt16LE(opt);
  const ddOff = opt + (magic === 0x20b ? 112 : 96);
  const thunkSize = magic === 0x20b ? 8 : 4;

  const sections = [];
  const secTable = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    sections.push({
      va: buf.readUInt32LE(s + 12),
      vsize: buf.readUInt32LE(s + 8),
      rawSize: buf.readUInt32LE(s + 16),
      rawPtr: buf.readUInt32LE(s + 20)
    });
  }
  const rvaToOff = rva => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.rawPtr;
    }
    return -1;
  };
  const cstr = off => (off < 0 ? '' : buf.toString('latin1', off, buf.indexOf(0, off)));

  const exports = [];
  const expRva = buf.readUInt32LE(ddOff);
  if (expRva) {
    const e = rvaToOff(expRva);
    if (e >= 0) {
      const count = buf.readUInt32LE(e + 24);
      const namesOff = rvaToOff(buf.readUInt32LE(e + 32));
      for (let i = 0; i < count && namesOff >= 0; i++) exports.push(cstr(rvaToOff(buf.readUInt32LE(namesOff + i * 4))));
    }
  }

  const imports = {};
  const impRva = buf.readUInt32LE(ddOff + 8);
  if (impRva) {
    let d = rvaToOff(impRva);
    while (d >= 0 && d + 20 <= buf.length) {
      const origThunk = buf.readUInt32LE(d);
      const nameRva = buf.readUInt32LE(d + 12);
      const firstThunk = buf.readUInt32LE(d + 16);
      if (!nameRva && !firstThunk) break;
      const dll = cstr(rvaToOff(nameRva)).toLowerCase();
      const names = [];
      let t = rvaToOff(origThunk || firstThunk);
      while (t >= 0 && t + thunkSize <= buf.length) {
        const value = thunkSize === 8 ? buf.readBigUInt64LE(t) : BigInt(buf.readUInt32LE(t));
        if (value === 0n) break;
        const ordinalFlag = thunkSize === 8 ? 1n << 63n : 1n << 31n;
        if (!(value & ordinalFlag)) names.push(cstr(rvaToOff(Number(value & 0x7fffffffn)) + 2));
        t += thunkSize;
      }
      imports[dll] = names;
      d += 20;
    }
  }

  // Delay-load import'ları: node-gyp eklentileri node.exe'yi delay-load hook ile yükler
  // (exe adı değişse de çalışsın diye), bu yüzden N-API import'ları burada görünür.
  const delayRva = buf.readUInt32LE(ddOff + 13 * 8);
  if (delayRva) {
    let d = rvaToOff(delayRva);
    while (d >= 0 && d + 32 <= buf.length) {
      const nameRva = buf.readUInt32LE(d + 4);
      const intRva = buf.readUInt32LE(d + 16);
      if (!nameRva) break;
      const dll = cstr(rvaToOff(nameRva)).toLowerCase();
      const names = imports[dll] || [];
      let t = rvaToOff(intRva);
      while (t >= 0 && t + thunkSize <= buf.length) {
        const value = thunkSize === 8 ? buf.readBigUInt64LE(t) : BigInt(buf.readUInt32LE(t));
        if (value === 0n) break;
        const ordinalFlag = thunkSize === 8 ? 1n << 63n : 1n << 31n;
        if (!(value & ordinalFlag)) names.push(cstr(rvaToOff(Number(value & 0x7fffffffn)) + 2));
        t += thunkSize;
      }
      imports[dll] = names;
      d += 32;
    }
  }
  return { machine, exports, imports };
}

/**
 * @returns {{ kind: 'napi'|'abi'|'unknown'|'not-addon'|'other-platform', abi?: number }}
 */
function classifyAddon(file) {
  const pe = readPe(fs.readFileSync(file));
  if (!pe) return { kind: 'other-platform' };
  if (pe.machine !== IMAGE_FILE_MACHINE_AMD64) return { kind: 'other-platform' };
  if (pe.exports.includes('napi_register_module_v1')) return { kind: 'napi' };
  const abiExport = pe.exports.map(e => /^node_register_module_v(\d+)$/.exec(e)).find(Boolean);
  if (abiExport) return { kind: 'abi', abi: Number(abiExport[1]) };

  const nodeImports = pe.imports['node.exe'] || [];
  if (!nodeImports.length) return { kind: 'not-addon' };
  if (nodeImports.every(n => /^(napi_|uv_|node_api_)/.test(n))) return { kind: 'napi' };
  return { kind: 'unknown' };
}

/** node_modules altındaki tüm .node dosyalarını bulur (iç içe node_modules dahil). */
function findAddonFiles(nodeModulesDir) {
  const out = [];
  const stack = [nodeModulesDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '.bin') stack.push(full);
      } else if (e.name.endsWith('.node')) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Dosyayı içeren paket kökü (node_modules/<ad> veya node_modules/@scope/<ad>). */
function packageRootOf(file, nodeModulesDir) {
  const rel = path.relative(nodeModulesDir, file).split(path.sep);
  // son "node_modules" segmentinden sonraki paket
  let idx = -1;
  for (let i = rel.length - 1; i >= 0; i--) {
    if (rel[i] === 'node_modules') { idx = i; break; }
  }
  const start = idx + 1;
  const len = rel[start].startsWith('@') ? 2 : 1;
  return path.join(nodeModulesDir, ...rel.slice(0, start + len));
}

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Node çözümleme kuralıyla `name` paketini `fromDir`'den başlayarak bulur. */
function resolvePackageDir(name, fromDir, rootNodeModules) {
  let dir = fromDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.resolve(dir, 'node_modules') === path.resolve(rootNodeModules)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Paket + production bağımlılık kapanışı (dependencies + optionalDependencies). */
function dependencyClosure(pkgDirs, appDir) {
  const rootNodeModules = path.join(appDir, 'node_modules');
  const seen = new Set();
  const queue = [...pkgDirs];
  while (queue.length) {
    const dir = queue.pop();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pkg = readPkg(dir);
    if (!pkg) continue;
    for (const dep of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) })) {
      const found = resolvePackageDir(dep, dir, rootNodeModules);
      if (found) queue.push(found);
    }
  }
  return [...seen];
}

/**
 * @param {string} appDir npm install yapılmış uygulama klasörü
 * @param {number} targetNodeMajor pkg hedef Node major'ı
 * @returns {{ packages: Array<{name, dir, addons: Array<{file, kind, abi?}>}>, externalDirs: string[], errors: string[], warnings: string[] }}
 */
function analyzeNativeModules(appDir, targetNodeMajor) {
  const nodeModules = path.join(appDir, 'node_modules');
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(nodeModules)) return { packages: [], externalDirs: [], errors, warnings };

  const targetAbi = NODE_ABI[targetNodeMajor];
  const byPkg = new Map();
  for (const file of findAddonFiles(nodeModules)) {
    const root = packageRootOf(file, nodeModules);
    if (!byPkg.has(root)) byPkg.set(root, []);
    byPkg.get(root).push({ file, ...classifyAddon(file) });
  }

  const packages = [];
  for (const [dir, addons] of byPkg) {
    const pkg = readPkg(dir) || {};
    const name = pkg.name || path.basename(dir);
    const relevant = addons.filter(a => a.kind !== 'other-platform' && a.kind !== 'not-addon');
    if (!relevant.length) continue;
    packages.push({ name, dir, addons: relevant });

    for (const a of relevant) {
      const rel = path.relative(appDir, a.file);
      if (a.kind === 'abi' && a.abi !== targetAbi) {
        errors.push(
          `${name}: ${rel} Node ABI ${a.abi} için derlenmiş, hedef Node ${targetNodeMajor} (ABI ${targetAbi}) ile uyumsuz.\n` +
            `    Build'i Node ${targetNodeMajor} ile çalıştırın (npm install aynı Node sürümüyle derlemeli) veya --node-target ile hedefi değiştirin`
        );
      } else if (a.kind === 'unknown') {
        errors.push(`${name}: ${rel} native eklentisinin ABI'si tespit edilemedi (N-API veya node_register_module export'u yok)`);
      }
    }
  }

  const externalDirs = dependencyClosure(packages.map(p => p.dir), appDir);
  const unknownKnown = KNOWN_NATIVE.filter(n => fs.existsSync(path.join(nodeModules, n)) && !packages.some(p => p.name === n));
  for (const n of unknownKnown) {
    warnings.push(`${n} paketi kurulu ama Windows x64 native eklentisi (.node) bulunamadı — kurulum eksik olabilir`);
  }
  return { packages, externalDirs, errors, warnings };
}

module.exports = { analyzeNativeModules, classifyAddon, readPe, dependencyClosure, NODE_ABI, KNOWN_NATIVE };
