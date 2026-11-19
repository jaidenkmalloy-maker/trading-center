// ===== ENGINE PART 2: backtester stats, rules manager, executor =====
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const pct = x => (x * 100).toFixed(0) + '%';
const usd = n => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function wilson(k, n, z) {
  if (!n) return 0; const p = k / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}
// System 2 maths: how often did past trades reach take-profit, and is that above breakeven?
function stats(tr, c) {
  const n = tr.length;
  if (!n) return { n: 0, tp: 0, sl: 0, oth: 0, pTP: 0, low: 0, be: 0, rr: 0, exp: 0, avgR: 0, pf: 0 };
  const tp = tr.filter(t => t.reason === 'tp').length, sl = tr.filter(t => t.reason === 'stop').length;
  const rr = mean(tr.map(t => t.rr)), win = tr.filter(t => t.pnl1 > 0).reduce((a, t) => a + t.pnl1, 0), loss = Math.abs(tr.filter(t => t.pnl1 < 0).reduce((a, t) => a + t.pnl1, 0));
  return { n, tp, sl, oth: n - tp - sl, pTP: tp / n, low: wilson(tp, n, c.z), be: 1 / (1 + rr), rr,
           exp: mean(tr.map(t => t.pnl1)), avgR: mean(tr.map(t => t.r)), pf: loss > 0 ? win / loss : (win > 0 ? Infinity : 0) };
}
function gateDecision(past, c) {
  const s = stats(past, c), why = []; let pass = true;
  if (s.n < c.minN) { pass = false; why.push(`only ${s.n} past trades (need ${c.minN})`); }
  else {
    if (!(s.low > s.be)) { pass = false; why.push(`TP probability ${pct(s.low)} is not above breakeven ${pct(s.be)}`); }
    if (!(s.exp > 0)) { pass = false; why.push(`past expectancy ${usd(s.exp)} per contract is not positive`); }
  }
  return { pass, why, s };
}

// System 4: tracks the numbers Topstep cares about and decides whether a trade is allowed and how big.
class Rules {
  constructor(c) { this.c = c; this.reset(); }
  reset() {
    this.closed = 0; this.day = null; this.dayClosed = 0; this.days = {}; this.peak = this.c.start;
    this.floor = this.c.start - this.c.maxLoss; this.tradedDays = new Set(); this.failed = false; this.dayHalt = false; this.nToday = 0;
  }
  roll(bar) {
    if (bar.day === this.day) return;
    if (this.day !== null) {
      this.days[this.day] = this.dayClosed;
      this.peak = Math.max(this.peak, this.c.start + this.closed);          // end-of-day balance
      this.floor = Math.min(this.c.start, this.peak - this.c.maxLoss);       // trails up, locks at start
    }
    this.day = bar.day; this.dayClosed = 0; this.dayHalt = false; this.nToday = 0;
  }
  record(pnl, day) { this.closed += pnl; this.dayClosed += pnl; this.nToday++; this.tradedDays.add(day); }
  snap(open) {
    const c = this.c, equity = c.start + this.closed + open, buffer = equity - this.floor;
    const best = Math.max(0, this.dayClosed, ...Object.values(this.days));
    return { equity, buffer, bufPct: buffer / c.maxLoss * 100, floor: this.floor, today: this.dayClosed + open, closed: this.closed,
             progress: this.closed / c.profitTarget, best, cons: this.closed > 0 ? best / this.closed * 100 : null,
             days: this.tradedDays.size, reached: this.closed >= c.profitTarget };
  }
  permit(riskPerC, open, kill) {
    const c = this.c, s = this.snap(open), why = [];
    if (this.failed) why.push('account failed (loss limit breached)');
    if (kill) why.push('kill switch is on');
    if (this.dayHalt) why.push('daily stop hit, done for the day');
    if (s.reached) why.push('profit target reached, stop trading');
    if (s.bufPct <= c.bufferHaltPct) why.push(`buffer ${s.bufPct.toFixed(0)}% is at or below the ${c.bufferHaltPct}% halt level`);
    if (this.nToday >= c.maxTradesPerDay) why.push(`max ${c.maxTradesPerDay} trades today`);
    const budget = Math.max(0, Math.min(c.maxRiskPerTrade, c.riskFracOfBuffer * s.buffer, c.dailyStop + s.today));
    const qty = Math.min(c.maxContracts, Math.floor(budget / riskPerC));
    if (!why.length && qty < 1) why.push(`risk ${usd(riskPerC)} per contract exceeds the ${usd(budget)} budget`);
    return { ok: !why.length, qty, budget, why };
  }
}

// System 3: places orders (simulated against the candles) and manages stop/target brackets.
class Executor {
  constructor(c) { this.c = c; this.reset(); }
  reset() { this.pos = null; this.pending = null; this.orders = []; this.trades = []; this.nid = 1; this.fills = 0; this.rejects = 0; this.slipSum = 0; }
  log(o) { const x = Object.assign({ id: this.nid++ }, o); this.orders.unshift(x); if (this.orders.length > 300) this.orders.pop(); return x; }
  place(i, bar, sig, qty) {
    const side = sig.dir === 'long' ? 'Buy' : 'Sell';
    this.pending = { sig, qty, side, i, o: this.log({ t: bar.t, i, side, qty, type: 'Market', price: sig.planned, status: 'Working', note: 'Entry, fills at next bar open' }) };
  }
  cancelPending(note) { if (this.pending) { this.pending.o.status = 'Canceled'; this.pending.o.note = note; this.pending = null; } }
  fillPending(i, bar) {
    const p = this.pending; if (!p) return null; this.pending = null;
    const s = p.sig.dir === 'long' ? 1 : -1, price = bar.o + s * this.c.slipTicks * this.c.tick;
    const risk = Math.abs(price - p.sig.stop), reward = Math.abs(p.sig.target - price);
    const bad = !canEnter(bar.mins, this.c) ? 'outside entry window' : (!(reward > 0 && risk > 0 && reward / risk >= 1) || (s > 0 ? price <= p.sig.stop : price >= p.sig.stop)) ? 'reward/risk below 1 after the gap' : null;
    if (bad) { p.o.status = 'Rejected'; p.o.note = 'Rejected: ' + bad; this.rejects++; return { rejected: bad }; }
    Object.assign(p.o, { status: 'Filled', price, t: bar.t, note: 'Entry filled' });
    const opp = p.side === 'Buy' ? 'Sell' : 'Buy';
    const stopO = this.log({ t: bar.t, i, side: opp, qty: p.qty, type: 'Stop', price: p.sig.stop, status: 'Working', note: 'Protective stop' });
    const tpO = this.log({ t: bar.t, i, side: opp, qty: p.qty, type: 'Limit', price: p.sig.target, status: 'Working', note: 'Take profit' });
    this.pos = { s, side: p.side, qty: p.qty, entry: price, stop: p.sig.stop, target: p.sig.target, openI: i, t: bar.t, stopO, tpO };
    this.fills++; this.slipSum += Math.abs(price - bar.o) / this.c.tick;
    return { filled: this.pos };
  }
  manage(i, bar) {
    const p = this.pos; if (!p) return null;
    const r = resolveBar(p, bar, i === p.openI, i - p.openI + 1, this.c);
    return r ? this.close(i, bar, r.price, r.reason) : null;
  }
  close(i, bar, price, reason) {
    const p = this.pos; this.pos = null;
    const gross = (price - p.entry) * p.s, pnl = gross * this.c.mult * p.qty - 2 * this.c.fee * p.qty;
    const tr = { openI: p.openI, closeI: i, t: bar.t, openT: p.t, side: p.side, qty: p.qty, entry: p.entry, exit: price, reason,
                 pnl, r: gross / Math.max(Math.abs(p.entry - p.stop), this.c.tick), day: bar.day };
    this.trades.push(tr);
    if (reason === 'tp') { Object.assign(p.tpO, { status: 'Filled', price }); p.stopO.status = 'Canceled'; }
    else if (reason === 'stop') { Object.assign(p.stopO, { status: 'Filled', price }); p.tpO.status = 'Canceled'; }
    else {
      p.stopO.status = 'Canceled'; p.tpO.status = 'Canceled';
      this.log({ t: bar.t, i, side: p.side === 'Buy' ? 'Sell' : 'Buy', qty: p.qty, type: 'Market', price, status: 'Filled', note: 'Exit: ' + reason });
    }
    return tr;
  }
  openPnl(price) { return this.pos ? (price - this.pos.entry) * this.pos.s * this.pos.qty * this.c.mult : 0; }
}
