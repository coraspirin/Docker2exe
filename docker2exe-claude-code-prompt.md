# Proje: docker2exe — Docker Tabanlı Node.js Web Uygulamalarını Windows EXE'ye Dönüştüren CLI Aracı

## Amaç

Docker Compose ile çalışacak şekilde geliştirilmiş bir Node.js/Express web uygulamasını (yerel klasör veya GitHub reposu olarak verilir), Docker gerektirmeden yerel Windows makinesinde çalışabilen taşınabilir bir exe paketine dönüştüren bir CLI aracı geliştir.

Kullanım şekli:

```
docker2exe build --path ./my-app
docker2exe build --github https://github.com/user/repo
docker2exe build --github https://github.com/user/repo --branch develop --token <PAT>
docker2exe build --path ./my-app --insecure   # kurumsal proxy/SSL kesintisi varsa (son çare)
docker2exe clean-cache
docker2exe clean-cache --keep-latest
```

Kullanıcı sadece kaynağı (klasör yolu veya GitHub linki) verir, geri kalan her şey (parse, build, paketleme) otomatik yapılır. Hedef kitle: SAP/enterprise ortamında çalışan, kendi geliştirdiği yardımcı web uygulamalarını (defter, harcama takibi, portal gibi) Docker olmayan makinelerde de çalıştırabilmek isteyen bir geliştirici. Aracın kendisi tek kullanıcılı / dahili kullanım için, üçüncü taraf dağıtım önceliği yok — bu yüzden installer yerine basit portable klasör/zip çıktısı tercih ediliyor.

## Teknoloji Yığını

- **CLI framework:** `commander`
- **GitHub clone:** `simple-git`
- **Compose/YAML parse:** `yaml`
- **Node → exe:** `@yao-pkg/pkg` (vercel/pkg'nin aktif community fork'u — orijinal pkg artık bakımsız)
- **Zip/extract:** `extract-zip`, `archiver`
- **Terminal UX:** `ora` (spinner), renkli/net hata mesajları
- **Dosya işlemleri:** `fs-extra`
- Node.js 20+ üzerinde, **sadece Windows hedefli** (native modül derlemeleri nedeniyle cross-platform build güvenilir değil — build makinesi Windows olmalı)

## Genel Pipeline

```
[Kaynak Belirleme] → [Doğrulama] → [Parse] → [Uyumluluk Kontrolü]
→ [DB Bundling] → [Node Build] → [Launcher Üretimi] → [Paketleme]
```

## Proje Yapısı

```
docker2exe/
├── src/
│   ├── cli.js
│   ├── sources/
│   │   ├── localSource.js
│   │   └── githubSource.js
│   ├── parser/
│   │   ├── composeParser.js
│   │   └── dockerfileParser.js
│   ├── detector/
│   │   └── stackDetector.js
│   ├── compatibility/
│   │   └── versionResolver.js
│   ├── builder/
│   │   ├── nodeBuilder.js
│   │   ├── dbBundler.js
│   │   └── launcherGen.js
│   ├── packager/
│   │   └── portablePackager.js
│   └── utils/
│       └── tempWorkspace.js
├── manifests/
│   └── db-manifest.json
├── templates/
│   ├── launcher.template.js
│   ├── start.template.bat
│   └── stop.template.bat
└── package.json
```

## Modül Detayları ve Kararlaştırılmış Mimari

### 1. Kaynak Belirleme (`sources/`)

- **Local:** Verilen path, build kirlenmesin diye bir temp workspace'e kopyalanır, orijinal proje klasörüne dokunulmaz.
- **GitHub:** `simple-git` ile `git clone --depth 1 <url> <tempDir>` (branch verilirse `--branch` eklenir). Private repo için `--token` (GitHub PAT) desteklenir, token URL'e enjekte edilir. Build bitince temp klasör silinir. Kurumsal ağ toleransı: sistemdeki `HTTP_PROXY`/`HTTPS_PROXY` ortam değişkenleri `simple-git`'in altında çalışan `git`'e otomatik yansır (git bu değişkenleri kendi başına okur), ek konfigürasyon gerekmez.

### 2. `composeParser.js`

`docker-compose.yml`/`.yaml`/`compose.yml` dosyasını bulur, parse eder ve şu bilgiyi üretir:
- `webService`: build edilecek Node.js servisi (image değil, `build` alanı olan)
- `dependencyServices`: bilinen DB image'leri (postgres, redis, mongo, mysql, mariadb tespiti)
- Her servis için: ports (normalize edilmiş `{host, container}`), environment (array veya object formatını normalize et), volumes, `depends_on` (array veya object formatını normalize et)

Referans implementasyon (önceki planlama sürecinde yazıldı, birebir kullanılabilir):

```javascript
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

function parseCompose(projectDir) {
  const composePath = findComposeFile(projectDir);
  if (!composePath) {
    throw new Error('docker-compose.yml veya docker-compose.yaml bulunamadı');
  }
  const raw = fs.readFileSync(composePath, 'utf8');
  const doc = YAML.parse(raw);

  const services = Object.entries(doc.services || {}).map(([name, cfg]) => ({
    name,
    image: cfg.image || null,
    build: cfg.build
      ? {
          context: path.resolve(projectDir, typeof cfg.build === 'string' ? cfg.build : cfg.build.context || '.'),
          dockerfile: cfg.build.dockerfile || 'Dockerfile'
        }
      : null,
    ports: (cfg.ports || []).map(normalizePort),
    environment: normalizeEnv(cfg.environment),
    volumes: cfg.volumes || [],
    dependsOn: cfg.depends_on
      ? (Array.isArray(cfg.depends_on) ? cfg.depends_on : Object.keys(cfg.depends_on))
      : [],
    isDatabase: detectKnownDbImage(cfg.image)
  }));

  return {
    webService: services.find(s => s.build && !s.isDatabase) || null,
    dependencyServices: services.filter(s => s.isDatabase),
    otherServices: services.filter(s => !s.build && !s.isDatabase),
    raw: services
  };
}

function findComposeFile(dir) {
  const candidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const name of candidates) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function normalizePort(entry) {
  if (typeof entry === 'string') {
    const [host, container] = entry.split(':');
    return { host: Number(host), container: Number(container || host) };
  }
  return { host: entry.published, container: entry.target };
}

function normalizeEnv(env) {
  if (!env) return {};
  if (Array.isArray(env)) return Object.fromEntries(env.map(e => e.split('=')));
  return env;
}

const KNOWN_DB_IMAGES = ['postgres', 'redis', 'mongo', 'mysql', 'mariadb'];
function detectKnownDbImage(image) {
  if (!image) return false;
  return KNOWN_DB_IMAGES.some(db => image.toLowerCase().includes(db));
}

module.exports = { parseCompose };
```

**Ek zorunlu görev — Env interpolation ve servis adı → localhost remap:**

`composeParser`, YAML parse edilmeden önce kök dizindeki `.env` dosyasını (veya compose içindeki `env_file` referanslarını) okumalı ve `${VARIABLE}` / `${VARIABLE:-default}` söz dizimlerini gerçek değerleriyle resolve etmelidir. Tanımsız kalan bir değişken sessizce boş bırakılmaz — eksik değişken build raporunda listelenir.

Ayrıca Docker Compose servis isimleri (`postgres`, `redis`, `db` gibi) Windows'ta DNS ile resolve edilemez. Bu yüzden:
- `environment` içindeki bağlantı string'leri (`DATABASE_URL`, `REDIS_URL`, `MONGO_URI` vb.) ve host değişkenleri (`DB_HOST`, `POSTGRES_HOST`, `REDIS_HOST` vb.) taranır
- Tespit edilen servis isimleri otomatik olarak `127.0.0.1`/`localhost`'a remap edilir
- Sonuç, servise **`resolvedEnvironment`** adında ayrı bir alan olarak eklenir (orijinal `environment` bozulmadan korunur) — launcher çalışma zamanında `.env` üretirken bunu kullanır
- Her değiştirilen host/URL, build raporunda tablo halinde kullanıcıya gösterilir (sessiz bir dönüşüm olarak kalmaz)

### 3. `stackDetector.js`

Otomatik entry point ve port tespiti (kullanıcıya soru sorulmaz, tam otomatik olmalı):
1. `package.json` → `scripts.start` komutundan entry point çıkar
2. Yoksa `package.json` → `main`
3. Yoksa Dockerfile `CMD`/`ENTRYPOINT` parse et
4. Hiçbiri yoksa hata ver, `--entry` flag'i zorunlu kıl (fallback, otomasyonu bozan durum kullanıcıya net bildirilir)

Port tespiti: önce compose `ports`, yoksa Dockerfile `EXPOSE`, yoksa kod içinde `process.env.PORT` fallback pattern'i taranır.

### 4. Uyumluluk Doğrulama Katmanı (`compatibility/versionResolver.js`) — KRİTİK

Bu, projenin en önem verilen kısmı: **hiçbir aşamada "muhtemelen uyumlu" varsayımıyla sessizce devam edilmemeli.**

- Image tag'inden major versiyon parse et (`postgres:15-alpine` → `15`, `redis:7.2.4-bookworm` → `7`). Varyant sonekleri (`-alpine`, `-bookworm` vb.) yok sayılır.
- Tag `latest` ise veya tag yoksa → **build durur**, kullanıcıya hangi versiyonu hedeflediğini netleştirmesi istenir (`--pg-version 15` gibi override flag'i).
- `manifests/db-manifest.json` içinde her DB tipi için `supported_majors`, `eol_majors`, `experimental_majors` listeleri tutulur; her versiyon girdisi `tested: true/false` alanı taşır.
- Desteklenmeyen/eol versiyon → build durur, net mesaj + desteklenen versiyon listesi gösterilir. Sessiz downgrade/fallback **yapılmaz**.
- `experimental` (test edilmemiş ama teorik uyumlu) versiyonlarla build çalışır ama sarı uyarı verir.
- Kontrol **tüm DB servisleri için toplu** yapılır (pre-flight check raporu) — ilk uyumsuzlukta durup kullanıcıyı art arda tekrar denetmeye zorlamaz.
- Aynı DB tipinden farklı versiyonlarda birden fazla servis olabilir (örn. iki farklı Postgres) — her biri izole `data/<servis-adı>/` klasörüne ve kendi binary'sine sahip olur, bu durum raporda açıkça belirtilir.

`manifests/db-manifest.json` başlangıç iskeleti:

```json
{
  "postgres": {
    "supported_majors": [14, 15, 16],
    "eol_majors": [11, 12, 13],
    "experimental_majors": [],
    "versions": {
      "15": { "url": "<EDB-zip-url>", "sha256": "<hash>", "tested": true }
    }
  },
  "redis": {
    "supported_majors": [6, 7],
    "eol_majors": [],
    "experimental_majors": [],
    "versions": {
      "7": { "url": "<tporadowski-zip-url>", "sha256": "<hash>", "tested": true, "engine": "tporadowski" }
    }
  },
  "mongo": {
    "supported_majors": [5, 6, 7],
    "eol_majors": [4],
    "experimental_majors": [],
    "versions": {}
  },
  "mariadb": {
    "supported_majors": [10, 11],
    "eol_majors": [],
    "experimental_majors": [],
    "versions": {}
  }
}
```

### 5. `dbBundler.js`

DB eşleştirme stratejisi: **gerçek portable binary gömme** (SQLite'a otomatik düşürme değil — uygulama kodunun değişmeden çalışması, gerçekten generic bir araç olması önceliklendirildi).

| DB | Binary Kaynağı | Engine Notu |
|---|---|---|
| Postgres | EDB resmi "binaries only" zip | `initdb.exe`, `pg_ctl.exe`, `pg_isready.exe` |
| Redis | `tporadowski/redis-windows` (varsayılan), `--redis-engine memurai` opsiyonel | Resmi Redis Windows'u desteklemiyor |
| MongoDB | Resmi `mongodb-windows-x86_64` zip | SSPL, yerel masaüstü kullanımı ihlal etmiyor |
| MySQL/MariaDB | MariaDB noinstall zip | GPL, serbestçe redistribute edilebilir |

Süreç:
1. İndirme: `~/.docker2exe/cache/<db-tipi>/<versiyon>/` altına, **SHA256 checksum doğrulamasıyla**. Doğrulama başarısızsa cache'e yazılmaz, geçici dosya silinir, build hatayla durur.
2. Sonraki build'ler cache'ten kullanır (`--offline` flag'i ile cache zorunlu kılınabilir).
3. Sadece compose'da **gerçekten kullanılan** DB'ler bundle edilir.
4. Veri kalıcılığı: `%LOCALAPPDATA%\<AppName>\data\<servis-adı>\`

**Kurumsal ağ/proxy ve SSL kesintisi toleransı:** SAP/enterprise ortamlarda Zscaler, Cisco Umbrella gibi araçlar TLS trafiğine araya girip kendi sertifikalarını enjekte eder (SSL inspection/MITM). Bu yüzden binary indirme (EDB/MongoDB/tporadowski zip'leri) şu sırayla ele alınır:
- İndirme istemcisi sistemdeki `HTTP_PROXY`/`HTTPS_PROXY` ortam değişkenlerini otomatik tanır (proxy-agent üzerinden), ayrı bir flag gerekmez.
- SSL doğrulama hatası (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`) alınırsa, önce `NODE_EXTRA_CA_CERTS` ile bir kurumsal kök sertifikası tanımlı mı kontrol edilir/kullanıcıya önerilir — bu, güvenliği bozmadan kurumsal MITM sertifikasını meşru şekilde tanımanın doğru yolu.
- Bu yeterli olmazsa, CLI'a `--insecure` bayrağı eklenir; verildiğinde TLS doğrulaması **process-wide** (`NODE_TLS_REJECT_UNAUTHORIZED=0`) değil, **sadece o indirme isteğine özel** (`https.Agent({ rejectUnauthorized: false })`) olarak atlanır — böylece git clone/npm install gibi diğer ağ işlemleri etkilenmez. Bu bayrak kullanıldığında konsola **her seferinde** "TLS doğrulaması atlanıyor, bu güvenli değildir, mümkünse NODE_EXTRA_CA_CERTS kullanın" uyarısı yazılır, sessizce geçiştirilmez.

**Cache boyutu yönetimi:** Postgres/MongoDB binary'leri yüzlerce MB olabildiğinden, birden fazla proje/versiyon denendiğinde `~/.docker2exe/cache/` hızla büyüyebilir.
- Ayrı bir CLI komutu eklenir: `docker2exe clean-cache` (tüm cache'i temizler) ve `docker2exe clean-cache --keep-latest` (her DB tipi için sadece en son kullanılan versiyonu tutar, gerisini siler).
- Her build sonunda toplam cache boyutu hesaplanır; belirli bir eşiği (örn. 5GB) aşarsa konsola bilgilendirici bir uyarı yazılır ("Cache boyutu X GB'a ulaştı, `docker2exe clean-cache` ile temizleyebilirsiniz") — otomatik silme yapılmaz, karar kullanıcıya bırakılır.

### 6. `nodeBuilder.js`

- `npm install --production` (devDependencies hariç)
- `@yao-pkg/pkg` config'i otomatik üretilir: `targets` (package.json `engines.node`'dan veya varsayılan `node20-win-x64`), `assets`, `scripts`
- **Native modül tespiti kritik:** `node_modules` taranır, bilinen native paket listesiyle (bcrypt, sharp, sqlite3, canvas, argon2, better-sqlite3 vb.) eşleştirilir. `@yao-pkg/pkg`'nin snapshot dosya sistemi native `.node` eklentilerini bellekten yükleyemediği için bu paketler **pkg snapshot'ına hiç gömülmez** — derlenmiş `node_modules/<paket-adı>` klasörleri fiziksel olarak `build-output/<AppName>/node_modules/` altına kopyalanır. Launcher, `app.exe`'yi başlatırken `NODE_PATH` ortam değişkenini bu harici `node_modules` dizinine işaret edecek şekilde enjekte eder. Build sırasında native modül binary'lerinin Node ABI versiyonu ile pkg'nin hedef Node versiyonu karşılaştırılır (pre-flight check); uyuşmazsa build durur, sessizce devam edilmez.
- **Frontend build (yalnızca SPA/statik çıktı projeleri için) — multi-stage simülasyonu yasak, monorepo alt dizin farkındalığı:** Dockerfile içindeki Linux'a özgü adımlar (`RUN apk add`, `sh build.sh`, Linux path'leri) hiçbir şekilde taklit edilmeye çalışılmaz. Bunun yerine: önce compose web servisinin `build.context` yolu ve projede yaygın isimlendirilen alt klasörler (`client/`, `frontend/`, `ui/`) taranır, bu alt dizinlerden hangisinde ayrı bir `package.json` + `scripts.build` varsa tespit edilir. Bulunursa derleme kök dizinde değil, `npm --prefix <alt-dizin> run build` şeklinde tetiklenir; çıktı dizini (`dist`/`build`/`public`) tespit edilip Express'in static middleware'inin işaret ettiği klasöre kopyalanır. Bu adım `nodeBuilder`'dan önce ayrı bir alt adım olarak koşulur.
- **SSR framework tespiti (Next.js, Nuxt.js, SvelteKit vb.) — ayrı servis olarak ele alınır, statik kopyalama uygulanmaz:** Frontend `package.json`'ında `next`/`nuxt`/`@sveltejs/kit` bağımlılığı veya `scripts.start` içinde `next start`/`nuxt start` gibi komutlar tespit edilirse, bu bir SPA değildir — yukarıdaki statik dosya kopyalama stratejisi **uygulanmaz**, çünkü SSR uygulamalar kendi Node.js sunucusuna ihtiyaç duyar ve Express içine statik olarak gömülemez.
  - **Next.js:** `next.config.js`'te `output: 'standalone'` ayarı var mı kontrol edilir. Varsa, `.next/standalone` çıktısı (minimal, kendi içinde çalışabilen bir `server.js` içerir — Next'in container/portable dağıtım için resmi önerdiği mod) frontend build'inin temeli olur.
  - **Nuxt.js:** Nitro'nun ürettiği `.output/server/index.mjs` (varsayılan olarak zaten standalone) kullanılır.
  - Standalone/Nitro çıktısı **yoksa** (örn. Next'te `output: 'standalone'` ayarlı değilse), **build durur** — "SSR framework tespit edildi ama standalone çıktı modu aktif değil, lütfen `next.config.js`'e `output: 'standalone'` ekleyin ve tekrar deneyin" mesajı verilir. Bu ayar kullanıcının config dosyasına sessizce/otomatik enjekte edilmez.
  - Standalone çıktı bulunduğunda, bu **ayrı bir `frontend.exe`** olarak pkg ile derlenir (backend `app.exe`'den bağımsız), kendi portunda çalışır. `launcherGen` bunu (bkz. madde 7) üçüncü bir servis olarak state machine'e ekler; `OPEN_BROWSER` adımında açılan port backend değil, kullanıcının asıl giriş noktası olan **frontend portu** olur.
- Environment variable'lar build-time'da gömülmez; launcher çalışma zamanında `.env` üretip enjekte eder.
- **SQLite ve salt-okunur pkg snapshot çakışması:** `@yao-pkg/pkg`'nin oluşturduğu sanal dosya sistemi salt okunurdur; uygulama SQLite (`better-sqlite3`, `sqlite3` vb.) kullanıyorsa ve `.db`/`.sqlite` dosya yolu kod içinde `__dirname` gibi statik bir yola bağlıysa, uygulama ilk yazma denemesinde çöker. Bu, native modül dışarıda tutma stratejisinden (yukarıdaki madde) **ayrı bir sorun** — native binding değil, veri dosyasının kendisiyle ilgili. Çözüm: launcher, çalışma zamanında `SQLITE_DB_PATH` adında bir ortam değişkenini yazılabilir bir konuma (`%LOCALAPPDATA%\<AppName>\data\`) işaret edecek şekilde enjekte eder. Ancak bu, **uygulama kodunun bu değişkeni okuyacak şekilde yazılmış olmasını gerektirir** — araç kullanıcının kaynak kodunu sessizce değiştirip `.db` yolunu otomatik patch'lemez (bu, kırılgan ve öngörülemez bir AST manipülasyonu olurdu). SQLite tespit edilirse build raporunda açık bir uyarı gösterilir: "SQLite tespit edildi, uygulamanızın DB yolunu `process.env.SQLITE_DB_PATH` üzerinden okuduğundan emin olun, aksi halde uygulama yazma denemesinde çökecektir."

### 7. `launcherGen.js`

Ayrı, hafif bir orchestrator exe (`launcher.exe`, kendisi de pkg ile derlenir, birkaç MB). State machine:

```
INIT → EXTRACT (ilk çalıştırma, binary'ler LOCALAPPDATA'ya kopyalanır, initdb vb. koşulur)
→ START_DEPS (composeParser dependsOn sırasına göre child_process.spawn)
→ HEALTH_CHECK (pg_isready, redis-cli ping vb., max 30sn timeout, DUR eğer geçmezse)
→ START_APP (Express app spawn, .env ile)
→ OPEN_BROWSER (app portu HTTP GET ile gerçekten cevap verince `open` paketiyle tarayıcı açılır)
→ RUNNING (child process exit event'leri sürekli dinlenir)
→ SHUTTING_DOWN (ters sırayla graceful shutdown, timeout'ta kill)
```

Hata toleransı prensipleri (önem sırasıyla):
- **Init yarıda kalma koruması:** init tamamlanınca data klasörüne `.d2e-init-complete` marker dosyası yazılır. Yoksa launcher "yarım kalmış kurulum" sayar, klasörü temizleyip init'i baştan dener.
- **Runtime crash:** bir DB process'i beklenmedik kapanırsa log'a yazılır, **otomatik restart denenmez** (veri bütünlüğü riski), kullanıcı launcher'ı yeniden başlatmaya yönlendirilir.
- **Dinamik port atama:** spawn öncesi hedef port kontrol edilir; doluysa **işlem durdurulmaz** — bir sonraki boş port otomatik seçilir, DB bu portla başlatılır ve `resolvedEnvironment`'taki bağlantı adresi/portu buna göre güncellenir. Bu yönlendirme sessiz yapılmaz — konsola ve `launcher.log`'a "Port X kullanımda olduğu için Y portuna yönlendirildi ve bağlantı string'i güncellendi" uyarısı yazılır. Spawn *sonrası* health-check (servis gerçekten cevap veriyor mu) yine de zorunludur; health-check başarısız olursa (port açıldı ama servis yanıt vermiyor) bu gerçek bir arıza sinyalidir, sessiz retry yapılmadan kullanıcıya net hata verilir.
- Tray icon **kapsam dışı** (native modül sorunu yaratıyor, gereksiz karmaşıklık) — bunun yerine konsolsuz çalışan launcher + `Durdur.bat` (taskkill wrapper) yeterli.
- **Öksüz süreç (orphan process) önleme — Windows Job Object API (zorunlu, fallback'siz):** launcher, alt süreçleri (`app.exe`, `postgres.exe`, `redis-server.exe`, varsa `frontend.exe`) bir Windows Job Object'e bağlar (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` bayrağıyla), böylece launcher çökse veya zorla kapatılsa bile OS tüm alt süreçleri anında sonlandırır. Node.js standart kütüphanesinde Job Object API olmadığından `koffi` (derleme gerektirmeyen, platform başına prebuilt binary sunan FFI paketi) ile köprü kurulur; koffi'nin native bileşeni diğer native modüller gibi pkg snapshot'ına gömülmez, fiziksel olarak launcher'ın yanına çıkartılır (bkz. madde 6). **WMI tabanlı polling fallback'i kullanılmaz** — launcher `taskkill /F` ile anında öldürülürse ayrı bir watcher process'i de aynı anda ölebileceğinden bu, sessizce daha zayıf bir garanti sunan bir "workaround"a dönüşür. FFI/Job Object entegrasyonu native derleme veya platform sorunuyla başarısız olursa, **build durdurulur** ve native derleme hatası net şekilde loglanır — geriye düşülecek ikinci, "daha az güvenilir ama çalışan" bir yol bilinçli olarak tanımlanmamıştır.
- **Administrator yetki kontrolü (pre-flight, sadece Postgres varsa):** Bu kontrol projede PostgreSQL kullanılıyorsa devreye girer — Redis/Mongo/MariaDB'nin böyle bir kısıtı yok, sadece Postgres varsa `isAdmin()` çağrılır. Launcher elevated ("Yönetici Olarak Çalıştır") modda başlatılmışsa işlem hemen durmaz: önce alt süreç `runas /trustlevel:0x20000` (Basic User seviyesi, kısıtlı token) ile başlatılmaya denenir. Bu da başarısız olursa **o zaman** işlem durur; `launcher.log` ve konsola net hata yazılır: "PostgreSQL güvenlik kısıtı nedeniyle uygulama Yönetici haklarıyla çalıştırılamaz, lütfen standart kullanıcı olarak başlatın."

Log stratejisi:
```
%LOCALAPPDATA%\<AppName>\logs\
  ├── launcher.log
  ├── postgres.log / redis.log / mongo.log / mariadb.log
  └── app.log
```
Her child process'in stdout/stderr'i ilgili log dosyasına yönlendirilir. `FAILED` durumunda hangi log dosyasına bakılacağı kullanıcıya net söylenir.

### 8. `packager/portablePackager.js`

**Installer YOK.** NSIS/installer yaklaşımı bilinçli olarak terk edildi çünkü: tek kullanıcılı/dahili kullanım senaryosunda gereksiz ağırlık, enterprise ortamlarda installer çalıştırma izni kısıtlı olabiliyor, ve code signing/SmartScreen sorunu installer ile de çözülmüyor.

Çıktı, doğrudan bir portable klasör:

```
build-output/<AppName>/
├── launcher.exe
├── app.exe
├── deps/
│   ├── postgres/
│   └── redis/
├── config/
│   ├── .env.template
│   └── *.conf.template
├── assets/
├── Başlat.bat
├── Durdur.bat
└── icon.ico
```

`Başlat.bat`:
```batch
@echo off
start "" "%~dp0launcher.exe"
```

`Durdur.bat`:
```batch
@echo off
taskkill /F /IM launcher.exe /T >nul 2>&1
taskkill /F /IM app.exe /T >nul 2>&1
taskkill /F /IM pg_ctl.exe /T >nul 2>&1
taskkill /F /IM redis-server.exe /T >nul 2>&1
taskkill /F /IM mongod.exe /T >nul 2>&1
echo Uygulama ve servisler sonlandirildi.
```
(Job Object mimarisi çoğu durumda bunu zaten otomatik hallediyor olmalı — bu script sadece yedek/acil durum içindir.)

Son adım: klasör `archiver` ile `.zip`'e sıkıştırılır. Opsiyonel `--desktop-shortcut` flag'i verilirse küçük bir PowerShell/`WScript.Shell` script'i ile masaüstü kısayolu oluşturulur (varsayılan kapalı).

## Genel Hata Yönetimi Felsefesi (Tüm Modüller İçin Geçerli)

- Hiçbir noktada "muhtemelen çalışır" varsayımıyla sessizce devam edilmez.
- Belirsizlik (latest tag, test edilmemiş versiyon, eksik manifest girdisi, checksum uyuşmazlığı) her zaman kullanıcıya açık bir hata/uyarı olarak döner, otomatik tahmine dönüşmez.
- Workaround'lar kalıcı çözüm gibi sunulmaz; gerçek hata (log dosyası, exit code, hangi adımda durduğu) her zaman kullanıcıya net şekilde raporlanır.
- Sessiz retry/fallback yapılmaz (port çakışması, DB versiyon downgrade, native modül atlama gibi durumlarda).

## Başlangıç İçin İlk Görev

1. Proje iskeletini (`package.json`, klasör yapısı) oluştur.
2. `composeParser.js`'i yukarıdaki referans implementasyonla başlat, **`.env`/`env_file` interpolasyonunu ve servis adı → `127.0.0.1` remap mantığını (`resolvedEnvironment` alanı) dahil ederek**, birim testleri ekle (farklı compose formatları: array/object env, array/object depends_on, string/object build, tanımsız `${VAR}` durumu).
3. `cli.js`'te `commander` ile `build --path` ve `build --github` komutlarını iskelet olarak kur (henüz sonraki aşamalara bağlanmamış, sadece kaynak çözümleme + compose parse çıktısını konsola basan bir MVP).
4. Bu adım çalışır durumda olunca bir sonraki mesajda `stackDetector.js` ve uyumluluk katmanına geçeceğiz.

Not: Windows Job Object mimarisi (koffi, fallback'siz), dinamik port atama ve koşullu Administrator yetki kontrolü `launcherGen.js`/`launcher.template.js` aşamasında; monorepo alt dizin farkındalığı, SSR framework (Next.js/Nuxt.js) ayrı servis stratejisi ve SQLite yazılabilir yol enjeksiyonu `nodeBuilder.js` aşamasında; cache temizleme komutu (`clean-cache`) ve kurumsal proxy/SSL toleransı `dbBundler.js`/`githubSource.js`/`cli.js` aşamasında ele alınacak — ilk fazın kapsamında değil, ama plana zaten işlendi, ilgili aşamalara gelindiğinde atlanmamalı.

Sorular varsa veya bir karar noktasında belirsizlik hissedersen (özellikle native modül tespiti, manifest ilk versiyon listesi, veya DB binary URL'lerinin gerçek/güncel linkleri konusunda), varsayım yapıp sessizce ilerlemek yerine sor.
