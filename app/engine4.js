// ===== ENGINE PART 4: expectations and health for each system =====
Sim.prototype.health = function () {
  const c = this.c, R = this.rules, E = this.ex, i = Math.max(0, this.i - 1), bar = this.bars[i] || { mins: 0, c: 0, day: '' };
  const snap = R.snap(E.openPnl(bar.c)), past = this.past(i + 1), st = stats(past, c);
  const cut = Math.floor(past.length * 0.7), isS = stats(past.slice(0, cut), c), oosS = stats(past.slice(cut), c);
  const tr = E.trades, nTr = tr.length, net = tr.reduce((a, t) => a + t.pnl, 0);
  const liveTP = nTr ? tr.filter(t => t.reason === 'tp').length / nTr : 0, liveExp = mean(tr.map(t => t.pnl));
  const x = (l, d, ok, crit) => ({ l, d, ok, crit: !!crit });
  const approved = this.sigs.filter(s => s.decision === 'approved' && this.histBySig[s.sig.i] && this.histBySig[s.sig.i].exitI <= i).map(s => this.histBySig[s.sig.i].pnl1);
  const rejected = this.sigs.filter(s => (s.decision === 'rejected' || s.decision === 'blocked') && this.histBySig[s.sig.i] && this.histBySig[s.sig.i].exitI <= i).map(s => this.histBySig[s.sig.i].pnl1);
  const maxDay = Math.max(0, ...Object.values(this.sigDay));
  let peak = c.start, mdd = 0; for (const p of this.eq) { peak = Math.max(peak, p.eq); mdd = Math.max(mdd, peak - p.eq); }
  const working = E.orders.some(o => o.status === 'Working');
  const sys = [
    { id: 'scanner', name: '1 · Entry Scanner', role: 'Reads candles, finds fib continuation setups',
      m: [['Setups found', this.sigs.length], ['Today', this.sigDay[bar.day] || 0], ['Active leg', this.scan.leg && !this.scan.leg.dead && !this.scan.leg.used ? this.scan.leg.dir + ' ' + this.scan.leg.R.toFixed(3) : 'none']],
      e: [x('Enough candles loaded (150+)', this.bars.length + ' bars', this.bars.length >= 150),
          x(`Every setup has reward/risk ≥ ${c.minRR}`, '', this.sigs.every(s => s.sig.rr >= c.minRR)),
          x('No more than 6 setups in a day', 'max ' + maxDay, maxDay <= 6),
          x('Uses confirmed swings only (no look-ahead)', `swings confirm ${c.pivotLen} bars late`, true)] },
    { id: 'backtester', name: '2 · Backtester', role: 'Checks how often similar setups hit take-profit',
      m: [['Past trades', st.n], ['TP probability', st.n ? pct(st.pTP) : 'n/a'], ['Breakeven needs', st.n ? pct(st.be) : 'n/a']],
      e: [x(`Sample size ≥ ${c.minN}`, st.n + ' trades', st.n >= c.minN),
          x('TP probability above breakeven', st.n ? `${pct(st.low)} vs ${pct(st.be)}` : '', st.n >= c.minN ? st.low > st.be : null),
          x('Expectancy per contract above $0', st.n ? usd(st.exp) : '', st.n ? st.exp > 0 : null),
          x('In-sample vs out-of-sample TP rate within 15 pts', oosS.n >= 8 && isS.n >= 8 ? `${pct(isS.pTP)} vs ${pct(oosS.pTP)}` : 'need 8+ in each', oosS.n >= 8 && isS.n >= 8 ? Math.abs(isS.pTP - oosS.pTP) <= 0.15 : null)] },
    { id: 'rules', name: '4 · Rules Manager', role: 'Tracks Topstep limits and sizes every trade',
      m: [['Buffer to loss limit', usd(snap.buffer)], ['Today P&L', usd(snap.today)], ['Target progress', (snap.progress * 100).toFixed(0) + '%']],
      e: [x('Account alive (equity above floor)', `floor ${usd(snap.floor)}`, !R.failed && snap.buffer > 0, true),
          x('Buffer above 25% of the loss limit', snap.bufPct.toFixed(0) + '%', snap.bufPct >= 25, snap.bufPct < c.bufferHaltPct),
          x(`Today within your daily stop (${usd(c.dailyStop)} loss)`, usd(snap.today), snap.today > -c.dailyStop, true),
          x(`Position within ${c.maxContracts} contracts`, E.pos ? E.pos.qty + ' open' : 'flat', !E.pos || E.pos.qty <= c.maxContracts),
          x(`Flat by ${c.flatTime} CT`, E.pos ? 'holding' : 'flat', !(E.pos && inFlat(bar.mins, c)), true),
          x(`Best day under ${c.consistencyPct}% of profit`, snap.cons == null ? 'no profit yet' : snap.cons.toFixed(0) + '%', snap.cons == null ? null : snap.cons <= c.consistencyPct)] },
    { id: 'executor', name: '3 · Executor', role: 'Places orders with stop and target attached (simulated)',
      m: [['Orders', E.orders.length], ['Fills', E.fills], ['Open', E.pos ? `${E.pos.side} ${E.pos.qty}` : 'flat']],
      e: [x('Open trade has stop and target', E.pos ? 'attached' : 'no trade', E.pos ? !!(E.pos.stop && E.pos.target) : null, true),
          x('No rejected entries', E.rejects + ' rejected', E.rejects === 0),
          x('Average slippage ≤ 2 ticks', E.fills ? (E.slipSum / E.fills).toFixed(1) + ' ticks' : 'no fills', E.fills ? E.slipSum / E.fills <= 2 : null),
          x('No orphan working orders', working ? 'working order found' : 'clean', !working || !!(E.pos || E.pending))] },
    { id: 'performance', name: '5 · Performance Manager', role: 'Compares live results to the backtest across all systems',
      m: [['Net P&L', usd(net)], ['Trades', nTr], ['TP rate', nTr ? pct(liveTP) : 'n/a']],
      e: [x(`Live TP rate within ${c.driftBand} pts of backtest`, nTr >= c.driftMinN ? `${pct(liveTP)} vs ${pct(st.pTP)}` : `need ${c.driftMinN}+ trades`, nTr >= c.driftMinN ? liveTP >= st.pTP - c.driftBand / 100 : null),
          x('Live expectancy at or above $0', nTr >= 10 ? usd(liveExp) + ' per trade' : 'need 10+ trades', nTr >= 10 ? liveExp >= 0 : null),
          x('Gate adds value (approved beat rejected, hindsight)', approved.length >= 8 && rejected.length >= 8 ? `${usd(mean(approved))} vs ${usd(mean(rejected))}` : 'need 8+ of each', approved.length >= 8 && rejected.length >= 8 ? mean(approved) >= mean(rejected) : null),
          x('No pause or kill switch active', this.paused || (this.kill ? 'kill switch on' : 'running'), !this.paused && !this.kill)] }
  ];
  for (const s of sys) {
    const bad = s.e.filter(e => e.ok === false);
    s.status = bad.some(e => e.crit) ? 'halt' : bad.length ? 'warn' : (s.e.some(e => e.ok === true) ? 'ok' : 'idle');
    if (s.id === 'performance' && (this.paused || this.kill) && s.status === 'ok') s.status = 'warn';
  }
  const rank = { idle: 0, ok: 0, warn: 1, halt: 2 }, overall = sys.reduce((a, s) => rank[s.status] > rank[a] ? s.status : a, 'ok');
  const perf = { net, nTr, liveExp, mdd, st, snap, counts: this.counts, rejects: E.rejects, fills: E.fills,
                 hypRejected: rejected.reduce((a, v) => a + v, 0), hypRejectedN: rejected.length, appN: approved.length };
  return { sys, overall, perf, st, isS, oosS, snap };
};
