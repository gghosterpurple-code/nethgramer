/**
 * NETHGRAM SERVER — full featured
 * Pure Node.js, no external dependencies
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

const PORT      = process.env.PORT || 3000;
// Пароль администратора для /l. На хостинге задайте переменную окружения ADMIN_PASSWORD.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'rgeok4309fkl443p';
// Официальный канал новостей: все новые пользователи подписываются автоматически.
// Публиковать могут только те, кто ввёл секретную команду в боте Nethgram
// (на хостинге её лучше переопределить переменной окружения NEWS_POSTER_COMMAND).
const NEWS_CHANNEL_ID = 'neth_news';
const NEWS_CHANNEL_USERNAME = 'neth';
const NEWS_POSTER_COMMAND = (process.env.NEWS_POSTER_COMMAND || '/imrerowq1').trim();
const DATA_FILE  = storage.DATA_FILE;                       // data/data.json (локальный режим без БД)
const CLIENT_DIR = path.join(storage.ROOT_DIR, 'client');   // фронтенд
const STATIC_DIR = path.join(storage.ROOT_DIR, 'static');   // картинки, подарки, стикеры

// ── STATE ──
const users          = new Map();
const messages       = new Map();
const channels       = new Map();
const pendingCodes   = new Map();
// ── ОБЛАЧНЫЙ ПАРОЛЬ ──
const verifiedPhones = new Map();   // цифры номера -> до какого времени действует подтверждённый код
const pwdAttempts    = new Map();   // цифры номера -> { n, lockUntil }
const CLOUD_PWD_MIN = 4, CLOUD_PWD_MAX = 128;
const CODE_VALID_MS = 10 * 60 * 1000, PWD_MAX_TRIES = 5, PWD_LOCK_MS = 5 * 60 * 1000;
function hashCloudPwd(pwd, saltHex) {
  return crypto.scryptSync(String(pwd), Buffer.from(saltHex, 'hex'), 32).toString('hex');
}
function makeCloudPwd(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashCloudPwd(pwd, salt) };
}
function checkCloudPwd(u, pwd) {
  if (!u || !u.cloudPwd || typeof pwd !== 'string') return false;
  try {
    const a = Buffer.from(hashCloudPwd(pwd, u.cloudPwd.salt), 'hex');
    const b = Buffer.from(u.cloudPwd.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}
function validCloudPwd(pwd) {
  return typeof pwd === 'string' && pwd.length >= CLOUD_PWD_MIN && pwd.length <= CLOUD_PWD_MAX;
}
function sha256hex(x) { return crypto.createHash('sha256').update(String(x)).digest('hex'); }
function issueToken(u) {
  const tok = crypto.randomBytes(24).toString('hex');
  u.tokens = (u.tokens || []).concat(sha256hex(tok)).slice(-10);
  return tok;
}
function checkToken(u, tok) {
  return !!(u && typeof tok === 'string' && tok && (u.tokens || []).includes(sha256hex(tok)));
}
const giftStock      = new Map();
const userGifts      = new Map();
const nftCounters    = new Map();
const fakeMembers    = new Map();
const userStars      = new Map();
const dailyRewards   = new Map();   // userId -> время последней ежедневной награды
const UNLIMITED_STARS = 999999999;   // баланс-метка режима /unlimited
const DAILY_REWARD = 500, DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const premiumUsernames = new Map();
const premiumUsers = new Set(); // у кого есть Nethgram Premium (выдаёт администратор: /premium @юзернейм)
const PROFILE_BG_IDS = new Set(['aurora','sunset','ocean','forest','candy','midnight','lava','mint','gold','rose','cosmic','carbon']);
const giveaways = new Map();       // giveawayId -> {id, channelId, prize, winnersCount, endDateStr, endDate, creatorId, participants:Set, ended, winners, msgId}
const nethgramAdminUsers = new Set();
const superUsers       = new Set(); // set by /setDev console command
const adminAuthLogs    = [];        // log of all /l auth events
let   aLogsActive      = false;     // /alogs real-time mode
const channelGifts   = new Map(); // channelId -> [{giftId, giftName, giftPrice, fromId, fromName, ts}]
let   globalSoldOut  = false;

// ── GIFT DEFINITIONS ──
const GIFT_DEFS = [
  { id:'candy_cane',  name:'Candy Cane',  price:15,    stock:50,   limited:true  },
  { id:'wine',        name:'Wine',        price:50,    stock:450,   limited:true  },
  { id:'lollipop',    name:'Lollipop',    price:75,    stock:100,  limited:true  },
  { id:'scared_cat',  name:'Scared Cat',  price:100,   stock:500,   limited:true  },
  { id:'heart',       name:'Heart',       price:175,   stock:450,   limited:false },
  { id:'spy_agaric',  name:'Spy Agaric',  price:200,   stock:100,   limited:true  },
  { id:'cake',        name:'Cake',        price:500,   stock:30,    limited:true  },
  { id:'astral_shard',name:'Crystal Ball',price:555,   stock:150,  limited:true  },
  { id:'plush_pepe',  name:'Plush Pepe',  price:2000,  stock:500,   limited:true  },
  { id:'duck',        name:'Duck',        price:7000,  stock:50,    limited:false },
  { id:'durov_cap',   name:'Durov Cap',   price:10000, stock:100,   limited:false },
  { id:'lime',        name:'Lime',        price:1000000, stock:15,  limited:true  },
  { id:'zombie',      name:'Zombie',      price:9999999, stock:100, limited:true  },
  { id:'facepalm',    name:'Facepalm',    price:3000,    stock:5,   limited:true  },
  { id:'medal',       name:'Medal',       price:7777,    stock:66,  limited:true  },
  { id:'test_gift_1', name:'Test Gift 1', price:10,    stock:5,     limited:true,  adminOnly:true },
  { id:'test_gift_2', name:'Test Gift 2', price:15,    stock:10,    limited:true,  adminOnly:true },
  { id:'test_nft',    name:'Test NFT',    price:1500,  stock:50,    limited:true,  adminOnly:true },
  { id:'test_nft_1',  name:'Test NFT 1',  price:7777,  stock:5,     limited:true,  adminOnly:true },
  { id:'Shard_test',  name:'Shard test',  price:999,   stock:25,    limited:true,  adminOnly:true },
  { id:'Test_flower', name:'Flower test', price:1200,  stock:25,    limited:true,  adminOnly:true },
];

const GIFT_PRICES = {};
const GIFT_NAMES  = {};
GIFT_DEFS.forEach(g => {
  GIFT_PRICES[g.id] = g.price;
  GIFT_NAMES[g.id]  = g.name;
  // limited:false — подарок без тиража (в магазине показывается как ∞)
  giftStock.set(g.id, g.limited ? g.stock : null);
});

// ── NFT MODELS ──
const NFT_MODELS_BY_GIFT = {
  scared_cat: [
    {id:'cat_nukem',name:'Cat Nukem'},{id:'cat2o',name:'Cat2O'},{id:'chilli_wisk',name:'Chilli Wisk'},
    {id:'creeper',name:'Creeper'},{id:'nyan_cat',name:'Nyan Cat'},{id:'pepe_paws',name:'Pepe Paws'},
    {id:'puss_in_boots',name:'Puss in Boots'},{id:'vapurr',name:'Vapurr'},{id:'voodoo',name:'Voodoo'},
    {id:'yolkster',name:'Yolkster'},
  ],
  wine: [
    {id:'margentia_mix',name:'Margentia Mix'},{id:'green_glitter',name:'Green Glitter'},
    {id:'galaxy',name:'Galaxy'},{id:'color_theory',name:'Color Theory'},{id:'indigo',name:'Indigo'},
    {id:'grinch',name:'Grinch'},{id:'earl_grey',name:'Earl Grey'},{id:'telegram_wine',name:'@Nethgram'},
    {id:'gin_gemini',name:'Gin Gemini'},
  ],
  candy_cane: [
    {id:'new_layer',name:'New Layer'},{id:'golden_jelly',name:'Golden Jelly'},
    {id:'nightmare',name:'Nightmare'},{id:'lime_twist',name:'Lime Twist'},{id:'weasley',name:'Weasley'},
    {id:'phoenix',name:'Phoenix'},{id:'bronzy',name:'Bronzy'},{id:'goldium',name:'Goldium'},
  ],
  astral_shard: [
    {id:'crash_test',name:'Crash Test'},{id:'fatal_error',name:'Fatal Error'},
    {id:'ghosted',name:'Ghosted'},{id:'peridot',name:'Peridot'},{id:'pink_chess',name:'Pink Chess'},
    {id:'poor_kitty',name:'Poor Kitty'},{id:'rainbow',name:'Rainbow'},
  ],
  plush_pepe: [
    {id:'aqua_plush',name:'Aqua Plush'},{id:'barcelona',name:'Barcelona'},{id:'gucci_leap',name:'Gucci Leap'},
    {id:'kung_fu_pepe',name:'Kung Fu Pepe'},{id:'marble',name:'Marble'},{id:'pepe_la_rana',name:'Pepe La Rana'},
    {id:'raphael',name:'Raphael'},{id:'red_pepple',name:'Red Pepple'},{id:'sketchy',name:'Sketchy'},
    {id:'spectrum',name:'Spectrum'},
  ],
};

const NFT_GRADIENTS = [
  {name:'Nethgram',   css:'linear-gradient(135deg,#4287f5,#edf0f5)'},
  {name:'Sunset',     css:'linear-gradient(135deg,#a63790,#d6c356)'},
  {name:'Black',      css:'linear-gradient(135deg,#000000,#000000)'},
  {name:'Bloody Red', css:'linear-gradient(135deg,#4d1818,#cf2d2d)'},
  {name:'Aurora',     css:'linear-gradient(135deg,#1a1a2e,#16213e,#0f3460)'},
  {name:'Emerald',    css:'linear-gradient(135deg,#134e5e,#71b280)'},
  {name:'Candy',      css:'linear-gradient(135deg,#f953c6,#b91d73)'},
  {name:'Gold Rush',  css:'linear-gradient(135deg,#f7971e,#ffd200)'},
  {name:'Deep Space', css:'linear-gradient(135deg,#000428,#004e92)'},
  {name:'Mint',       css:'linear-gradient(135deg,#00b09b,#96c93d)'},
  {name:'Lava',       css:'linear-gradient(135deg,#200122,#6f0000)'},
  {name:'Neon City',  css:'linear-gradient(135deg,#12c2e9,#f64f59,#c471ed)'},
  {name:'Sakura',     css:'linear-gradient(135deg,#f8b4d9,#ff6fa8)'},
  {name:'Toxic',      css:'linear-gradient(135deg,#56ab2f,#a8e063)'},
];

const NFT_UPGRADEABLE = new Set(['scared_cat','wine','plush_pepe','astral_shard','candy_cane']);

// ── VELO$IPE ECONOMY ──────────────────────────────────────────────
// Игровая валюта внутри Nethgram. Не настоящая криптовалюта.
const VLP_TOTAL_SUPPLY = 500000;
const VLP_START_RATE   = 500;
const VLP_MIN_RATE     = 50;
const VLP_MAX_RATE     = 20000;
const VLP_DAILY_LIMIT  = 10000;
const VLP_TICK_MS      = 15000;
const VLP_NEWS_MS      = 30000;
const VLP_PERIODS      = { '1h':3600e3, '1d':86400e3, '1w':7*86400e3, '1m':30*86400e3, 'all':Infinity };

// История курса хранится в 4 уровнях детализации, чтобы файл не рос бесконечно
const SERIES_TIERS = [ ['m5',300e3,2016], ['h1',3600e3,2160], ['d1',86400e3,3650] ];
const SERIES_RAW_CAP = 360;
function newSeries(rate) { const s = { raw:[], m5:[], h1:[], d1:[] }; seriesPush(s, rate, Date.now()); return s; }
function seriesPush(s, rate, t) {
  s.raw.push({ t, r:rate });
  if (s.raw.length > SERIES_RAW_CAP) s.raw.shift();
  for (const [key, step, cap] of SERIES_TIERS) {
    const arr = s[key], bucket = Math.floor(t / step) * step, last = arr[arr.length - 1];
    if (last && last.b === bucket) { last.r = rate; last.t = t; }
    else { arr.push({ t, r:rate, b:bucket }); if (arr.length > cap) arr.shift(); }
  }
}
function seriesPoints(s, period) {
  const win = VLP_PERIODS[period] || VLP_PERIODS['1d'], from = Date.now() - win;
  let src;
  if (period === '1h') src = s.raw;
  else if (period === '1d' || period === '1w') src = s.m5;
  else if (period === '1m') src = s.h1;
  else src = (s.d1.length && s.h1.length && s.d1[0].t < s.h1[0].t) ? s.d1 : s.h1;
  let pts = src.filter(p => p.t >= from).map(p => ({ t:p.t, r:p.r }));
  const latest = s.raw[s.raw.length - 1];
  if (latest && (!pts.length || pts[pts.length - 1].t < latest.t)) pts.push({ t:latest.t, r:latest.r });
  if (pts.length < 2 && src.length) pts.unshift({ t:src[0].t, r:src[0].r });
  return pts;
}
function periodChangeOf(pts) {
  if (pts.length < 2 || !pts[0].r) return 0;
  return Math.round(((pts[pts.length - 1].r - pts[0].r) / pts[0].r) * 10000) / 100;
}
function decimate(pts, max) {
  if (pts.length <= max) return pts;
  const out = [], step = (pts.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

let velosipe = {
  rate: VLP_START_RATE, prevRate: VLP_START_RATE,
  available: VLP_TOTAL_SUPPLY,
  series: newSeries(VLP_START_RATE),
};
const userVelosipe   = new Map(); // userId -> {balance, boughtToday, boughtDate, basis}
const velosipeTrades = new Map(); // userId -> [{type,...,ts}]
const userPositions  = new Map(); // userId -> [{assetId,currency,units,cost,basis,ts}]
const marketNews     = [];

const ASSET_DEFS = [
  { id:'rare_fish',      name:'Редкие рыбы',               icon:'🐟', category:'asset', start:100, desc:'Рынок редких рыб Нефграма' },
  { id:'potato_fields',  name:'Картофельные поля в Литве', icon:'🥔', category:'asset', start:100, desc:'Инвестиции в картофельную империю' },
  { id:'sand_farm',      name:'Ферма песка',               icon:'🏖️', category:'asset', start:100, desc:'Крупнейшая песчаная ферма Нефграма' },
  { id:'rainbow_sheep',  name:'Разноцветные овцы',         icon:'🐑', category:'asset', start:100, desc:'Рынок разноцветных овец' },
  { id:'stock_nethgram', name:'Nethgram',                  icon:'📱', category:'stock', start:250, desc:'Акции основной компании Нефграма' },
  { id:'stock_velosipe', name:'Velosipe Inc.',             icon:'🚲', category:'stock', start:250, desc:'Компания, связанная с VELO$IPE' },
  { id:'stock_tesla',    name:'Tesla',                     icon:'🚗', category:'stock', start:250, desc:'Шуточная акция Tesla в игровой экономике' },
  { id:'stock_apple',    name:'Apple',                     icon:'🍎', category:'stock', start:250, desc:'Шуточная акция Apple в игровой экономике' },
  { id:'stock_priton',   name:'Priton',                    icon:'🏢', category:'stock', start:250, desc:'Шуточная компания Нефграма' },
];
const assetsMarket = new Map(); // id -> {rate, prevRate, series}
ASSET_DEFS.forEach(a => assetsMarket.set(a.id, { rate:a.start, prevRate:a.start, series:newSeries(a.start) }));
const assetDef = id => ASSET_DEFS.find(a => a.id === id);

// dir: 1 рост, -1 падение, 0 случайно; min/max — размер скачка
const NEWS_TEMPLATES = [
  { title:'🚨 СРОЧНЫЕ НОВОСТИ',    text:'В Литве обнаружено подозрительно большое картофельное поле.', target:'potato_fields',  dir:1,  min:.20, max:.45 },
  { title:'🐟 РЫБНЫЙ КРИЗИС',      text:'Редкая рыба временно перестала быть редкой.',                  target:'rare_fish',      dir:-1, min:.20, max:.45 },
  { title:'🏖️ ПЕСЧАНАЯ ЛИХОРАДКА', text:'Спрос на песок бьёт все рекорды.',                             target:'sand_farm',      dir:1,  min:.15, max:.35 },
  { title:'🐑 ОВЕЧИЙ СКАНДАЛ',     text:'Выяснилось, что часть овец просто покрашена.',                  target:'rainbow_sheep',  dir:-1, min:.15, max:.40 },
  { title:'📱 NETHGRAM NEWS',      text:'Разработчики выкатили большое обновление.',                    target:'stock_nethgram', dir:1,  min:.10, max:.30 },
  { title:'🚲 VELOSIPE INC. NEWS', text:'Инсайдеры массово скупают акции Velosipe Inc.',                target:'stock_velosipe', dir:1,  min:.15, max:.40 },
  { title:'🚗 TESLA NEWS',         text:'Кто-то написал про Nethgram в твиттере. Акции дёрнулись.',     target:'stock_tesla',    dir:0,  min:.10, max:.30 },
  { title:'🍎 APPLE NEWS',         text:'Слухи о новом устройстве будоражат инвесторов.',               target:'stock_apple',    dir:0,  min:.10, max:.30 },
  { title:'🏢 PRITON NEWS',        text:'Отчётность Priton оказалась хуже ожиданий.',                   target:'stock_priton',   dir:-1, min:.15, max:.40 },
  { title:'🪙 VELO$IPE NEWS',      text:'Кто-то купил 8 $VLP. Рынок в панике.',                         target:'vlp',            dir:1,  min:.08, max:.25 },
  { title:'🪙 VELO$IPE NEWS',      text:'Большой холдер внезапно распродал свои $VLP.',                 target:'vlp',            dir:-1, min:.08, max:.25 },
];

const r2 = x => Math.round(x * 100) / 100;
const toInt = x => { const n = Math.floor(Number(x)); return (Number.isFinite(n) && n > 0 && n <= 1e9) ? n : 0; };
const pct = (prev, cur) => prev ? r2(((cur - prev) / prev) * 100) : 0;
const dayKey = () => { const d = new Date(); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }; // серверное время
const nextMidnight = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); };

/** Общий на всех дневной лимит покупки $VLP: сколько уже куплено всеми сегодня */
function sharedVlpDaily() {
  const today = dayKey();
  if (velosipe.dailyDate !== today) {
    let bought = 0;
    // первый запуск после обновления: учитываем то, что люди уже купили сегодня
    if (!velosipe.dailyDate) {
      for (const rec of userVelosipe.values()) if (rec.boughtDate === today) bought += rec.boughtToday || 0;
    }
    velosipe.dailyDate = today;
    velosipe.dailyBought = bought;
  }
  return velosipe.dailyBought;
}
function getUserVlp(uid) {
  let rec = userVelosipe.get(uid);
  if (!rec) { rec = { balance:0, boughtToday:0, boughtDate:dayKey(), basis:0 }; userVelosipe.set(uid, rec); }
  if (rec.boughtDate !== dayKey()) { rec.boughtDate = dayKey(); rec.boughtToday = 0; } // сброс лимита раз в сутки
  return rec;
}
const positionsOf = uid => { if (!userPositions.has(uid)) userPositions.set(uid, []); return userPositions.get(uid); };
function addTrade(uid, t) {
  if (!velosipeTrades.has(uid)) velosipeTrades.set(uid, []);
  const arr = velosipeTrades.get(uid); arr.push({ ...t, ts:Date.now() });
  if (arr.length > 200) arr.shift();
}

// шаг цены: небольшие колебания + мягкое притяжение к базе + редкий памп/дамп
function stepRate(rate, base, min, max, jumpChance) {
  let nr, jump = false;
  if (Math.random() < jumpChance) {
    nr = rate * (1 + (Math.random() < 0.5 ? -1 : 1) * (0.10 + Math.random() * 0.40)); jump = true;
  } else {
    const noise = Math.random() < 0.2 ? (Math.random() - 0.5) * 0.002 : (Math.random() * 2 - 1) * 0.004;
    nr = rate * Math.exp(noise - Math.log(rate / base) * 0.0003);
  }
  return { rate: r2(Math.min(max, Math.max(min, nr))), jump };
}
function assetBounds(def) { return [Math.max(1, def.start / 20), def.start * 50]; }

function addNews(title, text, target, change) {
  const entry = { id:genId(), ts:Date.now(), title, text, target, change };
  marketNews.unshift(entry);
  if (marketNews.length > 100) marketNews.pop();
  broadcastAll(null, { type:'market_news', news:entry });
}
function shock(target, p) { // применить скачок на p (доля), вернуть реальное изменение в %
  if (target === 'vlp') {
    velosipe.prevRate = velosipe.rate;
    velosipe.rate = r2(Math.min(VLP_MAX_RATE, Math.max(VLP_MIN_RATE, velosipe.rate * (1 + p))));
    seriesPush(velosipe.series, velosipe.rate, Date.now());
    return pct(velosipe.prevRate, velosipe.rate);
  }
  const a = assetsMarket.get(target), def = assetDef(target); if (!a) return 0;
  const [mn, mx] = assetBounds(def);
  a.prevRate = a.rate; a.rate = r2(Math.min(mx, Math.max(mn, a.rate * (1 + p))));
  seriesPush(a.series, a.rate, Date.now());
  return pct(a.prevRate, a.rate);
}

function tickMarket() {
  try {
    const now = Date.now();
    velosipe.prevRate = velosipe.rate;
    const v = stepRate(velosipe.rate, VLP_START_RATE, VLP_MIN_RATE, VLP_MAX_RATE, 0.0001);
    velosipe.rate = v.rate; seriesPush(velosipe.series, v.rate, now);
    if (v.jump) {
      const c = pct(velosipe.prevRate, v.rate);
      addNews(c > 0 ? '🚀 ПАМП VELO$IPE' : '📉 ДАМП VELO$IPE', c > 0 ? 'Курс $VLP резко взлетел. Рынок в панике.' : 'Курс $VLP резко рухнул. Рынок в панике.', 'vlp', c);
    }
    for (const def of ASSET_DEFS) {
      const a = assetsMarket.get(def.id), [mn, mx] = assetBounds(def);
      a.prevRate = a.rate;
      const s = stepRate(a.rate, def.start, mn, mx, 0.00008);
      a.rate = s.rate; seriesPush(a.series, s.rate, now);
      if (s.jump) { const c = pct(a.prevRate, s.rate); addNews(c > 0 ? '📈 РЕЗКИЙ РОСТ' : '📉 РЕЗКОЕ ПАДЕНИЕ', def.name + (c > 0 ? ' внезапно взлетел.' : ' внезапно обвалился.'), def.id, c); }
    }
    broadcastAll(null, { type:'velosipe_tick', t:now, market:marketLive(), assets:assetsLive() });
  } catch (e) { console.error('tickMarket error:', e.message); }
}
function randomNewsEvent() {
  try {
    if (Math.random() > 0.015) return; // в среднем одна новость примерно раз в 30 минут
    const t = NEWS_TEMPLATES[Math.floor(Math.random() * NEWS_TEMPLATES.length)];
    if (t.target === 'vlp' && Math.random() < 0.6) return; // новости про сам $VLP — реже
    const dir = t.dir || (Math.random() < 0.5 ? -1 : 1);
    const change = shock(t.target, dir * (t.min + Math.random() * (t.max - t.min)));
    addNews(t.title, t.text, t.target, change);
  } catch (e) { console.error('randomNewsEvent error:', e.message); }
}

function marketLive() {
  return { dailyBought:sharedVlpDaily(), rate:velosipe.rate, prevRate:velosipe.prevRate, change:pct(velosipe.prevRate, velosipe.rate),
           available:velosipe.available, circulating:VLP_TOTAL_SUPPLY - velosipe.available };
}
function assetsLive() {
  const o = {};
  for (const [id, a] of assetsMarket) o[id] = { rate:a.rate, prevRate:a.prevRate, change:pct(a.prevRate, a.rate) };
  return o;
}
function marketFull(period) {
  const pts = seriesPoints(velosipe.series, period);
  return { ...marketLive(), totalSupply:VLP_TOTAL_SUPPLY, dailyLimit:VLP_DAILY_LIMIT, minRate:VLP_MIN_RATE, maxRate:VLP_MAX_RATE,
           resetsAt:nextMidnight(), periodChange:periodChangeOf(pts), history:decimate(pts, 240) };
}
function assetsFull(period) {
  return ASSET_DEFS.map(def => {
    const a = assetsMarket.get(def.id), pts = seriesPoints(a.series, period);
    return { id:def.id, name:def.name, icon:def.icon, category:def.category, desc:def.desc,
             rate:a.rate, prevRate:a.prevRate, change:pct(a.prevRate, a.rate),
             periodChange:periodChangeOf(pts), spark:decimate(pts, 36).map(p => p.r) }; // spark — мини-график для карточки
  });
}
function positionView(p) {
  const a = assetsMarket.get(p.assetId), def = assetDef(p.assetId);
  const value = Math.floor(p.units * a.rate), pnl = value - p.cost;
  return { assetId:p.assetId, name:def.name, icon:def.icon, currency:p.currency, cost:p.cost, units:p.units, value, rate:a.rate,
           pnl, pnlPct: p.cost ? r2((pnl / p.cost) * 100) : 0 };
}
function meView(uid) {
  const rec = getUserVlp(uid), pos = positionsOf(uid);
  const locked = pos.filter(p => p.currency === 'vlp').reduce((s, p) => s + p.cost, 0);
  const basis = rec.basis + pos.filter(p => p.currency === 'vlp').reduce((s, p) => s + p.basis, 0);
  const held = rec.balance + locked, valueStars = Math.floor(held * velosipe.rate);
  const pnl = held ? Math.round(valueStars - basis) : 0;
  return { vlp:rec.balance, locked, stars:userStars.get(uid) || 0, boughtToday:sharedVlpDaily(), myBoughtToday:rec.boughtToday, dailyLimit:VLP_DAILY_LIMIT,
           valueStars, pnl, basis:Math.round(basis), pnlPct: basis > 0 ? r2((pnl / basis) * 100) : 0 };
}
function velosipeSnapshot(uid, period) {
  if (!VLP_PERIODS[period]) period = '1d';
  return { type:'velosipe_market', period, market:marketFull(period), assets:assetsFull(period), me:meView(uid),
           positions:positionsOf(uid).map(positionView), trades:(velosipeTrades.get(uid) || []).slice(-60).reverse(),
           news:marketNews.slice(0, 40) };
}
function releaseUserVelosipe(uid) { // при удалении аккаунта монеты возвращаются в резерв
  const rec = userVelosipe.get(uid);
  const held = (rec ? rec.balance : 0) + positionsOf(uid).filter(p => p.currency === 'vlp').reduce((s, p) => s + p.cost, 0);
  velosipe.available = Math.min(VLP_TOTAL_SUPPLY, velosipe.available + held);
  userVelosipe.delete(uid); velosipeTrades.delete(uid); userPositions.delete(uid);
}

function serializeVelosipe() {
  const mapObj = m => { const o = {}; for (const [k, v] of m) o[k] = v; return o; };
  const assets = {}; for (const [id, a] of assetsMarket) assets[id] = a;
  return { market:velosipe, users:mapObj(userVelosipe), trades:mapObj(velosipeTrades), positions:mapObj(userPositions), assets, news:marketNews };
}
function loadVelosipe(d) {
  if (!d) return;
  if (d.market && d.market.series) velosipe = { ...velosipe, ...d.market };
  for (const [k, v] of Object.entries(d.users || {})) userVelosipe.set(k, { basis:0, ...v });
  for (const [k, v] of Object.entries(d.trades || {})) velosipeTrades.set(k, v);
  for (const [k, v] of Object.entries(d.positions || {})) userPositions.set(k, v);
  for (const [id, a] of Object.entries(d.assets || {})) if (assetsMarket.has(id) && a.series) assetsMarket.set(id, a);
  if (Array.isArray(d.news)) { marketNews.length = 0; marketNews.push(...d.news); }
  // самолечение: резерв всегда = тираж − всё, что на руках и в инвестициях
  let held = 0;
  for (const rec of userVelosipe.values()) held += rec.balance;
  for (const list of userPositions.values()) for (const p of list) if (p.currency === 'vlp') held += p.cost;
  velosipe.available = Math.max(0, VLP_TOTAL_SUPPLY - held);
}

// ── PERSISTENCE ──
let saveTimer = null;
let saveForce = true;   // есть настоящие изменения (не просто колебания курса)
function scheduleSave() {
  saveForce = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 2000);
}

function saveNow() {
  try {
    const usersArr = [...users.values()].map(u => ({
      id:u.id, name:u.name, phone:u.phone, initials:u.initials, color:u.color,
      avatarUrl:u.avatarUrl||null, username:u.username||null, wornNft:u.wornNft||null, nameBadge:u.nameBadge||null,
      profileBg:u.profileBg||null, cloudPwd:u.cloudPwd||null, tokens:u.tokens||[],
      verifiedOrg:u.verifiedOrg||null, pushDevices:u.pushDevices||null,
    }));
    const messagesObj = {};
    for (const [k, v] of messages) messagesObj[k] = v;
    const channelsArr = [...channels.values()].map(ch => ({
      id:ch.id, name:ch.name, username:ch.username, type:ch.type, ownerId:ch.ownerId, admins:[...(ch.admins||[])],
      avatarUrl:ch.avatarUrl||null, avatarEmoji:ch.avatarEmoji||null,
      description:ch.description||'', members:[...ch.members],
      admins:[...(ch.admins||[])],
      extraSubscribers:ch.extraSubscribers||0, extraMembers:ch.extraMembers||0, createdAt:ch.createdAt,
      verifiedOrg:ch.verifiedOrg||null, autoSubscribedAll:!!ch.autoSubscribedAll, isPrivate:!!ch.isPrivate,
    }));
    const giftStockObj = {};
    for (const [id, stock] of giftStock) giftStockObj[id] = stock;
    const userGiftsObj = {};
    for (const [uid, gifts] of userGifts) userGiftsObj[uid] = gifts;
    const nftCountersObj = {};
    for (const [gid, cnt] of nftCounters) nftCountersObj[gid] = cnt;
    const fakeMembersObj = {};
    for (const [cid, bots] of fakeMembers) fakeMembersObj[cid] = bots;
    const userStarsObj = {};
    for (const [uid, bal] of userStars) userStarsObj[uid] = bal;
    const premiumUnObj = {};
    for (const [uid, uns] of premiumUsernames) premiumUnObj[uid] = uns;
    const channelGiftsObj = {};
    for (const [cid, gifts] of channelGifts) channelGiftsObj[cid] = gifts;
    const giveawaysObj = {};
    for (const [gid, gw] of giveaways) giveawaysObj[gid] = { ...gw, participants: [...gw.participants] };
    const snapshot = {
      users:usersArr, messages:messagesObj, channels:channelsArr,
      giftStock:giftStockObj, userGifts:userGiftsObj, nftCounters:nftCountersObj,
      fakeMembers:fakeMembersObj, userStars:userStarsObj, premiumUsernames:premiumUnObj,
      channelGifts: channelGiftsObj,
      giveaways: giveawaysObj,
      dailyRewards: Object.fromEntries(dailyRewards),
      globalSoldOut,
      velosipe: serializeVelosipe(),
      premiumUsers: [...premiumUsers],
    };
    if (storage.usesDb) {
      const force = saveForce || shuttingDown;
      saveForce = false;
      return storage.save(snapshot, { force }).catch(e => { saveForce = true; console.error('[db] Save error:', e.message); });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 0));
  } catch(e) { console.error('Save error:', e.message); }
}

/** Остаток не может быть больше, чем тираж минус реально выданные подарки (чинит прошлые сбросы) */
function restoreGiftStock() {
  const used = new Map();
  const count = g => {
    if (!g || !g.giftId) return;
    // подарки от бота (/autosend) тираж не расходуют, улучшение в NFT расходует ещё одну единицу
    const n = (g.fromId === 'bot_nethgram' ? 0 : 1) + (g.isNft ? 1 : 0);
    used.set(g.giftId, (used.get(g.giftId) || 0) + n);
  };
  for (const list of userGifts.values()) list.forEach(count);
  for (const list of channelGifts.values()) list.forEach(count);
  for (const def of GIFT_DEFS) {
    if (!def.limited) continue;
    const real = Math.max(0, def.stock - (used.get(def.id) || 0));
    const cur = giftStock.get(def.id);
    if (cur === null || cur === undefined || cur > real) giftStock.set(def.id, real);
  }
}

function loadState() {
  try {
    let data = global.__NETHGRAM_DATA;
    if (!data) {
      const localFile = storage.localDataPath();
      if (storage.usesDb || !localFile) return;
      data = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    }
    for (const u of (data.users||[])) users.set(u.id, {...u, wornNft:u.wornNft||null, nameBadge:u.nameBadge||null, profileBg:u.profileBg||null, online:false, ws:null});
    for (const [k, msgs] of Object.entries(data.messages||{})) messages.set(k, msgs);
    for (const ch of (data.channels||[])) {
      channels.set(ch.id, {
        ...ch, members:new Set(ch.members||[]), admins:new Set(ch.admins||[]),
        extraSubscribers:ch.extraSubscribers||0, extraMembers:ch.extraMembers||0,
      });
    }
    // Сохранённый остаток важнее значения по умолчанию, иначе тираж сбрасывается при каждом запуске
    for (const [id, stock] of Object.entries(data.giftStock||{})) {
      const def = GIFT_DEFS.find(g => g.id === id);
      if (def && def.limited && Number.isFinite(Number(stock)) && stock !== null) giftStock.set(id, Math.max(0, Math.floor(Number(stock))));
    }
    for (const [uid, gifts] of Object.entries(data.userGifts||{})) userGifts.set(uid, gifts);
    for (const [gid, cnt] of Object.entries(data.nftCounters||{})) nftCounters.set(gid, Number(cnt));
    for (const [cid, bots] of Object.entries(data.fakeMembers||{})) fakeMembers.set(cid, bots);
    for (const [uid, bal] of Object.entries(data.userStars||{})) userStars.set(uid, Number(bal));
    for (const [uid, ts] of Object.entries(data.dailyRewards||{})) dailyRewards.set(uid, Number(ts));
    for (const [uid, uns] of Object.entries(data.premiumUsernames||{})) premiumUsernames.set(uid, uns);
    for (const [gid, gw] of Object.entries(data.giveaways||{})) {
      giveaways.set(gid, { ...gw, participants: new Set(gw.participants||[]) });
    }
    for (const [cid, gifts] of Object.entries(data.channelGifts||{})) channelGifts.set(cid, gifts);
    if (data.globalSoldOut !== undefined) globalSoldOut = !!data.globalSoldOut;
    loadVelosipe(data.velosipe);
    for (const id of (data.premiumUsers||[])) premiumUsers.add(id);
    restoreGiftStock();
    console.log('State loaded:', users.size, 'users,', channels.size, 'channels');
  } catch(e) { console.error('Load error:', e.message); }
}

loadState();
cleanStoredProfiles();
ensureNewsChannel();

// ── Действия с сообщениями: изменить / удалить / реакции / пересылка ──
const ALLOWED_REACTIONS = new Set(['👍','❤️','🔥','😂','😮','😢','🎉','👎']);
function cleanFwd(f) {
  if (!f || typeof f !== 'object') return null;
  const name = cleanText(String(f.name || '').trim(), 64);
  if (!name) return null;
  return { name, id: f.id ? String(f.id).replace(/[^\w-]/g, '').slice(0, 64) : null };
}
function isJsonObjectText(t) {
  try { const d = JSON.parse(t); return !!d && typeof d === 'object'; } catch (e) { return false; }
}
/** Найти сообщение в чате пользователя. req: { chatId, isChannel, msgId } */
function findMsgCtx(userId, req) {
  const msgId = String(req.msgId || '');
  if (!msgId) return null;
  if (req.isChannel) {
    const ch = channels.get(req.chatId);
    if (!ch || !ch.members.has(userId)) return null;
    const list = messages.get('ch_' + ch.id) || [];
    const idx = list.findIndex(m => m.id === msgId);
    return idx < 0 ? null : { ch, list, idx, m: list[idx] };
  }
  const peerId = String(req.chatId || '');
  const list = messages.get(chatKey(userId, peerId)) || [];
  const idx = list.findIndex(m => m.id === msgId);
  return idx < 0 ? null : { peerId, list, idx, m: list[idx] };
}
/** Разослать изменение всем участникам чата (у каждого свой chatId) */
function notifyMsgChange(userId, ctx, payload) {
  if (ctx.ch) {
    const p = { ...payload, chatId: ctx.ch.id, isChannel: true };
    for (const mid of ctx.ch.members) { const u = users.get(mid); if (u && isSocketOpen(u.ws)) safeSend(u.ws, p); }
    return;
  }
  const me = users.get(userId);
  if (me && isSocketOpen(me.ws)) safeSend(me.ws, { ...payload, chatId: ctx.peerId, isChannel: false });
  const peer = users.get(ctx.peerId);
  if (peer && ctx.peerId !== userId && isSocketOpen(peer.ws)) safeSend(peer.ws, { ...payload, chatId: userId, isChannel: false });
}

// ── Защита от внедрения кода: всё, что вводит пользователь и что попадает в разметку ──
const UNSAFE_CHARS = { '&':'＆', '<':'‹', '>':'›', '"':'”', "'":'’', '`':'’', '\\':'／' };
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[&<>"'`\\]/g, ch => UNSAFE_CHARS[ch]).slice(0, max || 256);
}
function cleanAvatarUrl(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(t)) return t;
  if (/^\/assets\/[\w.-]+$/.test(t)) return t;
  if (/^https?:\/\/[^\s"'<>`\\]+$/i.test(t)) return t;
  return null;
}
/** Поля запроса клиента, которые потом показываются другим людям */
function cleanClientFields(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (typeof msg.name === 'string') msg.name = cleanText(msg.name, 64);
  if (typeof msg.initials === 'string') msg.initials = cleanText(msg.initials, 4);
  if (typeof msg.description === 'string') msg.description = cleanText(msg.description, 500);
  if (typeof msg.message === 'string') msg.message = cleanText(msg.message, 500);
  if (typeof msg.emoji === 'string') msg.emoji = cleanText(msg.emoji, 16);
  if (typeof msg.avatarEmoji === 'string') msg.avatarEmoji = cleanText(msg.avatarEmoji, 16);
  if (typeof msg.username === 'string') msg.username = msg.username.replace(/[^\w@.-]/g, '').slice(0, 64);
  if (typeof msg.msgId === 'string') msg.msgId = msg.msgId.replace(/[^\w-]/g, '').slice(0, 64);
  if ('avatarUrl' in msg && msg.avatarUrl !== null) msg.avatarUrl = cleanAvatarUrl(msg.avatarUrl);
}
/** Разовая очистка того, что уже лежит в базе */
function cleanStoredProfiles() {
  for (const u of users.values()) {
    if (u.name) u.name = cleanText(u.name, 64);
    if (u.initials) u.initials = cleanText(u.initials, 4);
    if (u.username) u.username = String(u.username).replace(/[^\w@.-]/g, '').slice(0, 64);
    u.avatarUrl = cleanAvatarUrl(u.avatarUrl);
  }
  for (const ch of channels.values()) {
    if (ch.name) ch.name = cleanText(ch.name, 64);
    if (ch.description) ch.description = cleanText(ch.description, 500);
    if (ch.username) ch.username = String(ch.username).replace(/[^\w@.-]/g, '').slice(0, 64);
    if (ch.avatarEmoji) ch.avatarEmoji = cleanText(ch.avatarEmoji, 16);
    ch.avatarUrl = cleanAvatarUrl(ch.avatarUrl);
  }
}
function premiumStateMsg(uid, notify) {
  return { type:'premium_state', active: premiumUsers.has(uid), notify: !!notify };
}
function findUserForAdmin(query) {
  const q = String(query || '').replace(/^@/, '').toLowerCase();
  if (!q) return null;
  const digits = q.replace(/\D/g, '');
  for (const u of users.values()) {
    if (u.id === q || (u.username && u.username.replace(/^@/, '').toLowerCase() === q)) return u;
    if (digits.length >= 5 && digits === q.replace(/^\+/, '') && phoneDigits(u.phone) === digits) return u;
  }
  return findUserByPremiumUsername(q) || null;
}

// ── Уведомления Android без Firebase ──
// Приложение держит отдельное лёгкое соединение. Его токен годится только для получения уведомлений:
// войти с ним в аккаунт нельзя. В базе хранится только хеш токена.
const pushSockets = new Map();   // userId -> Map(deviceId -> socket)
const PUSH_MAX_DEVICES = 5, PUSH_REPLAY_MS = 48 * 60 * 60 * 1000, PUSH_REPLAY_MAX = 50;
const validDeviceId = v => typeof v === 'string' && /^[\w-]{16,64}$/.test(v);

function pushPreview(text) {
  const t = String(text || '');
  if (t.charCodeAt(0) === 123) {
    try {
      const d = JSON.parse(t);
      if (d && d.isPhoto) return d.caption ? '📷 ' + String(d.caption).slice(0, 160) : '📷 Фото';
      if (d && d.isSticker) return '🎭 Стикер';
      if (d && d.isNftTransfer) return '🎁 NFT: ' + String(d.giftName || 'подарок').slice(0, 60);
      if (d && d.isGift) return '🎁 Подарок: ' + String(d.giftName || '').slice(0, 60);
    } catch (e) {}
  }
  const plain = t.replace(/\[\[e:\d+_\d+\]\]/g, '🙂').replace(/\s+/g, ' ').trim();
  return plain.length > 200 ? plain.slice(0, 199) + '…' : plain;
}
function pushNotify(uid, item) {
  const devices = pushSockets.get(uid);
  if (!devices || !devices.size) return;
  const msg = { type:'push', id:String(item.id), chatId:item.chatId, title:cleanText(item.title, 64),
                sender:item.sender ? cleanText(item.sender, 64) : null, body:pushPreview(item.text), ts:item.ts || Date.now() };
  for (const sock of devices.values()) if (isSocketOpen(sock)) safeSend(sock, msg);
}
function pushItemFor(uid, chatId, m, ch) {
  const from = users.get(m.from);
  const sender = (from && from.name) || m.fromName || 'Пользователь';
  if (ch) return { id:m.id, chatId:ch.id, title:ch.name, sender: ch.type === 'channel' ? null : sender, text:m.text, ts:m.ts };
  return { id:m.id, chatId, title:sender, sender:null, text:m.text, ts:m.ts };
}
/** Сообщения, пришедшие, пока телефон был без связи */
function replayPushes(uid, socket, sinceRaw) {
  const now = Date.now();
  const since = Math.max(Number(sinceRaw) || 0, now - PUSH_REPLAY_MS);
  if (!Number(sinceRaw)) return;
  const found = [];
  const collect = (list, chatId, ch) => {
    for (let i = list.length - 1, n = 0; i >= 0 && n < 20; i--) {
      const m = list[i];
      if (!m || !(m.ts > since)) break;
      if (m.ts > now || m.from === uid || String(m.from).startsWith('bot_')) continue;
      found.push(pushItemFor(uid, chatId, m, ch)); n++;
    }
  };
  for (const [key, list] of messages) {
    if (key.startsWith('ch_') || !key.includes('::')) continue;
    const [a, b] = key.split('::');
    if (a === uid || b === uid) collect(list, a === uid ? b : a, null);
  }
  for (const ch of channels.values()) {
    if (ch.members.has(uid)) collect(messages.get('ch_' + ch.id) || [], ch.id, ch);
  }
  found.sort((x, y) => x.ts - y.ts).slice(-PUSH_REPLAY_MAX).forEach(item => {
    safeSend(socket, { type:'push', id:String(item.id), chatId:item.chatId, title:cleanText(item.title, 64),
      sender:item.sender ? cleanText(item.sender, 64) : null, body:pushPreview(item.text), ts:item.ts });
  });
}
function dropPushDevice(uid, deviceId) {
  const devices = pushSockets.get(uid);
  const sock = devices && devices.get(deviceId);
  if (sock) { devices.delete(deviceId); try { sock.destroy(); } catch (e) {} }
  if (devices && !devices.size) pushSockets.delete(uid);
}

// ── Звёзды: баланс считает только сервер ──
function starsOf(uid) { return userStars.get(uid) || 0; }
function trySpendStars(uid, cost) {
  const bal = starsOf(uid);
  if (bal >= UNLIMITED_STARS) return true;
  if (bal < cost) return false;
  userStars.set(uid, bal - cost);
  return true;
}
function starsSyncMsg(uid) {
  return { type:'stars_sync', balance: starsOf(uid), lastDaily: dailyRewards.get(uid) || null };
}
/** Текст, притворяющийся подарком: такие карточки создаёт только сервер или оплаченная покупка */
function isForgedGiftText(t) {
  if (typeof t !== 'string' || t.charCodeAt(0) !== 123) return false;
  try { const d = JSON.parse(t); return !!d && (d.isGift === true || d.isNftTransfer === true); } catch (e) { return false; }
}

/** Частную группу видят и читают только её участники */
function canSeeChannel(ch, uid) {
  return !!ch && (!ch.isPrivate || (!!uid && ch.members.has(uid)));
}

// ── Подарки каналов и групп: управляют только владелец и админы ──
function canManageChannelGifts(ch, uid) {
  return !!ch && !!uid && (ch.ownerId === uid || !!(ch.admins && ch.admins.has(uid)));
}
function visibleChannelGifts(ch, uid) {
  if (!canSeeChannel(ch, uid)) return [];
  const all = (ch && channelGifts.get(ch.id)) || [];
  return canManageChannelGifts(ch, uid) ? all : all.filter(g => !g.hidden);
}
/** Разослать участникам актуальный список (скрытые подарки видят только админы) */
function syncChannelGifts(ch) {
  for (const mid of ch.members) {
    const u = users.get(mid);
    if (u && isSocketOpen(u.ws)) safeSend(u.ws, { type:'channel_gifts', channelId: ch.id, gifts: visibleChannelGifts(ch, mid) });
  }
}
/** Поставить подарок в список так, чтобы его ts (идентификатор) был уникальным */
function pushGiftUnique(list, gift) {
  while (list.some(x => String(x.ts) === String(gift.ts))) gift.ts = Number(gift.ts) + 1;
  list.push(gift);
}

function ensureNewsChannel() {
  let ch = channels.get(NEWS_CHANNEL_ID);
  if (!ch) {
    ch = { id: NEWS_CHANNEL_ID, createdAt: Date.now(), members: new Set(), admins: new Set(),
           extraSubscribers: 0, extraMembers: 0, avatarEmoji: null };
    channels.set(NEWS_CHANNEL_ID, ch);
    console.log('📢 Создан канал Nethgram news (@' + NEWS_CHANNEL_USERNAME + ')');
  }
  // Постоянные свойства канала (никто, кроме сервера, их не меняет: владелец — бот)
  Object.assign(ch, {
    name: 'Nethgram news', username: NEWS_CHANNEL_USERNAME, type: 'channel', ownerId: 'bot_nethgram',
    avatarUrl: '/assets/neth-news.png', verifiedOrg: 'Nethgram',
    description: ch.description || 'Официальный канал новостей Nethgram',
  });
  if (!(ch.members instanceof Set)) ch.members = new Set(ch.members || []);
  if (!(ch.admins instanceof Set)) ch.admins = new Set(ch.admins || []);
  // Один раз подписываем всех уже существующих пользователей; дальше — только новых при регистрации
  if (!ch.autoSubscribedAll) {
    for (const uid of users.keys()) ch.members.add(uid);
    ch.autoSubscribedAll = true;
  }
  scheduleSave();
}

setInterval(saveNow, 30000);
setInterval(tickMarket, VLP_TICK_MS);
setInterval(randomNewsEvent, VLP_NEWS_MS);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  setTimeout(() => process.exit(0), 10000).unref();   // Render даёт ~30 с на остановку
  try { await saveNow(); await storage.flush(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', e => { console.error('Uncaught:', e); saveNow(); });

// ── BOTS ──
const BOTS = {
  simpson: {
    id:'bot_simpson', name:'Simpson Bot', username:'@simpson',
    desc:'Симпсон бот — пропишите /commands', type:'bot',
    initials:'SB', color:'linear-gradient(135deg,#f9a825,#f57f17)',
    avatarType:'homer', online:true, status:'бот',
  },
  random: {
    id:'bot_random', name:'Randomizer Bot', username:'@random',
    desc:'Розыгрыши и рандомайзер — /giveaway', type:'bot',
    initials:'RB', color:'#8e44ad', avatarType:'color', online:true, status:'бот',
  },
  nethgram: {
    id:'bot_nethgram', name:'Nethgram', username:'@Nethgram', verifiedOrg:'Nethgram',
    desc:'Official developer bot', type:'devbot',
    initials:'N', color:'linear-gradient(135deg,#2aabee,#1565c0)',
    avatarType:'logo', online:true, status:'Всегда в сети',
  },
};

const SIMPSON_CMDS = {
  '/hello':'D\'oh! Привет, человек! Я Гомер Симпсон 😄',
  '/burger':'"Ммм... бургер..." *пускает слюни* 🍔',
  '/donut':'"Ммм... пончик..." 🍩🍩🍩',
  '/duff':'"Пиво Дафф! Лучшее, что придумало человечество!" 🍺',
  '/doh':'Д\'о!! 😱',
  '/commands':'📋 Все команды:\n/hello /burger /donut /duff /doh /commands',
};

function handleSimpson(text) {
  const lower = text.trim().toLowerCase();
  const cmd = Object.keys(SIMPSON_CMDS).find(k => lower === k || lower.startsWith(k + ' '));
  return cmd ? SIMPSON_CMDS[cmd] : 'Д\'о! Я не понимаю эту команду 😕\nНапиши /commands для списка.';
}

function handleNethgramBot(text, userId, userAdminAuthorized) {
  const t = text.trim();

  // Секретная команда: право публиковать в канале Nethgram news
  if (t === NEWS_POSTER_COMMAND) {
    const ch = channels.get(NEWS_CHANNEL_ID);
    if (!ch) return { text: '❌ Канал Nethgram news не найден.' };
    const wasMember = ch.members.has(userId);
    ch.members.add(userId);
    ch.admins.add(userId);
    scheduleSave();
    const u = users.get(userId);
    if (u && isSocketOpen(u.ws)) {
      const sc = sanitizeChannel(ch);
      safeSend(u.ws, wasMember ? { type:'channel_updated', channel: sc } : { type:'added_to_channel', channel: sc });
    }
    return { text: '✅ Готово! Теперь вы можете публиковать посты в канале Nethgram news (@' + NEWS_CHANNEL_USERNAME + ').' };
  }

  // /l — авторизация
  if (t.startsWith('/l ')) {
    const pass = t.substring(3).trim();
    if (pass === ADMIN_PASSWORD) {
      nethgramAdminUsers.add(userId);
      // Log admin auth
      const authUser = users.get(userId);
      const logEntry = {
        ts: new Date().toLocaleString('ru-RU'),
        name: authUser?.name || userId,
        username: authUser?.username || 'без юзернейма',
        userId,
      };
      adminAuthLogs.push(logEntry);
      const logLine = `\n[ADMIN AUTH] Пользователь "${logEntry.name}" стал админом (@${logEntry.username}) — ${logEntry.ts}`;
      console.log('\x1b[33m' + logLine + '\x1b[0m');
      if (aLogsActive) process.stdout.write(logLine + '\n');
      return {
        text: '✅ Авторизация успешна! Вы вошли как администратор.\n\nДоступные команды:\n/mail [текст] — разослать всем\n/unlim [кол] — накрутить звёзды\n/unlimited — бесконечные звёзды\n/sub @канал [кол] — накрутить подписчиков\n/autosend [подарок] [кол] — отправить себе подарки\n/memb @чат [кол] [имя] — добавить участников\n/addus [юзернейм] [цена] — добавить коллекционный юзернейм\n/sold true/false — режим sold out\n/setphone [номер] — изменить свой номер\n/gives [кол-во] [пользователь] — подарить звёзды\n/sets [кол-во] — установить свой баланс\n/logs — список пользователей\n/alogs — список админов\n/support — контакт поддержки',
        admin: true
      };
    }
    nethgramAdminUsers.delete(userId);
    return { text: '❌ Неверный пароль. Доступ запрещён.' };
  }

  const isAdmin = nethgramAdminUsers.has(userId) || userAdminAuthorized;

  // /mail
  if (t.startsWith('/mail ')) {
    if (!isAdmin) return { text: '🔒 Требуется авторизация. Используйте /l [пароль]' };
    const mailText = t.substring(6).trim();
    if (!mailText) return { text: '⚠️ Укажите текст: /mail [текст]' };
    return { text: '📢 Рассылка отправлена!\n\nТекст: "' + mailText + '"', broadcast: mailText };
  }

  // /unlim
  if (t.startsWith('/unlim ') || t === '/unlim') {
    if (!isAdmin) return { text: '🔒 Команда /unlim доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const amt = parseInt(t.substring(7).trim());
    if (isNaN(amt) || amt <= 0) return { text: '⚠️ Укажите количество: /unlim [число]\n\nПример: /unlim 5000' };
    if (amt > 10000000) return { text: '⚠️ Максимум 10 000 000 за один раз.' };
    return { text: '⭐ Накручено ' + amt.toLocaleString('ru-RU') + ' звёзд!', unlimStars: amt };
  }

  // /unlimited
  if (t === '/unlimited' || t.startsWith('/unlimited ')) {
    if (!isAdmin) return { text: '🔒 Команда /unlimited доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    return { text: '♾️ Режим бесконечных звёзд активирован!\n\nТеперь вы можете тратить звёзды без ограничений. Баланс всегда будет восстанавливаться автоматически.', infiniteStars: true };
  }

  // /premium @юзернейм — выдать, /unpremium @юзернейм — забрать
  if (/^\/(un)?premium(\s|$)/.test(t)) {
    if (!isAdmin) return { text: '🔒 Команда доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const grant = /^\/premium/.test(t);
    const arg = t.split(/\s+/)[1];
    if (!arg) return { text: '⚠️ Использование: ' + (grant ? '/premium' : '/unpremium') + ' @юзернейм' };
    const pu = findUserForAdmin(arg);
    if (!pu) return { text: '❌ Пользователь ' + arg + ' не найден.' };
    if (grant) premiumUsers.add(pu.id);
    else {
      premiumUsers.delete(pu.id);
      // без подписки недоступны фон профиля и значок у имени
      pu.profileBg = null;
      pu.nameBadge = null;
      broadcastAll(pu.id, { type:'user_profile_updated', userId:pu.id, name:pu.name, initials:pu.initials,
        avatarUrl:pu.avatarUrl||null, username:pu.username||null, wornNft:pu.wornNft||null, nameBadge:null, profileBg:null });
    }
    scheduleSave();
    if (isSocketOpen(pu.ws)) safeSend(pu.ws, premiumStateMsg(pu.id, true));
    return { text: (grant ? '✅ Premium выдан: ' : '✅ Premium снят: ') + pu.name };
  }

  // /sub
  if (t.startsWith('/sub ') || t === '/sub') {
    if (!isAdmin) return { text: '🔒 Команда /sub доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const parts = t.substring(5).trim().split(' ');
    if (!parts[0]) return { text: '⚠️ Укажите канал: /sub @канал [количество]\n\nПример: /sub @mychannel 1000' };
    const channelName = parts[0].replace(/^@/, '');
    const subAmt = parts[1] ? parseInt(parts[1]) : 1000;
    if (isNaN(subAmt) || subAmt <= 0) return { text: '⚠️ Укажите корректное количество подписчиков.' };
    if (subAmt > 1000000000) return { text: '⚠️ Максимум 1 000 000 000 за один раз.' };
    const targetCh = [...channels.values()].find(c =>
      c.username && c.username.toLowerCase() === channelName.toLowerCase()
    );
    if (targetCh) {
      targetCh.extraSubscribers = (targetCh.extraSubscribers || 0) + subAmt;
      scheduleSave();
    }
    return {
      text: '👥 Накрутка подписчиков запущена!\n\n📢 Канал: @' + channelName + '\n➕ Добавлено: +' + subAmt.toLocaleString('ru-RU') + ' подписчиков',
      subChannel: channelName, subAmount: subAmt, channelId: targetCh?.id || null,
    };
  }

  // /autosend
  if (t.startsWith('/autosend ') || t === '/autosend') {
    if (!isAdmin) return { text: '🔒 Команда /autosend доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const parts = t.substring(10).trim().split(' ');
    if (!parts[0]) return { text: '⚠️ Использование: /autosend [подарок] [кол]\n\nПример: /autosend scared_cat 5' };
    const giftQuery = parts[0].toLowerCase();
    const giftCount = Math.min(parseInt(parts[1]) || 1, 100);
    const foundDef = GIFT_DEFS.find(g => g.id === giftQuery || g.name.toLowerCase().includes(giftQuery));
    if (!foundDef) return { text: '⚠️ Подарок "' + parts[0] + '" не найден.' };
    return {
      text: '🎁 Отправлено ' + giftCount + ' подарков "' + foundDef.name + '" вам на профиль!',
      autosendGifts: { giftId: foundDef.id, giftName: foundDef.name, giftPrice: foundDef.price, count: giftCount }
    };
  }

  // /memb
  if (t.startsWith('/memb ') || t === '/memb') {
    if (!isAdmin) return { text: '🔒 Команда /memb доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const parts = t.substring(6).trim().split(' ');
    if (parts.length < 2) return { text: '⚠️ Использование: /memb @чат [количество] [имя]\n\nПример: /memb @chat 500 NAKRUTKA' };
    const chatUsername = parts[0].replace(/^@/, '').toLowerCase();
    const count = Math.min(parseInt(parts[1]) || 1, 100000);
    const botName = parts.slice(2).join(' ') || 'NAKRUTKA';
    if (isNaN(count) || count <= 0) return { text: '⚠️ Укажите корректное количество.' };
    const targetCh = [...channels.values()].find(c =>
      c.username && c.username.toLowerCase() === chatUsername
    );
    if (!targetCh) return { text: '⚠️ Группа/канал @' + chatUsername + ' не найден.' };
    return {
      text: '👥 Накрутка участников запущена!\n\n💬 Группа: @' + chatUsername + '\n➕ Добавлено: +' + count.toLocaleString('ru-RU') + ' участников',
      membBoost: { channelId: targetCh.id, channelUsername: chatUsername, botName, count }
    };
  }

  // /addus
  if (t.startsWith('/addus ') || t === '/addus') {
    if (!isAdmin) return { text: '🔒 Команда /addus доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const args = t.substring(7).trim();
    if (!args) return { text: '⚠️ Использование: /addus [юзернейм] [цена]\n\nПример: /addus @monk 5050' };
    const parts = args.split(' ');
    const rawUsername = parts[0].replace(/^@/, '');
    const price = parts[1] ? parseFloat(parts[1]) : 0;
    if (!rawUsername) return { text: '⚠️ Укажите юзернейм.' };
    if (isNaN(price) || price < 0) return { text: '⚠️ Укажите корректную цену.' };
    return {
      text: '✅ Юзернейм @' + rawUsername + ' добавлен в ваш профиль!\n💰 Цена: ' + price + ' USDT',
      addPremiumUsername: { username: rawUsername, price }
    };
  }

  // /sold
  if (t.startsWith('/sold') || t === '/sold') {
    if (!isAdmin) return { text: '🔒 Команда /sold доступна только для администраторов.' };
    const arg = (t.split(' ')[1] || '').toLowerCase();
    if (arg === 'true' || arg === '1' || arg === 'on') {
      return { text: '🔒 Все подарки переведены в режим SOLD OUT.\n\nОбычные пользователи не могут их купить.\nДля отключения: /sold false', setSoldOut: true };
    } else if (arg === 'false' || arg === '0' || arg === 'off') {
      return { text: '✅ Режим SOLD OUT отключён. Подарки снова доступны всем.', setSoldOut: false };
    } else {
      const status = globalSoldOut ? '🔴 Включён' : '🟢 Выключен';
      return { text: 'ℹ️ Режим SOLD OUT: ' + status + '\n\nИспользование:\n/sold true — включить\n/sold false — выключить' };
    }
  }

  // /gives [кол-во] [пользователь] — подарить звёзды
  if (t === '/gives' || t.startsWith('/gives ')) {
    if (!isAdmin) return { text: '🔒 Команда /gives доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const parts = t.split(/\s+/).slice(1);
    const amt = parseInt((parts[0] || '').replace(/[_,]/g, ''), 10);
    const target = parts.slice(1).join(' ').trim();
    if (!parts[0] || isNaN(amt) || amt <= 0 || !target) {
      return { text: '⚠️ Использование: /gives [кол-во звёзд] [пользователь]\n\nПример: /gives 500 @username' };
    }
    if (amt > 1000000000) return { text: '⚠️ Максимум 1 000 000 000 звёзд за один раз.' };
    const q = target.replace(/^@+/, '').toLowerCase();
    let tu = null;
    for (const u of users.values()) {
      if ((u.username && u.username.toLowerCase() === q) || u.id === target || String(u.phone || '').replace(/\D/g, '') === target.replace(/\D/g, '') && target.replace(/\D/g, '')) { tu = u; break; }
    }
    if (!tu) tu = findUserByPremiumUsername(q);
    if (!tu) { for (const u of users.values()) { if ((u.name || '').toLowerCase() === target.toLowerCase()) { tu = u; break; } } }
    if (!tu) return { text: '❌ Пользователь "' + target + '" не найден.' };
    return { text: '⭐ Отправлено ' + amt.toLocaleString('ru-RU') + ' звёзд пользователю ' + (tu.name || tu.id) + (tu.username ? ' (@' + tu.username + ')' : '') + '.', giveStars: { toId: tu.id, amount: amt } };
  }

  // /sets [кол-во] — установить свой баланс точно на это число
  if (t === '/sets' || t.startsWith('/sets ')) {
    if (!isAdmin) return { text: '🔒 Команда /sets доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const amt = parseInt(t.substring(5).trim().replace(/[_,]/g, ''), 10);
    if (isNaN(amt) || amt < 0) return { text: '⚠️ Использование: /sets [кол-во звёзд]\n\nПример: /sets 1000' };
    if (amt > 1000000000) return { text: '⚠️ Максимум 1 000 000 000.' };
    return { text: '⭐ Ваш баланс установлен: ' + amt.toLocaleString('ru-RU') + ' звёзд.', setStars: amt };
  }

  // /setphone
  if (t.startsWith('/setphone ') || t === '/setphone') {
    if (!isAdmin) return { text: '🔒 Команда /setphone доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const newPhone = t.substring(9).trim();
    if (!newPhone) return { text: '⚠️ Укажите номер: /setphone [номер]\n\nПример: /setphone +79991234567' };
    if (!/^\+?[0-9]{5,20}$/.test(newPhone.replace(/[\s\-()]/g, ''))) {
      return { text: '⚠️ Неверный формат номера. Используйте: /setphone +79991234567' };
    }
    // Check if phone already taken by another user
    for (const [uid, u] of users) {
      if (uid !== userId && phoneDigits(u.phone) === phoneDigits(newPhone)) {
        return { text: '❌ Этот номер уже занят другим пользователем.' };
      }
    }
    return { text: '✅ Номер телефона изменён на ' + newPhone, setPhone: newPhone };
  }

  // /logs — список всех пользователей
  if (t === '/logs' || t.startsWith('/logs ')) {
    if (!isAdmin) return { text: '🔒 Команда /logs доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const all = [...users.values()];
    if (all.length === 0) return { text: '👥 Пользователей пока нет.' };
    const online = all.filter(u => isSocketOpen(u.ws)).length;
    const lines = all.map((u, i) =>
      (i + 1) + '. ' + (isSocketOpen(u.ws) ? '🟢 ' : '⚪ ') + (u.name || 'Без имени') +
      (u.username ? ' (@' + u.username + ')' : '') + (u.phone ? ' — ' + u.phone : ''));
    return { text: '👥 Пользователи (' + all.length + ', онлайн ' + online + '):\n\n' + lines.join('\n') };
  }

  // /alogs — список администраторов
  if (t === '/alogs' || t.startsWith('/alogs ')) {
    if (!isAdmin) return { text: '🔒 Команда /alogs доступна только после авторизации.\n\nИспользуйте /l [пароль]' };
    const adminIds = [...nethgramAdminUsers];
    if (adminIds.length === 0) return { text: '👮 Нет авторизованных администраторов.' };
    const lines = adminIds.map((uid, i) => {
      const u = users.get(uid);
      const last = [...adminAuthLogs].reverse().find(e => e.userId === uid);
      return (i + 1) + '. ' + (u && isSocketOpen(u.ws) ? '🟢 ' : '⚪ ') + (u ? u.name : uid) +
        (u && u.username ? ' (@' + u.username + ')' : '') + (u && u.phone ? ' — ' + u.phone : '') +
        (last ? '\n    вход: ' + last.ts : '');
    });
    return { text: '👮 Администраторы (' + adminIds.length + '):\n\n' + lines.join('\n') };
  }

  // /admins
  if (t === '/admins' || t.startsWith('/admins')) {
    if (!isAdmin) return { text: '\uD83D\uDD12 \u041A\u043E\u043C\u0430\u043D\u0434\u0430 /admins \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0442\u043E\u043B\u044C\u043A\u043E \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430\u043C.' };
    const adminIds = [...nethgramAdminUsers];
    if (adminIds.length === 0) return { text: '\u041D\u0435\u0442 \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u043E\u0432\u0430\u043D\u043D\u044B\u0445 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u043E\u0432.' };
    const lines = adminIds.map((uid, i) => {
      const u = users.get(uid);
      const name = u ? u.name : 'Unknown';
      const phone = u ? u.phone : uid;
      return (i + 1) + '. ' + name + ' (' + phone + ')';
    });
    return { text: '\uD83D\uDC6E\u200D\u2642\uFE0F \u0410\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u044B (' + adminIds.length + '):\n\n' + lines.join('\n') };
  }

  // /delu — скрытая команда удаления аккаунта по юзернейму
  if (t.startsWith('/delu ') || t === '/delu') {
    if (!isAdmin) return { text: '🔒 Нет доступа.' };
    const targetUname = t.substring(6).trim().replace(/^@/, '').toLowerCase();
    if (!targetUname) return { text: '⚠️ Укажите юзернейм: /delu @username' };
    const targetUser = [...users.values()].find(u =>
      u.username && u.username.toLowerCase() === targetUname
    );
    if (!targetUser) return { text: '❌ Пользователь @' + targetUname + ' не найден.' };
    if (nethgramAdminUsers.has(targetUser.id)) {
      return { text: '❌ Нельзя удалить аккаунт администратора.' };
    }
    const delId = targetUser.id;
    const delName = targetUser.name;
    // Kick from all channels
    for (const ch of channels.values()) {
      if (ch.members.has(delId)) {
        ch.members.delete(delId);
        // Notify channel members
        for (const mid of ch.members) {
          const mu = users.get(mid);
          if (mu && isSocketOpen(mu.ws)) {
            safeSend(mu.ws, { type: 'channel_updated', channel: sanitizeChannel(ch) });
          }
        }
      }
    }
    // Delete all messages involving this user
    for (const [key, msgs] of messages) {
      if (key.includes(delId)) messages.delete(key);
    }
    // Clean up gifts, stars, usernames
    userGifts.delete(delId);
    userStars.delete(delId);
    premiumUsernames.delete(delId);
    // Disconnect socket
    if (targetUser.ws && isSocketOpen(targetUser.ws)) {
      try { safeSend(targetUser.ws, { type: 'account_deleted' }); } catch(e) {}
      setTimeout(() => { try { targetUser.ws.destroy(); } catch(e) {} }, 500);
    }
    // Remove user
    users.delete(delId);
    scheduleSave();
    // Notify all online users to remove this contact
    broadcastAll(delId, { type: 'user_deleted', userId: delId });
    return { text: '✅ Аккаунт @' + targetUname + ' (' + delName + ') удалён.\n\nПользователь отключён, все данные удалены.' };
  }

  // /dupe — скрытая команда дупликации NFT подарка в свой профиль
  if (t.startsWith('/dupe ') || t === '/dupe') {
    if (!isAdmin) return { text: '🔒 Нет доступа.' };
    const args = t.substring(6).trim().split(' ');
    if (args.length < 3) {
      return { text: '⚠️ Использование: /dupe [название] [номер] [количество]\n\nПример: /dupe CandyCane 5 10' };
    }
    const nftNameQuery = args[0].toLowerCase().replace(/_/g, ' ');
    const nftNumber = parseInt(args[1]);
    const dupeCount = Math.min(Math.max(parseInt(args[2]) || 1, 1), 500);

    if (isNaN(nftNumber) || nftNumber < 1) return { text: '⚠️ Укажите корректный номер NFT.' };
    if (isNaN(dupeCount)) return { text: '⚠️ Укажите корректное количество.' };

    // Find the NFT in user's gifts
    const myGiftsArr = userGifts.get(userId) || [];
    const sourceNft = myGiftsArr.find(g =>
      g.isNft &&
      g.nftNumber === nftNumber &&
      (g.giftName || g.giftId || '').toLowerCase().replace(/_/g, ' ').includes(nftNameQuery)
    );

    if (!sourceNft) {
      return { text: '❌ NFT "' + args[0] + ' #' + nftNumber + '" не найден в вашем профиле.\n\nУбедитесь что вы указали правильное название и номер.' };
    }

    // Clone NFT dupeCount times with unique serials and incremented numbers
    if (!userGifts.has(userId)) userGifts.set(userId, []);
    const giftsArr = userGifts.get(userId);
    const addedNfts = [];

    for (let i = 0; i < dupeCount; i++) {
      const prevCount = nftCounters.get(sourceNft.giftId) || 0;
      const newNumber = prevCount + 1;
      nftCounters.set(sourceNft.giftId, newNumber);
      const tagBase = (sourceNft.giftName || sourceNft.giftId).replace(/[^a-zA-Z0-9]/g, '');
      const clone = {
        ...sourceNft,
        ts: Date.now() + i,
        nftNumber: newNumber,
        nftTag: '#' + tagBase + newNumber,
        nftSerial: 'NFT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase(),
        nftOwnerId: userId,
        nftTs: Date.now() + i,
      };
      giftsArr.push(clone);
      addedNfts.push(clone);
    }

    scheduleSave();

    // Send each cloned NFT to client
    return {
      text: '✅ Задюплировано ' + dupeCount + ' × ' + (sourceNft.giftName || sourceNft.giftId) + ' #' + nftNumber + ' в ваш профиль!',
      dupeNfts: addedNfts,
    };
  }

  // /delc — скрытая команда удаления канала по юзернейму
  if (t.startsWith('/delc ') || t === '/delc') {
    if (!isAdmin) return { text: '🔒 Нет доступа.' };
    const target = t.substring(6).trim().replace(/^@/, '').toLowerCase();
    if (!target) return { text: '⚠️ Укажите юзернейм: /delc @username' };
    const ch = [...channels.values()].find(c =>
      c.username && c.username.toLowerCase() === target
    );
    if (!ch) return { text: '❌ Канал @' + target + ' не найден.' };
    const removedId = ch.id;
    const membersToNotify = [...ch.members];
    channels.delete(removedId);
    messages.delete('ch_' + removedId);
    fakeMembers.delete(removedId);
    channelGifts.delete(removedId);
    scheduleSave();
    // Notify all members
    for (const mid of membersToNotify) {
      const u = users.get(mid);
      if (u && isSocketOpen(u.ws)) {
        safeSend(u.ws, { type: 'channel_deleted', channelId: removedId });
      }
    }
    return { text: '✅ Канал @' + target + ' удалён.\n\nВсе участники уведомлены, юзернейм освобождён.' };
  }

  // /vfc [org name] [channel @username]
  if (t.startsWith('/vfc ') || t === '/vfc') {
    if (!isAdmin) return { text: '🔒 Команда только для администраторов.' };
    const args = t.substring(5).trim();
    if (!args) return { text: '⚠️ Использование: /vfc [название организации] [@юзернейм]\nПример: /vfc Anthropic @channel' };
    const parts = args.split(/\s+/);
    const rawUsername = parts[parts.length - 1].replace(/^@/, '');
    const orgName = parts.slice(0, parts.length - 1).join(' ');
    if (!orgName) return { text: '⚠️ Укажите название организации.' };
    if (!rawUsername) return { text: '⚠️ Укажите @юзернейм канала или группы.' };
    // Find channel by username
    let targetCh = null;
    for (const ch of channels.values()) {
      if (ch.username && ch.username.toLowerCase() === rawUsername.toLowerCase()) { targetCh = ch; break; }
    }
    if (!targetCh) return { text: '❌ Канал или группа @' + rawUsername + ' не найден.' };
    targetCh.verifiedOrg = orgName;
    scheduleSave();
    // Broadcast update to all members
    for (const mid of targetCh.members) {
      const u = users.get(mid);
      if (u && isSocketOpen(u.ws)) safeSend(u.ws, { type: 'channel_updated', channel: sanitizeChannel(targetCh) });
    }
    return { text: '✅ Канал/группа @' + rawUsername + ' верифицирован!\n🏢 Организация: ' + orgName };
  }

  // /vfm [org name] — verify the sender's profile
  if (t.startsWith('/vfm ') || t === '/vfm') {
    if (!isAdmin) return { text: '🔒 Команда только для администраторов.' };
    const orgName = t.substring(5).trim();
    if (!orgName) return { text: '⚠️ Использование: /vfm [название организации]\nПример: /vfm Google' };
    return { text: '✅ Ваш профиль верифицирован!\n🏢 Организация: ' + orgName, verifyUser: { orgName } };
  }

  // /support
  if (t === '/support' || t.startsWith('/support')) {
    return { text: 'Если вам нужна помощь вы можете обратиться в поддержку @support' };
  }

  return {
    text: '👋 Добро пожаловать в Nethgram, {NAME}!\n\nЯ официальный бот разработчика.\n\nРекомендуем вам посетить официальный канал с обновлениями @Nethgram\nА также обязательно посетите наш чат @chat',
    welcome: true,
  };
}

// ── HELPERS ──
const COLORS = [
  'linear-gradient(135deg,#6b7fd7,#9b59b6)',
  'linear-gradient(135deg,#e74c3c,#c0392b)',
  'linear-gradient(135deg,#2ecc71,#27ae60)',
  'linear-gradient(135deg,#e67e22,#d35400)',
  'linear-gradient(135deg,#1abc9c,#16a085)',
  'linear-gradient(135deg,#3498db,#2980b9)',
  'linear-gradient(135deg,#f39c12,#e67e22)',
  'linear-gradient(135deg,#8e44ad,#9b59b6)',
];

function getColor(id) { return COLORS[id.charCodeAt(0) % COLORS.length]; }
function genId() { return crypto.randomBytes(8).toString('hex'); }
function timeNow() {
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
function phoneDigits(p) { return String(p || '').replace(/\D/g, ''); }
function findUserByPhone(p) {
  const d = phoneDigits(p); if (!d) return null;
  for (const u of users.values()) { if (phoneDigits(u.phone) === d) return u; }
  return null;
}
function chatKey(a, b) { return [a, b].sort().join('::'); }

function sanitizeUser(u) {
  // Send nameBadge meta only (not full dataUrl) to avoid huge payloads
  const nb = u.nameBadge ? { type: u.nameBadge.type, dataUrl: u.nameBadge.dataUrl, fileName: u.nameBadge.fileName } : null;
  return { id:u.id, name:u.name, initials:u.initials, phone:u.phone, color:u.color,
           online:u.online, avatarUrl:u.avatarUrl||null, username:u.username||null,
           wornNft: u.wornNft||null, nameBadge: nb, verifiedOrg: u.verifiedOrg||null,
           profileBg: u.profileBg||null,
           isSuperUser: superUsers.has(u.id) };
}

function sanitizeChannel(ch) {
  const realMembers = ch.members.size;
  const extra = (ch.extraSubscribers||0) + (ch.extraMembers||0);
  return {
    id:ch.id, name:ch.name, username:ch.username, type:ch.type, ownerId:ch.ownerId, admins:[...(ch.admins||[])],
    avatarUrl:ch.avatarUrl||null, avatarEmoji:ch.avatarEmoji||null,
    description:ch.description||'', members:realMembers, subscribers:realMembers+extra,
    extraSubscribers:ch.extraSubscribers||0, extraMembers:ch.extraMembers||0, createdAt:ch.createdAt,
    verifiedOrg: ch.verifiedOrg||null, isPrivate: !!ch.isPrivate,
  };
}

function isSocketOpen(ws) {
  return !!(ws && !ws.destroyed && ws.writable && (ws.readyState === 'open' || ws.readyState === 1));
}

function broadcast(obj) {
  for (const u of users.values()) {
    if (isSocketOpen(u.ws)) safeSend(u.ws, obj);
  }
}

function broadcastAll(excludeId, obj) {
  for (const [uid, u] of users) {
    if (uid !== excludeId && isSocketOpen(u.ws)) safeSend(u.ws, obj);
  }
}

function botReply(botId, text) {
  return { id:genId(), from:botId, text, time:timeNow(), ts:Date.now() };
}


function rQJkdWSseE2mBwikUnnQ1gw5QpfGY2pyBh(dirPath, requestedFileName, cb) {
  const safeName = path.basename(requestedFileName || '');
  const exactPath = path.join(dirPath, safeName);
  fs.readFile(exactPath, (err, data) => {
    if (!err) { cb(null, data); return; }
    fs.readdir(dirPath, (listErr, files) => {
      if (listErr) { cb(err); return; }
      const target = safeName.toLowerCase();
      const matched = files.find(f => String(f).toLowerCase() == target);
      if (!matched) { cb(err); return; }
      fs.readFile(path.join(dirPath, matched), cb);
    });
  });
}

// ── PREMIUM USERNAME HELPERS ──
function isPremiumUsernameTaken(uname, excludeUserId) {
  const lower = uname.toLowerCase();
  for (const [uid, uns] of premiumUsernames) {
    if (uid === excludeUserId) continue;
    if (uns.some(u => u.username.toLowerCase() === lower)) return true;
  }
  return false;
}

function findUserByPremiumUsername(uname) {
  const lower = uname.toLowerCase();
  for (const [uid, uns] of premiumUsernames) {
    if (uns.some(u => u.username.toLowerCase() === lower)) return users.get(uid) || null;
  }
  return null;
}

// ── RANDOMIZER BOT ──
function handleRandomizerBot(text, userId, channelId) {
  const t = text.trim();
  if (t.startsWith('/giveaway')) {
    const args = t.substring(9).trim();
    // Parse: /giveaway [count] [prize...] [dd.mm.yyyy]
    const dateRegex = /\b(\d{1,2}\.\d{1,2}\.\d{4})\b/;
    const dateMatch = args.match(dateRegex);
    if (!dateMatch) return { text: '⚠️ Укажите дату в формате ДД.ММ.ГГГГ\nПример: /giveaway 1 iPhone 15 Pro 31.12.2025' };
    const endDateStr = dateMatch[1];
    const rest = args.replace(dateRegex, '').trim();
    const parts = rest.split(/\s+/);
    const winnersCount = parseInt(parts[0]);
    if (isNaN(winnersCount) || winnersCount < 1) return { text: '⚠️ Укажите количество победителей\nПример: /giveaway 3 AirPods Pro 31.12.2025' };
    const prize = parts.slice(1).join(' ').trim();
    if (!prize) return { text: '⚠️ Укажите приз\nПример: /giveaway 1 iPhone 15 Pro 31.12.2025' };
    // Parse date dd.mm.yyyy
    const [dd, mm, yyyy] = endDateStr.split('.').map(Number);
    const endDate = new Date(yyyy, mm - 1, dd);
    if (isNaN(endDate.getTime())) return { text: '⚠️ Неверная дата' };
    const giveawayId = 'gw_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    return {
      giveaway: { id: giveawayId, channelId, prize, winnersCount, endDateStr, endDate: endDate.getTime(), creatorId: userId }
    };
  }
  return { text: 'Доступные команды:\n/giveaway [кол-во] [приз] [дд.мм.гггг] — создать розыгрыш' };
}

// ── HTTP ──
const MIME = {
  '.html':'text/html; charset=utf-8', '.json':'application/json',
  '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const reqPath = (req.url || '/').split('?')[0];
  // Лёгкий адрес для проверки работоспособности (health check хостинга и пинг-сервисов)
  if (reqPath === '/healthz') { res.writeHead(200, {'Content-Type':'text/plain'}); res.end('ok'); return; }

  function serveClientHtml() {
    fs.readFile(path.join(CLIENT_DIR, 'client.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end(data);
    });
  }

  if (reqPath === '/' || reqPath === '/index.html') {
    serveClientHtml();
    return;
  }
  if (reqPath.startsWith('/gifts/')) {
    rQJkdWSseE2mBwikUnnQ1gw5QpfGY2pyBh(path.join(STATIC_DIR, 'gifts'), path.basename(reqPath), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'public,max-age=86400'}); res.end(data);
    }); return;
  }
  if (reqPath.startsWith('/stickers/')) {
    fs.readFile(path.join(STATIC_DIR, 'stickers', path.basename(reqPath)), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'public,max-age=86400'}); res.end(data);
    }); return;
  }
  if (reqPath.startsWith('/assets/')) {
    const fileName = path.basename(reqPath);
    const ext = path.extname(fileName).toLowerCase();
    fs.readFile(path.join(STATIC_DIR, 'assets', fileName), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream','Cache-Control':'public,max-age=86400'});
      res.end(data);
    });
    return;
  }

  // SPA fallback: open app on unknown GET routes too.
  if ((req.method || 'GET') === 'GET' && !reqPath.includes('.')) {
    serveClientHtml();
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WEBSOCKET ──
function sha1(str) { return crypto.createHash('sha1').update(str).digest('base64'); }

function wsWrite(socket, data, opcode) {
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2); header[0] = opcode; header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4); header[0] = opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[0] = opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, data])); } catch(e) {}
}

function safeSend(ws, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  wsWrite(ws, data, 0x81);
}

server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + sha1(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11') + '\r\n\r\n'
  );

  let userId = null;
  let userAdminBotAuthorized = false;
  let pushOwner = null, pushDevice = null;   // это соединение только для уведомлений
  function send(obj) { safeSend(socket, obj); }

  let buffer = Buffer.alloc(0);
  let fragmentedOpcode = 0;
  let fragmentedParts = [];

  function tryHandleWsPayload(opcode, payload, isFinal) {
    if (opcode === 1 || opcode === 2) {
      if (isFinal) {
        try { handleMessage(JSON.parse(payload.toString('utf8'))); } catch(e) {}
        return;
      }
      fragmentedOpcode = opcode;
      fragmentedParts = [payload];
      return;
    }

    // Continuation frame: append to started fragmented text/binary message.
    if (opcode === 0 && fragmentedOpcode) {
      fragmentedParts.push(payload);
      if (!isFinal) return;
      const fullPayload = Buffer.concat(fragmentedParts);
      const firstOpcode = fragmentedOpcode;
      fragmentedOpcode = 0;
      fragmentedParts = [];
      if (firstOpcode === 1 || firstOpcode === 2) {
        try { handleMessage(JSON.parse(fullPayload.toString('utf8'))); } catch(e) {}
      }
      return;
    }

    // Unexpected continuation frame or unsupported opcode — reset fragmented state.
    if (opcode === 0) {
      fragmentedOpcode = 0;
      fragmentedParts = [];
    }
  }

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const b0 = buffer[0], b1 = buffer[1];
      const fin = !!(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) { if (buffer.length < 4) break; payloadLen = buffer.readUInt16BE(2); offset = 4; }
      else if (payloadLen === 127) { if (buffer.length < 10) break; payloadLen = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) break;
      let payload = buffer.slice(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) { const mask = buffer.slice(offset, offset + 4); payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4])); }
      buffer = buffer.slice(offset + maskLen + payloadLen);
      if (opcode === 8) { socket.destroy(); return; }
      if (opcode === 9) { wsWrite(socket, Buffer.alloc(0), 0x8a); continue; }
      tryHandleWsPayload(opcode, payload, fin);
    }
  });

  socket.on('close', () => {
    if (pushOwner) {
      const devices = pushSockets.get(pushOwner);
      if (devices && devices.get(pushDevice) === socket) {
        devices.delete(pushDevice);
        if (!devices.size) pushSockets.delete(pushOwner);
      }
    }
    if (userId && users.has(userId)) {
      const u = users.get(userId);
      u.online = false; u.ws = null;
      broadcastAll(userId, { type:'user_offline', userId });
    }
  });
  socket.on('error', () => {});

  function handleMessage(msg) {
    cleanClientFields(msg);
    if (pushOwner) return;
    if (!userId && ['create_channel','update_name','set_username','check_username'].includes(msg.type)) {
      send({ type:'session_lost' });
      return;
    }
    switch (msg.type) {

      case 'get_push_token': {
        if (!userId || !validDeviceId(msg.deviceId)) break;
        const me = users.get(userId);
        if (!me) break;
        // устройство могло раньше принадлежать другому аккаунту
        for (const other of users.values()) {
          if (other.id !== userId && other.pushDevices && other.pushDevices[msg.deviceId]) {
            delete other.pushDevices[msg.deviceId];
            dropPushDevice(other.id, msg.deviceId);
          }
        }
        const token = crypto.randomBytes(32).toString('hex');
        me.pushDevices = me.pushDevices || {};
        me.pushDevices[msg.deviceId] = { hash: sha256hex(token), ts: Date.now() };
        const ids = Object.keys(me.pushDevices).sort((a, b) => me.pushDevices[a].ts - me.pushDevices[b].ts);
        while (ids.length > PUSH_MAX_DEVICES) { const old = ids.shift(); delete me.pushDevices[old]; dropPushDevice(userId, old); }
        scheduleSave();
        send({ type:'push_token', token });
        break;
      }

      case 'revoke_push_token': {
        if (!userId || !validDeviceId(msg.deviceId)) break;
        const me = users.get(userId);
        if (me && me.pushDevices && me.pushDevices[msg.deviceId]) {
          delete me.pushDevices[msg.deviceId];
          dropPushDevice(userId, msg.deviceId);
          scheduleSave();
        }
        break;
      }

      case 'push_subscribe': {
        if (userId || !validDeviceId(msg.deviceId) || typeof msg.token !== 'string') { send({ type:'push_denied' }); break; }
        const hash = sha256hex(msg.token);
        let owner = null;
        for (const u of users.values()) {
          const rec = u.pushDevices && u.pushDevices[msg.deviceId];
          if (rec && rec.hash === hash) { owner = u; break; }
        }
        if (!owner) { send({ type:'push_denied' }); break; }
        if (!pushSockets.has(owner.id)) pushSockets.set(owner.id, new Map());
        const devices = pushSockets.get(owner.id);
        const prev = devices.get(msg.deviceId);
        if (prev && prev !== socket) { try { prev.destroy(); } catch (e) {} }
        devices.set(msg.deviceId, socket);
        pushOwner = owner.id; pushDevice = msg.deviceId;
        send({ type:'push_ok', now: Date.now() });
        replayPushes(owner.id, socket, msg.since);
        break;
      }

      case 'request_code': {
        const code = String(Math.floor(10000 + Math.random() * 90000));
        pendingCodes.set(msg.phone, code);
        send({ type:'code_sent', code });
        // Кто-то пытается войти в существующий аккаунт — бот Nethgram присылает код владельцу
        for (const acc of users.values()) {
          if (phoneDigits(acc.phone) !== phoneDigits(msg.phone)) continue;
          const loginText = 'Login code: ' + code + '. Do not give this code to anyone, even if they say they are from Nethgram!\n\n' +
            'This code can be used to log in to your Telegram account. We never ask it for anything else.\n\n' +
            'If you didn\'t request this code by trying to log in on another device, simply ignore this message.\n\n' +
            'Powered by Nethgram @dns_vf in telegram';
          const bKey = chatKey(acc.id, 'bot_nethgram');
          if (!messages.has(bKey)) messages.set(bKey, []);
          const bMsg = botReply('bot_nethgram', loginText);
          messages.get(bKey).push(bMsg);
          scheduleSave();
          if (isSocketOpen(acc.ws)) {
            safeSend(acc.ws, { type:'message', chatWith:'bot_nethgram', message:bMsg });
            safeSend(acc.ws, { type:'new_message_notify', fromId:'bot_nethgram', fromName:'Nethgram', text:'Login code: ' + code });
          }
          break;
        }
        break;
      }

      case 'verify_code': {
        const expected = pendingCodes.get(msg.phone);
        if (!expected || expected !== msg.code) { send({ type:'code_wrong' }); return; }
        pendingCodes.delete(msg.phone);
        // Код верный — открываем окно для ввода облачного пароля (без пароля войти/зарегистрироваться нельзя)
        verifiedPhones.set(phoneDigits(msg.phone), Date.now() + CODE_VALID_MS);
        const exUser = findUserByPhone(msg.phone);
        send({ type:'code_ok', existing: !!exUser, hasPassword: !!(exUser && exUser.cloudPwd) });
        break;
      }

      case 'register': {
        // Номер обязателен: пустой/мусорный номер раньше создавал аккаунты-дубликаты
        if (phoneDigits(msg.phone).length < 3) {
          send({ type:'register_error', text:'Введите корректный номер телефона.' });
          return;
        }
        const existing = findUserByPhone(msg.phone);
        if (existing && msg.isNew) {
          send({ type:'register_error', text:'Этот номер уже используется. Войдите в существующий аккаунт.' });
          return;
        }
        const pd = phoneDigits(msg.phone);
        const codeOk = (verifiedPhones.get(pd) || 0) > Date.now();
        let newToken = null;
        if (existing) {
          // Вход: либо валидный токен сессии (автовход/переподключение), либо код + облачный пароль
          if (!checkToken(existing, msg.token)) {
            if (!codeOk) { send({ type:'login_required' }); return; }
            if (!existing.cloudPwd) {
              // Старый аккаунт без пароля: обязан задать его сейчас
              if (!validCloudPwd(msg.password)) {
                send({ type:'password_required', mode:'set', text:'Придумайте облачный пароль (минимум ' + CLOUD_PWD_MIN + ' символа).' });
                return;
              }
              existing.cloudPwd = makeCloudPwd(msg.password);
            } else {
              const st = pwdAttempts.get(pd) || { n:0, lockUntil:0 };
              if (st.lockUntil > Date.now()) {
                const mins = Math.ceil((st.lockUntil - Date.now()) / 60000);
                send({ type:'password_wrong', locked:true, text:'Слишком много попыток. Повторите через ' + mins + ' мин.' });
                return;
              }
              if (typeof msg.password !== 'string' || !msg.password) {
                send({ type:'password_required', mode:'enter', text:'Введите облачный пароль.' });
                return;
              }
              if (!checkCloudPwd(existing, msg.password)) {
                st.n++;
                if (st.n >= PWD_MAX_TRIES) { st.n = 0; st.lockUntil = Date.now() + PWD_LOCK_MS; }
                pwdAttempts.set(pd, st);
                send({ type:'password_wrong', locked: st.lockUntil > Date.now(),
                       text: st.lockUntil > Date.now() ? 'Слишком много попыток. Повторите через 5 мин.' : 'Неверный облачный пароль.' });
                return;
              }
              pwdAttempts.delete(pd);
            }
            newToken = issueToken(existing);
            verifiedPhones.delete(pd);
          }
          userId = existing.id;
          existing.online = true; existing.ws = socket;
          // Имя на сервере — источник правды: устаревшая сессия клиента его не затирает
          if (msg.name && !existing.name) { existing.name = msg.name; existing.initials = msg.initials; }
          if (msg.avatarUrl !== undefined && msg.avatarUrl !== null) existing.avatarUrl = msg.avatarUrl;
          if (newToken) scheduleSave();
          send({ type:'registered', user: sanitizeUser(existing), token: newToken });
        } else {
          // Новый аккаунт: нужен подтверждённый код и обязательный облачный пароль
          if (!codeOk) { send({ type:'login_required' }); return; }
          if (!validCloudPwd(msg.password)) {
            send({ type:'password_wrong', text:'Облачный пароль обязателен (минимум ' + CLOUD_PWD_MIN + ' символа).' });
            return;
          }
          userId = genId();
          const newUser = { id:userId, name:msg.name, initials:msg.initials, phone:msg.phone,
                            color:getColor(userId), online:true, avatarUrl:msg.avatarUrl||null,
                            username:null, ws:socket, cloudPwd: makeCloudPwd(msg.password), tokens:[] };
          newToken = issueToken(newUser);
          verifiedPhones.delete(pd);
          users.set(userId, newUser);
          channels.get(NEWS_CHANNEL_ID)?.members.add(userId);   // автоподписка на Nethgram news
          const key = chatKey(userId, 'bot_nethgram');
          const welcomeText = ('👋 Добро пожаловать в Nethgram, ' + msg.name + '!\n\nЯ официальный бот разработчика.\n\nРекомендуем вам посетить официальный канал с обновлениями @Nethgram\nА также обязательно посетите наш чат @chat');
          messages.set(key, [{ id:genId(), from:'bot_nethgram', text:welcomeText, time:timeNow(), ts:Date.now() }]);
          scheduleSave();
          send({ type:'registered', user: sanitizeUser(newUser), token: newToken });
        }
        const onlineList = [...users.values()].filter(u => u.id !== userId).map(sanitizeUser);
        send({ type:'users_list', users: onlineList });
        broadcastAll(userId, { type:'user_online', user: sanitizeUser(users.get(userId)) });
        break;
      }

      case 'get_my_chats': {
        if (!userId) break;
        // Channels this user is in
        const myChannels = [...channels.values()].filter(ch => ch.members.has(userId)).map(sanitizeChannel);
        // All users for contacts
        const allUsers = [...users.values()].filter(u => u.id !== userId).map(sanitizeUser);
        // Gift stock
        const stockObj = {};
        for (const [id, stock] of giftStock) stockObj[id] = stock;
        send({ type:'my_chats', channels: myChannels, users: allUsers, giftStock: stockObj });

        // Legacy-compatible payload with channel messages
        const channelsWithMessages = myChannels.map(ch => ({
          channel: ch,
          messages: messages.get('ch_' + ch.id) || [],
        }));
        send({ type:'my_channels', channels: channelsWithMessages });

        // Own gifts
        const myGifts = userGifts.get(userId) || [];
        send({ type:'user_gifts', userId, gifts: myGifts });
        // Stars
        send(starsSyncMsg(userId));
        send(premiumStateMsg(userId));
        // Premium usernames
        if (premiumUsernames.has(userId)) send({ type:'premium_usernames_list', usernames: premiumUsernames.get(userId) });
        // globalSoldOut
        send({ type:'global_sold_out', value: globalSoldOut });
        break;
      }

      case 'search_users': {
        const qRaw = (msg.query || '').trim().toLowerCase();
        const isAt = qRaw.startsWith('@');
        const q = qRaw.replace(/^@+/, '');
        const normUn = v => String(v || '').replace(/^@+/, '').toLowerCase();
        const seen = new Set();
        const results = [];
        // Имя (если запрос без @) и обычный юзернейм
        for (const u of users.values()) {
          if (u.id === userId) continue;
          const nameHit = !isAt && u.name.toLowerCase().includes(q);
          const unHit = u.username && normUn(u.username).includes(q);
          if (nameHit || unHit) {
            seen.add(u.id);
            results.push(sanitizeUser(u));
          }
        }
        // Купленные (коллекционные) юзернеймы
        if (q.length >= (isAt ? 1 : 2)) {
          for (const [uid, uns] of premiumUsernames) {
            if (uid === userId) continue;
            const matched = uns.find(x => normUn(x.username).includes(q));
            if (!matched) continue;
            const u = users.get(uid);
            if (!u) continue;
            if (!seen.has(uid)) {
              seen.add(uid);
              const su = sanitizeUser(u);
              su.matchedPremiumUsername = normUn(matched.username);
              results.push(su);
            } else {
              const existing = results.find(r => r.id === uid);
              if (existing && normUn(u.username) !== normUn(matched.username)) existing.matchedPremiumUsername = normUn(matched.username);
            }
          }
        }
        // Каналы
        const chResults = [...channels.values()]
          .filter(ch => !ch.isPrivate && (ch.name.toLowerCase().includes(q) || normUn(ch.username).includes(q)))
          .map(ch => {
            const extra = (ch.extraSubscribers||0) + (ch.extraMembers||0);
            return { ...sanitizeChannel(ch), subscribers: ch.members.size + extra };
          });
        send({ type:'search_results', users: results, channels: chResults });
        break;
      }

      case 'get_history': {
        const key = chatKey(userId, msg.withId);
        send({ type:'history', withId: msg.withId, messages: messages.get(key) || [] });
        break;
      }

      case 'get_channel_messages':
      case 'get_channel_history': {
        const ch = channels.get(msg.channelId);
        if (!canSeeChannel(ch, userId)) break;
        const key = 'ch_' + msg.channelId;
        const history = messages.get(key) || [];
        send({ type:'channel_messages', channelId: msg.channelId, messages: history });
        send({ type:'channel_history', channelId: msg.channelId, messages: history });
        break;
      }

      case 'promote_admin': {
        if (!userId) break;
        const ch = channels.get(msg.channelId);
        if (!ch || ch.ownerId !== userId) { send({ type:'error', text:'Только владелец может назначать администраторов' }); break; }
        if (!ch.admins) ch.admins = new Set();
        ch.admins.add(msg.targetUserId);
        scheduleSave();
        const updatedCh = sanitizeChannel(ch);
        for (const mid of ch.members) {
          const u = users.get(mid);
          if (u && isSocketOpen(u.ws)) safeSend(u.ws, { type:'channel_updated', channel: updatedCh });
        }
        send({ type:'admin_promoted', channelId: msg.channelId, userId: msg.targetUserId });
        break;
      }

      case 'demote_admin': {
        if (!userId) break;
        const ch = channels.get(msg.channelId);
        if (!ch || ch.ownerId !== userId) { send({ type:'error', text:'Только владелец может снимать администраторов' }); break; }
        if (ch.admins) ch.admins.delete(msg.targetUserId);
        scheduleSave();
        const updatedCh2 = sanitizeChannel(ch);
        for (const mid of ch.members) {
          const u = users.get(mid);
          if (u && isSocketOpen(u.ws)) safeSend(u.ws, { type:'channel_updated', channel: updatedCh2 });
        }
        send({ type:'admin_demoted', channelId: msg.channelId, userId: msg.targetUserId });
        break;
      }

      case 'get_channel_members': {
        const ch = channels.get(msg.channelId);
        if (!canSeeChannel(ch, userId)) break;
        const memberList = [...ch.members].map(mid => {
          const u = users.get(mid);
          const isAdm = ch.admins ? ch.admins.has(mid) : false;
          return u ? { ...sanitizeUser(u), isOwner: mid === ch.ownerId, isAdmin: isAdm } : null;
        }).filter(Boolean);
        const fake = fakeMembers.get(msg.channelId) || [];
        send({ type:'channel_members', channelId: msg.channelId, members: [...memberList, ...fake] });
        break;
      }

      case 'create_channel': {
        if (!userId) break;
        const makePrivate = msg.isPrivate === true && (msg.channelType || msg.chType) === 'group';
        const wantUn = makePrivate ? '' : String(msg.username || '').replace(/^@/, '').toLowerCase();
        if (wantUn && [...channels.values()].some(c => (c.username || '').toLowerCase() === wantUn)) {
          send({ type:'create_channel_result', ok:false, error:'Юзернейм @' + wantUn + ' уже занят' });
          break;
        }
        const chId = genId();
        const requestedType = msg.channelType || msg.chType || 'channel';
        const memberIds = Array.isArray(msg.memberIds) ? msg.memberIds : [];
        const members = new Set([userId]);
        if (requestedType === 'group') {
          for (const memberId of memberIds) {
            if (users.has(memberId)) members.add(memberId);
          }
        }
        const newCh = {
          id: chId, name: msg.name, username: makePrivate ? '' : (msg.username || ''), type: requestedType, isPrivate: makePrivate,
          ownerId: userId, members, admins: new Set(), avatarUrl: null, avatarEmoji: msg.emoji || null,
          description: msg.description || '', extraSubscribers: 0, extraMembers: 0, createdAt: Date.now(),
        };
        channels.set(chId, newCh);
        scheduleSave();
        const sanitizedChannel = sanitizeChannel(newCh);
        // New client event format
        send({ type:'create_channel_result', ok:true, channel: sanitizedChannel });
        // Backward compatibility with older clients
        send({ type:'channel_created', channel: sanitizedChannel });

        // Notify invited users (for groups/channels created with predefined members)
        for (const memberId of newCh.members) {
          if (memberId === userId) continue;
          const member = users.get(memberId);
          if (!member || !isSocketOpen(member.ws)) continue;
          safeSend(member.ws, {
            type: newCh.type === 'group' ? 'added_to_group' : 'added_to_channel',
            channel: sanitizedChannel,
            addedBy: sanitizeUser(users.get(userId)),
          });
        }
        break;
      }

      case 'join_channel': {
        if (!userId) break;
        const ch = channels.get(msg.channelId);
        if (!ch) break;
        // В частную группу можно попасть, только если добавит владелец или админ
        if (ch.isPrivate && !ch.members.has(userId)) {
          send({ type:'join_result', ok:false, channelId: ch.id, error:'Это частная группа' });
          break;
        }
        ch.members.add(userId);
        scheduleSave();
        const sanitized = sanitizeChannel(ch);
        // New client event format
        send({ type:'join_result', ok:true, channel: sanitized });
        // Backward compatibility with older clients
        send({ type:'channel_joined', channel: sanitized });

        // Notify other members about new participant in groups
        if (ch.type === 'group') {
          for (const mid of ch.members) {
            if (mid === userId) continue;
            const u = users.get(mid);
            if (u && isSocketOpen(u.ws)) {
              safeSend(u.ws, { type:'group_member_joined', channelId: ch.id, channel: sanitized, userId });
            }
          }
        }
        break;
      }

      case 'leave_channel': {
        if (!userId) break;
        const ch = channels.get(msg.channelId);
        if (!ch) { send({ type:'leave_result', ok:false, channelId: msg.channelId }); break; }
        ch.members.delete(userId);
        scheduleSave();
        send({ type:'leave_result', ok:true, channelId: msg.channelId });
        break;
      }

      case 'add_members': {
        if (!userId) break;
        const ch = channels.get(msg.channelId);
        if (!ch) break;
        const isOwnerAM = ch.ownerId === userId;
        const isAdminAM = ch.admins && ch.admins.has(userId);
        if (!isOwnerAM && !isAdminAM) {
          send({ type:'error', text:'Только владелец или администратор может добавлять участников' });
          break;
        }

        const memberIds = Array.isArray(msg.memberIds) ? msg.memberIds : [];
        const botIds = new Set(Object.values(BOTS).map(b => b.id));
        // Separate bots from users
        const addingBots = memberIds.filter(id => botIds.has(id));
        const addingUsers = memberIds.filter(id => !botIds.has(id));
        // For channels: only allow bots (not regular users unless owner)
        const finalIds = ch.type === 'group' ? memberIds : addingBots;
        let changed = false;
        for (const memberId of finalIds) {
          // Accept both real users and bots
          if (!users.has(memberId) && !botIds.has(memberId)) continue;
          if (!ch.members.has(memberId)) {
            ch.members.add(memberId);
            changed = true;
          }
        }
        if (changed) scheduleSave();
        const sanitized = sanitizeChannel(ch);
        send({ type:'members_added', channelId: msg.channelId, channel: sanitized });

        // Notify newly added users and current members
        const adder = sanitizeUser(users.get(userId));
        for (const memberId of finalIds) {
          if (memberId === userId) continue;
          const u = users.get(memberId);
          if (u && isSocketOpen(u.ws)) {
            safeSend(u.ws, { type:'added_to_group', channel: sanitized, addedBy: adder });
          }
        }
        for (const mid of ch.members) {
          if (mid === userId) continue;
          const u = users.get(mid);
          if (u && isSocketOpen(u.ws)) {
            safeSend(u.ws, { type:'group_member_joined', channelId: ch.id, channel: sanitized });
          }
        }
        break;
      }

      case 'end_giveaway': {
        if (!userId) break;
        const gw = giveaways.get(msg.giveawayId);
        if (!gw || gw.ended) break;
        const ch = channels.get(gw.channelId);
        if (!ch || (ch.ownerId !== userId && !(ch.admins && ch.admins.has(userId)))) break;
        // Pick random winners from participants
        const pool = [...gw.participants];
        const shuffled = pool.sort(() => Math.random() - 0.5);
        const winners = shuffled.slice(0, Math.min(gw.winnersCount, shuffled.length));
        gw.ended = true;
        gw.winners = winners;
        scheduleSave();
        // Build winner names
        const winnerNames = winners.map(wid => users.get(wid)?.name || 'Пользователь');
        // Update giveaway message in channel
        const key = 'ch_' + gw.channelId;
        const msgs = messages.get(key) || [];
        const gwMsg = msgs.find(m => m.id === gw.msgId);
        if (gwMsg) { gwMsg.giveaway = { ...gwMsg.giveaway, ended: true, winners, winnerNames, participantCount: pool.length }; }
        scheduleSave();
        for (const mid of ch.members) {
          const u = users.get(mid);
          if (u && isSocketOpen(u.ws)) safeSend(u.ws, { type:'giveaway_ended', giveawayId: gw.id, channelId: gw.channelId, winners, winnerNames, participantCount: pool.length });
        }
        break;
      }

      case 'join_giveaway': {
        if (!userId) break;
        const gw = giveaways.get(msg.giveawayId);
        if (!gw) { send({ type:'giveaway_error', text:'Розыгрыш не найден' }); break; }
        if (gw.ended) { send({ type:'giveaway_error', text:'Розыгрыш уже завершён' }); break; }
        const ch = channels.get(gw.channelId);
        // Check if user is a member of the channel
        if (!ch || !ch.members.has(userId)) {
          send({ type:'giveaway_error', text:'Вы должны быть подписаны на канал чтобы участвовать!' });
          break;
        }
        gw.participants.add(userId);
        scheduleSave();
        send({ type:'giveaway_joined', giveawayId: msg.giveawayId, participantCount: gw.participants.size });
        break;
      }

      case 'send_channel_message': {
        if (!userId) break;
        const ch = channels.get(msg.channelId);
        if (!ch) break;
        if (!canSeeChannel(ch, userId)) {
          send({ type:'channel_post_denied', channelId: msg.channelId, msgId: msg.msgId || null, text:'Вы не участник этой группы.' });
          break;
        }
        // В канале (не группе) публикуют только владелец и администраторы — проверка на сервере
        if (ch.type === 'channel' && ch.ownerId !== userId && !(ch.admins && ch.admins.has(userId))) {
          send({ type:'channel_post_denied', channelId: ch.id, msgId: msg.msgId || null,
                 text:'Публиковать в этом канале могут только администраторы.' });
          break;
        }
        if (isForgedGiftText(msg.text)) break;
        const senderUser = users.get(userId);

        // Bot @random intercepts /giveaway command if it's a member of this channel
        if (msg.text && msg.text.trim().startsWith('/giveaway') &&
            ch.members && ch.members.has('bot_random') &&
            (ch.ownerId === userId || (ch.admins && ch.admins.has(userId)))) {
          const result = handleRandomizerBot(msg.text, userId, msg.channelId);
          if (result.giveaway) {
            const gw = {
              ...result.giveaway,
              participants: new Set(),
              ended: false, winners: [],
              msgId: null,
            };
            giveaways.set(gw.id, gw);
            scheduleSave();
            // Post giveaway message to channel as bot_random
            const gwMsgId = genId();
            gw.msgId = gwMsgId;
            const gwMsg = {
              id: gwMsgId, channelId: msg.channelId,
              from: 'bot_random', fromName: 'Randomizer Bot',
              fromInitials: 'RB', fromColor: '#8e44ad', fromAvatarUrl: null,
              text: '', time: timeNow(), ts: Date.now(),
              isPost: ch.type === 'channel',
              giveaway: { id: gw.id, prize: gw.prize, winnersCount: gw.winnersCount, endDateStr: gw.endDateStr, participantCount: 0, ended: false },
            };
            const key2 = 'ch_' + msg.channelId;
            if (!messages.has(key2)) messages.set(key2, []);
            messages.get(key2).push(gwMsg);
            scheduleSave();
            for (const mid of ch.members) {
              const u = users.get(mid);
              if (u && isSocketOpen(u.ws)) safeSend(u.ws, { type:'channel_message', channelId: msg.channelId, message: gwMsg });
            }
          } else if (result.text) {
            // Error reply from bot — send as private to user
            const errMsg = botReply('bot_random', result.text);
            send({ type:'message', chatWith:'bot_random', message:errMsg });
          }
          break;
        }

        const messageId = (typeof msg.msgId === 'string' && msg.msgId.trim()) ? msg.msgId.trim() : genId();
        const msgTs = Number.isFinite(Number(msg.ts)) ? Number(msg.ts) : Date.now();
        const newMsg = {
          id: messageId, channelId: msg.channelId, from: userId,
          fromName: senderUser?.name || 'Пользователь',
          fromInitials: senderUser?.initials || '?',
          fromColor: senderUser?.color || '#888',
          fromAvatarUrl: senderUser?.avatarUrl || null,
          text: msg.text, time: timeNow(), ts: msgTs,
          isPost: ch.type === 'channel',
        };
        const chFwd = cleanFwd(msg.fwd);
        if (chFwd) newMsg.fwd = chFwd;
        const key = 'ch_' + msg.channelId;
        if (!messages.has(key)) messages.set(key, []);
        messages.get(key).push(newMsg);
        scheduleSave();
        // Deliver to all members
        for (const mid of ch.members) {
          const u = users.get(mid);
          if (u && isSocketOpen(u.ws)) safeSend(u.ws, { type:'channel_message', channelId: msg.channelId, message: newMsg });
          if (mid !== userId) pushNotify(mid, pushItemFor(mid, ch.id, newMsg, ch));
        }
        break;
      }

      case 'edit_channel':
      case 'update_channel': {
        if (!userId) break;
        const ch = channels.get(msg.channelId);
        if (!ch || ch.ownerId !== userId) break;
        if (msg.name) ch.name = msg.name;
        if (msg.username !== undefined && !ch.isPrivate) ch.username = msg.username;
        if (msg.description !== undefined) ch.description = msg.description;
        if (msg.avatarUrl !== undefined) ch.avatarUrl = msg.avatarUrl;
        if (msg.avatarEmoji !== undefined) ch.avatarEmoji = msg.avatarEmoji;
        scheduleSave();
        const updated = sanitizeChannel(ch);
        // Notify all members
        for (const mid of ch.members) {
          const u = users.get(mid);
          if (u && isSocketOpen(u.ws)) safeSend(u.ws, { type:'channel_updated', channel: updated });
        }
        break;
      }

      case 'delete_channel': {
        if (!userId) break;
        const ch = channels.get(msg.channelId);
        if (!ch || ch.ownerId !== userId) {
          send({ type:'delete_channel_result', ok:false, channelId: msg.channelId, error:'Нет прав для удаления' });
          break;
        }

        const removedChannelId = ch.id;
        const membersToNotify = [...ch.members];
        channels.delete(removedChannelId);
        messages.delete('ch_' + removedChannelId);
        fakeMembers.delete(removedChannelId);
        scheduleSave();

        send({ type:'delete_channel_result', ok:true, channelId: removedChannelId });
        for (const mid of membersToNotify) {
          const u = users.get(mid);
          if (u && isSocketOpen(u.ws)) {
            safeSend(u.ws, { type:'channel_deleted', channelId: removedChannelId });
          }
        }
        break;
      }

      case 'update_avatar': {
        if (!userId) break;
        const u = users.get(userId);
        if (u) { u.avatarUrl = msg.avatarUrl || null; scheduleSave(); }
        broadcastAll(userId, { type:'user_avatar_updated', userId, avatarUrl: msg.avatarUrl || null });
        break;
      }

      case 'update_name': {
        if (!userId) break;
        const u = users.get(userId);
        if (u) {
          u.name = msg.name; u.initials = msg.initials;
          scheduleSave();
          send({ type:'name_updated', name:u.name, initials:u.initials });
          broadcastAll(userId, { type:'user_profile_updated', userId, name:u.name, initials:u.initials, avatarUrl:u.avatarUrl||null, username:u.username||null, wornNft:u.wornNft||null });
        }
        break;
      }

      case 'check_username': {
        if (!userId) break;
        const uname = (msg.username || '').toLowerCase().trim();
        if (!uname || uname.length < 5) { send({ type:'username_taken', reason:'too_short', username: uname || null }); break; }
        let isTaken = false;
        // Check against users
        for (const [uid, u] of users) {
          if (uid !== userId && u.username && u.username.toLowerCase() === uname) {
            isTaken = true;
            break;
          }
        }
        // Check against channels
        if (!isTaken) {
          for (const ch of channels.values()) {
            if (ch.username && ch.username.toLowerCase() === uname) {
              isTaken = true;
              break;
            }
          }
        }
        // Check against premium usernames of all users
        if (!isTaken) {
          isTaken = isPremiumUsernameTaken(uname, userId);
        }
        if (isTaken) send({ type:'username_taken', username: uname });
        else send({ type:'username_available', username: uname });
        break;
      }

      case 'set_username': {
        if (!userId) break;
        const u = users.get(userId);
        if (!u) break;
        const newUname = msg.username || null;
        if (newUname) {
          const lower = newUname.toLowerCase();
          // Check regular usernames
          let taken = false;
          for (const [uid, ru] of users) {
            if (uid !== userId && ru.username && ru.username.toLowerCase() === lower) { taken = true; break; }
          }
          // Check channel usernames
          if (!taken) for (const ch of channels.values()) {
            if (ch.username && ch.username.toLowerCase() === lower) { taken = true; break; }
          }
          // Check premium usernames
          if (!taken) taken = isPremiumUsernameTaken(lower, userId);
          if (taken) { send({ type:'username_taken', username: newUname }); break; }
        }
        u.username = newUname;
        scheduleSave();
        send({ type:'profile_updated', username: u.username });
        broadcastAll(userId, { type:'user_profile_updated', userId, name:u.name, initials:u.initials, avatarUrl:u.avatarUrl||null, username:u.username||null, wornNft:u.wornNft||null });
        break;
      }

      case 'send_message': {
        if (!userId) break;
        const toId = msg.toId;
        const senderUser = users.get(userId);
        const now = timeNow();
        const messageId = (typeof msg.msgId === 'string' && msg.msgId.trim()) ? msg.msgId.trim() : genId();
        const msgTs = Number.isFinite(Number(msg.ts)) ? Number(msg.ts) : Date.now();
        const newMsg = { id:messageId, from:userId, text:msg.text, time:now, ts:msgTs };
        const fwdInfo = cleanFwd(msg.fwd);
        if (fwdInfo) newMsg.fwd = fwdInfo;

        if (msg.isGift) {
          // Цену, название и наличие определяет сервер; звёзды списываются до доставки
          let gReq = null;
          try { gReq = JSON.parse(msg.text); } catch (e) {}
          const gDef = gReq && gReq.isGift === true ? GIFT_DEFS.find(g => g.id === gReq.giftId) : null;
          const giftFail = text => send({ ...starsSyncMsg(userId), type:'gift_failed', msgId:messageId, toId, text, refund: gDef ? gDef.price : 0 });
          if (!gDef) { giftFail('Подарок не найден'); break; }
          if (!users.has(toId)) { giftFail('Получатель не найден'); break; }
          const isBotAdmin = nethgramAdminUsers.has(userId);
          if (gDef.adminOnly && !isBotAdmin) { giftFail('Этот подарок недоступен'); break; }
          if (globalSoldOut && !isBotAdmin) { giftFail('Магазин временно закрыт'); break; }
          const gStock = giftStock.get(gDef.id);
          if (gStock !== null && gStock !== undefined && gStock <= 0) { giftFail('Подарок распродан!'); break; }
          if (!trySpendStars(userId, gDef.price)) { giftFail('Недостаточно звёзд'); break; }
          gReq.giftName = gDef.name;
          gReq.giftPrice = gDef.price;
          gReq.fromName = senderUser?.name || 'Пользователь';
          gReq.message = String(gReq.message || '').slice(0, 500);
          newMsg.text = JSON.stringify(gReq);
          send(starsSyncMsg(userId));
        } else if (isForgedGiftText(msg.text)) {
          break;
        }

        if (toId === 'bot_random') {
          const key = chatKey(userId, 'bot_random');
          if (!messages.has(key)) messages.set(key, []);
          const userMsg = { id:messageId, from:userId, to:'bot_random', text:msg.text, time:timeNow(), ts:Date.now() };
          messages.get(key).push(userMsg);
          send({ type:'message', chatWith:'bot_random', message:userMsg });
          const result = handleRandomizerBot(msg.text, userId, null);
          if (result.text) {
            const reply = botReply('bot_random', result.text);
            messages.get(key).push(reply);
            scheduleSave();
            send({ type:'message', chatWith:'bot_random', message:reply });
          }
          break;
        }

        if (toId === 'bot_simpson') {
          const key = chatKey(userId, 'bot_simpson');
          if (!messages.has(key)) messages.set(key, []);
          messages.get(key).push(newMsg);
          setTimeout(() => {
            const reply = botReply('bot_simpson', handleSimpson(msg.text));
            messages.get(key).push(reply);
            send({ type:'message', chatWith:'bot_simpson', message:reply });
          }, 900);
          break;
        }

        if (toId === 'bot_nethgram') {
          const key = chatKey(userId, 'bot_nethgram');
          if (!messages.has(key)) messages.set(key, []);
          messages.get(key).push(newMsg);
          setTimeout(() => {
            const result = handleNethgramBot(msg.text, userId, userAdminBotAuthorized);
            if (result.admin) { userAdminBotAuthorized = true; }
            if (result.welcome) {
              const replyText = result.text.replace('{NAME}', senderUser?.name || '');
              const reply = botReply('bot_nethgram', replyText);
              messages.get(key).push(reply);
              send({ type:'message', chatWith:'bot_nethgram', message:reply });
              return;
            }
            const reply = botReply('bot_nethgram', result.text);
            messages.get(key).push(reply);
            send({ type:'message', chatWith:'bot_nethgram', message:reply });

            if (result.unlimStars) {
              send({ type:'stars_unlim', amount: result.unlimStars });
              const cur = userStars.get(userId) || 0;
              userStars.set(userId, cur + result.unlimStars);
              scheduleSave();
            }
            if (result.infiniteStars) {
              userStars.set(userId, UNLIMITED_STARS);
              scheduleSave();
              send({ type:'stars_infinite' });
            }
            if (result.giveStars) {
              const gs = result.giveStars;
              const newBal = (userStars.get(gs.toId) || 0) + gs.amount;
              userStars.set(gs.toId, newBal);
              scheduleSave();
              const tu = users.get(gs.toId);
              if (tu && isSocketOpen(tu.ws)) {
                safeSend(tu.ws, { type:'stars_gifted', amount: gs.amount, balance: newBal, fromName: 'Nethgram Bot' });
              }
            }
            if (result.setStars !== undefined) {
              userStars.set(userId, result.setStars);
              scheduleSave();
              send({ type:'stars_set', balance: result.setStars });
            }
            if (result.setPhone) {
              const u = users.get(userId);
              if (u) {
                u.phone = result.setPhone;
                scheduleSave();
                send({ type:'phone_changed', phone: result.setPhone });
              }
            }
            if (result.broadcast) {
              const broadText = result.broadcast;
              for (const [uid, u] of users) {
                const bKey = chatKey(uid, 'bot_nethgram');
                if (!messages.has(bKey)) messages.set(bKey, []);
                const bMsg = botReply('bot_nethgram', '📢 Сообщение от Nethgram:\n\n' + broadText);
                messages.get(bKey).push(bMsg);
                if (isSocketOpen(u.ws)) {
                  safeSend(u.ws, { type:'message', chatWith:'bot_nethgram', message:bMsg });
                  safeSend(u.ws, { type:'broadcast_toast', text:broadText });
                }
                pushNotify(uid, { id:bMsg.id, chatId:'bot_nethgram', title:'Nethgram', text:broadText, ts:bMsg.ts });
              }
            }
            if (result.subChannel) {
              const ch = [...channels.values()].find(c => c.username && c.username.toLowerCase() === result.subChannel.toLowerCase());
              if (ch) {
                ch.extraSubscribers = (ch.extraSubscribers || 0) + result.subAmount;
                scheduleSave();
                broadcast({ type:'channel_updated', channel: sanitizeChannel(ch) });
              }
            }
            if (result.autosendGifts) {
              const ag = result.autosendGifts;
              if (!userGifts.has(userId)) userGifts.set(userId, []);
              for (let i = 0; i < ag.count; i++) {
                const entry = {
                  giftId: ag.giftId, giftName: ag.giftName, giftPrice: ag.giftPrice,
                  fromId: 'bot_nethgram', fromName: 'Nethgram Bot', msg: '',
                  ts: Date.now() + i,
                };
                userGifts.get(userId).push(entry);
                send({ type:'gift_delivered', toId: userId, gift: entry });
              }
              scheduleSave();
            }
            if (result.membBoost) {
              const mb = result.membBoost;
              const ch = channels.get(mb.channelId);
              if (ch) {
                if (!fakeMembers.has(mb.channelId)) fakeMembers.set(mb.channelId, []);
                const existing = fakeMembers.get(mb.channelId);
                const FAKE_COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e'];
                for (let i = 0; i < mb.count; i++) {
                  const initials = (mb.botName || 'N+').substring(0, 2).toUpperCase();
                  existing.push({
                    id: 'fake_' + genId(), name: (mb.botName || 'NAKRUTKA') + ' +' + mb.count,
                    initials, color: FAKE_COLORS[i % FAKE_COLORS.length], isBot: true,
                  });
                  if (i >= 99) break; // max display 100 per call
                }
                ch.extraMembers = (ch.extraMembers || 0) + mb.count;
                scheduleSave();
                broadcast({ type:'channel_updated', channel: sanitizeChannel(ch) });
              }
            }
            if (result.verifyUser) {
              const u2 = users.get(userId);
              if (u2) {
                u2.verifiedOrg = result.verifyUser.orgName;
                scheduleSave();
                send({ type: 'profile_verified', verifiedOrg: u2.verifiedOrg });
                broadcastAll(userId, { type: 'user_profile_updated', userId, name: u2.name, initials: u2.initials, avatarUrl: u2.avatarUrl||null, username: u2.username||null, wornNft: u2.wornNft||null, verifiedOrg: u2.verifiedOrg });
              }
            }
            if (result.addPremiumUsername) {
              const { username, price } = result.addPremiumUsername;
              const lower = username.toLowerCase();
              // Uniqueness check across all users, channels, and premium usernames
              let alreadyTaken = false;
              for (const [uid, u] of users) {
                if (u.username && u.username.toLowerCase() === lower) { alreadyTaken = true; break; }
              }
              if (!alreadyTaken) for (const ch of channels.values()) {
                if (ch.username && ch.username.toLowerCase() === lower) { alreadyTaken = true; break; }
              }
              if (!alreadyTaken) alreadyTaken = isPremiumUsernameTaken(lower, userId);
              if (alreadyTaken) {
                const errReply = botReply('bot_nethgram', '❌ Юзернейм @' + username + ' уже занят другим пользователем.');
                messages.get(chatKey(userId, 'bot_nethgram'))?.push(errReply);
                send({ type:'message', chatWith:'bot_nethgram', message:errReply });
              } else {
                if (!premiumUsernames.has(userId)) premiumUsernames.set(userId, []);
                premiumUsernames.get(userId).push({ username, price, grantedAt: Date.now() });
                scheduleSave();
                send({ type:'premium_username_added', username, price, grantedAt: Date.now() });
              }
            }
            if (result.setSoldOut !== undefined) {
              globalSoldOut = result.setSoldOut;
              scheduleSave();
              broadcast({ type:'global_sold_out', value: globalSoldOut });
            }
            if (result.dupeNfts && result.dupeNfts.length) {
              for (const nft of result.dupeNfts) {
                send({ type:'gift_delivered', toId: userId, gift: nft });
              }
            }
          }, 1000);
          break;
        }

        // Real user message
        const key = chatKey(userId, toId);
        if (!messages.has(key)) messages.set(key, []);
        messages.get(key).push(newMsg);

        if (msg.isGift) {
          try {
            const gData = JSON.parse(newMsg.text);
            const giftId = gData.giftId;
            // Deduct stock
            if (giftStock.has(giftId)) {
              const curStock = giftStock.get(giftId);
              if (curStock !== null && curStock <= 0) {
                send({ type:'error', text:'Подарок распродан!' }); break;
              }
              if (curStock !== null) {
                giftStock.set(giftId, curStock - 1);
                send({ type:'stock_update', giftId, stock: curStock - 1 });
              }
            }
            const entry = {
              giftId, giftName: gData.giftName, giftPrice: gData.giftPrice,
              fromId: userId, fromName: senderUser?.name || 'Пользователь',
              msg: gData.message || '', ts: newMsg.ts,
            };
            if (!userGifts.has(toId)) userGifts.set(toId, []);
            pushGiftUnique(userGifts.get(toId), entry);
            scheduleSave();

            // Realtime update for gifts/profile state
            const payload = { type:'gift_delivered', toId, gift:entry };
            send(payload);

            // Realtime chat message delivery (same behavior as regular messages)
            const recipient = users.get(toId);
            if (toId !== userId && recipient && isSocketOpen(recipient.ws)) {
              safeSend(recipient.ws, { type:'message', chatWith:userId, message: {...newMsg, fromName: senderUser?.name} });
              safeSend(recipient.ws, payload);
              safeSend(recipient.ws, { type:'new_message_notify', fromId:userId, fromName:senderUser?.name, text:'🎁 ' + (gData.giftName || 'Подарок') });
            }
            if (toId !== userId) pushNotify(toId, pushItemFor(toId, userId, newMsg));
          } catch(e) {}
          break;
        }

        // Normal message — deliver to recipient
        const recipient = users.get(toId);
        if (recipient && isSocketOpen(recipient.ws)) {
          safeSend(recipient.ws, { type:'message', chatWith:userId, message: {...newMsg, fromName: senderUser?.name} });
          safeSend(recipient.ws, { type:'new_message_notify', fromId:userId, fromName:senderUser?.name, text:msg.text });
        }
        if (toId !== userId) pushNotify(toId, pushItemFor(toId, userId, newMsg));
        break;
      }

      case 'edit_message': {
        if (!userId) break;
        const ctx = findMsgCtx(userId, msg);
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        // Менять можно только своё текстовое сообщение (не фото/подарок/стикер)
        if (!ctx || ctx.m.from !== userId || !text || text.length > 4096 ||
            isJsonObjectText(ctx.m.text) || isJsonObjectText(text)) break;
        ctx.m.text = text; ctx.m.edited = true; ctx.m.editedAt = Date.now();
        scheduleSave();
        notifyMsgChange(userId, ctx, { type:'message_edited', msgId: ctx.m.id, text, edited: true });
        break;
      }

      case 'delete_message': {
        if (!userId) break;
        const ctx = findMsgCtx(userId, msg);
        if (!ctx) break;
        // Личный чат: любое сообщение удаляется у обоих. Канал/группа: своё, а владелец и админы — любое
        if (ctx.ch && ctx.m.from !== userId && ctx.ch.ownerId !== userId && !(ctx.ch.admins && ctx.ch.admins.has(userId))) break;
        ctx.list.splice(ctx.idx, 1);
        scheduleSave();
        notifyMsgChange(userId, ctx, { type:'message_deleted', msgId: ctx.m.id });
        break;
      }

      case 'react_message': {
        if (!userId) break;
        const emoji = String(msg.emoji || '');
        if (!ALLOWED_REACTIONS.has(emoji)) break;
        const ctx = findMsgCtx(userId, msg);
        if (!ctx) break;
        // Одна реакция на пользователя; повторное нажатие той же — снимает её
        const r = ctx.m.reactions || {};
        const had = Array.isArray(r[emoji]) && r[emoji].includes(userId);
        for (const k of Object.keys(r)) { r[k] = (r[k] || []).filter(id => id !== userId); if (!r[k].length) delete r[k]; }
        if (!had) (r[emoji] = r[emoji] || []).push(userId);
        if (Object.keys(r).length) ctx.m.reactions = r; else delete ctx.m.reactions;
        scheduleSave();
        notifyMsgChange(userId, ctx, { type:'message_reactions', msgId: ctx.m.id, reactions: ctx.m.reactions || {} });
        break;
      }

      case 'typing': {
        const recipient = users.get(msg.toId);
        if (recipient && isSocketOpen(recipient.ws)) safeSend(recipient.ws, { type:'typing', fromId:userId });
        break;
      }

      case 'get_user_info': {
        // Return fresh full user data for contact profile rendering
        const targetUser = users.get(msg.userId);
        if (targetUser) {
          send({ type: 'user_info', user: sanitizeUser(targetUser) });
          // Always send premium usernames (even empty array so client clears stale data)
          send({ type:'user_premium_usernames', userId: msg.userId, usernames: premiumUsernames.get(msg.userId) || [] });
        }
        break;
      }

      case 'get_user_gifts': {
        const targetUid = msg.userId;
        const allG = userGifts.get(targetUid) || [];
        send({ type:'user_gifts', userId:targetUid, gifts: targetUid === userId ? allG : allG.filter(g => !g.hidden) });
        // Always send premium usernames unconditionally
        send({ type:'user_premium_usernames', userId:targetUid, usernames: premiumUsernames.get(targetUid) || [] });
        break;
      }

      case 'toggle_gift_hidden': {
        if (!userId) break;
        if (msg.channelId) {
          const hCh = channels.get(msg.channelId);
          if (!canManageChannelGifts(hCh, userId)) {
            send({ type:'channel_gift_failed', text:'Это могут только админы канала или группы' });
            break;
          }
          const hg = (channelGifts.get(hCh.id) || []).find(g => String(g.ts) === String(msg.giftTs));
          if (!hg) break;
          hg.hidden = !!msg.hidden;
          scheduleSave();
          syncChannelGifts(hCh);
          break;
        }
        const own = userGifts.get(userId) || [];
        const gi = own.find(g => String(g.ts) === String(msg.giftTs));
        if (!gi) break;
        gi.hidden = !!msg.hidden;
        scheduleSave();
        break;
      }

      case 'upgrade_to_nft': {
        if (!userId) break;
        const upCh = msg.channelId ? channels.get(msg.channelId) : null;
        const upFail = text => send({ type:'channel_gift_failed', text, balance: starsOf(userId) });
        if (msg.channelId && !canManageChannelGifts(upCh, userId)) { upFail('Улучшать подарки могут только админы канала или группы'); break; }
        const gifts = upCh ? (channelGifts.get(upCh.id) || []) : (userGifts.get(userId) || []);
        const idx = gifts.findIndex(g => g.ts == msg.giftTs && !g.isNft);
        if (idx === -1) { upFail('Подарок не найден'); break; }
        const g = gifts[idx];
        if (upCh && !NFT_MODELS_BY_GIFT[g.giftId]) { upFail('Этот подарок нельзя улучшить'); break; }
        // Deduct stars (при улучшении подарка канала платит админ, который нажал кнопку)
        const upgradeCost = Math.ceil((g.giftPrice || 0) * 0.15);
        if (!trySpendStars(userId, upgradeCost)) { upFail('Недостаточно звёзд для улучшения!'); break; }
        send(starsSyncMsg(userId));
        // Deduct stock
        if (giftStock.has(g.giftId)) {
          const curStock = giftStock.get(g.giftId);
          if (curStock !== null && curStock > 0) giftStock.set(g.giftId, curStock - 1);
        }
        const models = NFT_MODELS_BY_GIFT[g.giftId] || NFT_MODELS_BY_GIFT.scared_cat;
        const model = models[Math.floor(Math.random() * models.length)];
        const gradient = NFT_GRADIENTS[Math.floor(Math.random() * NFT_GRADIENTS.length)];
        const prevCount = nftCounters.get(g.giftId) || 0;
        const nftNumber = prevCount + 1;
        nftCounters.set(g.giftId, nftNumber);
        const tagBase = (g.giftName || g.giftId).replace(/[^a-zA-Z0-9]/g, '');
        gifts[idx] = {
          ...g, isNft:true, nftModel:model.id, nftModelName:model.name,
          nftGradient:gradient.css, nftGradientName:gradient.name,
          nftSerial:'NFT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase(),
          nftNumber, nftTag:'#' + tagBase + nftNumber, nftOwnerId: upCh ? upCh.id : userId, nftOwnerChannel: !!upCh, nftTs:Date.now(),
        };
        scheduleSave();
        if (upCh) {
          syncChannelGifts(upCh);
          send({ type:'channel_nft_upgraded', channelId: upCh.id, gift: gifts[idx] });
        } else {
          send({ type:'nft_upgraded', gift:gifts[idx] });
        }
        break;
      }

      case 'transfer_nft': {
        if (!userId) break;
        const fromCh = msg.fromChannelId ? channels.get(msg.fromChannelId) : null;
        const tFail = text => msg.fromChannelId ? send({ type:'channel_gift_failed', text }) : send({ type:'error', text });
        if (msg.fromChannelId && !canManageChannelGifts(fromCh, userId)) { tFail('Передавать NFT могут только админы канала или группы'); break; }
        const srcGifts = fromCh ? (channelGifts.get(fromCh.id) || []) : (userGifts.get(userId) || []);
        const nftIdx = srcGifts.findIndex(g => String(g.ts) === String(msg.giftTs) && g.isNft);
        if (nftIdx === -1) { tFail('NFT не найден или вы не владелец'); break; }

        // Получатель: канал/группа (нужно быть участником) или пользователь
        const toCh = msg.toChannelId ? channels.get(msg.toChannelId) : null;
        if (msg.toChannelId && (!toCh || !toCh.members.has(userId))) { tFail('Канал или группа не найдены'); break; }
        if (toCh && fromCh && toCh.id === fromCh.id) { tFail('NFT уже находится в этом канале'); break; }
        const targetUser = toCh ? null : users.get(msg.toUserId);
        if (!toCh && (!targetUser || (!fromCh && msg.toUserId === userId))) { tFail('Пользователь не найден'); break; }

        const fromUser = users.get(userId);
        const srcName = fromCh ? fromCh.name : (fromUser?.name || 'Пользователь');
        const toId = toCh ? toCh.id : msg.toUserId;
        const nft = { ...srcGifts[nftIdx], nftOwnerId:toId, nftOwnerChannel:!!toCh,
                      nftTransferredFrom: fromCh ? fromCh.id : userId, nftTransferTs:Date.now(), hidden:false };
        const oldTs = nft.ts;
        srcGifts.splice(nftIdx, 1);

        // если NFT был надет у отправителя — снимаем
        if (!fromCh && fromUser && fromUser.wornNft && String(fromUser.wornNft.ts) === String(oldTs)) {
          fromUser.wornNft = null;
          broadcastAll(userId, { type:'user_profile_updated', userId, name:fromUser.name, initials:fromUser.initials,
            avatarUrl:fromUser.avatarUrl||null, username:fromUser.username||null, wornNft:null, nameBadge:fromUser.nameBadge||null });
        }

        if (toCh) {
          nft.fromId = userId; nft.fromName = srcName;
          if (!channelGifts.has(toCh.id)) channelGifts.set(toCh.id, []);
          pushGiftUnique(channelGifts.get(toCh.id), nft);
          for (const mid of toCh.members) {
            const u = users.get(mid);
            if (u && isSocketOpen(u.ws)) safeSend(u.ws, { type:'channel_gift_received', channelId: toCh.id, gift: nft });
          }
        } else {
          if (!userGifts.has(toId)) userGifts.set(toId, []);
          pushGiftUnique(userGifts.get(toId), nft);
          // сообщение о передаче в чате (кроме случая, когда админ забирает NFT канала себе)
          if (toId !== userId) {
            const tData = { isNftTransfer:true, giftId:nft.giftId, giftName:nft.giftName, giftPrice:nft.giftPrice,
              nftTs:nft.ts, nftTag:nft.nftTag, nftNumber:nft.nftNumber, nftSerial:nft.nftSerial, nftModel:nft.nftModel,
              nftModelName:nft.nftModelName, nftGradient:nft.nftGradient, nftGradientName:nft.nftGradientName,
              fromId:userId, fromName:srcName, toId, toName:targetUser.name };
            const tMsg = { id:genId(), from:userId, text:JSON.stringify(tData), time:timeNow(), ts:Date.now() };
            const tKey = chatKey(userId, toId);
            if (!messages.has(tKey)) messages.set(tKey, []);
            messages.get(tKey).push(tMsg);
            send({ type:'message', chatWith:toId, message:tMsg });
            if (isSocketOpen(targetUser.ws)) {
              safeSend(targetUser.ws, { type:'message', chatWith:userId, message:{ ...tMsg, fromName:fromUser?.name } });
              safeSend(targetUser.ws, { type:'new_message_notify', fromId:userId, fromName:fromUser?.name, text:'🎁 ' + (nft.giftName || 'NFT-подарок') });
            }
            pushNotify(toId, pushItemFor(toId, userId, tMsg));
          }
          if (isSocketOpen(targetUser.ws)) safeSend(targetUser.ws, { type:'nft_received', nft });
        }
        scheduleSave();

        if (fromCh) {
          syncChannelGifts(fromCh);
          send({ type:'channel_nft_transferred', channelId: fromCh.id, toName: toCh ? toCh.name : targetUser.name });
        } else {
          send({ type:'nft_transferred', toUserId: toCh ? null : toId, toChannelId: toCh ? toCh.id : null, giftTs: oldTs, nft });
        }
        break;
      }

      case 'claim_daily': {
        if (!userId) break;
        const lastClaim = dailyRewards.get(userId) || 0;
        if (Date.now() - lastClaim < DAILY_COOLDOWN_MS) { send({ ...starsSyncMsg(userId), denied:true }); break; }
        dailyRewards.set(userId, Date.now());
        if (starsOf(userId) < UNLIMITED_STARS) userStars.set(userId, starsOf(userId) + DAILY_REWARD);
        scheduleSave();
        send({ type:'daily_ok', amount: DAILY_REWARD, balance: starsOf(userId), lastDaily: dailyRewards.get(userId) });
        break;
      }

      case 'set_name_badge': {
        if (!userId) break;
        const u = users.get(userId);
        if (msg.nameBadge && !premiumUsers.has(userId)) {
          send({ ...premiumStateMsg(userId), denied:true });
          break;
        }
        if (u) {
          u.nameBadge = msg.nameBadge || null;
          scheduleSave();
          broadcastAll(userId, {
            type: 'user_profile_updated',
            userId, name: u.name, initials: u.initials,
            avatarUrl: u.avatarUrl||null, username: u.username||null,
            wornNft: u.wornNft||null,
            nameBadge: u.nameBadge || null,
          });
        }
        break;
      }

      case 'set_worn_nft': {
        if (!userId) break;
        const u = users.get(userId);
        if (u) {
          u.wornNft = msg.wornNft || null;
          scheduleSave();
          broadcastAll(userId, {
            type: 'user_profile_updated',
            userId,
            name: u.name,
            initials: u.initials,
            avatarUrl: u.avatarUrl||null,
            username: u.username||null,
            wornNft: u.wornNft||null,
            nameBadge: u.nameBadge||null,
          });
        }
        break;
      }

      case 'set_profile_bg': {
        if (!userId) break;
        const u = users.get(userId); if (!u) break;
        const bg = msg.profileBg ? String(msg.profileBg) : null;
        if (bg && !PROFILE_BG_IDS.has(bg)) { send({ type:'profile_bg_result', ok:false, profileBg:u.profileBg||null, text:'Такого фона нет' }); break; }
        // сбросить фон можно всегда, поставить градиент — только с подпиской
        if (bg && !premiumUsers.has(userId)) {
          send({ type:'profile_bg_result', ok:false, profileBg:u.profileBg||null, text:'Смена фона профиля доступна по подписке Premium' });
          break;
        }
        u.profileBg = bg;
        scheduleSave();
        send({ type:'profile_bg_result', ok:true, profileBg:bg });
        broadcastAll(userId, {
          type:'user_profile_updated', userId, name:u.name, initials:u.initials,
          avatarUrl:u.avatarUrl||null, username:u.username||null,
          wornNft:u.wornNft||null, nameBadge:u.nameBadge||null, profileBg:bg,
        });
        break;
      }

      case 'dev_delete_account': {
        // Only superUsers can trigger this
        if (!superUsers.has(userId)) { send({ type:'error', text:'Нет прав суперпользователя' }); break; }
        const delU = users.get(msg.targetUserId);
        if (!delU) { send({ type:'error', text:'Пользователь не найден' }); break; }
        if (nethgramAdminUsers.has(delU.id)) { send({ type:'error', text:'Нельзя удалить администратора' }); break; }
        const delId = delU.id;
        for (const ch of channels.values()) { ch.members.delete(delId); if (ch.admins) ch.admins.delete(delId); }
        for (const [key] of messages) { if (key.includes(delId)) messages.delete(key); }
        userGifts.delete(delId); userStars.delete(delId); premiumUsernames.delete(delId);
        releaseUserVelosipe(delId); premiumUsers.delete(delId);
        if (delU.ws && isSocketOpen(delU.ws)) {
          try { safeSend(delU.ws, { type:'account_deleted' }); } catch(e) {}
          setTimeout(() => { try { delU.ws.destroy(); } catch(e) {} }, 500);
        }
        users.delete(delId);
        scheduleSave();
        broadcastAll(delId, { type:'user_deleted', userId: delId });
        console.log(`\x1b[31m[DEV] Аккаунт "${delU.name}" (@${delU.username||'?'}) удалён суперпользователем\x1b[0m`);
        send({ type:'dev_action_done', action:'account_deleted', targetId: delId, targetName: delU.name });
        break;
      }

      case 'dev_delete_channel': {
        if (!superUsers.has(userId)) { send({ type:'error', text:'Нет прав суперпользователя' }); break; }
        const delCh = channels.get(msg.channelId);
        if (!delCh) { send({ type:'error', text:'Канал не найден' }); break; }
        const delChId = delCh.id;
        const delChMembers = [...delCh.members];
        channels.delete(delChId); messages.delete('ch_' + delChId);
        fakeMembers.delete(delChId); channelGifts.delete(delChId);
        scheduleSave();
        for (const mid of delChMembers) {
          const u = users.get(mid);
          if (u && isSocketOpen(u.ws)) safeSend(u.ws, { type:'channel_deleted', channelId: delChId });
        }
        console.log(`\x1b[31m[DEV] Канал "${delCh.name}" (@${delCh.username||'?'}) удалён суперпользователем\x1b[0m`);
        send({ type:'dev_action_done', action:'channel_deleted', targetId: delChId, targetName: delCh.name });
        break;
      }

      case 'gift_stock_update': {
        // Client-side only, ignore
        break;
      }

      case 'get_gift_stock': {
        const stockObj = {};
        for (const [id, stock] of giftStock) stockObj[id] = stock;
        send({ type:'my_chats', channels:[], users:[], giftStock: stockObj });
        break;
      }

      // ── CHANNEL GIFTS ──
      case 'send_channel_gift': {
        if (!userId) break;
        const giftId = msg.giftId;
        const giftDef = GIFT_DEFS.find(g => g.id === giftId);
        const chFail = text => send({ ...starsSyncMsg(userId), type:'gift_failed', text, refund: giftDef ? giftDef.price : 0 });
        const ch = channels.get(msg.channelId);
        if (!ch) { chFail('Канал не найден'); break; }
        if (!ch.members.has(userId)) { chFail('Вы не участник этого канала'); break; }
        if (!giftDef) { chFail('Подарок не найден'); break; }
        const isBotAdmin = nethgramAdminUsers.has(userId);
        if (giftDef.adminOnly && !isBotAdmin) { chFail('Этот подарок недоступен'); break; }
        if (globalSoldOut && !isBotAdmin) { chFail('Магазин временно закрыт'); break; }
        const curStock = giftStock.get(giftId);
        if (curStock !== null && curStock !== undefined && curStock <= 0) { chFail('Подарок распродан!'); break; }
        if (!trySpendStars(userId, giftDef.price)) { chFail('Недостаточно звёзд'); break; }
        if (curStock !== null && curStock !== undefined) {
          giftStock.set(giftId, curStock - 1);
          send({ type:'stock_update', giftId, stock: curStock - 1 });
        }
        send(starsSyncMsg(userId));

        const senderUser = users.get(userId);
        const entry = {
          giftId,
          giftName: giftDef.name,
          giftPrice: giftDef.price,
          fromId: userId,
          fromName: senderUser?.name || 'Пользователь',
          message: String(msg.message || '').slice(0, 500),
          ts: Date.now(),
        };

        if (!channelGifts.has(msg.channelId)) channelGifts.set(msg.channelId, []);
        pushGiftUnique(channelGifts.get(msg.channelId), entry);
        scheduleSave();

        // Notify all channel members
        const payload = { type:'channel_gift_received', channelId: msg.channelId, gift: entry };
        for (const mid of ch.members) {
          const u = users.get(mid);
          if (u && isSocketOpen(u.ws)) safeSend(u.ws, payload);
        }
        break;
      }

      case 'get_channel_gifts': {
        const giftsCh = channels.get(msg.channelId);
        send({ type:'channel_gifts', channelId: msg.channelId, gifts: visibleChannelGifts(giftsCh, userId) });
        break;
      }

      // ── VELO$IPE ECONOMY ──
      case 'get_velosipe_market': {
        if (!userId) break;
        send(velosipeSnapshot(userId, msg.period));
        break;
      }

      case 'get_velosipe_history': {
        if (!userId) break;
        const period = VLP_PERIODS[msg.period] ? msg.period : '1d';
        const target = msg.target === 'vlp' ? 'vlp' : msg.target;
        const series = target === 'vlp' ? velosipe.series : (assetsMarket.get(target) || {}).series;
        if (!series) break;
        const pts = seriesPoints(series, period);
        send({ type:'velosipe_history', target, period, points:decimate(pts, 240), change:periodChangeOf(pts) });
        break;
      }

      case 'buy_velosipe': {
        if (!userId) break;
        const want = toInt(msg.amount);
        if (!want) { send({ type:'velosipe_error', text:'Введите количество $VLP' }); break; }
        const rec = getUserVlp(userId);
        const left = VLP_DAILY_LIMIT - sharedVlpDaily();
        if (left <= 0) { send({ type:'velosipe_error', text:'Общий дневной лимит исчерпан. Он сбросится автоматически.' }); break; }
        if (want > left) { send({ type:'velosipe_error', text:`Общий дневной лимит — ${VLP_DAILY_LIMIT.toLocaleString('ru-RU')} $VLP. Сегодня осталось ${left.toLocaleString('ru-RU')} $VLP` }); break; }
        if (velosipe.available <= 0) { send({ type:'velosipe_error', text:'В резерве не осталось монет' }); break; }
        const n = Math.min(want, velosipe.available);
        const cost = Math.ceil(n * velosipe.rate - 1e-9);
        const stars = userStars.get(userId) || 0;
        if (stars < cost) { send({ type:'velosipe_error', text:`Недостаточно звёзд: нужно ${cost.toLocaleString('ru-RU')} ⭐` }); break; }
        trySpendStars(userId, cost);
        rec.balance += n; rec.boughtToday += n; rec.basis += cost;
        velosipe.dailyBought += n;
        velosipe.available -= n;
        const trade = { type:'buy', amount:n, rate:velosipe.rate, stars:cost };
        addTrade(userId, trade);
        scheduleSave();
        send({ ...velosipeSnapshot(userId, msg.period), type:'velosipe_trade_ok', kind:'buy', partial: n < want, trade });
        broadcastAll(userId, { type:'velosipe_limit', bought: velosipe.dailyBought, limit: VLP_DAILY_LIMIT });
        break;
      }

      case 'sell_velosipe': {
        if (!userId) break;
        const n = toInt(msg.amount), rec = getUserVlp(userId);
        if (!n) { send({ type:'velosipe_error', text:'Введите количество $VLP' }); break; }
        if (n > rec.balance) { send({ type:'velosipe_error', text:'У вас нет столько $VLP' }); break; }
        const payout = Math.floor(n * velosipe.rate);
        rec.basis = rec.balance > 0 ? rec.basis * (1 - n / rec.balance) : 0;
        rec.balance -= n;
        velosipe.available = Math.min(VLP_TOTAL_SUPPLY, velosipe.available + n);
        userStars.set(userId, (userStars.get(userId) || 0) + payout);
        const trade = { type:'sell', amount:n, rate:velosipe.rate, stars:payout };
        addTrade(userId, trade);
        scheduleSave();
        send({ ...velosipeSnapshot(userId, msg.period), type:'velosipe_trade_ok', kind:'sell', trade });
        break;
      }

      case 'invest_asset': {
        if (!userId) break;
        const def = assetDef(msg.assetId);
        if (!def) { send({ type:'velosipe_error', text:'Актив не найден' }); break; }
        const currency = msg.currency === 'vlp' ? 'vlp' : 'stars';
        const amount = toInt(msg.amount);
        if (!amount) { send({ type:'velosipe_error', text:'Введите сумму' }); break; }
        const a = assetsMarket.get(def.id);
        let basisShare = 0;
        if (currency === 'stars') {
          const stars = userStars.get(userId) || 0;
          if (stars < amount) { send({ type:'velosipe_error', text:'Недостаточно звёзд' }); break; }
          trySpendStars(userId, amount);
        } else {
          const rec = getUserVlp(userId);
          if (rec.balance < amount) { send({ type:'velosipe_error', text:'Недостаточно $VLP' }); break; }
          basisShare = rec.balance > 0 ? rec.basis * (amount / rec.balance) : 0;
          rec.basis -= basisShare; rec.balance -= amount;
        }
        const list = positionsOf(userId);
        let pos = list.find(p => p.assetId === def.id && p.currency === currency);
        if (!pos) { pos = { assetId:def.id, currency, units:0, cost:0, basis:0, ts:Date.now() }; list.push(pos); }
        pos.units += amount / a.rate; pos.cost += amount; pos.basis += basisShare;
        addTrade(userId, { type:'invest', assetId:def.id, assetName:def.name, icon:def.icon, currency, amount });
        scheduleSave();
        send({ ...velosipeSnapshot(userId, msg.period), type:'velosipe_trade_ok', kind:'invest' });
        break;
      }

      case 'sell_position': {
        if (!userId) break;
        const def = assetDef(msg.assetId);
        const currency = msg.currency === 'vlp' ? 'vlp' : 'stars';
        const list = positionsOf(userId);
        const idx = list.findIndex(p => p.assetId === msg.assetId && p.currency === currency);
        if (!def || idx < 0) { send({ type:'velosipe_error', text:'Позиция не найдена' }); break; }
        const pos = list[idx], rate = assetsMarket.get(def.id).rate, value = pos.units * rate;
        let f = msg.all ? 1 : Math.min(1, toInt(msg.amount) / Math.max(value, 1e-9));
        if (!(f > 0)) { send({ type:'velosipe_error', text:'Введите сумму' }); break; }
        if (f > 0.9999) f = 1;
        const unitsPart = f === 1 ? pos.units : pos.units * f;
        const costPart  = f === 1 ? pos.cost  : Math.min(pos.cost, Math.round(pos.cost * f));
        const basisPart = f === 1 ? pos.basis : pos.basis * f;
        let payout = Math.floor(unitsPart * rate);
        if (payout <= 0 && f < 1) { send({ type:'velosipe_error', text:'Слишком маленькая сумма' }); break; }
        if (currency === 'stars') {
          userStars.set(userId, (userStars.get(userId) || 0) + payout);
        } else {
          // прибыль/убыток в $VLP проходит через резерв — общий тираж остаётся ровно 500 000
          const delta = payout - costPart;
          if (delta > 0) { const take = Math.min(delta, velosipe.available); payout = costPart + take; velosipe.available -= take; }
          else velosipe.available = Math.min(VLP_TOTAL_SUPPLY, velosipe.available - delta);
          const rec = getUserVlp(userId); rec.balance += payout; rec.basis += basisPart;
        }
        if (f === 1) list.splice(idx, 1);
        else { pos.units -= unitsPart; pos.cost -= costPart; pos.basis -= basisPart; }
        addTrade(userId, { type:'divest', assetId:def.id, assetName:def.name, icon:def.icon, currency, amount:payout, pnl:payout - costPart });
        scheduleSave();
        send({ ...velosipeSnapshot(userId, msg.period), type:'velosipe_trade_ok', kind:'divest' });
        break;
      }
    }
  }
});

server.listen(PORT, () => {
  console.log('\n🚀 Nethgram сервер запущен!');
  console.log('📱 Открой в браузере: http://localhost:' + PORT);
  console.log('💻 Консольные команды: /setDev @юзернейм | /alogs | /help\n');
});

// ── CONSOLE REPL ──
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const cmd = line.trim();
  if (!cmd) return;

  // /help
  if (cmd === '/help') {
    console.log('\n📋 Консольные команды:');
    console.log('  /setDev @юзернейм  — назначить суперпользователя');
    console.log('  /unsetDev @юзернейм — снять суперпользователя');
    console.log('  /alogs             — показать лог авторизаций + включить реал-тайм');
    console.log('  /admins            — список текущих онлайн-админов');
    console.log('  /devlist           — список суперпользователей\n');
    return;
  }

  // /setDev @username
  if (cmd.startsWith('/setDev ')) {
    const uname = cmd.substring(8).trim().replace(/^@/, '').toLowerCase();
    const target = [...users.values()].find(u => u.username && u.username.toLowerCase() === uname);
    if (!target) { console.log('\x1b[31m❌ Пользователь @' + uname + ' не найден\x1b[0m'); return; }
    superUsers.add(target.id);
    // Notify client so their UI updates immediately
    if (target.ws && isSocketOpen(target.ws)) {
      safeSend(target.ws, { type:'user_info', user: sanitizeUser(target) });
    }
    console.log('\x1b[32m✅ @' + uname + ' (' + target.name + ') теперь суперпользователь\x1b[0m');
    return;
  }

  // /unsetDev @username
  if (cmd.startsWith('/unsetDev ')) {
    const uname = cmd.substring(10).trim().replace(/^@/, '').toLowerCase();
    const target = [...users.values()].find(u => u.username && u.username.toLowerCase() === uname);
    if (!target) { console.log('\x1b[31m❌ Пользователь @' + uname + ' не найден\x1b[0m'); return; }
    superUsers.delete(target.id);
    if (target.ws && isSocketOpen(target.ws)) {
      safeSend(target.ws, { type:'user_info', user: sanitizeUser(target) });
    }
    console.log('\x1b[33m🔻 @' + uname + ' (' + target.name + ') больше не суперпользователь\x1b[0m');
    return;
  }

  // /alogs — show admin auth logs + enable realtime
  if (cmd === '/alogs') {
    aLogsActive = !aLogsActive;
    if (adminAuthLogs.length === 0) {
      console.log('\n📋 Логи авторизаций пусты');
    } else {
      console.log('\n📋 Логи авторизаций администраторов:');
      adminAuthLogs.forEach((e, i) => {
        console.log('  ' + (i+1) + '. "' + e.name + '" (@' + e.username + ') — ' + e.ts);
      });
    }
    console.log(aLogsActive ? '\x1b[32m🔔 Реал-тайм логи включены\x1b[0m' : '\x1b[33m🔕 Реал-тайм логи выключены\x1b[0m');
    console.log('');
    return;
  }

  // /devlist — list super users
  if (cmd === '/devlist') {
    if (superUsers.size === 0) { console.log('\n👥 Суперпользователей нет\n'); return; }
    console.log('\n👥 Суперпользователи:');
    for (const uid of superUsers) {
      const u = users.get(uid);
      console.log('  • ' + (u ? u.name + ' (@' + (u.username||'?') + ')' : uid));
    }
    console.log('');
    return;
  }

  // /admins — list current admins
  if (cmd === '/admins') {
    if (nethgramAdminUsers.size === 0) { console.log('\n🔐 Нет авторизованных администраторов\n'); return; }
    console.log('\n🔐 Текущие администраторы:');
    let i = 1;
    for (const uid of nethgramAdminUsers) {
      const u = users.get(uid);
      console.log('  ' + i++ + '. ' + (u ? u.name + ' (@' + (u.username||'?') + ')' : uid));
    }
    console.log('');
    return;
  }

  console.log('\x1b[33m❓ Неизвестная команда. Напишите /help для списка команд.\x1b[0m');
});
