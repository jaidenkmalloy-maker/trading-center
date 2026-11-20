// ===== ENGINE PART 1: config, time, data, scanner, trade simulation =====
const TICK = 0.0005;
const DEFAULTS = {
  // account / Topstep rules (verify these against your Topstep account)
  start: 50000, maxLoss: 2000, profitTarget: 3000, dailyStop: 1000,
  consistencyPct: 55, minDays: 2, maxContracts: 10,
  // risk sizing
  maxRiskPerTrade: 300, riskFracOfBuffer: 0.15, bufferHaltPct: 10,
  // instrument (picked under Settings; these are the copper defaults)
  symbol: 'MHG', tick: 0.0005, dec: 4,
  // costs
  mult: 2500, fee: 0.5, slipTicks: 1,
  // clock (Central Time)
  entryCutoff: '14:30', flatTime: '15:10',
  // scanner (fib continuation)
  pivotLen: 5, minLeg: 0.05, zoneLo: 0.382, zoneHi: 0.618, stopLvl: 0.786,
  stopBuf: 0.003, tpMode: 'retest', minRR: 1.2, maxBars: 96,
  // backtester gate
  floorOverride: 0, strategies: null, minTP: 0.5, sessionOpen: '08:30', gate: 'enforce', minN: 20, z: 0, lookback: 150,
  // rules / performance
  maxTradesPerDay: 3, driftBand: 15, driftMinN: 20
};

// Contract details are my understanding of CME micro specs: verify before relying on dollar figures.
const INSTR = {
  MHG: { name: 'Micro Copper', tick: 0.0005, mult: 2500, dec: 4, minLeg: 0.05, stopBuf: 0.003, p0: 6.6 },
  MES: { name: 'Micro E-mini S&P 500', tick: 0.25, mult: 5, dec: 2, minLeg: 12, stopBuf: 1, p0: 6000 },
  MNQ: { name: 'Micro E-mini Nasdaq-100', tick: 0.25, mult: 2, dec: 2, minLeg: 50, stopBuf: 4, p0: 21000 },
  MGC: { name: 'Micro Gold', tick: 0.1, mult: 10, dec: 1, minLeg: 6, stopBuf: 0.5, p0: 4000 },
  MCL: { name: 'Micro WTI Crude', tick: 0.01, mult: 100, dec: 2, minLeg: 0.5, stopBuf: 0.03, p0: 60 }
};
function hm(s) { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; }
const _fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
function ctInfo(ms) {
  const p = {};
  for (const x of _fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  const mins = (+p.hour) * 60 + (+p.minute);
  const date = p.year + '-' + p.month + '-' + p.day;
  let day = date;   // trading day rolls at 5:00 pm CT
  if (mins >= 1020) day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) + 864e5).toISOString().slice(0, 10);
  return { date, mins, day, dow: p.weekday };
}
function opexInfo(day) {   // monthly options expiration is the third Friday; the trading day after it often has new walls
  const d = new Date(day + 'T12:00:00Z'), dow = d.getUTCDay(), dom = d.getUTCDate(), m = d.getUTCMonth() + 1;
  const opex = dow === 5 && dom >= 15 && dom <= 21, after = dow === 1 && dom >= 18 && dom <= 24;
  return { opex, quarterly: opex && m % 3 === 0, after };
}
function annotate(bars) { for (const b of bars) { const c = ctInfo(b.t); b.mins = c.mins; b.day = c.day; } return bars; }
const inFlat = (mins, c) => mins >= hm(c.flatTime) && mins < 1020;
const canEnter = (mins, c) => !(mins >= hm(c.entryCutoff) && mins < 1020);
const rt = x => Math.round(x / TICK) * TICK;
// Orders can only sit on valid ticks. Stops round away from entry and targets toward it, so rounding never flatters a trade.
const gridUp = (x, T) => +(Math.ceil(x / T - 1e-9) * T).toFixed(8);
const gridDn = (x, T) => +(Math.floor(x / T + 1e-9) * T).toFixed(8);

// ---- synthetic data (random, NOT real prices) ----
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function randn(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function genBars(n, seed, sym) {
  const I = INSTR[sym || 'MHG'] || INSTR.MHG, f = I.p0 / 6.6, rI = x => Math.round(x / I.tick) * I.tick;
  const r = rng(seed || 7), out = []; let t = Date.UTC(2026, 8, 1, 22, 0), p = 6.6, drift = 0, left = 0;
  while (out.length < n) {
    t += 900000;
    const c = ctInfo(t);
    const closed = c.dow === 'Sat' || (c.dow === 'Sun' && c.mins < 1020) || (c.dow === 'Fri' && c.mins >= 960) || (c.mins >= 960 && c.mins < 1020);
    if (closed) continue;
    if (left <= 0) { drift = (r() < 0.5 ? -1 : 1) * (r() < 0.25 ? 0 : 1) * 0.0012 * (0.5 + r()); left = 40 + Math.floor(r() * 100); }
    left--;
    if (p > 7.2 && drift > 0) drift = -drift;
    if (p < 6.0 && drift < 0) drift = -drift;
    const o = p, cl = o + drift + 0.008 * randn(r);
    const h = Math.max(o, cl) + Math.abs(randn(r)) * 0.004, l = Math.min(o, cl) - Math.abs(randn(r)) * 0.004;
    out.push({ t, o: rI(o * f), h: rI(h * f), l: rI(l * f), c: rI(cl * f) });
    p = cl;
  }
  return annotate(out);
}

// ---- CSV candles: time,open,high,low,close (time with no zone = Central Time) ----
function parseTime(s) {
  s = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const v = +s; return v < 1e11 ? v * 1000 : v; }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/);
  if (m) {
    for (const off of [5, 6]) {
      const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + off, +m[5]), c = ctInfo(ms);
      if (c.date === `${m[1]}-${m[2]}-${m[3]}` && c.mins === (+m[4]) * 60 + (+m[5])) return ms;
    }
    return NaN;
  }
  return Date.parse(s);
}
function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { bars: [], skipped: 0 };
  let idx = { t: 0, o: 1, h: 2, l: 3, c: 4 }, start = 0;
  if (/[a-z]/i.test(lines[0])) {
    const hd = lines[0].toLowerCase().split(',').map(x => x.trim()); start = 1;
    const f = (...k) => hd.findIndex(x => k.includes(x));
    idx = { t: f('time', 'date', 'datetime', 'timestamp'), o: f('open', 'o'), h: f('high', 'h'), l: f('low', 'l'), c: f('close', 'c') };
    if (Object.values(idx).some(v => v < 0)) return { bars: [], skipped: lines.length - 1, error: 'Need columns: time, open, high, low, close' };
  }
  const bars = []; let skipped = 0;
  for (const ln of lines.slice(start)) {
    const x = ln.split(',').map(s => s.trim());
    const b = { t: parseTime(x[idx.t]), o: +x[idx.o], h: +x[idx.h], l: +x[idx.l], c: +x[idx.c] };
    if ([b.t, b.o, b.h, b.l, b.c].some(v => !isFinite(v)) || b.h < b.l || b.h < Math.max(b.o, b.c) - 1e-9 || b.l > Math.min(b.o, b.c) + 1e-9) { skipped++; continue; }
    bars.push(b);
  }
  bars.sort((a, b) => a.t - b.t);
  return { bars: annotate(bars.filter((b, i) => i === 0 || b.t !== bars[i - 1].t)), skipped };
}

// ---- Chart screenshot reader (approximate): turns a cropped candle PNG into candles ----
// px = RGBA pixel array (ImageData.data). Reads red/green candles (white wicks too), then maps pixel rows to prices
// using two prices the user supplies (the highest wick and the lowest wick in the picture).
function readChartImage(px, W, H, o) {
  const red = new Uint8Array(W * H), grn = new Uint8Array(W * H), any = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) {
    const r = px[4 * k], g = px[4 * k + 1], b = px[4 * k + 2];
    const R = r > 150 && g < 120 && b < 120 && r - g > 80, G = g > 130 && r < 160 && b < 140 && g - r > 30, Wt = r > 235 && g > 235 && b > 235;
    red[k] = R ? 1 : 0; grn[k] = G ? 1 : 0; any[k] = (R || G || Wt) ? 1 : 0;
  }
  const colCnt = new Int32Array(W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) colCnt[x] += any[y * W + x];
  const cl = []; for (let x = 0; x < W;) { if (colCnt[x] > 0) { const s = x; while (x < W && colCnt[x] > 0) x++; cl.push([s, x - 1]); } else x++; }
  const widths = cl.map(c => c[1] - c[0] + 1).sort((a, b) => a - b), medW = widths[Math.floor(widths.length / 2)] || 1;
  const raw = []; let dropped = 0;
  for (const [s, e] of cl) {
    const w = e - s + 1; if (w < medW * 0.7 || w > medW * 1.3) { dropped++; continue; }
    let top = -1, bot = -1, bt = -1, bb = -1, nr = 0, ng = 0;
    for (let y = 0; y < H; y++) {
      let a = 0, c = 0;
      for (let x = s; x <= e; x++) { const k = y * W + x; a += any[k]; c += red[k] + grn[k]; nr += red[k]; ng += grn[k]; }
      if (a > 0) { if (top < 0) top = y; bot = y; }
      if (c >= Math.max(3, 0.6 * w)) { if (bt < 0) bt = y; bb = y; }
    }
    if (bt < 0) { dropped++; continue; }
    raw.push({ x: s, top, bot: bot + 1, bt, bb: bb + 1, up: ng > nr });
  }
  if (raw.length < 2) return { bars: [], dropped, error: 'Could not find candles. Crop the picture to just the candles (no price labels or icons) and use a red/green candle theme.' };
  const y0 = Math.min(...raw.map(r => r.top)), y1 = Math.max(...raw.map(r => r.bot));
  const pr = y => o.high - (y - y0) / (y1 - y0) * (o.high - o.low), sn = v => Math.round(v / o.tick) * o.tick, dec = o.dec;
  const bars = raw.map(r => {
    const hi = sn(pr(r.top)), lo = sn(pr(r.bot)), a = sn(pr(r.bt)), b = sn(pr(r.bb)), op = r.up ? b : a, cl_ = r.up ? a : b;
    return { o: +op.toFixed(dec), h: +Math.max(hi, op, cl_).toFixed(dec), l: +Math.min(lo, op, cl_).toFixed(dec), c: +cl_.toFixed(dec) };
  });
  // timestamps: count back from the last candle's open time, skipping the closed hours (4-5pm CT and the weekend)
  const closed = t => { const c = ctInfo(t); return c.dow === 'Sat' || (c.dow === 'Fri' && c.mins >= 960) || (c.dow === 'Sun' && c.mins < 1020) || (c.mins >= 960 && c.mins < 1020); };
  let t = o.lastT; const step = o.tf * 60000, ts = [];
  for (let k = bars.length - 1; k >= 0; k--) { while (closed(t)) t -= step; ts[k] = t; t -= step; }
  bars.forEach((b, k) => b.t = ts[k]);
  return { bars: annotate(bars), dropped };
}

// ---- Scanner: fib continuation. Uses only bars 0..i when called with i. ----
class Scanner {
  constructor(b, c) { this.b = b; this.c = c; this.piv = []; this.leg = null; }
  mkLeg(i) {
    const P = this.piv; if (P.length < 2) { this.leg = null; return; }
    const p0 = P[P.length - 2], p1 = P[P.length - 1];
    const g = { dir: p1.type === 'L' ? 'short' : 'long', used: false, dead: false, hi: -Infinity, lo: Infinity, p1: p1.idx };
    if (p1.type === 'L') { g.H = p0.p; g.L = p1.p; } else { g.L = p0.p; g.H = p1.p; }
    g.R = g.H - g.L;
    for (let k = p1.idx + 1; k <= i; k++) { g.hi = Math.max(g.hi, this.b[k].h); g.lo = Math.min(g.lo, this.b[k].l); }
    this.leg = g;
  }
  add(pv, i) {
    const P = this.piv, last = P[P.length - 1];
    if (last && last.type === pv.type) {
      if ((pv.type === 'H' && pv.p > last.p) || (pv.type === 'L' && pv.p < last.p)) { P[P.length - 1] = pv; this.mkLeg(i); }
      return;
    }
    P.push(pv); if (P.length > 6) P.shift(); this.mkLeg(i);
  }
  onBar(i) {
    const b = this.b, c = this.c, N = c.pivotLen, bar = b[i];
    if (this.leg) { this.leg.hi = Math.max(this.leg.hi, bar.h); this.leg.lo = Math.min(this.leg.lo, bar.l); }
    const j = i - N;
    if (j - N >= 0) {   // a pivot at j is only known N bars later
      let H = true, W = true; const hj = b[j].h, lj = b[j].l;
      for (let k = j - N; k <= i; k++) {
        if (k === j) continue;
        if (k < j) { if (b[k].h >= hj) H = false; if (b[k].l <= lj) W = false; }
        else { if (b[k].h > hj) H = false; if (b[k].l < lj) W = false; }
      }
      if (H && !W) this.add({ type: 'H', idx: j, p: hj }, i); else if (W && !H) this.add({ type: 'L', idx: j, p: lj }, i);
    }
    const g = this.leg;
    if (!g || g.used || g.dead || g.R < c.minLeg || !canEnter(bar.mins + 15, c)) return null;
    let sig = null;
    if (g.dir === 'short') {
      const zl = g.L + c.zoneLo * g.R, zh = g.L + c.zoneHi * g.R, sl = g.L + c.stopLvl * g.R;
      if (g.lo < g.L || g.hi > sl) { g.dead = true; return null; }
      if (bar.h >= zl && bar.c < bar.o) {
        const stop = gridUp(sl + c.stopBuf, c.tick), e = bar.c, tp = gridUp(c.tpMode === 'ext' ? g.L - 0.272 * g.R : g.L, c.tick);
        if (stop > e && e > tp && (e - tp) / (stop - e) >= c.minRR) sig = { dir: 'short', planned: e, stop, target: tp, rr: (e - tp) / (stop - e), zl, zh };
      }
    } else {
      const zl = g.H - c.zoneLo * g.R, zh = g.H - c.zoneHi * g.R, sl = g.H - c.stopLvl * g.R;
      if (g.hi > g.H || g.lo < sl) { g.dead = true; return null; }
      if (bar.l <= zl && bar.c > bar.o) {
        const stop = gridDn(sl - c.stopBuf, c.tick), e = bar.c, tp = gridDn(c.tpMode === 'ext' ? g.H + 0.272 * g.R : g.H, c.tick);
        if (e > stop && tp > e && (tp - e) / (e - stop) >= c.minRR) sig = { dir: 'long', planned: e, stop, target: tp, rr: (tp - e) / (e - stop), zl, zh };
      }
    }
    if (sig) {
      g.used = true;
      Object.assign(sig, { i, t: bar.t, legH: g.H, legL: g.L, fibRetr: (sig.dir === 'short' ? sig.planned - g.L : g.H - sig.planned) / g.R });
    }
    return sig;
  }
}

// ---- Trade simulation shared by the backtester and the executor ----
function resolveBar(p, bar, first, held, c) {
  const s = p.s, slip = c.slipTicks * c.tick;
  if (!first && inFlat(bar.mins, c)) return { price: bar.o, reason: 'flat' };
  if (!first) {
    if (s > 0 ? bar.o <= p.stop : bar.o >= p.stop) return { price: bar.o, reason: 'stop' };
    if (s > 0 ? bar.o >= p.target : bar.o <= p.target) return { price: p.target, reason: 'tp' };
  }
  const sh = s > 0 ? bar.l <= p.stop : bar.h >= p.stop, th = s > 0 ? bar.h >= p.target : bar.l <= p.target;
  if (sh) return { price: p.stop - s * slip, reason: 'stop' };   // if both hit in one bar, assume the stop came first
  if (th) return { price: p.target, reason: 'tp' };
  if (held >= c.maxBars) return { price: bar.c, reason: 'timeout' };
  return null;
}
function simTrade(b, sig, c) {
  const e = sig.i + 1; if (e >= b.length || !canEnter(b[e].mins, c)) return null;
  const s = sig.dir === 'long' ? 1 : -1, entry = b[e].o + s * c.slipTicks * c.tick;
  const p = { s, stop: sig.stop, target: sig.target, entry };
  for (let k = e; k < b.length; k++) {
    const r = resolveBar(p, b[k], k === e, k - e + 1, c);
    if (r) {
      const risk = Math.max(Math.abs(entry - sig.stop), c.tick), gross = (r.price - entry) * s;
      return { strat: sig.strat, sigI: sig.i, entryI: e, exitI: k, dir: sig.dir, entry, exit: r.price, stop: sig.stop, target: sig.target,
               reason: r.reason, r: gross / risk, pnl1: gross * c.mult - 2 * c.fee, rr: Math.abs(sig.target - entry) / risk };
    }
  }
  return null;   // not resolved before data ended
}
