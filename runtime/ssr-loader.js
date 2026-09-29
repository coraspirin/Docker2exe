/**
 * SSR yükleyici (pkg ile frontend.exe / SSR app.exe olarak derlenir).
 *
 * Next.js standalone, Nuxt (Nitro) ve SvelteKit (adapter-node) çıktıları kendi sunucularını içerir ve
 * `process.chdir(__dirname)`, dinamik require/import gibi pkg snapshot'ında çalışmayan kalıplar kullanır.
 * Bu yüzden çıktı snapshot'a gömülmez; exe'nin yanındaki klasörden gerçek dosya sisteminden yüklenir.
 *
 * ES module backend'ler (type: module) de aynı nedenle (import.meta, dinamik import, worker thread) bununla yüklenir.
 *
 * Ortam: D2E_SSR_DIR (exe'ye göre klasör), D2E_SSR_ENTRY (klasöre göre giriş dosyası),
 *        D2E_SSR_ESM ('1': import() ile yükle), D2E_KEEP_CWD ('1': entry klasörüne chdir yapma)
 */
const path = require('path');
const { pathToFileURL } = require('url');

const dir = process.env.D2E_SSR_DIR;
const entryRel = process.env.D2E_SSR_ENTRY;
if (!dir || !entryRel) {
  console.error('D2E_SSR_DIR / D2E_SSR_ENTRY tanımlı değil');
  process.exit(1);
}
const entry = path.resolve(path.dirname(process.execPath), dir, entryRel);
// ESM backend'ler de bu yükleyiciyle çalışır; onlarda cwd launcher'ın verdiği uygulama kökü kalır (Docker WORKDIR'ı gibi)
if (process.env.D2E_KEEP_CWD !== '1') process.chdir(path.dirname(entry));

if (/\.mjs$/.test(entry) || process.env.D2E_SSR_ESM === '1') {
  import(pathToFileURL(entry).href).catch(err => {
    console.error(err);
    process.exit(1);
  });
} else {
  require(entry);
}
