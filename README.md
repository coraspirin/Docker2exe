# docker2exe

Docker Compose ile çalışan bir Node.js web uygulamasını (yerel klasör veya GitHub reposu), Docker gerektirmeden Windows'ta çalışan taşınabilir bir klasöre/zip'e dönüştürür. Veritabanları gerçek Windows binary'leri olarak pakete gömülür; uygulama kodu değiştirilmez.

## Gereksinimler

- Windows 10 1803+ (build makinesi ve hedef makine), x64
- Build makinesinde Node.js 22+, npm ve git (GitHub kaynağı için)

## Kullanım

```bash
npm install
npm link                      # isteğe bağlı: `docker2exe` komutunu global yapar
docker2exe build --path ./my-app
docker2exe build --github https://github.com/user/repo --branch develop --token <PAT>
docker2exe build --path ./my-app --check        # sadece pre-flight raporu
docker2exe clean-cache [--keep-latest]
```

(`npm link` yapılmadıysa `node src/cli.js ...`)

Çıktı: `build-output/<Uygulama>/` ve `build-output/<Uygulama>.zip`. Hedef makinede `Başlat.bat` çalıştırılır: launcher pencere açmadan arka planda çalışır, uygulama hazır olunca tarayıcı açılır. Durdurmak için `Durdur.bat`. Hatalar Windows mesaj kutusuyla gösterilir.

| Bayrak | Açıklama |
|---|---|
| `--service <ad>` | Birden fazla build'li servis varsa web servisini seçer |
| `--entry <dosya>`, `--port <n>` | Otomatik tespit başarısız olursa |
| `--node-target <22\|24\|26>` | Paketlenecek Node sürümü (varsayılan: Dockerfile `FROM node:XX` / `engines.node`) |
| `--db-version <servis=versiyon>` | `latest`/tag'siz image için versiyon (tekrarlanabilir) |
| `--pg-version`, `--redis-version`, `--mongo-version`, `--mysql-version`, `--mariadb-version` | Tip bazında versiyon |
| `--redis-engine <redis-windows\|memurai>` | `memurai`: Redis binary gömülmez, hedef makinede kurulu Memurai servisi kullanılır (Memurai lisansı yeniden dağıtıma izin vermez; launcher sadece sağlık kontrolü yapar) |
| `--name`, `--out` | Uygulama adı, çıktı klasörü |
| `--offline` | DB binary'lerini sadece cache'ten kullan |
| `--insecure` | Kurumsal SSL inspection'da son çare: sadece DB binary indirmesinde TLS doğrulamasını atlar (SHA256 yine kontrol edilir). Önce `NODE_EXTRA_CA_CERTS` deneyin |
| `--no-zip`, `--desktop-shortcut` | Zip üretme / masaüstü kısayolu |

Kurumsal ağ: `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` hem DB binary indirmelerinde hem git clone'da otomatik kullanılır.

## Pipeline

```
Kaynak → Compose parse (.env interpolasyonu, servis adı → 127.0.0.1) → Stack tespiti (entry, port, Node)
→ DB pre-flight (tüm servisler toplu) → DB binary (indirme + SHA256 + cache) → Frontend build
→ npm install → native modül ABI kontrolü → pkg (app.exe) → launcher.exe (Job Object self-test) → paket + zip
```

Pre-flight'ta belirsiz olan her şey (latest tag, EOL/desteklenmeyen versiyon, entry/port bulunamaması, ABI uyuşmazlığı) build'i durdurur; tahminle devam edilmez.

## Desteklenen proje düzenleri

- Tek servis: Express/Fastify/Koa/Nest backend (+ `client/`, `frontend/`, `ui/`, `web/` altında SPA; çıktı `express.static` hedefine yerleştirilir)
- Monorepo: `server/` + `client/` kardeş klasörler (`express.static(path.join(__dirname, '../client/dist'))`); göreli düzen pakette korunur
- SSR: Next.js (`output: 'standalone'`), Nuxt (Nitro), SvelteKit (`adapter-node`) — tek başına veya backend'in yanında ayrı compose servisi olarak (`frontend.exe`; tarayıcı frontend portunu açar, frontend'in backend adresi port değişikliğinde güncellenir)

## Desteklenen veritabanları

Versiyonlar, URL'ler ve SHA256'lar [manifests/db-manifest.json](manifests/db-manifest.json) içindedir.

| DB | Seriler | Kaynak |
|---|---|---|
| PostgreSQL | 14–18 | EDB "binaries only" zip |
| Redis | 6, 7, 8 | [redis-windows/redis-windows](https://github.com/redis-windows/redis-windows) (msys2) |
| MongoDB | 7.0, 8.0 (8.2 deneysel) | Resmi `mongodb-windows-x86_64` zip |
| MySQL | 8.4, 9.7 | Resmi noinstall zip (MariaDB ile ikame edilmez) |
| MariaDB | 10.11, 11.4, 11.8, 12.3 | Resmi winx64 zip |

Manifest'teki 17 versiyonun tamamı `test/e2e/db-matrix.js` ile gerçek binary'lerle uçtan uca doğrulandı (kurulum, başlatma, sağlık kontrolü, compose kimlik bilgileriyle bağlantı, graceful kapatma). Manifest güncellendiğinde `npm run test:e2e -- --mark` ile yeniden doğrulanır.

## Çalışma zamanı (launcher.exe)

`INIT → EXTRACT → START_DEPS/HEALTH_CHECK → START_APP → OPEN_BROWSER → RUNNING → SHUTTING_DOWN`

- **Öksüz süreç koruması:** launcher kendini `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` bayraklı bir Job Object'e bağlar (koffi FFI). Launcher çökse veya `taskkill /F` ile öldürülse bile tüm alt süreçler OS tarafından sonlandırılır. Fallback yoktur; build sırasında paketlenen exe ile self-test yapılır.
- **Konsolsuz:** launcher.exe'nin PE subsystem'i build sırasında GUI yapılır. Uygulama çalışırken tekrar `Başlat.bat` çalıştırmak yeni örnek başlatmaz, tarayıcıyı açar.
- **İlk çalıştırma:** DB binary'leri `%LOCALAPPDATA%\<app>\runtime` altına kopyalanır, veritabanları compose ortamına göre kurulur (`POSTGRES_*`, `MYSQL_*`/`MARIADB_*`, `MONGO_INITDB_*`, redis `--requirepass`), `/docker-entrypoint-initdb.d` altındaki `.sql` dosyaları çalıştırılır. Yarıda kalan kurulum `.d2e-init-complete` işaretiyle tespit edilip baştan yapılır.
- **Port çakışması:** port doluysa bir sonraki boş port seçilir, bağlantı string'leri (URL'ler ve `DB_HOST`/`DB_PORT` gibi çiftler) güncellenir ve loglanır; sonra sağlık kontrolü zorunludur.
- **Yönetici hakları:** PostgreSQL varsa kontrol edilir; `pg_ctl` Postgres'i kısıtlı token ile başlatır, bu da başarısız olursa net hata verilir.
- **Çökme:** DB veya uygulama beklenmedik kapanırsa otomatik restart yapılmaz, her şey kapatılır ve ilgili log gösterilir.
- **Loglar:** `%LOCALAPPDATA%\<app>\logs\` (`launcher.log`, `app.log`, `postgres.log`, `redis.log` ...).
- **Ayar:** `config\.env.template` → `config\.env` olarak kopyalanıp düzenlenebilir.

## Bilinen sınırlamalar

- Sadece Windows x64; build makinesi de Windows olmalı.
- V8 ABI'ye bağlı native modüller (örn. `better-sqlite3`) build'i çalıştıran Node ile derlenir; hedef Node sürümü farklıysa build durur. N-API modülleri (bcrypt, sqlite3, sharp ...) sürümden bağımsızdır.
- SQLite kullanan uygulamalar DB yolunu `process.env.SQLITE_DB_PATH` (yazılabilir veri klasörü) üzerinden okumalıdır; kaynak kod otomatik değiştirilmez.
- Next.js için `output: 'standalone'`, SvelteKit için `adapter-node` gereklidir. SSR çıktıları snapshot'a gömülmez; `app.exe`/`frontend.exe` gerçek dosya sisteminden yükleyen bir yükleyicidir.
- MongoDB init script'leri (mongosh gerektirir) ve kabuk script'leri çalıştırılmaz.
- Uygulama tüm arayüzlerde dinliyorsa (`app.listen(PORT)`) Windows Güvenlik Duvarı ilk çalıştırmada izin isteyebilir.
- Uygulama kodu pakette okunabilir durumdadır (`--no-bytecode`; dinamik `import()` uyumluluğu için).

## Geliştirme

```bash
npm test                   # birim testleri (node:test)
npm run test:e2e           # manifest'teki tüm DB versiyonları (indirme gerektirir)
```

Fixture'lar (`test/fixtures/`): `express-pg-redis` (Express + Postgres + Redis + bcrypt + SPA), `monorepo-mariadb` (server/ + client/ + MariaDB), `api-nuxt` (API + Nuxt SSR servisi + Redis), `next-standalone` (Next.js), `full-stack` (parser senaryoları).

Spec'teki `templates/launcher.template.js` yerine launcher çok dosyalı olduğu için `runtime/` klasöründedir (`runtime/launcher.js` giriş noktası); `templates/` bat ve OKUBENI şablonlarını içerir.
