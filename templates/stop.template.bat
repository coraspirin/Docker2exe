@echo off
rem docker2exe: {{APP_NAME}} durdurucu
rem Once launcher uzerinden graceful kapatma istenir (veritabanlari temiz kapanir).
echo {{APP_NAME}} durduruluyor...
"%~dp0launcher.exe" --stop
if %errorlevel% equ 0 (
  echo {{APP_NAME}} ve servisleri durduruldu.
  goto :done
)
if %errorlevel% equ 2 (
  echo {{APP_NAME}} zaten calismiyor.
  goto :done
)
echo Graceful durdurma basarisiz, bu paketin surecleri sonlandiriliyor...
rem Sadece bu paketin klasorlerinden calisan surecler hedeflenir (makinedeki diger postgres/redis vb. etkilenmez).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d='%~dp0'; $r=Join-Path $env:LOCALAPPDATA '{{APP_ID}}\runtime'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.StartsWith($d, 'OrdinalIgnoreCase') -or $_.ExecutablePath.StartsWith($r, 'OrdinalIgnoreCase')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Uygulama ve servisler sonlandirildi.
:done
rem Pencere hemen kapanmasin diye kisa bekleme (timeout komutu stdin yonlendirmesinde calismaz)
ping -n 4 127.0.0.1 >nul
