// ===== ENGINE PART 7: strategy library, multi-strategy scanner, Strategy Lab =====
// Every strategy only looks at bars 0..i (no look-ahead). Targets and stops are rounded onto the contract's tick grid.
const closedHours = t => { const c = ctInfo(t); return c.dow === 'Sat' || (c.dow === 'Fri' && c.mins >= 960) || (c.dow === 'Sun' && c.mins < 1020) || (c.mins >= 960 && c.mins < 1020); };

const HTFS = [60, 240, 1440];   // 1-hour, 4-hour, daily views built from the 15-minute candles (only finished higher candles are used)
class Ind {   // indicators, extended one bar at a time
  constructor(b) { this.b = b; this.n = 0; this.atr = []; this.e20 = []; this.e60 = []; this.e100 = []; this.rsi = []; this.m20 = []; this.s20 = []; this.ag = 0; this.al = 0; this.h = {}; for (const tf of HTFS) this.h[tf] = { bk: null, cur: 0, ema: null, prev: null, last: null, n: 0 }; }
  trend(tf) { const h = this.h[tf]; if (!h || h.n < 12 || h.ema == null || h.prev == null) return 0; return h.last > h.ema && h.ema > h.prev ? 1 : h.last < h.ema && h.ema < h.prev ? -1 : 0; }
  upto(n) {
    const b = this.b;
    for (let i = this.n; i < n; i++) {
      for (const tf of HTFS) { const h = this.h[tf], bk = Math.floor(b[i].t / (tf * 60000)); if (h.bk !== null && bk !== h.bk) { h.last = h.cur; h.prev = h.ema; h.ema = h.ema == null ? h.cur : h.ema + (h.cur - h.ema) * 2 / 21; h.n++; } h.bk = bk; h.cur = b[i].c; }
      const x = b[i], pc = i ? b[i - 1].c : x.o, tr = Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc));
      this.atr[i] = i ? (this.atr[i - 1] * 13 + tr) / 14 : tr;
      const ema = (arr, len) => { const a = 2 / (len + 1); arr[i] = i ? a * x.c + (1 - a) * arr[i - 1] : x.c; };
      ema(this.e20, 20); ema(this.e60, 60); ema(this.e100, 100);
      const ch = x.c - pc; this.ag = (this.ag + Math.max(ch, 0)) / 2; this.al = (this.al + Math.max(-ch, 0)) / 2;
      this.rsi[i] = this.al === 0 ? (this.ag === 0 ? 50 : 100) : 100 - 100 / (1 + this.ag / this.al);
      const s = Math.max(0, i - 19); let sum = 0, v = 0; for (let k = s; k <= i; k++) sum += b[k].c; const m = sum / (i - s + 1); for (let k = s; k <= i; k++) v += (b[k].c - m) * (b[k].c - m);
      this.m20[i] = m; this.s20[i] = Math.sqrt(v / (i - s + 1));
    }
    this.n = Math.max(this.n, n);
  }
}
function mkSig(c, i, bar, dir, stop, target, extra) {
  const T = c.tick, e = bar.c;
  stop = dir === 'long' ? gridDn(stop, T) : gridUp(stop, T); target = dir === 'long' ? gridDn(target, T) : gridUp(target, T);
  const risk = Math.abs(e - stop), reward = Math.abs(target - e);
  if (!(risk >= 2 * T) || !(reward >= 4 * T) || (dir === 'long' ? !(stop < e && target > e) : !(stop > e && target < e))) return null;
  return Object.assign({ dir, planned: e, stop, target, rr: reward / risk, i, t: bar.t, zl: e, zh: e, legH: e, legL: e, fibRetr: null }, extra || {});
}
const winOk = (bar, c) => canEnter(bar.mins + 15, c);

class FibStrat { constructor(b, c, p) { this.sc = new Scanner(b, Object.assign({}, c, p)); } get leg() { return this.sc.leg; } onBar(i) { return this.sc.onBar(i); } }
class OrbStrat {   // opening-range breakout
  constructor(b, c, p, ind) { this.b = b; this.c = c; this.p = p; this.ind = ind; this.day = null; this.n = 0; this.H = -Infinity; this.L = Infinity; this.fl = false; this.fs = false; }
  onBar(i) {
    const bar = this.b[i], c = this.c, p = this.p, o = hm(c.sessionOpen || '08:30');
    if (bar.day !== this.day) { this.day = bar.day; this.n = 0; this.H = -Infinity; this.L = Infinity; this.fl = this.fs = false; }
    if (bar.mins >= o && bar.mins < o + p.rangeBars * 15) { this.n++; this.H = Math.max(this.H, bar.h); this.L = Math.min(this.L, bar.l); return null; }
    if (this.n < p.rangeBars || bar.mins < o + p.rangeBars * 15 || bar.mins > o + 240 || !winOk(bar, c)) return null;
    const atr = this.ind.atr[i];
    if (!this.fl && bar.c > this.H) { this.fl = true; const stop = Math.max(this.L, bar.c - 3 * atr), r = bar.c - stop; return mkSig(c, i, bar, 'long', stop, bar.c + p.tpR * r); }
    if (!this.fs && bar.c < this.L) { this.fs = true; const stop = Math.min(this.H, bar.c + 3 * atr), r = stop - bar.c; return mkSig(c, i, bar, 'short', stop, bar.c - p.tpR * r); }
    return null;
  }
}
const MIN_LVL_DAYS = 15;   // recorded days of levels before the Lab will test level trades
const lvlDays = c => (c && c.levelsByDay) ? Object.keys(c.levelsByDay).filter(k => c.levelsByDay[k] && c.levelsByDay[k].lv && c.levelsByDay[k].lv.length).length : 0;
class LvlStrat {   // trades the bounce or rejection at the daily option levels you enter (call wall, put wall, gamma flip, IV range)
  constructor(b, c, p, ind) { this.b = b; this.c = c; this.p = p; this.ind = ind; this.day = null; this.fired = {}; }
  onBar(i) {
    const bar = this.b[i], c = this.c, p = this.p, L = c.levelsByDay && c.levelsByDay[bar.day];
    if (bar.day !== this.day) { this.day = bar.day; this.fired = {}; }
    if (!L || !L.lv || !L.lv.length || i < 30 || !winOk(bar, c)) return null;
    if (L.regime === 'negative' && p.negBreak) {   // negative gamma: walls tend to break, so trade the break instead of the bounce
      const atr = this.ind.atr[i], pc = i > 0 ? this.b[i - 1].c : bar.o;
      for (const l of L.lv) {
        const P = +l.p, key = 'b' + l.k; if (!(P > 0) || this.fired[key] || l.k === 'flip') continue;
        if ((l.k === 'put' || l.k === 'ivLo') && pc >= P && bar.c < P && bar.c < bar.o) { this.fired[key] = 1; const stop = P + 0.5 * atr, s = mkSig(c, i, bar, 'short', stop, bar.c - p.m * (stop - bar.c), { level: l.k + ' break' }); if (s) return s; }
        if ((l.k === 'call' || l.k === 'ivHi') && pc <= P && bar.c > P && bar.c > bar.o) { this.fired[key] = 1; const stop = P - 0.5 * atr, s = mkSig(c, i, bar, 'long', stop, bar.c + p.m * (bar.c - stop), { level: l.k + ' break' }); if (s) return s; }
      }
      return null;
    }
    if (p.posOnly && L.regime === 'negative') return null;   // walls hold best when dealers are long gamma
    const atr = this.ind.atr[i], tol = 0.15 * atr;
    for (const l of L.lv) {
      const P = +l.p; if (!(P > 0) || this.fired[l.k]) continue; if (p.use === 'walls' && l.k !== 'put' && l.k !== 'call') continue;
      const sup = l.k === 'put' || l.k === 'ivLo' || (l.k === 'flip' && bar.c > P), res = l.k === 'call' || l.k === 'ivHi' || (l.k === 'flip' && bar.c < P);
      if (sup && bar.l <= P + tol && bar.c > P && bar.c > bar.o) { this.fired[l.k] = 1; const stop = Math.min(bar.l, P) - p.k * atr, s = mkSig(c, i, bar, 'long', stop, bar.c + p.m * (bar.c - stop), { level: l.k }); if (s) return s; }
      if (res && bar.h >= P - tol && bar.c < P && bar.c < bar.o) { this.fired[l.k] = 1; const stop = Math.max(bar.h, P) + p.k * atr, s = mkSig(c, i, bar, 'short', stop, bar.c - p.m * (stop - bar.c), { level: l.k }); if (s) return s; }
    }
    return null;
  }
}
class KeyLvlStrat {   // bounce / rejection at yesterday's high-low and the overnight high-low (levels with full history, so the Lab can test the idea today)
  constructor(b, c, p, ind) { this.b = b; this.c = c; this.p = p; this.ind = ind; this.day = null; this.dH = -Infinity; this.dL = Infinity; this.pdH = null; this.pdL = null; this.onH = -Infinity; this.onL = Infinity; this.fired = {}; }
  onBar(i) {
    const bar = this.b[i], c = this.c, p = this.p, o = hm(c.sessionOpen || '08:30');
    if (bar.day !== this.day) { if (this.day !== null && this.dH > -Infinity) { this.pdH = this.dH; this.pdL = this.dL; } this.day = bar.day; this.dH = -Infinity; this.dL = Infinity; this.onH = -Infinity; this.onL = Infinity; this.fired = {}; }
    const rth = bar.mins >= o && bar.mins < 1020;
    let sig = null;
    if (rth && i >= 30 && winOk(bar, c)) {
      const atr = this.ind.atr[i], tol = 0.15 * atr, L = [];
      if (p.use !== 'on' && this.pdH != null) L.push(['pdh', this.pdH, -1], ['pdl', this.pdL, 1]);
      if (p.use !== 'pd' && this.onH > -Infinity) L.push(['onh', this.onH, -1], ['onl', this.onL, 1]);
      for (const [k, P, dir] of L) {
        if (sig || this.fired[k]) continue;
        if (dir > 0 && bar.l <= P + tol && bar.c > P && bar.c > bar.o) { this.fired[k] = 1; const stop = Math.min(bar.l, P) - p.k * atr; sig = mkSig(c, i, bar, 'long', stop, bar.c + p.m * (bar.c - stop), { level: k }); }
        else if (dir < 0 && bar.h >= P - tol && bar.c < P && bar.c < bar.o) { this.fired[k] = 1; const stop = Math.max(bar.h, P) + p.k * atr; sig = mkSig(c, i, bar, 'short', stop, bar.c - p.m * (stop - bar.c), { level: k }); }
      }
    }
    // update today's range and the overnight range only after this candle has been judged (no look-ahead)
    this.dH = Math.max(this.dH, bar.h); this.dL = Math.min(this.dL, bar.l);
    if (bar.mins < o || bar.mins >= 1020) { this.onH = Math.max(this.onH, bar.h); this.onL = Math.min(this.onL, bar.l); }
    return sig;
  }
}
class Rsi2Strat {
  constructor(b, c, p, ind) { this.b = b; this.c = c; this.p = p; this.ind = ind; this.last = -99; }
  onBar(i) {
    const bar = this.b[i], c = this.c, p = this.p, I = this.ind; if (i < 100 || i - this.last < 8 || !winOk(bar, c)) return null;
    const atr = I.atr[i]; let s = null;
    if (I.rsi[i] < p.th && bar.c > I.e100[i]) s = mkSig(c, i, bar, 'long', bar.c - p.k * atr, bar.c + p.m * atr);
    else if (I.rsi[i] > 100 - p.th && bar.c < I.e100[i]) s = mkSig(c, i, bar, 'short', bar.c + p.k * atr, bar.c - p.m * atr);
    if (s) this.last = i; return s;
  }
}
class BollStrat {
  constructor(b, c, p, ind) { this.b = b; this.c = c; this.p = p; this.ind = ind; this.last = -99; }
  onBar(i) {
    const bar = this.b[i], c = this.c, p = this.p, I = this.ind; if (i < 30 || i - this.last < 6 || !winOk(bar, c)) return null;
    const m = I.m20[i], sd = I.s20[i], atr = I.atr[i]; let s = null;
    if (bar.c < m - p.sd * sd && bar.c > bar.o) s = mkSig(c, i, bar, 'long', bar.c - p.k * atr, m);
    else if (bar.c > m + p.sd * sd && bar.c < bar.o) s = mkSig(c, i, bar, 'short', bar.c + p.k * atr, m);
    if (s) this.last = i; return s;
  }
}
class EmaPbStrat {
  constructor(b, c, p, ind) { this.b = b; this.c = c; this.p = p; this.ind = ind; this.last = -99; }
  onBar(i) {
    const bar = this.b[i], c = this.c, p = this.p, I = this.ind; if (i < 100 || i - this.last < 6 || !winOk(bar, c)) return null;
    const atr = I.atr[i]; let s = null;
    if (I.e20[i] > I.e60[i] && bar.c > I.e60[i] && bar.l <= I.e20[i] && bar.c > I.e20[i] && bar.c > bar.o) s = mkSig(c, i, bar, 'long', bar.c - p.k * atr, bar.c + p.m * atr);
    else if (I.e20[i] < I.e60[i] && bar.c < I.e60[i] && bar.h >= I.e20[i] && bar.c < I.e20[i] && bar.c < bar.o) s = mkSig(c, i, bar, 'short', bar.c + p.k * atr, bar.c - p.m * atr);
    if (s) this.last = i; return s;
  }
}
class DonchStrat {
  constructor(b, c, p, ind) { this.b = b; this.c = c; this.p = p; this.ind = ind; this.last = -99; }
  onBar(i) {
    const bar = this.b[i], c = this.c, p = this.p, N = p.n; if (i < N + 1 || i - this.last < 8 || !winOk(bar, c)) return null;
    let hh = -Infinity, ll = Infinity; for (let k = i - N; k < i; k++) { hh = Math.max(hh, this.b[k].h); ll = Math.min(ll, this.b[k].l); }
    const atr = this.ind.atr[i]; let s = null;
    if (bar.c > hh) s = mkSig(c, i, bar, 'long', bar.c - p.k * atr, bar.c + p.m * atr); else if (bar.c < ll) s = mkSig(c, i, bar, 'short', bar.c + p.k * atr, bar.c - p.m * atr);
    if (s) this.last = i; return s;
  }
}
const STRATS = {
  fib: { name: 'Fib continuation', blurb: 'Enters on a pullback into the 38-62% zone of a swing, targeting a retest of the swing extreme.', grid: { zoneLo: [0.382, 0.5, 0.618], minRR: [1.2, 2], pivotLen: [5, 8], tpMode: ['retest', 'ext'] }, make: (b, c, p) => new FibStrat(b, c, p) },
  orb: { name: 'Opening-range breakout', blurb: 'Trades the first close beyond the opening 30-60 minute range.', grid: { rangeBars: [2, 4], tpR: [1, 1.5, 2] }, make: (b, c, p, i) => new OrbStrat(b, c, p, i) },
  rsi2: { name: 'RSI(2) mean reversion', blurb: 'Buys very oversold dips in an uptrend (sells overbought rallies in a downtrend); small target, wide stop.', grid: { th: [5, 10], k: [1.5, 2.5], m: [0.5, 1] }, make: (b, c, p, i) => new Rsi2Strat(b, c, p, i) },
  boll: { name: 'Bollinger band reversion', blurb: 'Fades a close outside the 20-bar band when the candle turns back; target is the middle band.', grid: { sd: [2, 2.5], k: [1.5, 2.5] }, make: (b, c, p, i) => new BollStrat(b, c, p, i) },
  emapb: { name: 'Trend pullback (EMA)', blurb: 'In a trend, buys the bounce off the 20-bar average (sells the rejection in a downtrend).', grid: { k: [1, 1.5], m: [1.5, 2.5] }, make: (b, c, p, i) => new EmaPbStrat(b, c, p, i) },
  lvl: { name: 'Option-level bounce (GEX/IV walls)', needsLevels: true, blurb: 'Buys the bounce off a put wall or IV low, sells the rejection at a call wall or IV high, using the levels you enter each morning. Tested only once enough days are recorded.', grid: { k: [0.5, 1], m: [1.5, 2], use: ['walls', 'all'] }, make: (b, c, p, i) => new LvlStrat(b, c, p, i) },
  keylvl: { name: 'Key-level bounce (yesterday & overnight)', blurb: 'Buys the bounce off yesterday\'s low or the overnight low, sells the rejection at yesterday\'s high or the overnight high. Same idea as the GEX levels, but with years of history to test on.', grid: { k: [0.5, 1], m: [1.5, 2], use: ['pd', 'on', 'both'] }, make: (b, c, p, i) => new KeyLvlStrat(b, c, p, i) },
  donch: { name: 'Donchian breakout', blurb: 'Buys a close above the highest high of the last 20 or 40 candles (sells below the lowest low).', grid: { n: [20, 40], k: [1.5], m: [1.5, 3] }, make: (b, c, p, i) => new DonchStrat(b, c, p, i) }
};
const stratKey = (id, p) => id + '|' + Object.keys(p).sort().map(k => p[k]).join('|');
const stratLabel = (id, p) => STRATS[id].name + ' (' + Object.keys(p).sort().filter(k => k !== 'mtf').map(k => k + ' ' + p[k]).join(', ') + (p.mtf ? ', with 1h+4h trend filter' : '') + ')';
function gridCombos(id) {
  const g = Object.assign({}, STRATS[id].grid, { mtf: [0, 1] }), ks = Object.keys(g); let out = [{}];
  for (const k of ks) { const nx = []; for (const o of out) for (const v of g[k]) nx.push(Object.assign({}, o, { [k]: v })); out = nx; }
  return out.map(p => ({ id, params: p, key: stratKey(id, p), label: stratLabel(id, p) }));
}
const allCombos = c => Object.keys(STRATS).filter(id => !STRATS[id].needsLevels || lvlDays(c) >= MIN_LVL_DAYS).flatMap(gridCombos);

class MultiScanner {
  constructor(b, c, list) {
    this.b = b; this.c = c; this.ind = new Ind(b);
    this.items = list.filter(s => STRATS[s.id]).map(s => ({ s, key: s.key || stratKey(s.id, s.params), inst: STRATS[s.id].make(b, c, s.params, this.ind) }));
  }
  get leg() { const f = this.items.find(x => x.s.id === 'fib'); return f ? f.inst.leg : null; }
  onBar(i) {
    this.ind.upto(i + 1); let first = null;
    for (const it of this.items) { const sig = it.inst.onBar(i); if (sig && it.s.params && it.s.params.mtf) { const d = sig.dir === 'long' ? 1 : -1; if (this.ind.trend(60) !== d || this.ind.trend(240) !== d) continue; }
      if (sig) { sig.strat = it.key; sig.stratId = it.s.id; sig.name = STRATS[it.s.id].name; if (!first) first = sig; } }
    return first;
  }
}
class NullScanner { constructor() { this.leg = null; } onBar() { return null; } }
function makeScanner(b, c) {
  if (Array.isArray(c.strategies)) return c.strategies.length ? new MultiScanner(b, c, c.strategies) : new NullScanner();
  return new Scanner(b, c);     // legacy: the original fib scanner (used by Replay)
}

// ---- Strategy Lab: the Backtester's job. Test every strategy and setting on stored history, approve only what holds up. ----
function labTrades(bars, c, combo) {   // one trade at a time, as the real account would
  const sc = new MultiScanner(bars, c, [combo]), out = []; let free = 0;
  for (let k = 0; k < bars.length; k++) { const s = sc.onBar(k); if (s && s.i + 1 >= free) { const t = simTrade(bars, s, c); if (t) { t.strat = combo.key; out.push(t); free = t.exitI + 1; } } }
  return out;
}
function labReport(tr, nBars, c) {
  const cut = nBars * 2 / 3, sel = tr.filter(t => t.sigI < cut), hold = tr.filter(t => t.sigI >= cut), ps = sel.map(t => t.pnl1), ph = hold.map(t => t.pnl1);
  const m = mean(ps), sd = ps.length > 1 ? Math.sqrt(ps.reduce((a, v) => a + (v - m) * (v - m), 0) / (ps.length - 1)) : 0, all = stats(tr, c), s1 = stats(sel, c);
  const tp = sel.filter(t => t.reason === 'tp').length;
  return { n: tr.length, selN: sel.length, holdN: hold.length, exp: m, holdExp: ph.length ? mean(ph) : null, t: sd > 0 && sel.length ? m / (sd / Math.sqrt(sel.length)) : 0,
           pTP: s1.pTP, be: s1.be, tpLow: sel.length ? wilson(tp, sel.length, 1.28) : 0, holdTP: hold.length ? hold.filter(t => t.reason === 'tp').length / hold.length : null, avgRR: s1.rr, allExp: all.exp };
}
class Lab {
  constructor(sim) { this.sim = sim; this.history = []; this.proposal = null; this.running = false; this.lastRun = null; this.progress = 0; this.lastRunAt = 0; }
  combos() { return allCombos(this.sim.c); }
  async run(opts) {
    if (this.running) return null; this.running = true;
    const o = Object.assign({ maxBars: 8000, minTrades: 40, minHold: 10, minT: 3, minTP: null, maxPick: 3, yieldEvery: 3, onProgress: null }, opts || {});
    try {
      const c = this.sim.c, bars = this.sim.bars.slice(-o.maxBars), combos = this.combos(), minTP = o.minTP != null ? o.minTP : (c.minTP != null ? c.minTP : 0.5), rows = [];
      for (let k = 0; k < combos.length; k++) {
        const cb = combos[k], r = labReport(labTrades(bars, c, cb), bars.length, c), why = [];
        if (r.selN < o.minTrades) why.push(`only ${r.selN} trades (need ${o.minTrades})`);
        else {
          if (!(r.exp > 0)) why.push(`loses ${usd(r.exp)} per contract after costs`);
          else if (r.t < o.minT) why.push(`profit not convincing (score ${r.t.toFixed(1)}, need ${o.minT})`);
          if (r.pTP < minTP) why.push(`hits take-profit ${pct(r.pTP)} of the time (you want ${pct(minTP)}+)`);
          if (!(r.tpLow > r.be)) why.push(`TP rate not clearly above breakeven (${pct(r.tpLow)} vs ${pct(r.be)})`);
        }
        if (!why.length) { if (r.holdN < o.minHold) why.push(`only ${r.holdN} trades in the newest third (need ${o.minHold})`); else if (!(r.holdExp > 0)) why.push(`lost money on the newest third (${usd(r.holdExp)} per trade)`); }
        rows.push(Object.assign({ id: cb.id, params: cb.params, key: cb.key, label: cb.label, ok: !why.length, why: why.join('; ') }, r));
        this.progress = (k + 1) / combos.length; if (o.onProgress) o.onProgress(this.progress); if (k % o.yieldEvery === 0) await sleep(0);
      }
      const best = {}; for (const r of rows) { const b0 = best[r.id]; if (!b0 || (r.ok && !b0.ok) || (r.ok === b0.ok && r.t > b0.t)) best[r.id] = r; }
      const perStrategy = Object.keys(STRATS).map(id => best[id] || { id, params: {}, key: id, label: STRATS[id].name, ok: false, n: 0, selN: 0, holdN: 0, exp: 0, pTP: 0, holdExp: null, t: 0, why: `waiting for level data: ${lvlDays(c)} of ${MIN_LVL_DAYS} days recorded (type today's levels in the Levels panel each morning)` });
      const approved = perStrategy.filter(r => r.ok).sort((a, b) => b.t - a.t).slice(0, o.maxPick).map(r => ({ id: r.id, params: r.params, key: r.key, label: r.label, n: r.selN, exp: r.exp, pTP: r.pTP, t: r.t, holdExp: r.holdExp, holdN: r.holdN, rr: r.avgRR }));
      const cur = (c.strategies || []).map(s => s.key || stratKey(s.id, s.params)).sort().join(), nxt = approved.map(s => s.key).sort().join();
      let why;
      if (bars.length < 1500) why = `Only ${bars.length} candles of history. Too little to judge any strategy reliably (want 1,500+). Nothing is approved.`;
      else if (!approved.length) why = `None of the ${combos.length} strategy settings cleared the bar, so the Scanner has nothing approved to trade. That is a normal and honest result: most strategies do not survive costs and an untouched test period.`;
      else why = `${approved.length} of ${Object.keys(STRATS).length} strategies cleared every test: ${approved.map(a => STRATS[a.id].name).join(', ')}.`;
      const res = { at: Date.now(), nBars: bars.length, tried: combos.length, minTP, rows, perStrategy, approved, why, change: cur !== nxt && bars.length >= 1500,
                    caution: `Tested ${combos.length} strategy settings on the same history, so some can look good by luck. Each approved strategy must also have been profitable on the newest third of history, which it was not chosen on. That reduces luck but cannot remove it.` };
      this.lastRun = res; this.lastRunAt = res.at; this.proposal = res.change ? res : null;
      this.history.unshift({ at: res.at, why, approved: approved.map(a => a.label) }); if (this.history.length > 30) this.history.pop();
      return res;
    } finally { this.running = false; }
  }
  apply(extra) {
    const p = this.proposal; if (!p || this.sim.gexOnly) return false;   /* in GEX-only mode the Lab advises but never changes what trades */ const list = p.approved.map(a => ({ id: a.id, params: a.params, key: a.key, label: a.label }));
    for (const s of this.sim.promoted || []) if (!list.some(x => x.key === s.key)) list.push(s);   // strategies that earned their place on probation stay
    this.sim.setStrategies(list); this.proposal = null; this.history.unshift({ at: Date.now(), applied: true, to: list.map(s => s.label) });
    this.sim.note(Math.max(0, this.sim.i - 1), 'backtester', 'approve', list.length ? 'Strategies now in use: ' + list.map(s => s.label).join('; ') : 'No strategy approved: the Scanner is standing down.', list.length > 0);
    if (extra) extra(list); return true;
  }
}

let _mv = null;
function mtfView(bars, n) {   // what the 15m, 1h, 4h and daily charts are doing at candle n (+1 up, -1 down, 0 sideways/unknown); only finished higher candles are used
  n = Math.min(n || bars.length, bars.length); if (n < 2) return { m15: 0, h1: 0, h4: 0, d1: 0 };
  if (!_mv || _mv.b !== bars || _mv.n > n) _mv = { b: bars, ind: new Ind(bars), n: 0, r: null };
  if (_mv.n !== n) { _mv.ind.upto(n); _mv.n = n; const I = _mv.ind, k = n - 1, c = bars[k].c, e = I.e20[k], e0 = I.e20[Math.max(0, k - 5)];
    _mv.r = { m15: c > e && e > e0 ? 1 : c < e && e < e0 ? -1 : 0, h1: I.trend(60), h4: I.trend(240), d1: I.trend(1440) }; }
  return _mv.r;
}

// ---- Probation: strategies that came close in the Lab paper-trade live; only trades after they joined count ----
const PROB = { promoteN: 20, dropN: 15, maxNear: 4 };
class Probation {
  constructor(sim, store, key) { this.sim = sim; this.store = store || null; this.key = key || 'probation'; this.list = []; this.cache = null; this.promoted = []; try { const j = store && store.get(this.key); if (j) { const o = JSON.parse(j); this.list = o.list || []; this.promoted = o.promoted || []; } } catch (e) { } sim.promoted = this.promoted; sim.promotedOut = k => { this.promoted = this.promoted.filter(x => x.key !== k); sim.promoted = this.promoted; this.save(); }; this.ensureLevels(); }
  save() { try { if (this.store) this.store.set(this.key, JSON.stringify({ list: this.list, promoted: this.promoted })); } catch (e) { } this.cache = null; }
  now() { const b = this.sim.bars; return b.length ? b[b.length - 1].t : Date.now(); }
  ensureLevels() {   // the GEX level strategy has no history to judge, so it is always on probation (needs levels to trade)
    if (!this.list.some(p => p.id === 'lvl')) { const p = { k: 1, m: 2, use: 'all', mtf: 0 }; this.list.push({ id: 'lvl', params: p, key: stratKey('lvl', p), label: stratLabel('lvl', p), since: this.now(), why: 'GEX levels: judged on live days only', lab: null, always: true }); this.save(); }
  }
  consider(lr) {   // after each Lab run: add near-misses (profitable in the Lab but not proven), never the approved ones
    if (!lr || !lr.rows) return [];
    const approved = new Set((lr.approved || []).map(a => a.key)), have = new Set(this.list.map(p => p.key)), added = [];
    const near = lr.rows.filter(r => !r.ok && !approved.has(r.key) && r.selN >= 30 && r.exp > 0 && r.t >= 1.5 && (r.holdExp == null || r.holdExp > -Math.abs(r.exp)))
      .sort((a, b) => b.t - a.t);
    const perId = {}; for (const r of near) { if (perId[r.id]) continue; perId[r.id] = r; }
    for (const r of Object.values(perId)) {
      if (this.list.filter(p => !p.always).length >= PROB.maxNear) break;
      if (have.has(r.key) || this.list.some(p => p.id === r.id)) continue;
      const e = { id: r.id, params: r.params, key: r.key, label: r.label, since: this.now(), why: r.why, lab: { exp: r.exp, pTP: r.pTP, n: r.selN, t: r.t } };
      this.list.push(e); added.push(e);
    }
    for (const p of this.list) if (approved.has(p.key)) p.done = 'approved by the Lab';
    this.list = this.list.filter(p => !p.done); if (added.length) this.save();
    return added;
  }
  rows() {   // live paper results since each strategy joined (cached per candle)
    const b = this.sim.bars, c = this.sim.c, n = b.length, lev = c.levelsByDay ? Object.keys(c.levelsByDay).length : 0;
    if (this.cache && this.cache.n === n && this.cache.lev === lev && this.cache.len === this.list.length) return this.cache.rows;
    const rows = this.list.map(p => {
      const start = b.findIndex(x => x.t > p.since); let tr = [];
      if (start >= 0) { const from = Math.max(0, start - 400), part = b.slice(from); tr = labTrades(part, c, { id: p.id, params: p.params, key: p.key }).filter(t => t.sigI + from >= start).map(t => Object.assign({}, t, { sigI: t.sigI + from, entryI: t.entryI + from, exitI: t.exitI + from })); }
      const N = tr.length, exp = N ? tr.reduce((a, t) => a + t.pnl1, 0) / N : null, pTP = N ? tr.filter(t => t.reason === 'tp').length / N : null;
      let status, verdict;
      if (N >= PROB.promoteN && exp > 0 && (!p.lab || pTP >= Math.min(p.lab.pTP - 0.1, c.minTP != null ? c.minTP : 0.5))) { status = 'ready'; verdict = `Held up live: ${N} trades, ${usd(exp)} per contract. Ready to use.`; }
      else if (N >= PROB.dropN && !(exp > 0)) { status = 'failed'; verdict = `Lost money live (${usd(exp)} per contract over ${N} trades).`; }
      else { status = 'testing'; verdict = N ? `${N} of ${PROB.promoteN} live trades so far` : (p.id === 'lvl' && !lev ? 'waiting for GEX levels' : 'waiting for its first live setup'); }
      return Object.assign({}, p, { n: N, exp, pTP, net: N ? tr.reduce((a, t) => a + t.pnl1, 0) : 0, status, verdict, trades: tr });
    });
    this.cache = { n, lev, len: this.list.length, rows }; return rows;
  }
  drop(key) { const p = this.list.find(x => x.key === key); if (!p) return false; if (p.always) { p.since = this.now(); p.reset = true; } else this.list = this.list.filter(x => x.key !== key); this.save(); return true; }
  promote(key) {   // add to the strategies the Scanner uses (keeps any already approved)
    const r = this.rows().find(x => x.key === key); if (!r || r.status !== 'ready') return false;
    const s0 = { id: r.id, params: r.params, key: r.key, label: r.label }, cur = (this.sim.c.strategies || []).slice(); if (!cur.some(s => s.key === r.key)) cur.push(s0);
    if (!this.promoted.some(x => x.key === r.key)) this.promoted.push(s0); this.sim.promoted = this.promoted;
    this.sim.setStrategies(cur); this.sim.note(Math.max(0, this.sim.i - 1), 'backtester', 'approve', 'Promoted from probation after holding up live: ' + r.label, true);
    if (!r.always) this.list = this.list.filter(x => x.key !== key); this.save(); return true;
  }
}
