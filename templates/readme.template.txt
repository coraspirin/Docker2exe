{{APP_NAME}} — docker2exe ile paketlendi ({{BUILD_DATE}})

BASLATMA
  Başlat.bat dosyasına çift tıklayın. Uygulama arka planda (pencere açmadan) çalışır.
  İlk çalıştırmada veritabanları kurulur (biraz sürebilir), uygulama hazır olunca tarayıcı
  otomatik açılır: {{APP_URL}}
  Uygulama çalışırken Başlat.bat'a tekrar tıklamak sadece tarayıcıyı açar.
  Bir sorun olursa hata mesajı penceresi gösterilir; ayrıntılar log klasöründedir.

DURDURMA
  Durdur.bat çalıştırın. Veritabanları düzgün şekilde kapatılır.

VERI VE LOGLAR
  Veri:  %LOCALAPPDATA%\{{APP_ID}}\data\
  Loglar: %LOCALAPPDATA%\{{APP_ID}}\logs\  (launcher.log, app.log ve her veritabanı için ayrı log)
  Bu klasör silinirse tüm veriler kaybolur.

AYARLAR
  config\.env.template dosyasını config\.env olarak kopyalayıp düzenleyerek uygulamanın ortam
  değişkenlerini değiştirebilirsiniz (değişiklik bir sonraki başlatmada geçerli olur).

ICERIK
{{SERVICES}}
