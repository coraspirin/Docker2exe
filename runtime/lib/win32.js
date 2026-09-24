/**
 * Windows API köprüsü (koffi FFI). koffi.node pkg snapshot'ına gömülmez; paket içindeki
 * `native/koffi.node` dosyasından gerçek dosya sisteminden yüklenir.
 *
 * Job Object: launcher kendi process'ini JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE bayraklı bir job'a bağlar.
 * Sonradan oluşturulan tüm alt süreçler (app.exe, postgres.exe, pg_ctl'in başlattıkları ...) job'u miras alır.
 * Launcher çöker veya `taskkill /F` ile öldürülürse job handle'ı kapanır ve OS tüm alt süreçleri sonlandırır.
 * Fallback YOKTUR: bu kurulamazsa launcher başlamaz.
 */
const path = require('path');

const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

let koffi = null;
let api = null;

function loadKoffi(nativeDir) {
  if (koffi) return koffi;
  const file = path.join(nativeDir, 'koffi.node');
  try {
    koffi = require(file);
  } catch (err) {
    throw new Error(`koffi FFI yüklenemedi (${file}): ${err.message}`);
  }
  return koffi;
}

function bind(nativeDir) {
  if (api) return api;
  const k = loadKoffi(nativeDir);
  const kernel32 = k.load('kernel32.dll');
  const shell32 = k.load('shell32.dll');

  const BASIC = k.struct('D2E_JOBOBJECT_BASIC_LIMIT_INFORMATION', {
    PerProcessUserTimeLimit: 'int64',
    PerJobUserTimeLimit: 'int64',
    LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'size_t',
    MaximumWorkingSetSize: 'size_t',
    ActiveProcessLimit: 'uint32',
    Affinity: 'uintptr_t',
    PriorityClass: 'uint32',
    SchedulingClass: 'uint32'
  });
  const IO = k.struct('D2E_IO_COUNTERS', {
    ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64',
    ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64'
  });
  const EXT = k.struct('D2E_JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
    BasicLimitInformation: BASIC,
    IoInfo: IO,
    ProcessMemoryLimit: 'size_t',
    JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t',
    PeakJobMemoryUsed: 'size_t'
  });

  api = {
    k,
    EXT,
    CreateJobObjectW: kernel32.func('void* __stdcall CreateJobObjectW(void*, void*)'),
    SetInformationJobObject: kernel32.func('bool __stdcall SetInformationJobObject(void*, int, _In_ D2E_JOBOBJECT_EXTENDED_LIMIT_INFORMATION*, uint32)'),
    AssignProcessToJobObject: kernel32.func('bool __stdcall AssignProcessToJobObject(void*, void*)'),
    GetCurrentProcess: kernel32.func('void* __stdcall GetCurrentProcess()'),
    GetLastError: kernel32.func('uint32 __stdcall GetLastError()'),
    IsUserAnAdmin: shell32.func('bool __stdcall IsUserAnAdmin()'),
    MessageBoxW: k.load('user32.dll').func('int __stdcall MessageBoxW(void*, str16, str16, uint32)')
  };
  return api;
}

const MB_ICONERROR = 0x10;
const MB_ICONWARNING = 0x30;
const MB_ICONINFORMATION = 0x40;
const MB_SETFOREGROUND = 0x10000;

/**
 * Launcher konsolsuz (GUI subsystem) çalıştığı için kullanıcıya görünür tek kanal.
 * Bloklayıcıdır; kullanıcı Tamam'a basana kadar bekler.
 */
function showMessage(nativeDir, text, title, kind = 'error') {
  if (process.env.D2E_NO_DIALOG === '1') return;
  try {
    const icon = { error: MB_ICONERROR, warning: MB_ICONWARNING, info: MB_ICONINFORMATION }[kind] || MB_ICONERROR;
    bind(nativeDir).MessageBoxW(null, text, title, icon | MB_SETFOREGROUND);
  } catch {
    // koffi yüklenemediyse mesaj zaten launcher.log'da
  }
}

/** Launcher process'ini kill-on-close job'a bağlar. Handle process ömrü boyunca açık tutulur. */
function attachKillOnCloseJob(nativeDir) {
  const a = bind(nativeDir);
  const job = a.CreateJobObjectW(null, null);
  if (!job) throw new Error(`CreateJobObjectW başarısız (Win32 hata ${a.GetLastError()})`);
  const info = { BasicLimitInformation: { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } };
  if (!a.SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, a.k.type(a.EXT).size)) {
    throw new Error(`SetInformationJobObject başarısız (Win32 hata ${a.GetLastError()})`);
  }
  if (!a.AssignProcessToJobObject(job, a.GetCurrentProcess())) {
    throw new Error(`AssignProcessToJobObject başarısız (Win32 hata ${a.GetLastError()})`);
  }
  // GC'nin handle'ı toplamasını önlemek için modül seviyesinde tut.
  attachKillOnCloseJob.handle = job;
  return job;
}

function isAdmin(nativeDir) {
  return Boolean(bind(nativeDir).IsUserAnAdmin());
}

module.exports = { attachKillOnCloseJob, isAdmin, showMessage };
