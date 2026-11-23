/**
 * NETHGRAM STORAGE
 * Если задана переменная окружения DATABASE_URL — данные лежат в PostgreSQL
 * (переживают сон/перезапуск/деплой на Render). Иначе работает по-старому: файл data.json.
 *
 * Схема: одна таблица nethgram_kv (collection, key, value jsonb). Каждый пользователь, чат,
 * канал, подарки и т.д. — отдельная строка. При сохранении пишутся только изменившиеся строки.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Структура проекта: server/ (этот код), client/, static/, data/ (локальные данные)
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const LEGACY_DATA_FILE = path.join(ROOT_DIR, 'data.json');   // старое расположение (до разделения на папки)
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
/** Путь к локальному файлу данных для чтения: data/data.json, иначе старый data.json в корне. */
function localDataPath() {
  if (fs.existsSync(DATA_FILE)) return DATA_FILE;
  if (fs.existsSync(LEGACY_DATA_FILE)) return LEGACY_DATA_FILE;
  return null;
}
const DATABASE_URL = process.env.DATABASE_URL || '';
const usesDb = !!DATABASE_URL;

const ARRAY_COLLS = ['users', 'channels'];                       // data[coll] = [ {id, ...} ]
const MAP_COLLS = ['messages', 'giftStock', 'userGifts', 'nftCounters', 'fakeMembers',
                   'userStars', 'premiumUsernames', 'channelGifts', 'giveaways', 'dailyRewards'];  // data[coll] = { key: value }
const META_KEYS = ['globalSoldOut', 'velosipe', 'premiumUsers'];  // одиночные значения

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const rk = (c, k) => c + '\u0000' + k;
const digests = new Map();   // rowKey -> md5 последнего успешно записанного значения
let pool = null;

// ── data  <->  строки таблицы ──
function toRows(data) {
  const rows = new Map();
  const add = (coll, key, val) => {
    if (val === undefined) return;
    const json = JSON.stringify(val);
    if (json === undefined) return;
    rows.set(rk(coll, key), { coll, key: String(key), json });
  };
  for (const c of ARRAY_COLLS) for (const o of (data[c] || [])) add(c, o.id, o);
  for (const c of MAP_COLLS) for (const [k, v] of Object.entries(data[c] || {})) add(c, k, v);
  for (const k of META_KEYS) add('meta', k, data[k]);
  return rows;
}
function fromRows(list) {
  const data = {};
  for (const c of ARRAY_COLLS) data[c] = [];
  for (const c of MAP_COLLS) data[c] = {};
  for (const { collection: c, key, value } of list) {
    if (ARRAY_COLLS.includes(c)) data[c].push(value);
    else if (MAP_COLLS.includes(c)) data[c][key] = value;
    else if (c === 'meta') data[key] = value;
  }
  return data;
}

// ── подключение ──
function getPool() {
  if (pool) return pool;
  let Pool;
  try { ({ Pool } = require('pg')); }
  catch (e) { throw new Error('Модуль "pg" не установлен. Выполни: npm install'); }
  const local = /(@|\/\/)(localhost|127\.0\.0\.1)([:\/]|$)/.test(DATABASE_URL) || /sslmode=disable/.test(DATABASE_URL) || process.env.PGSSLMODE === 'disable';
  // sslmode из строки подключения убираем: SSL задаётся явно ниже (иначе pg пишет SECURITY WARNING в лог).
  // Проверка сертификата включена — у Neon он настоящий (так же вела себя строка с sslmode=require).
  const connectionString = local ? DATABASE_URL
    : DATABASE_URL.replace(/([?&])sslmode=[^&]*(&|$)/, (m, p1, p2) => (p2 ? p1 : '')).replace(/[?&]$/, '');
  pool = new Pool({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: true },
    max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 20000, keepAlive: true,
  });
  pool.on('error', e => console.error('[db] pool error:', e.message));
  return pool;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Загрузка при старте. Возвращает объект data или null (файловый режим / пустая база без data.json). */
async function loadAll() {
  if (!usesDb) {
    console.warn('[db] ⚠ DATABASE_URL не задан — данные сохраняются в файл ' + DATA_FILE + '.');
    if (process.env.RENDER) console.warn('[db] ⚠ На Render файл стирается при сне/перезапуске! Добавьте DATABASE_URL в Environment.');
    return null;
  }
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const p = getPool();
      await p.query(`CREATE TABLE IF NOT EXISTS nethgram_kv (
        collection text NOT NULL, key text NOT NULL, value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (collection, key))`);
      const res = await p.query('SELECT collection, key, value FROM nethgram_kv');
      if (res.rows.length) {
        for (const r of res.rows) digests.set(rk(r.collection, r.key), md5(JSON.stringify(r.value)));
        console.log('[db] PostgreSQL: загружено строк —', res.rows.length);
        return fromRows(res.rows);
      }
      // база пустая — разовый перенос из локального data.json, если он есть
      const localFile = localDataPath();
      if (localFile) {
        try {
          const d = JSON.parse(fs.readFileSync(localFile, 'utf8'));
          if (d && (d.users || []).length) { console.log('[db] база пустая, переношу данные из data.json'); return d; }
        } catch (e) {}
      }
      console.log('[db] PostgreSQL подключён, база пустая — начинаем с нуля');
      return null;
    } catch (e) {
      lastErr = e;
      console.error(`[db] подключение не удалось (${attempt}/6):`, e.message);
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

// ── сохранение (только изменившиеся строки, один сохраняющий поток) ──
let running = null, pendingRows = null, pendingForce = false;
// Курс VELO$IPE меняется каждые 15 с. Если писать его сразу, Neon не засыпает и съедает месячный лимит,
// поэтому одно только движение рынка сохраняем раз в час. Сделки и любые другие данные пишутся сразу.
const MARKET_KEY = rk('meta', 'velosipe');
const MARKET_SAVE_MS = 60 * 60 * 1000;
let lastMarketWrite = Date.now();

function save(data, opts) {
  pendingRows = toRows(data);          // снимок состояния прямо сейчас
  pendingForce = pendingForce || !!(opts && opts.force);
  if (!running) running = drain();
  return running;
}
async function drain() {
  try {
    while (pendingRows) { const rows = pendingRows, force = pendingForce; pendingRows = null; pendingForce = false; await writeRows(rows, force); }
  } finally { running = null; }
}
function flush() { return running || Promise.resolve(); }

async function writeRows(rows, force) {
  const up = [], del = [];
  for (const [key, r] of rows) { const h = md5(r.json); if (digests.get(key) !== h) up.push([key, r, h]); }
  for (const key of digests.keys()) if (!rows.has(key)) del.push(key);
  if (!up.length && !del.length) return;
  if (!force && !del.length && up.length === 1 && up[0][0] === MARKET_KEY && Date.now() - lastMarketWrite < MARKET_SAVE_MS) return;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // батчи по ~6 МБ / 400 строк
    for (let i = 0; i < up.length;) {
      const c = [], k = [], v = []; let size = 0;
      while (i < up.length && c.length < 400 && size < 6e6) { const [, r] = up[i]; c.push(r.coll); k.push(r.key); v.push(r.json); size += r.json.length; i++; }
      await client.query(
        `INSERT INTO nethgram_kv (collection, key, value)
         SELECT t.c, t.k, t.v::jsonb FROM unnest($1::text[], $2::text[], $3::text[]) AS t(c, k, v)
         ON CONFLICT (collection, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [c, k, v]);
    }
    if (del.length) {
      const c = del.map(x => x.split('\u0000')[0]), k = del.map(x => x.split('\u0000')[1]);
      await client.query(`DELETE FROM nethgram_kv WHERE (collection, key) IN (SELECT * FROM unnest($1::text[], $2::text[]))`, [c, k]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
  if (up.some(x => x[0] === MARKET_KEY)) lastMarketWrite = Date.now();
  for (const [key, , h] of up) digests.set(key, h);
  for (const key of del) digests.delete(key);
}

module.exports = { usesDb, loadAll, save, flush, DATA_FILE, localDataPath, ROOT_DIR };
