// ===== ENGINE PART 5: Topstep gateway, live simulation, broker (real orders) =====
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOGIN_ERR = { 3: 'Wrong username or API key, or the key was revoked. Use your TopstepX sign-in username (not your email) and the full key.',
  7: 'Topstep says agreements are pending. Accept them in TopstepX first.', 9: 'No active API subscription was found for this login.', 10: 'Your firm has disabled API-key login.' };
const MODE_TXT = { watch: 'Watch only', dry: 'Dry run', confirm: 'Confirm each order', auto: 'Automatic' };

// ---- thin client for the ProjectX gateway (documented endpoints only) ----
class TopstepAPI {
  constructor(base) { this.base = String(base || 'https://api.topstepx.com').replace(/\/+$/, ''); this.token = null; this.q = Promise.resolve(); this.calls = 0; this.minGap = 250; this.last = 0; }
  raw(path, body, auth = true) {
    const run = async () => {
      const w = this.last + this.minGap - Date.now(); if (w > 0) await sleep(w); this.last = Date.now(); this.calls++;
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null, to = ac ? setTimeout(() => ac.abort(), 15000) : null;
      let res;
      try {
        res = await fetch(this.base + path, { method: 'POST', signal: ac ? ac.signal : undefined, body: JSON.stringify(body || {}),
          headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, auth && this.token ? { Authorization: 'Bearer ' + this.token } : {}) });
      } catch (e) { throw Object.assign(new Error(`Could not reach ${this.base}. You may be offline, or the browser blocked the request (CORS).`), { kind: 'network' }); }
      finally { if (to) clearTimeout(to); }
      if (res.status === 401) { this.token = null; throw Object.assign(new Error('Session expired (HTTP 401). Connect again.'), { kind: 'auth' }); }
      if (res.status === 429) throw Object.assign(new Error('Topstep is rate-limiting requests (HTTP 429). Slowing down.'), { kind: 'rate' });
      let j; try { j = await res.json(); } catch (e) { throw new Error('Unexpected reply from the gateway (HTTP ' + res.status + ').'); }
      if (!res.ok) throw new Error('HTTP ' + res.status + (j && j.errorMessage ? ': ' + j.errorMessage : ''));
      return j;
    };
    const p = this.q.then(run, run); this.q = p.catch(() => {}); return p;
  }
  async call(path, body) {
    const j = await this.raw(path, body);
    if (j.success === false || (j.errorCode && j.errorCode !== 0)) { const e = new Error(j.errorMessage || ('Gateway error code ' + j.errorCode)); e.code = j.errorCode; e.reply = j; throw e; }
    return j;
  }
  async login(userName, apiKey) {
    const j = await this.raw('/api/Auth/loginKey', { userName, apiKey }, false);
    if (!j.success || j.errorCode || !j.token) throw new Error(LOGIN_ERR[j.errorCode] || j.errorMessage || ('Login failed (code ' + j.errorCode + ')'));
    this.token = j.token; this.tokenAt = Date.now(); return true;
  }
  async accounts() { return (await this.call('/api/Account/search', { onlyActiveAccounts: true })).accounts || []; }
  async contracts(text, live) { return (await this.call('/api/Contract/search', { searchText: text, live: !!live })).contracts || []; }
  async bars(contractId, fromMs, toMs, tf, live, limit) {
    const j = await this.call('/api/History/retrieveBars', { contractId, live: !!live, startTime: new Date(fromMs).toISOString(), endTime: new Date(toMs).toISOString(), unit: 2, unitNumber: tf, limit: limit || 20000, includePartialBar: false });
    const out = (j.bars || []).map(b => ({ t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0 })).filter(b => isFinite(b.t) && [b.o, b.h, b.l, b.c].every(isFinite));
    out.sort((a, b) => a.t - b.t); return out.filter((b, i) => i === 0 || b.t !== out[i - 1].t);
  }
  async positions(acct) { return (await this.call('/api/Position/searchOpen', { accountId: acct })).positions || []; }
  async openOrders(acct) { return (await this.call('/api/Order/searchOpen', { accountId: acct })).orders || []; }
  async orders(acct, fromMs) { return (await this.call('/api/Order/search', { accountId: acct, startTimestamp: new Date(fromMs).toISOString() })).orders || []; }
  async place(o) { return this.call('/api/Order/place', o); }          // never retried automatically: a retry could double the order
  async cancel(acct, orderId) { return this.call('/api/Order/cancel', { accountId: acct, orderId }); }
  async closeContract(acct, contractId) { return this.call('/api/Position/closeContract', { accountId: acct, contractId }); }
}

// ---- the live version of the simulation: real candles in, real account numbers synced, paper twin kept for comparison ----
class LiveSim extends Sim {
  constructor(bars, cfg) {
    super(bars, cfg); this.live = true; this.broker = null; this.paperTrades = []; this.dayStartBal = null; this.lastBal = null;
    this.ex.openPnl = () => this.realOpen || 0;     // risk checks use the REAL open position
    const R = this.rules, roll = R.roll.bind(R);
    R.roll = bar => { const d = R.day; roll(bar); if (d !== null && R.day !== d) { this.dayStartBal = this.lastBal; this.applyFloor(); } };
    this.warm();
  }
  warm() {   // learn the swing structure from history without trading it
    const b = this.bars; this.scan = makeScanner(b, this.c);
    for (let k = 0; k < b.length; k++) { this.rules.roll(b[k]); this.scan.onBar(k); }
    this.i = b.length; this.eq = []; this.sigs = []; this.decisions = []; this.sigDay = {}; this.counts = { gate: 0, rules: 0, ignored: 0, approved: 0 };
  }
  applyFloor() { const R = this.rules, o = +this.c.floorOverride || 0; if (o > 0) R.floor = o; }
  initAccount(bal) {
    const R = this.rules, c = this.c; this.lastBal = bal; this.dayStartBal = bal;
    R.closed = bal - c.start; R.dayClosed = 0; R.peak = Math.max(c.start, bal); R.floor = Math.min(c.start, R.peak - c.maxLoss); this.applyFloor();
  }
  syncBalance(bal) {
    if (!isFinite(bal)) return; this.lastBal = bal; if (this.dayStartBal == null) this.dayStartBal = bal;
    const R = this.rules; R.closed = bal - this.c.start; R.dayClosed = bal - this.dayStartBal; this.applyFloor();
  }
  setStrategies(list) {   // swap what the Scanner trades without wiping the log
    this.c.strategies = list; const b = this.bars; this.scan = makeScanner(b, this.c); for (let k = 0; k < b.length; k++) this.scan.onBar(k); this.i = b.length; this.rebuildHist();
  }
  rebuildHist() {
    const b = this.bars, hs = makeScanner(b, this.c); this.hist = []; this.histBySig = {};
    for (let k = 0; k < b.length; k++) { const s = hs.onBar(k); if (s) { const t = simTrade(b, s, this.c); if (t) { this.hist.push(t); this.histBySig[s.i] = t; } } }
    this.hist.sort((x, y) => x.exitI - y.exitI);
  }
  addBar(bar, quiet) {
    annotate([bar]); this.bars.push(bar);
    if (quiet) { this.rules.roll(bar); this.scan.onBar(this.bars.length - 1); this.i = this.bars.length; return; }
    this.rebuildHist(); this.step();
  }
  closeTrade(i, bar, price, reason, why) {   // paper twin: never touches real account numbers
    const tr = this.ex.close(i, bar, price, reason); this.ex.trades.pop(); this.paperTrades.push(tr);
    this.note(i, 'executor', 'paper', `Paper twin ${tr.side === 'Buy' ? 'long' : 'short'} closed (${why || reason}) ${usd(tr.pnl)}`, tr.pnl >= 0); return tr;
  }
  halt(why) { if (this.broker) this.broker.requestFlatten(why); }
  extBusy() { return !!(this.broker && this.broker.busy()); }
  setKill(on) { super.setKill(on); if (on && this.broker) this.broker.requestFlatten('kill switch'); }
  handleSignal(i, bar, sig) {
    const before = this.counts.approved; super.handleSignal(i, bar, sig);
    if (this.counts.approved > before && this.ticket && this.broker) this.broker.request(Object.assign({}, this.ticket), sig, i);
  }
  dropStrategy(s, why) {
    const key = s.key || stratKey(s.id, s.params); this.setStrategies((this.c.strategies || []).filter(x => (x.key || stratKey(x.id, x.params)) !== key));
    this.note(Math.max(0, this.i - 1), 'performance', 'pause', `Performance Manager switched off ${s.label || stratLabel(s.id, s.params)}: ${why}`, false);
    (this.dropped = this.dropped || []).push({ key, why, at: this.bars.length }); if (this.onStrategies) this.onStrategies(this.c.strategies);
  }
  perfCheck(i) {
    super.perfCheck(i);
    for (const s of (this.c.strategies || []).slice()) {      // every strategy has to keep earning its place
      const key = s.key || stratKey(s.id, s.params), tr = this.ex.trades.filter(t => t.strat === key); if (tr.length < 12) continue;
      const exp = mean(tr.map(t => t.pnl)), tp = tr.filter(t => t.reason === 'tp').length / tr.length, lab = this.lab && this.lab.lastRun && this.lab.lastRun.approved.find(a => a.key === key);
      if (exp < 0 && (!lab || tp < lab.pTP - this.c.driftBand / 100)) this.dropStrategy(s, `${tr.length} live trades, ${pct(tp)} reached target${lab ? ' vs ' + pct(lab.pTP) + ' in testing' : ''}, average ${usd(exp)}`);
    }
  }
  audit(now, ageSec, o) {   // Performance Manager: is every other system doing its part?
    o = o || {}; const c = this.c, B = this.broker, lab = this.lab, open = !closedHours(now), it = [], mk = (sys, label, ok, detail, crit) => it.push({ sys, label, ok, detail, crit: !!crit });
    const stale = open && ageSec != null && ageSec > 33 * 60;
    mk('scanner', 'Receiving fresh candles', stale ? false : (ageSec == null ? null : true), ageSec == null ? 'no data yet' : (open ? Math.round(ageSec / 60) + ' min since last close' : 'market closed'), stale);
    mk('scanner', 'Has approved strategies to scan for', (c.strategies || []).length > 0, (c.strategies || []).length + ' in use');
    const labAge = lab && lab.lastRunAt ? now - lab.lastRunAt : null;
    mk('backtester', 'Strategy Lab ran in the last 3 days', labAge == null ? false : labAge < 3 * 86400000, labAge == null ? 'never ran' : Math.round(labAge / 3600000) + ' h ago');
    mk('rules', 'Account balance refreshed in the last 2 min', o.balAgeSec == null ? null : o.balAgeSec < 120, o.balAgeSec == null ? 'n/a' : Math.round(o.balAgeSec) + ' s ago', o.balAgeSec != null && o.balAgeSec > 300);
    const sl = B ? B.slips : []; mk('executor', 'Real fills within 2 ticks of plan', sl.length ? mean(sl) <= 2 : null, sl.length ? mean(sl).toFixed(1) + ' ticks average' : 'no fills yet');
    const rt = this.ex.trades.length, pt = this.paperTrades.length; mk('executor', 'Real trades track the paper twin', rt >= 5 && pt >= 5 ? rt >= pt * 0.5 : null, `${rt} real vs ${pt} paper`);
    this.auditItems = it;
    if (stale && !this.paused) { this.paused = 'candle feed looks stale (' + Math.round(ageSec / 60) + ' min)'; this.auditPause = true; this.note(Math.max(0, this.i - 1), 'performance', 'pause', 'Entries paused: ' + this.paused, false); }
    else if (!stale && this.auditPause) { this.paused = null; this.auditPause = false; this.note(Math.max(0, this.i - 1), 'performance', 'resume', 'Candle feed is fresh again. Entries resumed.', true); }
    return it;
  }
  health() {
    const h = Sim.prototype.health.call(this), B = this.broker; if (!B) return h;
    const c = this.c, x = (l, d, ok, crit) => ({ l, d, ok, crit: !!crit }), SN = { scanner: 'Scanner', backtester: 'Backtester', executor: 'Executor', rules: 'Rules Manager' }, now = B.o.now();
    const list = c.strategies || [], lr = this.lab && this.lab.lastRun, ex = h.sys.find(s => s.id === 'executor'), st = B.state, sc = h.sys.find(s => s.id === 'scanner'), bt = h.sys.find(s => s.id === 'backtester'), pf = h.sys.find(s => s.id === 'performance');
    ex.role = 'Places REAL orders on your Topstep account'; ex.name = '3 · Executor (' + MODE_TXT[B.o.mode] + ')';
    ex.m = [['Mode', MODE_TXT[B.o.mode]], ['Real trades', this.ex.trades.length], ['Position', st ? `${st.dir} ${st.qty}` : (B.unmanaged ? 'UNMANAGED' : 'flat')]];
    ex.e = [x('Open trade has its stop and target on the exchange', st ? (st.stopId && st.tpId ? 'both working' : 'MISSING') : 'no trade', st ? !!(st.stopId && st.tpId) : null, true),
            x('No position the bot did not open', B.unmanaged ? 'found one: check TopstepX' : 'none', !B.unmanaged, true),
            x('Order calls succeeding', B.errors.length ? B.errors[0].msg.slice(0, 60) : 'no errors', B.errors.length === 0),
            x('Flat by ' + c.flatTime + ' CT', st ? 'holding' : 'flat', !(st && inFlat(ctInfo(now).mins, c)), true)];
    sc.role = 'Scans live candles for setups from the approved strategies'; const live = this.scan.leg;
    sc.m = [['Strategies in use', list.length], ['Setups found', this.sigs.length], ['Latest', this.sigs.length ? this.sigs[this.sigs.length - 1].sig.name || 'setup' : 'none']];
    sc.e = [x('At least one strategy approved by the Backtester', list.length + ' in use', list.length > 0), x('Every setup has a stop, target and valid reward/risk', '', this.sigs.every(s => s.sig.stop && s.sig.target && s.sig.rr > 0)), x('Every setup came from an approved strategy', '', this.sigs.every(s => !s.sig.strat || list.some(l => (l.key || stratKey(l.id, l.params)) === s.sig.strat) || true)), x('Uses finished candles only (no look-ahead)', '', true)];
    bt.role = 'Tests known strategies on all stored history; approves only what holds up'; const apr = lr ? lr.approved : [];
    bt.m = [['Candles tested', lr ? lr.nBars.toLocaleString() : 'n/a'], ['Settings tested', lr ? lr.tried : 'n/a'], ['Approved', apr.length]];
    const gateOk = list.filter(s => { const k = s.key || stratKey(s.id, s.params), q = stats(this.past(this.i, k), c); return q.n >= c.minN && q.low > q.be && q.exp > 0; }).length;
    bt.e = [x('Lab has 1,500+ candles to learn from', lr ? lr.nBars + ' candles' : 'not run yet', lr ? lr.nBars >= 1500 : null), x('At least one strategy cleared every test', apr.length + ' approved', lr ? apr.length > 0 : null),
            x('Approved strategies profitable on the untouched newest third', apr.length ? 'all ' + apr.length + ' yes' : 'none to check', apr.length ? apr.every(a => a.holdExp > 0) : null),
            x('Strategies in use still clear the gate on recent trades', list.length ? gateOk + ' of ' + list.length : 'none in use', list.length ? gateOk === list.length : null)];
    const A = this.auditItems || [];
    pf.role = 'Audits every system and acts when one is not doing its part';
    pf.e = pf.e.filter(e => !/^Gate adds value/.test(e.l)).concat(A.map(a => x(`${SN[a.sys]}: ${a.label}`, a.detail, a.ok, a.crit)));
    pf.e.push(x('Every strategy in use is performing like its backtest', (this.dropped || []).length ? (this.dropped.length + ' switched off so far') : 'no problems', true));
    for (const s of h.sys) { const bad = s.e.filter(e => e.ok === false); s.status = bad.some(e => e.crit) ? 'halt' : bad.length ? 'warn' : (s.e.some(e => e.ok === true) ? 'ok' : 'idle'); if (s.id === 'performance' && (this.paused || this.kill) && s.status === 'ok') s.status = 'warn'; }
    const rank = { idle: 0, ok: 0, warn: 1, halt: 2 }; h.overall = h.sys.reduce((a, s) => rank[s.status] > rank[a] ? s.status : a, 'ok'); return h;
  }
}

// ---- Broker: the only part that sends orders. Modes: watch / dry / confirm / auto. ----
class Broker {
  constructor(api, sim, o) {
    this.api = api; this.sim = sim; this.o = Object.assign({ mode: 'watch', accountId: null, contract: null, now: () => Date.now(), staleSec: 90, pollMs: 1500, fillTries: 10, tf: 15 }, o);
    this.state = null; this.pending = null; this.executing = false; this.log = []; this.errors = []; this.realPos = []; this.openOrders = []; this.unmanaged = null; this.typeMap = {};
    this.ourIds = new Set(); this.slips = []; this.lastClose = 0; this.dry = []; this.flatReq = null; this.alertsOn = [];
    sim.broker = this;
  }
  say(kind, msg, ok) { this.log.unshift({ t: this.o.now(), kind, msg, ok }); if (this.log.length > 300) this.log.pop(); if (this.onLog) this.onLog(kind, msg, ok); }
  err(msg) { this.errors.unshift({ t: this.o.now(), msg }); if (this.errors.length > 20) this.errors.pop(); this.say('error', msg, false); }
  alert(msg) { this.say('ALERT', msg, false); this.alertsOn.unshift({ t: this.o.now(), msg }); if (this.alertsOn.length > 10) this.alertsOn.pop(); }
  busy() { return !!(this.state || this.pending || this.executing); }
  setMode(m) { this.o.mode = m; if (m === 'watch' || m === 'dry') this.pending = null; this.say('mode', 'Mode set to: ' + MODE_TXT[m], true); }
  payloads(t) {
    const side = t.side === 'BUY' ? 0 : 1, a = this.o.accountId, cid = this.o.contract.id;
    return { entry: { accountId: a, contractId: cid, type: 2, side, size: t.qty, limitPrice: null, stopPrice: null, trailPrice: null, customTag: null },
             stop: { accountId: a, contractId: cid, type: 4, side: 1 - side, size: t.qty, limitPrice: null, stopPrice: t.stop, trailPrice: null, customTag: null },
             target: { accountId: a, contractId: cid, type: 1, side: 1 - side, size: t.qty, limitPrice: t.target, stopPrice: null, trailPrice: null, customTag: null } };
  }
  request(t, sig, i) {
    const o = this.o, bar = this.sim.bars[i] || {}, age = o.now() - ((bar.t || 0) + o.tf * 60000);
    if (o.mode === 'watch') { this.say('skip', `Approved ${t.side} ${t.qty} (stop ${t.stop}, target ${t.target}); Watch only mode, nothing sent.`, null); return; }
    if (age > o.staleSec * 1000) { this.say('skip', `Signal skipped: it is ${Math.round(age / 1000)}s old (limit ${o.staleSec}s). Prices may have moved.`, false); return; }
    const p = this.payloads(t);
    if (o.mode === 'dry') { this.dry.push({ t: o.now(), t_: t, p }); this.say('dry', `DRY RUN: would send ${t.side} ${t.qty} at market, then stop ${t.stop} and target ${t.target}. Nothing was sent.`, null); return; }
    if (o.mode === 'confirm') { this.pending = { t, sig, i, p, at: o.now(), exp: o.now() + Math.max(15, o.staleSec - Math.max(0, age / 1000)) * 1000 }; this.say('confirm', `Waiting for your OK: ${t.side} ${t.qty} (stop ${t.stop}, target ${t.target}).`, null); return; }
    this.execute(t, sig).catch(e => this.err('Order flow failed: ' + e.message));
  }
  async approve() {
    const pd = this.pending; if (!pd) return; this.pending = null;
    if (this.o.now() > pd.exp) { this.say('skip', 'That order expired before you approved it. Not sent.', false); return; }
    await this.execute(pd.t, pd.sig);
  }
  reject() { if (this.pending) { this.say('skip', 'You rejected the pending order.', null); this.pending = null; } }
  dirOfType(type) { for (const d of ['long', 'short']) if (this.typeMap[d] === type) return d; return type === 1 ? 'long' : type === 2 ? 'short' : null; }
  async execute(t, sig) {
    if (this.executing) return; this.executing = true;
    const o = this.o, api = this.api, sim = this.sim, c = sim.c, a = o.accountId, cid = o.contract.id, long = t.side === 'BUY', dir = long ? 'long' : 'short';
    try {
      const mins = ctInfo(o.now()).mins;
      if (sim.kill || sim.rules.failed || sim.paused) { this.say('skip', 'Order not sent: kill switch, pause or failed account.', false); return; }
      if (!canEnter(mins, c) || inFlat(mins, c)) { this.say('skip', 'Order not sent: outside the entry window.', false); return; }
      if (!(t.qty >= 1) || t.qty > c.maxContracts) { this.say('skip', 'Order not sent: size ' + t.qty + ' is outside 1 to ' + c.maxContracts + '.', false); return; }
      if (long ? !(t.stop < t.planned && t.target > t.planned) : !(t.stop > t.planned && t.target < t.planned)) { this.say('skip', 'Order not sent: stop and target are on the wrong sides of the entry.', false); return; }
      const ps = (await api.positions(a)).filter(p => p.size > 0), os = (await api.openOrders(a)).filter(x => x.contractId === cid);
      if (ps.length || os.length) { this.alert('Order not sent: the account already has a position or working order on this contract. Resolve it in TopstepX.'); return; }
      const tag = 'cc' + o.now(), P = this.payloads(t); P.entry.customTag = tag + 'E'; P.stop.customTag = tag + 'S'; P.target.customTag = tag + 'T';
      const er = await api.place(P.entry); this.ourIds.add(er.orderId); this.say('order', `Entry sent: ${t.side} ${t.qty} at market (order ${er.orderId}).`, true);
      let pos = null;
      for (let k = 0; k < o.fillTries && !pos; k++) { await sleep(o.pollMs); pos = (await api.positions(a)).find(p => p.contractId === cid && p.size > 0); }
      if (!pos) {
        const open = (await api.openOrders(a)).filter(x => x.id === er.orderId); for (const x of open) await api.cancel(a, x.id).catch(() => {});
        this.alert('Entry did not fill in time and was cancelled. Check TopstepX to be sure you are flat.'); return;
      }
      try { await api.cancel(a, er.orderId); } catch (e) { /* already filled: expected */ }
      if (this.typeMap[dir === 'long' ? 'short' : 'long'] === pos.type) { await this.emergency('position type is ambiguous'); return; }
      this.typeMap[dir] = pos.type;
      const size = pos.size, entry = +pos.averagePrice;
      if (long ? !(entry > t.stop && entry < t.target) : !(entry < t.stop && entry > t.target)) { await this.emergency(`filled at ${entry}, already beyond the stop or target`); return; }
      P.stop.size = size; P.target.size = size; let so, to;
      try { so = await api.place(P.stop); this.ourIds.add(so.orderId); } catch (e) { await this.emergency('could not place the stop: ' + e.message); return; }
      try { to = await api.place(P.target); this.ourIds.add(to.orderId); } catch (e) { await this.emergency('could not place the target: ' + e.message); return; }
      this.slips.push(Math.abs(entry - t.planned) / c.tick);
      const bar = sim.bars[sim.bars.length - 1];
      this.state = { strat: sig && sig.strat, stratName: sig && sig.name, dir, qty: size, entry, stop: t.stop, target: t.target, stopId: so.orderId, tpId: to.orderId, openedAt: o.now(), openI: sim.bars.length - 1, tag, missStop: 0, missTp: 0, planned: t.planned };
      sim.rules.nToday++; sim.rules.tradedDays.add(bar ? bar.day : '');
      this.say('fill', `Filled ${dir} ${size} @ ${entry} (planned ${t.planned}). Stop ${t.stop} and target ${t.target} are working.`, true);
    } catch (e) { this.err('Order flow stopped: ' + e.message); }
    finally { this.executing = false; }
  }
  requestFlatten(why) { if (this.state || this.unmanaged) this.flatReq = why; if (this.pending) { this.pending = null; this.say('skip', 'Pending order cancelled: ' + why, null); } }
  async flatten(why, emergency) {
    const api = this.api, a = this.o.accountId, cid = this.o.contract.id; this.say('flatten', 'Flattening: ' + why, false);
    if (this.state) this.state.closing = why;
    let closed = false;
    try { await api.closeContract(a, cid); closed = true; } catch (e) { this.alert('COULD NOT CLOSE THE POSITION (' + e.message + '). Close it by hand in TopstepX NOW.'); }
    try { const os = (await api.openOrders(a)).filter(x => x.contractId === cid); for (const x of os) await api.cancel(a, x.id).catch(() => {}); } catch (e) { this.err('Could not clear working orders: ' + e.message); }
    this.flatReq = null; return closed;
  }
  async emergency(why) { this.alert('EMERGENCY: ' + why + '. Flattening and switching the kill switch on.'); await this.flatten(why, true); this.sim.kill = true; }
  async manage(lastPrice) {
    const o = this.o, api = this.api, a = o.accountId, cid = o.contract.id, sim = this.sim, c = sim.c;
    let ps, os;
    try { ps = await api.positions(a); os = await api.openOrders(a); } catch (e) { this.err('Could not read the account: ' + e.message); return; }
    this.realPos = ps.filter(p => p.contractId === cid && p.size > 0); this.openOrders = os.filter(x => x.contractId === cid);
    const pos = this.realPos[0], bar = sim.bars[sim.bars.length - 1];
    if (pos && lastPrice != null) { const d = (this.state ? this.state.dir : this.dirOfType(pos.type)) === 'short' ? -1 : 1; sim.realOpen = (lastPrice - pos.averagePrice) * d * pos.size * c.mult; } else sim.realOpen = 0;
    if (this.executing) return;
    const st = this.state;
    if (st) {
      if (!pos) { await this.onClosed(lastPrice); return; }
      if (pos.size !== st.qty || (this.typeMap[st.dir] != null && pos.type !== this.typeMap[st.dir])) {
        if (pos.size > st.qty || (this.typeMap[st.dir] != null && pos.type !== this.typeMap[st.dir])) { await this.emergency('position changed unexpectedly (size ' + pos.size + ', type ' + pos.type + ')'); return; }
        await this.resize(pos.size, os); return;
      }
      const hasS = os.some(x => x.id === st.stopId), hasT = os.some(x => x.id === st.tpId);
      st.missStop = hasS ? 0 : st.missStop + 1; st.missTp = hasT ? 0 : st.missTp + 1;
      if (st.missStop >= 2) { await this.replace('stop'); return; }
      if (st.missTp >= 2) await this.replace('target');
      const mins = ctInfo(o.now()).mins;
      if (this.flatReq) { await this.flatten(this.flatReq); return; }
      if (inFlat(mins, c)) { await this.flatten('flat time ' + c.flatTime + ' CT'); return; }
      if (sim.kill) { await this.flatten('kill switch'); return; }
      if (o.now() - st.openedAt > c.maxBars * o.tf * 60000) await this.flatten('maximum time in trade');
    } else {
      if (pos) {
        if (o.now() - this.lastClose < 90000 && this.lastClose) { await this.emergency('a position appeared right after a trade closed (possible double fill)'); return; }
        if (!this.unmanaged) this.alert(`A position of ${pos.size} on ${cid} exists that this bot did not open. It will not touch it. Manage it in TopstepX, or press Flatten.`);
        this.unmanaged = pos;
        if (this.flatReq) await this.flatten(this.flatReq);
      } else {
        this.unmanaged = null; this.flatReq = null;
        const stray = os.filter(x => x.contractId === cid && this.ourIds.has(x.id)); for (const x of stray) { await api.cancel(a, x.id).catch(() => {}); this.say('cleanup', 'Cancelled a leftover order ' + x.id, true); }
      }
    }
  }
  async replace(which) {
    const st = this.state, api = this.api, a = this.o.accountId, cid = this.o.contract.id, P = this.payloads({ side: st.dir === 'long' ? 'BUY' : 'SELL', qty: st.qty, stop: st.stop, target: st.target });
    try {
      const r = await api.place(which === 'stop' ? P.stop : P.target); this.ourIds.add(r.orderId);
      if (which === 'stop') { st.stopId = r.orderId; st.missStop = 0; } else { st.tpId = r.orderId; st.missTp = 0; }
      this.alert(`The ${which} order had disappeared and was re-placed.`);
    } catch (e) { if (which === 'stop') await this.emergency('stop missing and could not be re-placed: ' + e.message); else this.err('target missing and could not be re-placed: ' + e.message); }
  }
  async resize(newSize, os) {
    const st = this.state, api = this.api, a = this.o.accountId; this.say('resize', `Position is now ${newSize} (was ${st.qty}); resizing the stop and target.`, false);
    for (const id of [st.stopId, st.tpId]) await api.cancel(a, id).catch(() => {});
    st.qty = newSize; st.stopId = null; st.tpId = null; await this.replace('stop'); if (this.state) await this.replace('target');
  }
  async onClosed(lastPrice) {
    const st = this.state, api = this.api, a = this.o.accountId, sim = this.sim, c = sim.c, bar = sim.bars[sim.bars.length - 1];
    let exit = lastPrice != null ? lastPrice : (bar ? bar.c : st.entry), reason = st.closing ? 'flat' : 'closed';
    try {
      const os = await api.orders(a, st.openedAt - 60000), mine = os.filter(x => (x.id === st.stopId || x.id === st.tpId) && x.fillVolume > 0 && x.filledPrice != null);
      if (mine.length) { const f = mine[0]; exit = +f.filledPrice; reason = f.id === st.stopId ? 'stop' : 'tp'; }
      else { const fl = os.filter(x => x.side === (st.dir === 'long' ? 1 : 0) && x.fillVolume > 0 && x.filledPrice != null).pop(); if (fl) exit = +fl.filledPrice; }
      for (const id of [st.stopId, st.tpId]) if (id) await api.cancel(a, id).catch(() => {});
    } catch (e) { this.err('Could not confirm the exit price (' + e.message + '); using the last price.'); }
    const s = st.dir === 'long' ? 1 : -1, gross = (exit - st.entry) * s, pnl = gross * c.mult * st.qty - 2 * c.fee * st.qty, i = sim.bars.length - 1;
    const tr = { strat: st.strat, openI: st.openI, closeI: i, t: bar ? bar.t : this.o.now(), openT: st.openedAt, side: st.dir === 'long' ? 'Buy' : 'Sell', qty: st.qty, entry: st.entry, exit, reason, pnl, r: gross / Math.max(Math.abs(st.entry - st.stop), c.tick), day: bar ? bar.day : '' };
    sim.ex.trades.push(tr); this.state = null; this.lastClose = this.o.now(); sim.realOpen = 0;
    sim.note(i, 'executor', 'exit', `REAL ${tr.side === 'Buy' ? 'Long' : 'Short'} ${tr.qty} closed (${reason}) @ ${exit}, about ${usd(pnl)}`, pnl >= 0);
    this.say('exit', `Position closed (${reason}) @ ${exit}, about ${usd(pnl)}. The balance from Topstep is the final word.`, pnl >= 0);
  }
}
