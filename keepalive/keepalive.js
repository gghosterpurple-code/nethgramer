#!/usr/bin/env node
/**
 * Универсальная версия пинга: работает на любом хостинге или компьютере с Node.js 18+.
 * Без зависимостей.
 *
 *   node keepalive.js                постоянно, раз в 14 минут
 *   node keepalive.js --once         один пинг (для cron)
 *
 * Адрес: переменная TARGET_URL. Интервал в минутах: INTERVAL_MIN.
 */
const URL_TO_PING = process.env.TARGET_URL || 'https://nethgram.onrender.com/healthz';
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN) || 14;

async function ping() {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(URL_TO_PING, {
        headers: { 'User-Agent': 'nethgram-keepalive', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(90000),
      });
      await res.arrayBuffer();
      if (res.ok) {
        console.log(new Date().toISOString(), 'ok', res.status);
        return true;
      }
      console.error(new Date().toISOString(), 'HTTP', res.status);
    } catch (e) {
      console.error(new Date().toISOString(), 'ошибка:', e.message);
    }
    if (i < 3) await new Promise(r => setTimeout(r, 5000));
  }
  return false;
}

if (process.argv.includes('--once')) {
  ping().then(ok => { process.exitCode = ok ? 0 : 1; });
} else {
  ping();
  setInterval(ping, INTERVAL_MIN * 60 * 1000);
}
