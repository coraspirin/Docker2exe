const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { compileRuntimeExe } = require('./runtimeExe');

// Launcher'ın kendi Node sürümü uygulamadan bağımsızdır (sadece orchestrator).
const LAUNCHER_NODE_MAJOR = 22;

/** koffi'nin Windows x64 native eklentisi (koffi 3: @koromix/koffi-win32-x64 paketi). */
function koffiNativePath() {
  const candidates = [];
  try {
    candidates.push(path.join(path.dirname(require.resolve('@koromix/koffi-win32-x64/package.json')), 'win32_x64', 'koffi.node'));
  } catch { /* paket yok */ }
  try {
    candidates.push(path.join(path.dirname(require.resolve('koffi/package.json')), 'build', 'koffi', 'win32_x64', 'koffi.node'));
  } catch { /* paket yok */ }
  return candidates.find(p => fs.existsSync(p)) || null;
}

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

/**
 * PE başlığındaki Subsystem alanını CONSOLE → WINDOWS_GUI yapar: launcher çift tıklandığında konsol
 * penceresi açılmaz. pkg payload'ı başlıktan bağımsız olduğu için sadece bu 2 bayt değişir.
 */
function setGuiSubsystem(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    const header = Buffer.alloc(0x400);
    fs.readSync(fd, header, 0, header.length, 0);
    if (header.readUInt16LE(0) !== 0x5a4d) throw new Error('MZ başlığı yok');
    const peOff = header.readUInt32LE(0x3c);
    if (header.readUInt32LE(peOff) !== 0x00004550) throw new Error('PE imzası yok');
    const subsystemOff = peOff + 24 + 68; // PE32 ve PE32+ optional header'da aynı konum
    const current = header.readUInt16LE(subsystemOff);
    if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) return;
    if (current !== IMAGE_SUBSYSTEM_WINDOWS_CUI) throw new Error(`beklenmeyen subsystem değeri: ${current}`);
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, 0);
    fs.writeSync(fd, buf, 0, 2, subsystemOff);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * launcher.exe'yi ve native/koffi.node'u pakete koyar, ardından paketlenmiş exe ile
 * Job Object self-test'i çalıştırır. Başarısızsa build durur (fallback yok).
 */
async function generateLauncher(outDir, { logFile } = {}) {
  const koffi = koffiNativePath();
  if (!koffi) {
    throw new Error('koffi Windows x64 native eklentisi bulunamadı (npm install ile @koromix/koffi-win32-x64 kurulmalı). Job Object kurulamayacağı için build durduruldu');
  }
  const exe = await compileRuntimeExe('launcher', LAUNCHER_NODE_MAJOR, { logFile });
  fs.copyFileSync(exe, path.join(outDir, 'launcher.exe'));
  setGuiSubsystem(path.join(outDir, 'launcher.exe'));
  fs.mkdirSync(path.join(outDir, 'native'), { recursive: true });
  fs.copyFileSync(koffi, path.join(outDir, 'native', 'koffi.node'));

  const res = spawnSync(path.join(outDir, 'launcher.exe'), ['--selftest'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (logFile) fs.appendFileSync(logFile, `\n$ launcher.exe --selftest\n${output}\n[çıkış kodu ${res.status}]\n`);
  if (res.status !== 0) {
    throw new Error(`launcher.exe Job Object self-test başarısız (koffi FFI): ${output || res.error?.message || 'çıktı yok'}\n    Öksüz süreç koruması kurulamadığı için build durduruldu`);
  }
  return { selftest: output };
}

module.exports = { generateLauncher, koffiNativePath, setGuiSubsystem, LAUNCHER_NODE_MAJOR };
