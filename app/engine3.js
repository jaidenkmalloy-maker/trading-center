// ===== ENGINE PART 3: the simulation that wires all five systems together =====
class Sim {
  constructor(bars, cfg) { this.bars = bars; this.c = Object.assign({}, DEFAULTS, cfg || {}); this.reset(); }
  reset() {
    const b = this.bars, c = this.c;
    this.i = 0; this.scan = makeScanner(b, c); this.rules = new Rules(c); this.ex = new Executor(c);
    this.kill = false; this.paused = null; this.decisions = []; this.sigs = []; this.eq = []; this.sigDay = {}; this.ticket = null; this.counts = { gate: 0, rules: 0, ignored: 0, approved: 0 };
    // System 2's memory: every setup the scanner would have produced, with how it turned out (independent of what we traded).
    const hs = makeScanner(b, c); this.hist = []; this.histBySig = {};
    for (let k = 0; k < b.length; k++) { const s = hs.onBar(k); if (s) { const t = simTrade(b, s, c); if (t) { this.hist.push(t); this.histBySig[s.i] = t; } } }
    this.hist.sort((x, y) => x.exitI - y.exitI);
  }
  note(i, sys, kind, msg, ok) {
    const b = this.bars[Math.min(i, this.bars.length - 1)];
    this.decisions.unshift({ i, t: b ? b.t : 0, sys, kind, msg, ok }); if (this.decisions.length > 400) this.decisions.pop();
    if (this.onNote) { try { this.onNote(sys, kind, msg, ok); } catch (x) { } }
  }
  past(i, strat) { return this.hist.filter(t => t.exitI < i && (!strat || t.strat === strat)).slice(-this.c.lookback); }
  setStrategies(list) { this.c.strategies = list; this.reset(); }
  closeTrade(i, bar, price, reason, why) {
    const tr = this.ex.close(i, bar, price, reason); this.rules.record(tr.pnl, tr.day);
    this.note(i, 'executor', 'exit', `${tr.side === 'Buy' ? 'Long' : 'Short'} ${tr.qty} closed (${why || reason}) @ ${tr.exit.toFixed(this.c.dec)}, ${usd(tr.pnl)}`, tr.pnl >= 0);
    return tr;
  }
  step() {
    const b = this.bars, i = this.i; if (i >= b.length) return false;
    const bar = b[i], c = this.c, R = this.rules, E = this.ex;
    R.roll(bar);
    const f = E.fillPending(i, bar);
    if (f && f.filled) this.note(i, 'executor', 'fill', `${f.filled.side} ${f.filled.qty} filled @ ${f.filled.entry.toFixed(this.c.dec)}, stop ${f.filled.stop.toFixed(this.c.dec)}, target ${f.filled.target.toFixed(this.c.dec)}`, true);
    else if (f && f.rejected) this.note(i, 'executor', 'reject', 'Entry rejected: ' + f.rejected, false);
    if (E.pos) {
      const r = resolveBar(E.pos, bar, i === E.pos.openI, i - E.pos.openI + 1, c);
      if (r) this.closeTrade(i, bar, r.price, r.reason);
    }
    // account protection checked on every bar close
    const open = E.openPnl(bar.c), eq = c.start + R.closed + open;
    if (!R.failed && eq <= R.floor) {
      R.failed = true; this.kill = true; E.cancelPending('account failed'); this.halt('loss limit breached');
      if (E.pos) this.closeTrade(i, bar, bar.c, 'breach', 'loss limit breached');
      this.note(i, 'rules', 'halt', 'LOSS LIMIT BREACHED. Account would be failed. All systems halted.', false);
    } else if (!R.dayHalt && R.dayClosed + open <= -c.dailyStop) {
      R.dayHalt = true; E.cancelPending('daily stop'); this.halt('daily stop');
      if (E.pos) this.closeTrade(i, bar, bar.c, 'daily-stop', 'daily stop');
      this.note(i, 'rules', 'halt', `Daily stop of ${usd(c.dailyStop)} hit. Flat until the next trading day.`, false);
    } else if (this.kill && E.pos) this.closeTrade(i, bar, bar.c, 'kill', 'kill switch');
    const sig = this.scan.onBar(i);
    if (sig) this.handleSignal(i, bar, sig);
    this.perfCheck(i);
    this.eq.push({ i, t: bar.t, eq: c.start + R.closed + E.openPnl(bar.c) });
    this.i++;
    if (!this.live && this.i >= b.length && E.pos) { this.closeTrade(i, bar, bar.c, 'end-of-data'); }
    return true;
  }
  handleSignal(i, bar, sig) {
    const c = this.c, R = this.rules, E = this.ex, rec = { sig, decision: 'approved', why: '' }; this.sigs.push(rec);
    this.sigDay[bar.day] = (this.sigDay[bar.day] || 0) + 1;
    this.note(i, 'scanner', 'signal', `${sig.dir.toUpperCase()} setup ${sig.fibRetr != null ? 'at the ' + (sig.fibRetr * 100).toFixed(0) + '% retracement' : '(' + (sig.name || 'strategy') + ')'}: entry ~${sig.planned.toFixed(this.c.dec)}, stop ${sig.stop.toFixed(this.c.dec)}, target ${sig.target.toFixed(this.c.dec)} (R:R ${sig.rr.toFixed(2)})`, true);
    const stop = (d, w, cnt) => { rec.decision = d; rec.why = w; if (cnt) this.counts[cnt]++; };
    if (this.paused) { stop('blocked', 'paused by performance manager', 'rules'); this.note(i, 'performance', 'pause', 'Signal skipped: ' + this.paused, false); return; }
    if (E.pos || E.pending || this.extBusy()) { stop('ignored', 'position already open', 'ignored'); this.note(i, 'executor', 'skip', 'Signal ignored: already in a trade or order pending', null); return; }
    const g = gateDecision(this.past(i, sig.strat), c); rec.gate = g;
    if (!g.pass && c.gate === 'enforce') { stop('rejected', g.why.join('; '), 'gate'); this.note(i, 'backtester', 'reject', 'Setup rejected: ' + g.why.join('; '), false); return; }
    this.note(i, 'backtester', 'approve', g.pass ? `Setup approved: past TP rate ${pct(g.s.pTP)} (low bound ${pct(g.s.low)}) vs breakeven ${pct(g.s.be)} over ${g.s.n} trades` : `Advisory mode: would have been rejected (${g.why.join('; ')})`, g.pass);
    const riskPerC = Math.abs(sig.planned - sig.stop) * c.mult + 2 * c.fee + c.slipTicks * c.tick * c.mult;
    const p = R.permit(riskPerC, E.openPnl(bar.c), this.kill);
    if (!p.ok) { stop('blocked', p.why.join('; '), 'rules'); this.note(i, 'rules', 'block', 'Trade blocked: ' + p.why.join('; '), false); return; }
    E.place(i, bar, sig, p.qty); this.counts.approved++;
    this.ticket = { t: bar.t, side: sig.dir === 'long' ? 'BUY' : 'SELL', qty: p.qty, stop: sig.stop, target: sig.target, planned: sig.planned, risk: p.qty * riskPerC };
    this.note(i, 'rules', 'size', `Size ${p.qty} contract(s): risk about ${usd(p.qty * riskPerC)} of a ${usd(p.budget)} budget`, true);
    this.note(i, 'executor', 'order', `Order placed: ${sig.dir === 'long' ? 'BUY' : 'SELL'} ${p.qty} ${c.symbol} at market with stop and target attached`, true);
  }
  perfCheck(i) {
    const n = this.ex.trades.length; if (this.paused || n < this.c.driftMinN) return;
    const tr = this.ex.trades, live = tr.filter(t => t.reason === 'tp').length / n, exp = stats(this.past(i), this.c).pTP;
    if (live < exp - this.c.driftBand / 100 && mean(tr.map(t => t.pnl)) < 0) {
      this.paused = `live TP rate ${pct(live)} is far below the backtest's ${pct(exp)} and expectancy is negative`;
      this.note(i, 'performance', 'pause', 'New entries paused: ' + this.paused, false);
    }
  }
  halt(why) {}            // live mode overrides: flatten the real account
  extBusy() { return false; }
  setKill(on) {
    this.kill = on; const i = Math.max(0, this.i - 1), bar = this.bars[i];
    if (on) { this.ex.cancelPending('kill switch'); if (this.ex.pos && bar) this.closeTrade(i, bar, bar.c, 'kill', 'kill switch'); }
    this.note(i, 'rules', on ? 'halt' : 'resume', on ? 'Kill switch ON: no new orders, open trade flattened.' : 'Kill switch released.', !on);
  }
}
