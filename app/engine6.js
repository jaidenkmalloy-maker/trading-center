// ===== ENGINE PART 6: learning from data, live runner, assistants =====
const STATUS_TXT = { ok: 'Healthy', warn: 'Attention', halt: 'HALT', idle: 'Waiting' };
const memStore = () => { const m = {}; return { get: k => (k in m ? m[k] : null), set: (k, v) => { m[k] = v; } }; };

// ---- LiveRunner: ties the gateway, history store, live simulation, broker and learner together. No DOM in here. ----
class LiveRunner {
  constructor(o) {
    this.o = Object.assign({ base: 'https://api.topstepx.com', tf: 15, histDays: 120, live: true, now: () => Date.now(), store: memStore(), barsEvery: 15000, mgrEvery: 5000, balEvery: 20000, learnMode: 'suggest', cfg: {}, storeCap: 30000 }, o);
    this.api = this.o.api || new TopstepAPI(this.o.base); this.sim = null; this.broker = null; this.learner = null; this.accounts = []; this.account = null; this.contract = null;
    this.lastBars = 0; this.lastMgr = 0; this.lastBal = 0; this.busy = false; this.lastError = null; this.status = 'disconnected'; this.barsSinceLearn = 1e9; this.cred = null; this.newBars = 0;
  }
  async connect(user, key) { this.cred = { user, key }; await this.api.login(user, key); this.accounts = await this.api.accounts(); this.status = 'connected'; return this.accounts; }
  async findContracts(symbol) {
    // Topstep serves two data feeds (live and sim). Try the preferred one, then the other, and remember which one works.
    const tried = []; let list = [];
    for (const live of [this.o.live, !this.o.live]) {
      let l = []; try { l = await this.api.contracts(symbol, live); } catch (e) { tried.push((live ? 'live' : 'sim') + ': ' + e.message); continue; }
      tried.push((live ? 'live' : 'sim') + ': ' + l.length + ' result(s)'); if (l.length) { list = l; this.o.live = live; break; }
    }
    this.lastSearch = { tried, names: list.map(c => c.name + (c.activeContract ? '' : ' (inactive)')) };
    const up = symbol.toUpperCase(), mine = list.filter(c => c.activeContract && String(c.symbolId || '').toUpperCase().endsWith('.' + up));
    if (mine.length) return mine; const act = list.filter(c => c.activeContract); if (act.length) return act;
    return list.filter(c => String(c.name || '').toUpperCase().startsWith(up));   // none flagged active: let the user choose, with the names visible
  }
  loadStored(cid) { try { const raw = this.o.store.get('bars_' + cid); return raw ? JSON.parse(raw).map(a => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4] })) : []; } catch (e) { return []; } }
  saveStored(cid, bars) { try { this.o.store.set('bars_' + cid, JSON.stringify(bars.slice(-this.o.storeCap).map(b => [b.t, b.o, b.h, b.l, b.c]))); } catch (e) { /* storage full: keep running */ } }
  async start(accountId, contract, symbol) {
    const o = this.o, tfms = o.tf * 60000, now = o.now(); this.account = this.accounts.find(a => a.id === accountId); this.contract = contract; if (!this.account) throw new Error('Pick an account first.');
    let bars = this.loadStored(contract.id); const stored = bars.length;
    const from = stored ? bars[bars.length - 1].t - 3 * tfms : now - o.histDays * 86400000;
    let nb = await this.api.bars(contract.id, from, now, o.tf, o.live);
    if (!nb.length && !stored) { this.liveFlagFlipped = true; nb = await this.api.bars(contract.id, from, now, o.tf, !o.live); if (nb.length) o.live = !o.live; }
    const have = new Set(bars.map(b => b.t)); for (const b of nb) if (!have.has(b.t)) bars.push(b);
    bars.sort((a, b) => a.t - b.t); bars = bars.filter(b => b.t + tfms <= now); this.saveStored(contract.id, bars);
    if (bars.length < 200) throw new Error(`Only ${bars.length} candles came back for ${contract.name}. Need at least 200. Check that your market-data subscription is active.`);
    const dec = Math.max(0, Math.min(6, (String(contract.tickSize).split('.')[1] || '').length)), I = INSTR[symbol] || {};
    const cfg = Object.assign({ minLeg: I.minLeg, stopBuf: I.stopBuf }, o.cfg, { symbol, tick: contract.tickSize, mult: contract.tickValue / contract.tickSize, dec });
    for (const k of Object.keys(cfg)) if (cfg[k] === undefined) delete cfg[k];
    if (!Array.isArray(cfg.strategies)) cfg.strategies = [];     // live: trade only what the Backtester approves
    this.sim = new LiveSim(bars, cfg); this.broker = new Broker(this.api, this.sim, { mode: 'watch', accountId, contract, tf: o.tf, now: o.now });
    this.sim.initAccount(this.account.balance); this.learner = new Lab(this.sim); this.sim.lab = this.learner; this.sim.onStrategies = l => this.onLearned && this.onLearned({ strategies: l }); this.status = 'running'; this.lastBars = this.lastMgr = this.lastBal = now;
    this.sim.note(this.sim.i - 1, 'scanner', 'info', `Live data loaded: ${bars.length} candles (${stored ? 'stored history plus new' : 'fresh download'}). Contract ${contract.name}, tick ${contract.tickSize}, $${(contract.tickValue / contract.tickSize).toFixed(2)} per point.`, true);
    return this.sim;
  }
  async pollBars() {
    const o = this.o, sim = this.sim, tfms = o.tf * 60000, now = o.now(), last = sim.bars[sim.bars.length - 1];
    const nb = await this.api.bars(this.contract.id, last.t - 3 * tfms, now, o.tf, o.live), fresh = nb.filter(b => b.t > last.t && b.t + tfms <= now);
    for (const b of fresh) { const quiet = now - (b.t + tfms) > 2 * tfms; sim.addBar({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }, quiet); this.newBars++; this.barsSinceLearn++; }
    if (fresh.length) { this.lastBarAt = now; this.saveStored(this.contract.id, sim.bars); this.maybeLearn(); }
    return fresh.length;
  }
  async pollBalance() { const acc = (await this.api.accounts()).find(a => a.id === this.account.id); if (acc) { this.account = acc; this.lastBalOkAt = this.o.now(); this.sim.syncBalance(acc.balance); if (acc.canTrade === false) this.broker.alert('Topstep says this account can no longer trade.'); } }
  maybeLearn() {
    if (this.barsSinceLearn < 96 || this.learner.running) return; this.barsSinceLearn = 0;
    this.learner.run().then(r => { if (r && r.change && this.o.learnMode === 'auto' && !this.broker.busy()) this.learner.apply(l => this.onLearned && this.onLearned({ strategies: l })); if (this.onChange) this.onChange(); }).catch(e => { this.lastError = 'Learning failed: ' + e.message; });
  }
  async tick() {
    if (this.busy || !this.sim) return; this.busy = true; const o = this.o;
    try {
      const now = o.now(), last = this.sim.bars[this.sim.bars.length - 1];
      if (now - this.lastBars >= o.barsEvery) { this.lastBars = now; await this.guard(() => this.pollBars()); }
      if (now - this.lastBal >= o.balEvery) { this.lastBal = now; await this.guard(() => this.pollBalance()); }
      if ((this.broker.state || this.broker.unmanaged) && now - (this.lastPx || 0) >= 10000) { this.lastPx = now; try { const nb = await this.api.bars(this.contract.id, now - 15 * 60000, now, 1, o.live, 3, true); if (nb.length) { this.livePrice = nb[nb.length - 1].c; this.livePriceAt = now; } } catch (e) { } }
      if (now - this.lastMgr >= o.mgrEvery) { this.lastMgr = now; await this.broker.manage(this.livePrice != null && now - this.livePriceAt < 60000 ? this.livePrice : last.c); }
      this.sim.audit(now, this.dataAgeSec(), { balAgeSec: this.lastBalOkAt ? (now - this.lastBalOkAt) / 1000 : null });
      this.lastError = null;
    } catch (e) { this.lastError = e.message; this.broker.err(e.message); }
    finally { this.busy = false; if (this.onChange) this.onChange(); }
  }
  async guard(fn) {
    try { return await fn(); }
    catch (e) { if (e.kind === 'auth' && this.cred) { await this.api.login(this.cred.user, this.cred.key); return fn(); } throw e; }
  }
  dataAgeSec() { const l = this.sim && this.sim.bars[this.sim.bars.length - 1]; return l ? Math.round((this.o.now() - (l.t + this.o.tf * 60000)) / 1000) : null; }
}

// ---- Assistants: answer questions about each system from the app's own numbers (no outside AI needed) ----
function snapshotForAI(sim, broker, learner) {
  const h = sim.health(), c = sim.c;
  return { instrument: c.symbol, mode: broker ? MODE_TXT[broker.o.mode] : 'replay', killSwitch: sim.kill, pausedBy: sim.paused || null,
    systems: h.sys.map(s => ({ name: s.name, status: s.status, metrics: Object.fromEntries(s.m), expectations: s.e.map(e => `${e.ok === true ? 'OK' : e.ok === false ? 'FAIL' : '-'} ${e.l}: ${e.d}`) })),
    settings: { start: c.start, maxLoss: c.maxLoss, dailyStop: c.dailyStop, profitTarget: c.profitTarget, maxContracts: c.maxContracts, maxRiskPerTrade: c.maxRiskPerTrade, maxTradesPerDay: c.maxTradesPerDay, flatTime: c.flatTime, entryCutoff: c.entryCutoff, zoneLo: c.zoneLo, minRR: c.minRR, pivotLen: c.pivotLen, tpMode: c.tpMode, gate: c.gate },
    recentDecisions: sim.decisions.slice(0, 12).map(d => `[${d.sys}] ${d.msg}`), realTrades: sim.ex.trades.slice(-8).map(t => `${t.side} ${t.qty} ${t.entry}->${t.exit} ${t.reason} ${t.pnl.toFixed(0)}`),
    broker: broker ? { position: broker.state ? `${broker.state.dir} ${broker.state.qty} @ ${broker.state.entry}` : 'flat', unmanaged: !!broker.unmanaged, recentLog: broker.log.slice(0, 8).map(l => l.msg), errors: broker.errors.slice(0, 3).map(e => e.msg) } : null,
    learning: learner && learner.lastRun ? { why: learner.lastRun.why, tried: learner.lastRun.tried, adopt: learner.lastRun.adopt } : null };
}
const SYS_PERSONA = {
  scanner: 'You are the Entry Scanner of a trading control center. You read candles and find fib-continuation setups. You explain what you see and why a setup was or was not flagged.',
  backtester: 'You are the Backtester. You judge how often similar past setups reached take-profit and whether the edge is statistically credible. Be skeptical and honest about sample size.',
  executor: 'You are the Executor. You place and manage real orders with stop and target on a Topstep account, subject to the mode the user chose. Describe what you did and why.',
  rules: 'You are the Rules Manager. You track Topstep account limits (loss-limit floor, daily stop, profit target, consistency, contracts, flat time) and size trades.',
  performance: 'You are the Performance Manager. You compare live results with the backtest, watch for drift, and can pause the bot.',
  all: 'You are the overseer of a five-system trading control center. Summarize how the whole system is doing and what the user should watch.'
};
function assistantReply(sysId, q, ctx) {
  const { sim, broker, learner } = ctx, text = String(q || '').toLowerCase(), h = sim.health(), c = sim.c, R = sim.rules, snap = h.snap, S = h.sys.find(s => s.id === sysId);
  const has = (...w) => w.some(x => text.includes(x)), fails = s => s.e.filter(e => e.ok === false).map(e => `${e.l} (${e.d})`);
  // commands (the UI asks you to confirm before they run)
  if (has('kill', 'emergency', 'stop everything', 'panic')) return { text: sim.kill ? 'The kill switch is already ON.' : 'I can switch the kill switch on. That stops new orders and flattens any open position.', action: sim.kill ? null : { label: 'Turn kill switch ON', fn: 'kill' }, cmd: true };
  if (has('flatten', 'close position', 'close it', 'get out', 'exit now')) return { text: broker && (broker.state || broker.unmanaged) ? 'I can flatten the position now (market close, then cancel working orders).' : 'There is no open position to flatten.', action: broker && (broker.state || broker.unmanaged) ? { label: 'Flatten now', fn: 'flatten' } : null, cmd: true };
  if (has('resume', 'unpause', 'release')) return { text: sim.paused || sim.kill ? 'I can release the pause / kill switch. Check why it was on first.' : 'Nothing is paused.', action: sim.paused ? { label: 'Release pause', fn: 'resume' } : (sim.kill ? { label: 'Release kill switch', fn: 'unkill' } : null), cmd: true };
  if (has('pause') && sysId === 'performance') return { text: 'I can pause new entries. Open trades keep their stop and target.', action: { label: 'Pause new entries', fn: 'pause' }, cmd: true };
  if (has('watch only', 'go to watch', 'switch to watch')) return { text: 'Switching to Watch only means nothing is ever sent.', action: { label: 'Watch only', fn: 'mode:watch' }, cmd: true };
  if (has('dry run', 'dry-run')) return { text: 'Dry run builds orders and logs them without sending.', action: { label: 'Dry run', fn: 'mode:dry' }, cmd: true };
  const out = [];
  if (sysId === 'scanner' || sysId === 'all') {
    const list = c.strategies, names = Array.isArray(list) ? list.map(x => x.label || stratLabel(x.id, x.params)) : ['Fib continuation (original)'], g = sim.scan.leg, live = g && !g.dead && !g.used;
    if (sysId === 'scanner') {
      if (!names.length) out.push('I have nothing to scan for: the Backtester has not approved any strategy yet. I only look for setups from strategies that passed its tests.');
      else if (has('why', 'no trade', 'not trading', 'nothing')) { const d = sim.decisions.find(x => x.sys === 'scanner' && x.kind === 'signal'); out.push(`I am scanning every finished candle for: ${names.join('; ')}. A setup needs the strategy's entry condition, a valid stop and target, and the entry window (no entries after ${c.entryCutoff} CT).`); out.push(d ? 'Last setup I flagged: ' + d.msg : 'I have not flagged a setup yet.'); }
      else out.push(`Scanning for ${names.length} strateg${names.length === 1 ? 'y' : 'ies'}: ${names.join('; ')}. ${sim.sigs.length} setup${sim.sigs.length === 1 ? '' : 's'} flagged since start.${live ? ' (Fib leg active: ' + g.dir + ' ' + g.R.toFixed(c.dec) + '.)' : ''}`);
    }
  }
  if (sysId === 'backtester' || sysId === 'all') {
    const lr = ctx.learner && ctx.learner.lastRun;
    if (sysId === 'backtester') {
      if (lr) {
        out.push(`Last Strategy Lab run tested ${lr.tried} settings of ${Object.keys(STRATS).length} known strategies on ${lr.nBars.toLocaleString()} candles. ${lr.why}`);
        if (has('why', 'reject', 'fail', 'strateg', 'which', 'list', 'rank')) out.push(lr.perStrategy.map(p => `${STRATS[p.id].name}: ${p.ok ? 'APPROVED (' + usd(p.exp) + ' per contract, ' + pct(p.pTP) + ' reach target)' : p.why}`).join(' | '));
        if (has('trust', 'reliable', 'confident', 'overfit', 'luck')) out.push(lr.caution);
      } else out.push('The Strategy Lab has not run yet. It needs about 1,500 candles of history.');
    }
  }
  if (sysId === 'executor' || sysId === 'all') {
    if (sysId === 'executor') {
      out.push(broker ? `Mode: ${MODE_TXT[broker.o.mode]}. ${broker.state ? `In a ${broker.state.dir} ${broker.state.qty} from ${broker.state.entry} (stop ${broker.state.stop}, target ${broker.state.target}).` : broker.unmanaged ? 'There is a position I did not open; I am not touching it.' : 'Flat.'}` : 'Replay mode: I only simulate.');
      if (broker && broker.pending) out.push(`An order is waiting for your OK: ${broker.pending.t.side} ${broker.pending.t.qty}.`);
      if (broker && (has('why', 'last', 'happen', 'log'))) out.push('Recent: ' + broker.log.slice(0, 3).map(l => l.msg).join(' | '));
      if (broker && broker.errors.length) out.push('Latest problem: ' + broker.errors[0].msg);
    }
  }
  if (sysId === 'rules' || sysId === 'all') {
    if (sysId === 'rules') out.push(`Equity about ${usd(snap.equity)}; loss-limit floor ${usd(snap.floor)}, so ${usd(snap.buffer)} of buffer (${snap.bufPct.toFixed(0)}%). Today ${usd(snap.today)} against a ${usd(c.dailyStop)} daily stop. Progress to target ${(snap.progress * 100).toFixed(0)}%. ${R.nToday} of ${c.maxTradesPerDay} trades used today.`, 'Max I would risk on the next trade: ' + usd(Math.max(0, Math.min(c.maxRiskPerTrade, c.riskFracOfBuffer * snap.buffer, c.dailyStop + snap.today))) + '. The floor shown is my estimate; TopstepX is the authority.');
  }
  if (sysId === 'performance' || sysId === 'all') {
    if (sysId === 'performance') { const p = h.perf; out.push(`Real trades: ${p.nTr}, net ${usd(p.net)}${p.nTr ? ', average ' + usd(p.liveExp) : ''}. Max drawdown ${usd(p.mdd)}.`, sim.paused ? 'I have paused entries: ' + sim.paused : 'No pause active.'); const bad = (sim.auditItems || []).filter(a => a.ok === false); out.push(bad.length ? 'Not doing their part: ' + bad.map(a => a.label + ' (' + a.detail + ')').join('; ') + '.' : 'Every system checked in on time.'); if (sim.dropped && sim.dropped.length) out.push('Strategies I switched off: ' + sim.dropped.map(d => d.why).join('; ')); }
  }
  if (has('learn', 'improv', 'adapt', 'propos') || sysId === 'performance' && has('suggest')) { if (learner && learner.lastRun) out.push('Learning: ' + learner.lastRun.why + (learner.proposal ? ' A change is waiting for your approval in the Learning panel.' : '')); else out.push('Learning has not run yet; it needs about 1,500 candles and runs about once a day of data.'); }
  if (sysId === 'all') {
    out.push(`Overall: ${STATUS_TXT[h.overall]}.`); for (const s of h.sys) { const f = fails(s); out.push(`${s.name}: ${STATUS_TXT[s.status]}${f.length ? ' — ' + f.join('; ') : ''}`); }
  } else if (S && (has('status', 'ok', 'health', 'how') || !out.length)) { const f = fails(S); out.push(`${S.name} is ${STATUS_TXT[S.status]}.` + (f.length ? ' Problems: ' + f.join('; ') + '.' : ' All its expectations are met or not yet testable.')); }
  if (!out.length) out.push('Ask me about status, why something happened, my numbers, or tell me to pause / flatten / kill.');
  return { text: out.join(' '), action: null };
}
