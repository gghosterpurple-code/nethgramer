/**
 * Nethgram keepalive для Cloudflare Workers (бесплатный план).
 * Раз в 14 минут открывает /healthz, чтобы сервер на Render не засыпал.
 * База данных при этом не трогается, поэтому лимит Neon не расходуется.
 *
 * Адрес можно поменять переменной TARGET_URL в настройках Worker.
 */
const DEFAULT_URL = 'https://nethgram.onrender.com/healthz';
const ATTEMPTS = 3;
const TIMEOUT_MS = 90000; // если сервер всё же спал, он просыпается около минуты

export async function ping(url, fetchImpl = fetch, retryDelayMs = 5000) {
  let last = 'нет ответа';
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'nethgram-keepalive', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        console.log(`ok ${res.status} (попытка ${i})`);
        return true;
      }
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.message;
    }
    if (i < ATTEMPTS) await new Promise(r => setTimeout(r, retryDelayMs));
  }
  console.error(`сервер не ответил: ${last}`);
  return false;
}

export default {
  // запускается по расписанию (Cron: */14 * * * *)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ping((env && env.TARGET_URL) || DEFAULT_URL));
  },
  // обычное открытие адреса Worker ничего не пингует — только показывает, что он жив
  async fetch() {
    return new Response('Nethgram keepalive работает\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};
