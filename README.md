# docker2exe

Docker Compose ile çalışan bir Node.js web uygulamasını Docker gerektirmeden Windows'ta çalışan **tek bir exe'ye** dönüştürür. İsterseniz taşınabilir klasör ve zip de üretir. Veritabanları (PostgreSQL, MySQL, MariaDB, MongoDB, Redis) gerçek Windows binary'leri olarak pakete gömülür; uygulama kodunuz değiştirilmez.

```
docker2exe.exe C:\Projeler\my-app   →   build-output\my-app.exe   →   hedef makinede çift tıkla, çalışsın
```

## İçindekiler

- [Gereksinimler](#gereksinimler)
- [1. docker2exe'yi hazırlama](#1-docker2exeyi-hazırlama)
- [2. Uygulamanızı paketleme](#2-uygulamanızı-paketleme)
- [3. Paketi hedef makinede çalıştırma](#3-paketi-hedef-makinede-çalıştırma)
- [Sorun giderme](#sorun-giderme)
- [Referans](#referans): bayraklar, desteklenen projeler ve veritabanları, iç işleyiş

## Gereksinimler

| | Build makinesi (paketi üreten) | Hedef makine (paketi çalıştıran) |
|---|---|---|
| İşletim sistemi | Windows 10 1803+ / 11, x64 | Windows 10 1803+ / 11, x64 |
| Node.js | `docker2exe.exe` ile **gerekmez** (içinde gömülü). Kaynaktan çalıştırırken 22+ | Gerekmez |
| Docker | Gerekmez | Gerekmez |
| Diğer | İnternet (ilk build'de DB binary'leri ve npm paketleri iner), git (sadece GitHub kaynağı için) | Gerekmez (.NET Framework 4.8 Windows'ta hazır gelir) |

Paketlenecek proje: kökünde `docker-compose.yml` bulunan, web servisi `build:` ile tanımlı bir Node.js uygulaması. Ayrıntılar: [Desteklenen proje düzenleri](#desteklenen-proje-düzenleri).

## 1. docker2exe'yi hazırlama

Bu adım bir kez yapılır. Sonuç, başka bir makineye de kopyalanabilen tek dosya `dist\docker2exe.exe`'dir.

```bash
git clone https://github.com/coraspirin/Docker2exe.git
cd Docker2exe
npm install
npm run build:exe
```

Çıktı: `dist\docker2exe.exe` (~58 MB; Node.js ve npm içinde). İstediğiniz yere kopyalayın. İlk çalıştırmada kendini `%LOCALAPPDATA%\docker2exe\tool\` altına açar (birkaç saniye), sonraki çalıştırmalar anında başlar.

> **Exe üretmeden kullanmak:** `npm install` sonrası `node src/cli.js <proje-klasörü>` aynı işi yapar (Node.js 22+ gerekir). `npm link` ile `docker2exe` komutu global olur.

## 2. Uygulamanızı paketleme

Üç yoldan biriyle başlatın:

- **Komut satırı:** `docker2exe.exe C:\Projeler\my-app`
- **Sürükle-bırak:** proje klasörünü `docker2exe.exe`'nin üzerine bırakın.
- **Çift tıklama:** `docker2exe.exe`'yi açın; proje klasörünü pencereye sürükleyip Enter'a basın (GitHub URL'i de yazabilirsiniz).

docker2exe önce projeyi analiz eder (**pre-flight**): compose servisleri, uygulama giriş dosyası, port, Node sürümü, veritabanı sürümleri. Belirsiz bir şey varsa (örn. `postgres:latest` gibi sürümsüz imaj) tahmin etmez; hatayı ve çözüm bayrağını yazıp durur. Örnek: `--pg-version 16`.

Kontrol geçince hangi çıktıların üretileceğini sorar:

```
Çıktı türü
  1) Tek exe  — hedef makineye tek dosya kopyalanır, çift tıklayınca çalışır (önerilen)
  2) Klasör   — Başlat.bat / Durdur.bat ile taşınabilir klasör
  3) Zip      — klasörün zip'i
  4) Hepsi
Seçiminiz (birden fazlası için virgülle, örn. 1,3) [1]:
```

Enter'a basarsanız sadece exe üretilir. Build birkaç dakika sürer; ilk build DB binary'lerini indirdiği için daha uzundur, sonrakiler cache'i kullanır. Sonuç `build-output\` klasöründedir. Explorer'dan başlattıysanız bu klasör `docker2exe.exe`'nin yanında oluşur.

```
✔ Tek exe: C:\...\build-output\my-app.exe (106 MB)
  Başlatmak için: C:\...\build-output\my-app.exe
```

Sık kullanılan örnekler:

```bash
docker2exe C:\Projeler\my-app --check            # sadece analiz raporu, build yok
docker2exe C:\Projeler\my-app --format exe,zip   # sormadan exe + zip
docker2exe C:\Projeler\my-app --pg-version 16    # sürümsüz postgres imajı için sürüm
docker2exe https://github.com/user/repo --branch develop --token <PAT>
docker2exe clean-cache --keep-latest             # indirilen DB binary cache'ini temizle
```

Tüm bayraklar: `docker2exe --help` veya [Bayraklar](#bayraklar). Build'in ayrıntılı günlüğü `build-output\<uygulama>.build.log` dosyasındadır.

## 3. Paketi hedef makinede çalıştırma

### Tek exe (`<Uygulama>.exe`)

1. Exe'yi hedef makineye kopyalayın (USB, ağ paylaşımı vb.). Kurulum yoktur.
2. **Çift tıklayın.** İlk açılışta bir ilerleme penceresiyle kendini `%LOCALAPPDATA%\<app>\app\` altına açar (yüzlerce MB'lık paketlerde birkaç saniye). Sonraki açılışlar anında başlar.
3. Küçük bir **durum penceresi** açılır: "Veritabanları başlatılıyor..." → "● Çalışıyor". Uygulama hazır olunca tarayıcı kendiliğinden açılır. Pencerede adres ve **Tarayıcıda aç** düğmesi bulunur.
4. **Kapatmak için pencereyi kapatın** (X veya **Durdur ve kapat**). Uygulama ve veritabanları düzgünce durdurulur.

- Uygulama açıkken exe'ye tekrar tıklamak ikinci bir kopya başlatmaz, mevcut pencereyi öne getirir.
- Komut satırından durdurma: `<Uygulama>.exe --stop`.
- **Güncelleme:** yeni build'in exe'sini eskisinin yerine koyup çalıştırın. Veriler korunur, eski sürümün açılmış dosyaları otomatik silinir.

### Klasör / zip

Zip'i açın (klasörü kopyalayın), sonra:

- `Başlat.bat` uygulamayı arka planda başlatır ve hazır olunca tarayıcıyı açar.
- `Durdur.bat` uygulamayı ve veritabanlarını durdurur.
- `OKUBENI.txt`: adres, servisler ve sürümler.

### Veriler, loglar ve ayarlar

| Ne | Nerede |
|---|---|
| Veritabanı dosyaları, yüklenen dosyalar (volume'ler) | `%LOCALAPPDATA%\<app>\data\` (exe ve klasör sürümü ortak kullanır; güncellemede korunur) |
| Loglar | `%LOCALAPPDATA%\<app>\logs\` (`launcher.log`, `app.log`, `postgres.log` ...) |
| Ortam değişkenlerini değiştirme (klasör sürümü) | `config\.env.template` dosyasını `config\.env` olarak kopyalayıp düzenleyin |

Yedek almak için uygulamayı durdurup `%LOCALAPPDATA%\<app>\data\` klasörünü kopyalamanız yeterlidir.

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| "Windows bilgisayarınızı korudu" (SmartScreen) | Exe'ler imzasızdır. **Ek bilgi → Yine de çalıştır**. |
| Güvenlik Duvarı izin soruyor | Uygulama tüm ağ arayüzlerinde dinliyordur; sadece bu bilgisayardan kullanılacaksa "İptal" de olur. |
| Başlatma hatası mesaj kutusu | Mesajdaki aşamaya bakın; ayrıntı `%LOCALAPPDATA%\<app>\logs\launcher.log` ve ilgili servis logunda. |
| Port dolu | Launcher otomatik olarak bir sonraki boş portu seçer ve bağlantı adreslerini günceller; tarayıcı doğru adrese açılır. |
| Build "Pre-flight kontrolünde hata" ile durdu | Raporda her hatanın yanında önerilen bayrak yazar (`--service`, `--entry`, `--port`, `--pg-version` ...). |
| Build npm/pkg adımında hata verdi | `build-output\<uygulama>.build.log` dosyasında komutun tam çıktısı bulunur. |
| Kurumsal ağda indirme hatası | Proxy için `HTTP_PROXY`/`HTTPS_PROXY`; SSL inceleme için önce `NODE_EXTRA_CA_CERTS`, son çare `--insecure`. |
| Uygulamanın bir özelliği Windows'ta çalışmıyor | Dockerfile'da `apk add`/`apt-get install` ile kurulan araçlar pakete girmez; build bunları uyarı olarak listeler. Bkz. [Bilinen sınırlamalar](#bilinen-sınırlamalar). |

---

## Referans

### Bayraklar

`docker2exe <proje-klasörü | github-url> [bayraklar]`. Eski yazım (`docker2exe build --path ...` / `--github ...`) de çalışır.

| Bayrak | Açıklama |
|---|---|
| `--format <exe,klasor,zip,hepsi>` | Çıktı türleri. Verilmezse sorulur; terminal etkileşimli değilse (CI) üçü de üretilir. `--no-zip`/`--no-exe`: sormadan ilgili çıktıyı atla |
| `--check`, `--json` | Sadece pre-flight raporu (metin / JSON), build yok |
| `--service <ad>` | Birden fazla build'li servis varsa web servisini seçer |
| `--entry <dosya>`, `--port <n>` | Otomatik tespit başarısız olursa |
| `--node-target <22\|24\|26>` | Paketlenecek Node sürümü (varsayılan: Dockerfile `FROM node:XX` / `engines.node`) |
| `--db-version <servis=versiyon>` | `latest`/tag'siz image için versiyon (tekrarlanabilir) |
| `--pg-version`, `--redis-version`, `--mongo-version`, `--mysql-version`, `--mariadb-version` | Tip bazında versiyon |
| `--redis-engine <redis-windows\|memurai>` | `memurai`: Redis binary gömülmez, hedef makinede kurulu Memurai servisi kullanılır (Memurai lisansı yeniden dağıtıma izin vermez; launcher sadece sağlık kontrolü yapar) |
| `--name`, `--out` | Uygulama adı, çıktı klasörü (varsayılan `build-output`) |
| `--branch`, `--token` | GitHub kaynağı için dal ve private repo PAT'i (`GITHUB_TOKEN` ortam değişkeni de olur) |
| `--offline` | DB binary'lerini sadece cache'ten kullan |
| `--insecure` | Kurumsal SSL inspection'da son çare: sadece DB binary indirmesinde TLS doğrulamasını atlar (SHA256 yine kontrol edilir). Önce `NODE_EXTRA_CA_CERTS` deneyin |
| `--desktop-shortcut` | Masaüstü kısayolu (klasör varsa Başlat.bat, yoksa exe) |

Kurumsal ağ: `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` hem DB binary indirmelerinde hem git clone'da otomatik kullanılır.

### Desteklenen proje düzenleri

- Tek servis: Express/Fastify/Koa/Nest backend (+ `client/`, `frontend/`, `ui/`, `web/` altında SPA; çıktı `express.static` hedefine yerleştirilir)
- Monorepo: `server/` + `client/` kardeş klasörler (`express.static(path.join(__dirname, '../client/dist'))`); göreli düzen pakette korunur. Compose `context: ./server` olabilir veya kökten build alıp Dockerfile'da `WORKDIR /app/server` + `COPY server/ ./` kullanabilir (uygulama klasörü son stage'de WORKDIR'a kopyalanan klasörden bulunur)
- SSR: Next.js (`output: 'standalone'`), Nuxt (Nitro), SvelteKit (`adapter-node`) — tek başına veya backend'in yanında ayrı compose servisi olarak (`frontend.exe`; tarayıcı frontend portunu açar, frontend'in backend adresi port değişikliğinde güncellenir)

### Desteklenen veritabanları

Versiyonlar, URL'ler ve SHA256'lar [manifests/db-manifest.json](manifests/db-manifest.json) içindedir.

| DB | Seriler | Kaynak |
|---|---|---|
| PostgreSQL | 14–18 | EDB "binaries only" zip |
| Redis | 6, 7, 8 | [redis-windows/redis-windows](https://github.com/redis-windows/redis-windows) (msys2) |
| MongoDB | 7.0, 8.0 (8.2 deneysel) | Resmi `mongodb-windows-x86_64` zip |
| MySQL | 8.4, 9.7 | Resmi noinstall zip (MariaDB ile ikame edilmez) |
| MariaDB | 10.11, 11.4, 11.8, 12.3 | Resmi winx64 zip |

Manifest'teki 17 versiyonun tamamı `test/e2e/db-matrix.js` ile gerçek binary'lerle uçtan uca doğrulandı (kurulum, başlatma, sağlık kontrolü, compose kimlik bilgileriyle bağlantı, graceful kapatma). Manifest güncellendiğinde `npm run test:e2e -- --mark` ile yeniden doğrulanır.

### Pipeline

```
Kaynak → Compose parse (.env interpolasyonu, servis adı → 127.0.0.1) → Stack tespiti (entry, port, Node)
→ DB pre-flight (tüm servisler toplu) → DB binary (indirme + SHA256 + cache) → Frontend build
→ npm install → native modül ABI kontrolü → pkg (app.exe) → launcher.exe (Job Object self-test) → klasör → zip → tek exe
```

Pre-flight'ta belirsiz olan her şey (latest tag, EOL/desteklenmeyen versiyon, entry/port bulunamaması, ABI uyuşmazlığı) build'i durdurur; tahminle devam edilmez.

**Tek dosya exe:** [runtime/sfx/Sfx.cs](runtime/sfx/Sfx.cs), Windows'la gelen .NET Framework 4 `csc.exe` ile derlenen ~14 KB'lık bir stub'dır. Düzen: `[stub][zip][meta][trailer]`; payload olarak build'in zip'i yeniden sıkıştırılmadan eklenir. Açılım klasörü adı zip'in SHA256'sıdır; yarım açılım `.d2e-sfx-complete` işaretiyle tespit edilip tekrarlanır, eşzamanlı açılışlar mutex ile sıralanır. Durum penceresi launcher'ın kontrol kanalını (`\\.\pipe\docker2exe-<appId>`, `status`/`stop` komutları) kullanır: uygulama zaten çalışıyorsa (örn. `Başlat.bat` ile) yeni launcher başlatmaz, ona bağlanır; launcher dışarıdan durdurulursa (`Durdur.bat`, `--stop`) pencere kendiliğinden kapanır. `stop`'a 2 dakikada yanıt gelmezse launcher sonlandırılır (Job Object alt süreçleri de kapatır).

### Çalışma zamanı (launcher.exe)

`INIT → EXTRACT → START_DEPS/HEALTH_CHECK → START_APP → OPEN_BROWSER → RUNNING → SHUTTING_DOWN`

- **Öksüz süreç koruması:** launcher kendini `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` bayraklı bir Job Object'e bağlar (koffi FFI). Launcher çökse veya `taskkill /F` ile öldürülse bile tüm alt süreçler OS tarafından sonlandırılır. Fallback yoktur; build sırasında paketlenen exe ile self-test yapılır.
- **Konsolsuz:** launcher.exe'nin PE subsystem'i build sırasında GUI yapılır. Uygulama çalışırken tekrar `Başlat.bat` çalıştırmak yeni örnek başlatmaz, tarayıcıyı açar.
- **İlk çalıştırma:** DB binary'leri `%LOCALAPPDATA%\<app>\runtime` altına kopyalanır, veritabanları compose ortamına göre kurulur (`POSTGRES_*`, `MYSQL_*`/`MARIADB_*`, `MONGO_INITDB_*`, redis `--requirepass`), `/docker-entrypoint-initdb.d` altındaki `.sql` dosyaları çalıştırılır. Yarıda kalan kurulum `.d2e-init-complete` işaretiyle tespit edilip baştan yapılır.
- **Port çakışması:** port doluysa bir sonraki boş port seçilir, bağlantı string'leri (URL'ler ve `DB_HOST`/`DB_PORT` gibi çiftler) güncellenir ve loglanır; sonra sağlık kontrolü zorunludur.
- **Yönetici hakları:** PostgreSQL varsa kontrol edilir; `pg_ctl` Postgres'i kısıtlı token ile başlatır, bu da başarısız olursa net hata verilir.
- **Çökme:** DB veya uygulama beklenmedik kapanırsa otomatik restart yapılmaz, her şey kapatılır ve ilgili log gösterilir.
- **Ortam:** Dockerfile `ENV` + compose `environment` (compose öncelikli). Container yolu olan değerler eşlenir: volume altındakiler (compose named volume, Dockerfile `VOLUME`) → `%LOCALAPPDATA%\<app>\data\volumes\<volume>\...` (paket güncellense de veri korunur), imaj içindekiler (`/app/client/dist`) → paketteki karşılığı; karşılığı olmayanlar çıkarılır ve build'de uyarılır. Bind mount'lar taşınmaz.
- **ES module uygulamalar** (`"type": "module"`): kod snapshot'a gömülmez; `app.exe` bir yükleyicidir ve `app/` altındaki gerçek dosyaları (node_modules dahil) yükler. `import.meta`, dinamik `import()` ve worker thread'ler Docker'daki gibi çalışır.

### Bilinen sınırlamalar

- Sadece Windows x64; build makinesi de Windows olmalı.
- V8 ABI'ye bağlı native modüller (örn. `better-sqlite3`) build'i çalıştıran Node ile derlenir; hedef Node sürümü farklıysa build durur. N-API modülleri (bcrypt, sqlite3, sharp ...) sürümden bağımsızdır.
- SQLite kullanan uygulamalar DB yolunu `process.env.SQLITE_DB_PATH` (yazılabilir veri klasörü) üzerinden okumalıdır; kaynak kod otomatik değiştirilmez.
- Next.js için `output: 'standalone'`, SvelteKit için `adapter-node` gereklidir. SSR çıktıları snapshot'a gömülmez; `app.exe`/`frontend.exe` gerçek dosya sisteminden yükleyen bir yükleyicidir.
- MongoDB init script'leri (mongosh gerektirir) ve kabuk script'leri çalıştırılmaz.
- Dockerfile'da kurulan işletim sistemi paketleri (`apk add`, `apt-get install` ...) pakete girmez; pre-flight bunları uyarı olarak listeler. Bu paketlerin komutlarını çağıran özellikler (örn. `pdftoppm`) hedef makinede kurulu değilse çalışmaz.
- Uygulama kodu pakette okunabilir durumdadır (`--no-bytecode`; dinamik `import()` uyumluluğu için).
- Exe'ler kod imzalı değildir; SmartScreen ilk çalıştırmada uyarı verebilir.

### Geliştirme

```bash
npm test                   # birim testleri (node:test)
npm run test:e2e           # manifest'teki tüm DB versiyonları (indirme gerektirir)
npm run build:exe          # dist\docker2exe.exe (--node <sürüm> ile gömülecek Node seçilir; varsayılan: çalışan Node)
```

`docker2exe.exe`: resmi Node.js Windows zip'i (SHASUMS256 ile doğrulanır, npm dahil) + araç kodu + production `node_modules`, konsol SFX stub'ıyla tek dosya. Araç pkg ile derlenmez: npm, pkg ve koffi gerçek dosya sisteminde çalışmalı. Gömülü Node, npm script'leri (`node install.js`, `npm run build`) için PATH'in başına eklenir; build makinesinde ayrıca Node gerekmez.

Fixture'lar (`test/fixtures/`): `express-pg-redis` (Express + Postgres + Redis + bcrypt + SPA), `monorepo-mariadb` (server/ + client/ + MariaDB), `api-nuxt` (API + Nuxt SSR servisi + Redis), `next-standalone` (Next.js), `full-stack` (parser senaryoları).

Launcher çok dosyalı olduğu için `runtime/` klasöründedir (`runtime/launcher.js` giriş noktası); `templates/` bat ve OKUBENI şablonlarını içerir.
