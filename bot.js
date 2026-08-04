
// =========================================================================
// AI Forex Signal Bot v13.1 - GitHub Actions Edition
// Platform: GitHub Actions (free, unlimited minutes on public repo)
// Strategy: Trend-following (15m + 1h EMA alignment)
// Expiry: 5 minutes | Score 7 trigger | 72% confidence threshold
// Updates: Fixed ADX threshold (10 instead of 15), added win rate tracking
// =========================================================================

const fs = require('fs');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = path.join(__dirname, 'state.json');
const TRACKER_FILE = path.join(__dirname, 'tracker.json');

// Config
const CD_MS = 15 * 60 * 1000;        // Per-pair cooldown: 15 min
const SIG_MEM_MS = 25 * 60 * 1000;   // Signal memory: 25 min
const GLOBAL_CD_MS = 7 * 60 * 1000;  // Global cooldown: 7 min
const CONFIDENCE_THRESHOLD = 72;
const SCORE_TRIGGER = 7;
const ADX_THRESHOLD = 8; // Balanced for simplified ADX (real ADX ~20 equivalent)

// === WIN RATE TRACKER ===

function loadTracker() {
  try {
    if (fs.existsSync(TRACKER_FILE)) {
      return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
    }
  } catch (e) {}
  return { signals: [], wins: 0, losses: 0, total: 0 };
}

function saveTracker(tracker) {
  try {
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2));
  } catch (e) {
    console.error('Failed to save tracker:', e.message);
  }
}

function recordSignal(pair, dir, conf, mode) {
  const tracker = loadTracker();
  const sigId = Date.now();
  tracker.signals.push({
    id: sigId,
    pair, dir, conf, mode,
    sentAt: new Date().toISOString(),
    result: null  // 'WIN', 'LOSS', or null (not yet tracked)
  });
  // Keep only last 100 signals
  if (tracker.signals.length > 100) tracker.signals = tracker.signals.slice(-100);
  tracker.total = tracker.signals.length;
  saveTracker(tracker);
  return sigId;
}

// === STATE MANAGEMENT ===

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { cooldowns: {}, signals: {}, globalCd: 0 };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// === INDICATORS ===

function emaArr(c, p) {
  if (!c || c.length === 0) return [];
  const k = 2 / (p + 1);
  const r = [c[0]];
  for (let i = 1; i < c.length; i++) r.push(c[i] * k + r[i - 1] * (1 - k));
  return r;
}

function ema(c, p) {
  const arr = emaArr(c, p);
  return arr[arr.length - 1] || 0;
}

function rsi(c, p = 14) {
  if (c.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = c.length - p; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const al = l / p;
  return al === 0 ? 100 : 100 - 100 / (1 + (g / p) / al);
}

function macd(c) {
  if (c.length < 35) return { h: 0, line: 0, signal: 0 };
  const e12 = emaArr(c, 12), e26 = emaArr(c, 26);
  const ml = e12.map((v, i) => v - e26[i]);
  const sl = emaArr(ml, 9);
  return {
    h: ml[ml.length - 1] - sl[sl.length - 1],
    line: ml[ml.length - 1],
    signal: sl[sl.length - 1]
  };
}

function bollinger(c, p = 20, s = 2) {
  if (c.length < p) return { u: 0, m: 0, l: 0, w: 999 };
  const slice = c.slice(-p);
  const m = slice.reduce((a, b) => a + b, 0) / p;
  const variance = slice.reduce((s, x) => s + Math.pow(x - m, 2), 0) / p;
  const sd = Math.sqrt(variance);
  return { u: m + s * sd, m, l: m - s * sd, w: 2 * s * sd };
}

function stochastic(h, l, c, p = 14) {
  if (c.length < p) return { k: 50, d: 50 };
  const rh = Math.max(...h.slice(-p));
  const rl = Math.min(...l.slice(-p));
  const range = rh - rl;
  const k = range === 0 ? 50 : ((c[c.length - 1] - rl) / range) * 100;
  let kArr = [];
  for (let i = Math.max(p, c.length - 3); i < c.length; i++) {
    const start = Math.max(0, i - p + 1);
    const hi = Math.max(...h.slice(start, i + 1));
    const lo = Math.min(...l.slice(start, i + 1));
    const r = hi - lo;
    kArr.push(r === 0 ? 50 : ((c[i] - lo) / r) * 100);
  }
  const d = kArr.reduce((a, b) => a + b, 0) / kArr.length;
  return { k, d };
}

function atr(h, l, c, p = 14) {
  if (c.length < p + 1) return 0;
  let t = 0;
  for (let i = c.length - p; i < c.length; i++) {
    t += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return t / p;
}

function adx(h, l, c, p = 14) {
  if (c.length < p * 2) return 25;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let i = c.length - p; i < c.length; i++) {
    const upMove = h[i] - h[i - 1];
    const downMove = l[i - 1] - l[i];
    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;
    tr += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  if (tr === 0) return 0;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  const dx = Math.abs(plusDI - minusDI);
  return Math.min(100, dx);
}

function rangePos(c, lb = 20) {
  const slice = c.slice(-lb);
  const hi = Math.max(...slice), lo = Math.min(...slice);
  const range = hi - lo;
  if (range === 0) return { pos: 50, hi, lo };
  return { pos: ((c[c.length - 1] - lo) / range) * 100, hi, lo };
}

// === DATA FETCHING ===

async function fetchData(sym, interval) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=5d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return null;
    const d = await res.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators?.quote?.[0];
    if (!q) return null;
    const ts = result.timestamp || [];
    const o = [], h = [], l = [], c = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open[i] != null && q.close[i] != null) {
        o.push(q.open[i]);
        h.push(q.high[i] || q.close[i]);
        l.push(q.low[i] || q.close[i]);
        c.push(q.close[i]);
      }
    }
    return c.length >= 35 ? { o, h, l, c } : null;
  } catch (e) {
    console.error(`Fetch error ${sym} ${interval}: ${e.message}`);
    return null;
  }
}

// === MARKET MODE ===

function marketMode() {
  const now = new Date();
  const lagosTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const day = lagosTime.getDay();
  const hour = lagosTime.getHours();
  if (day === 6) return 'OTC';
  if (day === 0 && hour < 23) return 'OTC';
  if (day === 5 && hour >= 23) return 'OTC';
  return 'NORMAL';
}

function fmtTime(d) {
  return d.toLocaleTimeString('en-US', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: true });
}

// === ANALYSIS ===

function analyze(pair, d15, d1h) {
  if (!d15 || !d1h) return null;
  if (d15.c.length < 35 || d1h.c.length < 25) return null;

  const c = d15.c, h = d15.h, l = d15.l, o = d15.o;
  const c1h = d1h.c;
  const price = c[c.length - 1];

  // Indicators
  const r15 = rsi(c, 14);
  const st = stochastic(h, l, c, 14);
  const bands = bollinger(c, 20, 2);
  const mc = macd(c);
  const a = atr(h, l, c, 14);
  const ap = (a / price) * 100;
  const adxVal = adx(h, l, c, 14);
  const rp = rangePos(c, 20);

  // EMAs
  const e9 = ema(c, 9);
  const e21 = ema(c, 21);
  const e9_1h = ema(c1h, 9);
  const e21_1h = ema(c1h, 21);

  // Volatility filter
  if (ap < 0.02) return null;

  // Trend detection
  const trendUp = e9 > e21 && e9_1h > e21_1h;
  const trendDn = e9 < e21 && e9_1h < e21_1h;

  // ADX filter - lowered to 10 for simplified ADX calculation
  if (adxVal < ADX_THRESHOLD) return null; // Balanced ADX filter

  const lc = c[c.length - 1];
  const lo = o[o.length - 1];
  const pc = c[c.length - 2];
  const po = o[o.length - 2];

  let dir = null, sc = 0;
  const reasons = [];

  if (trendUp) {
    if (r15 >= 35 && r15 <= 60) {
      sc += 3; reasons.push('RSI pullback zone');
      if (st.k >= 15 && st.k <= 55) { sc += 2; reasons.push('Stoch pullback'); }
      if (mc.h > 0) { sc += 2; reasons.push('MACD bullish'); }
      if (lc > lo) { sc += 2; reasons.push('Bullish candle'); }
      if (price <= bands.m * 1.005) { sc += 1; reasons.push('Near BB mid'); }
      if (ap > 0.04) { sc += 1; reasons.push('Good volatility'); }
      if (adxVal > 25) { sc += 1; reasons.push('Strong trend (ADX)'); }
      if (rp.pos <= 40) { sc += 1; reasons.push('Range low entry'); }
      if (lc > lo && pc < po) { sc += 1; reasons.push('Reversal candle'); }
      if (sc >= SCORE_TRIGGER) dir = 'BUY';
    }
  } else if (trendDn) {
    if (r15 >= 40 && r15 <= 65) {
      sc += 3; reasons.push('RSI pullback zone');
      if (st.k >= 45 && st.k <= 85) { sc += 2; reasons.push('Stoch pullback'); }
      if (mc.h < 0) { sc += 2; reasons.push('MACD bearish'); }
      if (lc < lo) { sc += 2; reasons.push('Bearish candle'); }
      if (price >= bands.m * 0.995) { sc += 1; reasons.push('Near BB mid'); }
      if (ap > 0.04) { sc += 1; reasons.push('Good volatility'); }
      if (adxVal > 25) { sc += 1; reasons.push('Strong trend (ADX)'); }
      if (rp.pos >= 60) { sc += 1; reasons.push('Range high entry'); }
      if (lc < lo && pc > po) { sc += 1; reasons.push('Reversal candle'); }
      if (sc >= SCORE_TRIGGER) dir = 'SELL';
    }
  }

  if (!dir) return null;

  const conf = Math.min(95, 45 + sc * 4);
  if (conf < CONFIDENCE_THRESHOLD) return null;

  const mode = marketMode();
  const now = new Date();
  const entry = new Date(now.getTime() + 2 * 60000);
  const exit = new Date(entry.getTime() + 5 * 60000);

  return { pair, dir, conf, mode, entry, exit, score: sc, reasons, adx: adxVal };
}

// === TELEGRAM ===

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Missing Telegram credentials');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
    const data = await res.json();
    return data.ok === true;
  } catch (e) {
    console.error('Telegram send error:', e.message);
    return false;
  }
}

function formatSignal(s, sigId) {
  const emoji = s.dir === 'BUY' ? '🟢' : '🔴';
  const filled = Math.round(s.conf / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const entryTime = fmtTime(s.entry);
  const exitTime = fmtTime(s.exit);

  return `🔔 NEW SIGNAL!\n\n` +
    `💲 ${s.pair} [${s.mode}]\n` +
    `⏳ Timer: 5 minutes\n` +
    `➡️ Entry: ${entryTime}\n` +
    `${emoji} ${s.dir}\n` +
    `🚪 Exit: ${exitTime}\n` +
    `🎯 Confidence: ${s.conf.toFixed(0)}% ${bar}\n` +
    `📊 Score: ${s.score} | ADX: ${s.adx.toFixed(0)}\n` +
    `🆔 ID: ${sigId}`;
}

function formatDailyReport(tracker) {
  const total = tracker.signals.length;
  const wins = tracker.signals.filter(s => s.result === 'WIN').length;
  const losses = tracker.signals.filter(s => s.result === 'LOSS').length;
  const pending = tracker.signals.filter(s => s.result === null).length;
  const tracked = wins + losses;
  const winRate = tracked > 0 ? ((wins / tracked) * 100).toFixed(0) : 'N/A';

  // Last 10 signals
  const recent = tracker.signals.slice(-10).map(s => {
    const result = s.result === 'WIN' ? '✅' : s.result === 'LOSS' ? '❌' : '⏳';
    return `${result} ${s.pair} ${s.dir} ${s.conf.toFixed(0)}%`;
  }).join('\n');

  return `📊 DAILY WIN RATE REPORT\n\n` +
    `Total Signals: ${total}\n` +
    `✅ Wins: ${wins}\n` +
    `❌ Losses: ${losses}\n` +
    `⏳ Pending: ${pending}\n` +
    `🎯 Win Rate: ${winRate}${tracked > 0 ? '%' : ''}\n\n` +
    `Recent Signals:\n${recent || 'None yet'}`;
}

// === COOLDOWN CHECKS ===

function canSend(state, pair, dir) {
  const key = `${pair}_${dir}`;
  const lastSent = state.cooldowns[key];
  if (!lastSent) return true;
  return (Date.now() - lastSent) >= CD_MS;
}

function isRecentSignal(state, pair, dir, conf) {
  const key = `${pair}_${dir}`;
  const record = state.signals[key];
  if (!record) return false;
  const age = Date.now() - record.ts;
  if (age > SIG_MEM_MS) return false;
  if (conf >= record.conf + 15) return false;
  return true;
}

// === MAIN SCAN ===

const PAIRS = [
  ['EURUSD=X', 'EUR/USD'], ['GBPUSD=X', 'GBP/USD'], ['USDJPY=X', 'USD/JPY'],
  ['USDCHF=X', 'USD/CHF'], ['AUDUSD=X', 'AUD/USD'], ['USDCAD=X', 'USD/CAD'],
  ['NZDUSD=X', 'NZD/USD'], ['AUDNZD=X', 'AUD/NZD'], ['EURCHF=X', 'EUR/CHF'],
  ['CADCHF=X', 'CAD/CHF'], ['EURGBP=X', 'EUR/GBP'], ['EURJPY=X', 'EUR/JPY'],
  ['GBPJPY=X', 'GBP/JPY'], ['GBPCHF=X', 'GBP/CHF'], ['AUDJPY=X', 'AUD/JPY'],
  ['CADJPY=X', 'CAD/JPY'], ['NZDJPY=X', 'NZD/JPY'], ['EURAUD=X', 'EUR/AUD'],
  ['EURCAD=X', 'EUR/CAD'], ['CHFJPY=X', 'CHF/JPY']
];

async function runScan(mode) {
  const state = loadState();
  const mMode = marketMode();

  // --report mode: send win rate report
  if (mode === 'report') {
    const tracker = loadTracker();
    const ok = await sendTelegram(formatDailyReport(tracker));
    console.log(JSON.stringify({ reportSent: ok, totalSignals: tracker.signals.length }));
    return;
  }

  // --test mode: send test message
  if (mode === 'test') {
    const tracker = loadTracker();
    const msg = `🤖 Bot v13.1 ONLINE\n\n` +
      `Platform: GitHub Actions (free, unlimited)\n` +
      `IQ Option | Binary Options | 5-min trades\n` +
      `20 pairs | Mode: ${mMode}\n` +
      `Strategy: Trend Following + ADX\n` +
      `72% threshold | Score 7 trigger\n` +
      `ADX threshold: ${ADX_THRESHOLD}\n` +
      `7-min global cooldown | 15-min per-pair\n` +
      `Win rate tracking: ACTIVE\n` +
      `Signals tracked: ${tracker.signals.length}\n\n` +
      `Ready! ⚡`;
    const ok = await sendTelegram(msg);
    console.log(JSON.stringify({ testSent: ok, mode: mMode, pairs: 20, tracked: tracker.signals.length }));
    return;
  }

  // Normal scan mode
  if (state.globalCd && (Date.now() - state.globalCd) < GLOBAL_CD_MS) {
    const elapsed = Math.round((Date.now() - state.globalCd) / 60000);
    const remaining = Math.max(0, Math.round(GLOBAL_CD_MS / 60000 - elapsed));
    console.log(JSON.stringify({ sent: 0, reason: 'global_cooldown', remainingMin: remaining, mode: mMode }));
    saveState(state);
    return;
  }

  const signals = [];
  for (const [sym, name] of PAIRS) {
    const d15 = await fetchData(sym, '15m');
    const d1h = await fetchData(sym, '60m');
    const sig = analyze(name, d15, d1h);
    if (sig) {
      if (canSend(state, sig.pair, sig.dir) && !isRecentSignal(state, sig.pair, sig.dir, sig.conf)) {
        signals.push(sig);
      }
    }
  }

  if (signals.length === 0) {
    console.log(JSON.stringify({ sent: 0, candidates: 0, mode: mMode, ts: new Date().toISOString() }));
    saveState(state);
    return;
  }

  const buys = signals.filter(s => s.dir === 'BUY').sort((a, b) => b.conf - a.conf);
  const sells = signals.filter(s => s.dir === 'SELL').sort((a, b) => b.conf - a.conf);
  const top = [];
  if (buys[0]) top.push(buys[0]);
  if (sells[0]) top.push(sells[0]);
  if (top.length < 2 && buys[1]) top.push(buys[1]);
  if (top.length < 2 && sells[1]) top.push(sells[1]);

  let sent = 0;
  for (const s of top) {
    const sigId = recordSignal(s.pair, s.dir, s.conf, s.mode);
    const ok = await sendTelegram(formatSignal(s, sigId));
    if (ok) {
      const key = `${s.pair}_${s.dir}`;
      state.cooldowns[key] = Date.now();
      state.signals[key] = { ts: Date.now(), conf: s.conf };
      sent++;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (sent > 0) {
    state.globalCd = Date.now();
  }

  saveState(state);
  console.log(JSON.stringify({
    sent,
    candidates: signals.length,
    mode: mMode,
    strategy: 'trend-following',
    expiry: '5min',
    ts: new Date().toISOString()
  }));
}

// Run
const mode = process.argv.includes('--test') ? 'test'
           : process.argv.includes('--report') ? 'report'
           : 'scan';

runScan(mode).catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
