# Пинг сервера, чтобы он не засыпал

Render засыпает через 15 минут без запросов. Этот скрипт открывает `/healthz` раз в 14 минут.
База данных при этом не используется.

## Установка на Cloudflare (бесплатно, 5 минут)

1. Зарегистрируйтесь на https://dash.cloudflare.com
2. Слева **Compute (Workers) → Workers & Pages → Create → Start with Hello World → Deploy**.
   Имя: `nethgram-keepalive`.
3. Нажмите **Edit code**, удалите всё и вставьте содержимое файла `worker.js`. Нажмите **Deploy**.
4. Вернитесь к Worker: **Settings → Trigger Events (Triggers) → Add → Cron Triggers**.
5. Впишите расписание `*/14 * * * *` и сохраните.

Проверка: вкладка **Logs** или **Cron Events** через 14 минут покажет успешный запуск.

Если адрес сайта изменится: **Settings → Variables → Add**, имя `TARGET_URL`,
значение `https://ваш-адрес.onrender.com/healthz`.

## Другой хостинг

`keepalive.js` запускается где угодно, где есть Node.js 18+:

```bash
TARGET_URL=https://nethgram.onrender.com/healthz node keepalive.js
```

Для системного cron: `*/14 * * * * node /путь/keepalive.js --once`

## Лимиты

- Render: 750 бесплатных часов в месяц. Один сервис без сна тратит до 744. **Второй бесплатный сервис в этом аккаунте создавать нельзя**, иначе часов не хватит.
- Neon: 100 CU-часов в месяц. Пинг их не тратит, расходуют только реальные действия пользователей. Следите за графиком **Usage** в панели Neon.
