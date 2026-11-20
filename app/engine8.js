// ===== Real-time market data: Topstep's market hub (SignalR over WebSocket), the same live feed TopstepX's charts use =====
const RT_URL = 'wss://rtc.topstepx.com/hubs/market', RS = '\x1e';
class CandleBuilder {   // turns live prices into finished candles of tf minutes; a candle is only used if we watched it from its start
  constructor(tfMin, onClose) { this.tf = tfMin * 60000; this.onClose = onClose; this.cur = null; this.since = Infinity; }
  start(now) { this.since = now; this.cur = null; }
  add(price, vol, t) {
    if (!(price > 0) || !isFinite(t)) return; const k = Math.floor(t / this.tf) * this.tf;
    if (this.cur && k > this.cur.t) this.close();
    if (!this.cur) this.cur = { t: k, o: price, h: price, l: price, c: price, v: 0, whole: k >= this.since };
    else if (k < this.cur.t) return;   // a late print for an old candle
    const c = this.cur; c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price; c.v += vol || 0;
  }
  tick(now) { if (this.cur && now >= this.cur.t + this.tf + 3000) this.close(); }   // close on time even if the next print is slow
  close() { const c = this.cur; this.cur = null; if (c && c.whole && this.onClose) this.onClose({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }); }
}
class MarketStream {
  constructor(o) { this.o = o; this.ws = null; this.state = 'off'; this.subs = new Map(); this.lastMsg = 0; this.lastTick = 0; this.errors = []; this.retry = 0; this.inv = 0; this.closedByUs = false; }
  url() { return (this.o.url || RT_URL) + '?access_token=' + encodeURIComponent(this.o.token() || ''); }
  connect() {
    const WS = this.o.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null); if (!WS) { this.state = 'unavailable'; return; }
    this.closedByUs = false; this.state = 'connecting'; let ws;
    try { ws = new WS(this.url()); } catch (e) { this.fail('could not open: ' + e.message); return; }
    this.ws = ws; this.buf = '';
    ws.onopen = () => { try { ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS); } catch (e) { } };
    ws.onmessage = ev => this.onData(typeof ev.data === 'string' ? ev.data : String(ev.data));
    ws.onerror = () => { };
    ws.onclose = ev => { if (this.ws !== ws) return; this.ws = null; clearInterval(this.ping); if (this.closedByUs) { this.state = 'off'; return; } this.fail('connection closed' + (ev && ev.code ? ' (' + ev.code + ')' : '')); };
  }
  fail(why) {
    this.state = 'reconnecting'; this.note(why); const wait = Math.min(60000, 2000 * Math.pow(2, this.retry++));
    clearTimeout(this.rt); this.rt = setTimeout(async () => { try { if (this.o.refresh) await this.o.refresh(); } catch (e) { } this.connect(); }, wait);
  }
  note(m) { this.errors.unshift({ t: Date.now(), m }); if (this.errors.length > 20) this.errors.pop(); if (this.o.log) this.o.log(m); }
  onData(s) {
    this.buf += s; let k;
    while ((k = this.buf.indexOf(RS)) >= 0) {
      const part = this.buf.slice(0, k); this.buf = this.buf.slice(k + 1); if (!part) continue; let m; try { m = JSON.parse(part); } catch (e) { continue; }
      this.lastMsg = Date.now();
      if (this.state === 'connecting') {   // handshake answer
        if (m.error) { this.note('Topstep refused the live data connection: ' + m.error); continue; }
        this.state = 'live'; this.retry = 0; this.note('Live market data connected.'); clearInterval(this.ping); this.ping = setInterval(() => this.send({ type: 6 }), 15000);
        for (const [cid, w] of this.subs) this.doSub(cid, w); if (this.o.onLive) this.o.onLive(); continue;
      }
      if (m.type === 1 && m.target) {
        const a = m.arguments || [], cid = a[0], data = a[1];
        if (m.target === 'GatewayQuote') for (const q of [].concat(data || [])) { const p = +q.lastPrice, t = Date.parse(q.timestamp || q.lastUpdated) || Date.now(); if (p > 0) { this.lastTick = Date.now(); this.o.onQuote && this.o.onQuote(cid, p, t, q); } }
        if (m.target === 'GatewayTrade') for (const x of [].concat(data || [])) { const p = +x.price, t = Date.parse(x.timestamp) || Date.now(); if (p > 0) { this.lastTick = Date.now(); this.o.onTrade && this.o.onTrade(cid, p, +x.volume || 0, t); } }
      } else if (m.type === 3 && m.error) this.note('Topstep rejected a live-data request: ' + m.error);
      else if (m.type === 7) { this.note('Topstep closed the live data connection' + (m.error ? ': ' + m.error : '')); }
    }
  }
  send(o) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o) + RS); } catch (e) { } }
  doSub(cid, w) { if (w.quotes) this.send({ type: 1, invocationId: String(++this.inv), target: 'SubscribeContractQuotes', arguments: [cid] }); if (w.trades) this.send({ type: 1, invocationId: String(++this.inv), target: 'SubscribeContractTrades', arguments: [cid] }); }
  subscribe(cid, w) { this.subs.set(cid, w); if (this.state === 'live') this.doSub(cid, w); }
  stop() { this.closedByUs = true; clearTimeout(this.rt); clearInterval(this.ping); try { if (this.ws) this.ws.close(); } catch (e) { } this.ws = null; this.state = 'off'; }
  status(now) { now = now || Date.now(); return { state: this.state, tickAgeSec: this.lastTick ? Math.round((now - this.lastTick) / 1000) : null, lastError: this.errors[0] || null }; }
}
// hook the live data into the runner: the main market from trades, the other markets from quotes; the history feed stays as a backup
LiveRunner.prototype.startStream = function () {
  if (this.o.realtime === false) return; const self = this, o = this.o;
  const addMain = bar => { const S = self.sim, last = S.bars[S.bars.length - 1]; if (bar.t <= last.t) return; S.addBar(bar, false); self.newBars++; self.barsSinceLearn++; self.lastBarAt = o.now(); self.rtBars = (self.rtBars || 0) + 1; self.saveStored(self.contract.id, S.bars); self.maybeLearn(); if (self.onChange) self.onChange(); };
  this.cb = new CandleBuilder(o.tf, addMain); this.mcb = new Map();
  this.stream = new MarketStream({
    url: o.rtUrl, WebSocket: o.WebSocket, token: () => self.api.token,
    refresh: async () => { if (Date.now() - (self.api.tokenAt || 0) > 20 * 3600e3) await self.api.validate(); },   // reuse the session: no new sign-in, so TopstepX in your browser is not logged out
    log: m => { if (self.broker) self.broker.say('data', 'Live data: ' + m, /connected\./.test(m)); },
    onLive: () => { const now = o.now(); self.cb.start(now); for (const b of self.mcb.values()) b.start(now); },
    onTrade: (cid, p, v, t) => { if (cid === self.contract.id) { self.cb.add(p, v, t); self.livePrice = p; self.livePriceAt = o.now(); } },
    onQuote: (cid, p, t) => { if (cid === self.contract.id) { self.livePrice = p; self.livePriceAt = o.now(); if (!self.tradesSeen) self.cb.add(p, 0, t); } else { const b = self.mcb.get(cid); if (b) b.add(p, 0, t); } }
  });
  const ot = this.stream.o.onTrade; this.stream.o.onTrade = (cid, p, v, t) => { if (cid === self.contract.id) self.tradesSeen = true; ot(cid, p, v, t); };
  this.stream.subscribe(this.contract.id, { quotes: true, trades: true }); this.stream.connect();
};
LiveRunner.prototype.watchMarket = function (m) {   // called when another market is ready: build its candles from live quotes
  if (!this.stream || !m.contract || this.mcb.has(m.contract.id)) return; const self = this;
  const b = new CandleBuilder(this.o.tf, bar => { const last = m.sim.bars[m.sim.bars.length - 1]; if (bar.t <= last.t) return; m.sim.bars.push(annotate([bar])[0]); m.newBars++; m.lastPoll = self.o.now(); self.markets.after(m); });
  if (this.stream.state === 'live') b.start(this.o.now()); this.mcb.set(m.contract.id, b); this.stream.subscribe(m.contract.id, { quotes: true });
};
LiveRunner.prototype.streamTick = function (now) { if (!this.stream) return; this.cb.tick(now); for (const b of this.mcb.values()) b.tick(now); };
