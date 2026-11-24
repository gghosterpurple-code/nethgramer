# Nethgram для Android (WebView)

Приложение открывает `https://nethgram.onrender.com`. Правки сайта появляются в приложении сами, новый APK для них не нужен.

## 1. Ассеты

**Скопируйте, а не перенесите**: сервер продолжает брать файлы из `static/`.

Скопируйте три папки из `static/`:

```
static/assets    →  android/app/src/main/assets/web/assets
static/gifts     →  android/app/src/main/assets/web/gifts
static/stickers  →  android/app/src/main/assets/web/stickers
```

Должно получиться `android/app/src/main/assets/web/gifts/Lime.json`.
Подпапка `assets/emoji` в APK не попадёт сама. APK будет весить примерно 35–45 МБ.

Можно не копировать ничего: всё будет грузиться с сервера, а APK будет весить несколько МБ.

## 2. Сборка

Android Studio → **Open** → папка `android` → дождаться Gradle Sync.

- Проверочный APK: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
  Файл: `android/app/build/outputs/apk/debug/app-debug.apk`.
- Для раздачи людям: **Build → Generate Signed Bundle / APK → APK → Create new** (ключ), вариант **release**.
  Файл: `android/app/release/app-release.apk`.

Или в терминале из папки `android`: `gradlew assembleDebug`.

**Сохраните файл ключа `.jks` и пароль.** Без того же ключа обновление не установится поверх старой версии. В Git ключи не попадают.

## Уведомления

Работают без Firebase: приложение держит отдельное лёгкое соединение с сервером.

- При первом входе разрешите **уведомления** и **работу без ограничений батареи**.
- В шторке будет тихий значок «Получение новых сообщений». Android требует его для фоновой работы. Скрыть: зажмите уведомление → отключите канал **«Фоновая связь»**. Сообщения продолжат приходить.
- **Xiaomi / Redmi / POCO:** Настройки → Приложения → Nethgram → включите **Автозапуск**, Контроль активности → **Нет ограничений**.
- **Huawei / Honor:** Батарея → Запуск приложений → Nethgram → **Управление вручную**, включить всё.
- **Samsung:** Батарея → Ограничения фонового использования → добавьте Nethgram в **Приложения без ограничений**.
- **Oppo / Realme / Vivo:** разрешите **Автозапуск** и фоновую активность.

Если смахнуть приложение и система всё равно его закроет, уведомления вернутся при следующем открытии. Пропущенные за последние 48 часов сообщения придут после восстановления связи.

## Что менять

| Что | Где |
|---|---|
| Адрес сервера | `app/build.gradle`, `SERVER_URL` |
| Версия перед новым APK | `app/build.gradle`, увеличить `versionCode` и `versionName` |
| Имя приложения | `app/src/main/res/values/strings.xml` |
| Иконка | `app/src/main/res/drawable-nodpi/ic_launcher_logo.png` (логотип канала Nethgram news) |
| ID приложения | `app/build.gradle`, `applicationId` (менять до первой раздачи) |
