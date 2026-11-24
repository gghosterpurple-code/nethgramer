# Собирает подписанный Nethgram.apk. Запуск из папки android:
#   powershell -ExecutionPolicy Bypass -File .\sign.ps1
# Если ключа nethgram.jks ещё нет, скрипт создаст его.

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

function Stop-WithError($text) {
    Write-Host ''
    Write-Host "ОШИБКА: $text" -ForegroundColor Red
    exit 1
}

$buildTools = Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk\build-tools" -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'apksigner.bat') } |
    Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } |
    Select-Object -Last 1
if (-not $buildTools) { Stop-WithError 'Не найдены Android build-tools.' }
$bt = $buildTools.FullName

$keytool = 'C:\Program Files\Java\jdk-21\bin\keytool.exe'
if (-not (Test-Path $keytool)) {
    $keytool = Get-ChildItem 'C:\Program Files\Java' -Recurse -Filter keytool.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $keytool) { Stop-WithError 'Не найден keytool (Java).' }

$hasKey = Test-Path 'nethgram.jks'
if ($hasKey) {
    Write-Host 'Ключ nethgram.jks найден.' -ForegroundColor Cyan
    $password = if ($env:NETHGRAM_KS_PASS) { $env:NETHGRAM_KS_PASS } else { Read-Host 'Введите пароль от ключа' }
} else {
    Write-Host 'Ключа ещё нет, создаём новый.' -ForegroundColor Cyan
    $password = if ($env:NETHGRAM_KS_PASS) { $env:NETHGRAM_KS_PASS } else { Read-Host 'Придумайте пароль (от 6 символов, английские буквы и цифры) и ЗАПИШИТЕ его' }
}
if ($password -notmatch '^[A-Za-z0-9]{6,}$') { Stop-WithError 'Пароль: минимум 6 символов, только английские буквы и цифры.' }

if (-not $hasKey) {
    & $keytool -genkeypair -keystore nethgram.jks -alias nethgram -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass $password -keypass $password -dname 'CN=Nethgram, O=Nethgram' 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path 'nethgram.jks')) { Stop-WithError 'Не удалось создать ключ.' }
    Write-Host 'Ключ создан.' -ForegroundColor Green
}

Write-Host 'Сборка...' -ForegroundColor Cyan
& cmd /c '.\gradlew.bat assembleRelease --console=plain'
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Сборка не удалась, текст ошибки выше.' }

$unsigned = 'app\build\outputs\apk\release\app-release-unsigned.apk'
Remove-Item aligned.apk, Nethgram.apk -ErrorAction SilentlyContinue

& "$bt\zipalign.exe" -f -p 4 $unsigned aligned.apk
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Не удалось подготовить APK (zipalign).' }

& cmd /c "`"$bt\apksigner.bat`" sign --ks nethgram.jks --ks-pass pass:$password --out Nethgram.apk aligned.apk 2>&1" | Out-Null
$signCode = $LASTEXITCODE
Remove-Item aligned.apk, Nethgram.apk.idsig -ErrorAction SilentlyContinue
if ($signCode -ne 0 -or -not (Test-Path 'Nethgram.apk')) { Stop-WithError 'Не удалось подписать APK. Скорее всего, неверный пароль.' }

& cmd /c "`"$bt\apksigner.bat`" verify Nethgram.apk 2>&1" | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-WithError 'APK подписан неправильно.' }

$file = Get-Item 'Nethgram.apk'
Write-Host ''
Write-Host ('ГОТОВО: {0} ({1:N1} МБ)' -f $file.FullName, ($file.Length / 1MB)) -ForegroundColor Green
Write-Host 'Сохраните nethgram.jks и пароль: без них обновления не встанут поверх приложения.' -ForegroundColor Yellow
