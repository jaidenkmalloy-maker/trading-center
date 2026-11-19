// ===== UI PART 2: panels, controls, settings, startup =====
function gauge(label, val, pctv, color) {
  const w = Math.max(0, Math.min(100, pctv));
  return `<div class="gauge"><div class="top"><span>${esc(label)}</span><span>${esc(val)}</span></div><div class="bar"><i style="width:${w}%;background:${color}"></i></div></div>`;
}
function gaugesHtml(h) {
  const c = sim.c, R = sim.rules, s = h.snap, E = sim.ex, bar = sim.bars[Math.max(0, sim.i - 1)] || { mins: 0 };
  const col = v => v > 50 ? '#3ee6b0' : v > 25 ? '#f2b84b' : '#f27272';
  let out = gauge('Buffer above loss-limit floor', `${usd(s.buffer)} of ${usd(c.maxLoss)}`, s.bufPct, col(s.bufPct));
  const room = (c.dailyStop + s.today) / c.dailyStop * 100;
  out += gauge('Room before daily stop', `${usd(c.dailyStop + s.today)} left (today ${usd(s.today)})`, room, col(room));
  out += gauge('Profit target', `${usd(s.closed)} of ${usd(c.profitTarget)}`, s.progress * 100, '#2bb7d6');
  out += s.cons == null ? gauge('Best day vs consistency limit', 'no profit yet', 0, '#2bb7d6') : gauge('Best day vs consistency limit', `${s.cons.toFixed(0)}% (limit ${c.consistencyPct}%)`, s.cons / c.consistencyPct * 100, s.cons <= c.consistencyPct ? '#3ee6b0' : '#f27272');
  out += gauge('Trades today', `${R.nToday} of ${c.maxTradesPerDay}`, R.nToday / c.maxTradesPerDay * 100, '#2bb7d6');
  let clock;
  if (inFlat(bar.mins, c)) clock = 'No-trade window (flat)';
  else { const f = hm(c.flatTime), left = bar.mins >= 1020 ? 1440 - bar.mins + f : f - bar.mins; clock = `${Math.floor(left / 60)}h ${left % 60}m until flat at ${c.flatTime} CT`; }
  out += `<div class="note" style="margin:0">Clock: ${esc(clock)}<br>Position: ${E.pos ? `${E.pos.side} ${E.pos.qty} (max ${c.maxContracts})` : 'flat'}<br>Days traded: ${s.days} (Topstep Combines may require a minimum; yours is set to ${c.minDays})</div>`;
  return out;
}
function ticketHtml() {
  const t = sim.ticket, E = sim.ex;
  if (!t) return '<div class="empty">No approved trade yet. When the scanner, backtester and rules manager all agree, the ticket appears here.</div>';
  const LV = isLive(), B = LV ? runner.broker : null;
  let state = LV ? 'Handled by the Executor (see Broker log)' : 'Closed in the simulation';
  if (LV) state = B.pending ? 'Waiting for your OK' : B.state ? 'Live on Topstep' : state; else if (E.pending) state = 'Working: fills at the next candle open'; else if (E.pos && E.pos.t >= t.t) state = 'Filled in the simulation';
  return `<div class="ticket"><b>${t.side} ${t.qty} ${sim.c.symbol}</b> at market<br>Stop <b>${p4(t.stop)}</b> &middot; Target <b>${p4(t.target)}</b><br>Risk about ${usd(t.risk)} &middot; ${esc(tt(t.t))} CT<br><span class="mut">${state}</span><div style="margin-top:8px"><button class="small" onclick="copyTicket()">Copy</button></div></div>
  <div class="note">${LV ? 'This is the latest trade the systems approved. Whether it was actually sent depends on the mode: Watch only and Dry run never send anything.' : 'The simulated executor fills this against the candles. For a real trade you would enter it yourself in TopstepX with the stop and target attached. Nothing here is sent to Topstep.'}</div>`;
}
const SYS_TAG = { scanner: 'Scanner', backtester: 'Backtest', rules: 'Rules', executor: 'Executor', performance: 'Perf' };
function decisionsHtml() {
  if (!sim.decisions.length) return '<div class="empty">Nothing yet. Press Play.</div>';
  return '<table class="nw"><tr><th>Time (CT)</th><th>System</th><th>What happened</th></tr>' + sim.decisions.slice(0, 80).map(d =>
    `<tr><td>${esc(tt(d.t))}</td><td><span class="tag ${d.ok === true ? 'good' : d.ok === false ? 'bad' : ''}">${SYS_TAG[d.sys] || d.sys}</span></td><td style="white-space:normal">${esc(d.msg)}</td></tr>`).join('') + '</table>';
}
function ordersHtml() {
  const o = sim.ex.orders; if (!o.length) return '<div class="empty">No orders yet.</div>';
  return '<table class="nw"><tr><th>Time</th><th>Side</th><th>Qty</th><th>Type</th><th>Price</th><th>Status</th><th>Note</th></tr>' + o.slice(0, 80).map(x =>
    `<tr><td>${esc(tt(x.t))}</td><td><span class="tag ${x.side}">${x.side}</span></td><td>${x.qty}</td><td>${x.type}</td><td>${p4(x.price)}</td><td><span class="tag ${x.status}">${x.status}</span></td><td style="white-space:normal">${esc(x.note || '')}</td></tr>`).join('') + '</table>';
}
function tradesHtml() {
  const T = sim.ex.trades; if (!T.length) return '<div class="empty">No closed trades yet.</div>';
  return '<table class="nw"><tr><th>Closed</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Why</th><th>P&amp;L</th><th>R</th></tr>' + T.slice().reverse().slice(0, 80).map(t =>
    `<tr><td>${esc(tt(t.t))}</td><td><span class="tag ${t.side}">${t.side}</span></td><td>${t.qty}</td><td>${p4(t.entry)}</td><td>${p4(t.exit)}</td><td>${esc(t.reason)}</td><td class="${cls(t.pnl)}">${usd(t.pnl)}</td><td class="${cls(t.r)}">${t.r.toFixed(2)}</td></tr>`).join('') + '</table>';
}
function perfHtml(h) {
  const p = h.perf, s = h.snap, c = sim.c;
  const row = (k, v, cl) => `<tr><td class="mut">${k}</td><td class="${cl || ''}">${v}</td></tr>`;
  let t = '<table>' + row('Net P&amp;L (closed trades)', usd(p.net), cls(p.net)) + row('Trades taken', p.nTr) + row('Expectancy per trade', p.nTr ? usd(p.liveExp) : 'n/a', cls(p.liveExp)) +
    row('Max drawdown so far', usd(p.mdd)) + row('Equity vs floor', `${usd(s.equity)} vs ${usd(s.floor)}`) +
    row('Scanner', `${sim.sigs.length} setups found`) +
    row('Backtester', `${p.counts.gate} rejected, ${p.counts.approved} approved`) +
    row('Rejected setups in hindsight', p.hypRejectedN >= 5 ? `${usd(p.hypRejected)} per 1 contract over ${p.hypRejectedN} (positive means the gate may be too strict)` : 'not enough yet') +
    row('Rules Manager', `${p.counts.rules} blocked, ${p.counts.ignored} skipped (already in a trade)`) +
    row('Executor', `${p.fills} fills, ${p.rejects} rejected`) + '</table>';
  const pts = sim.eq; if (pts.length > 1) {
    const W = 420, H = 110, vals = pts.map(q => q.eq), lo = Math.min(...vals, s.floor, c.start) - 50, hi = Math.max(...vals, c.start) + 50;
    const x = k => 6 + k / (pts.length - 1) * (W - 12), y = v => 6 + (hi - v) / (hi - lo) * (H - 12), step = Math.ceil(pts.length / 300);
    const line = pts.filter((_, k) => k % step === 0 || k === pts.length - 1).map(q => `${x(pts.indexOf(q)).toFixed(1)},${y(q.eq).toFixed(1)}`).join(' ');
    t += `<svg viewBox="0 0 ${W} ${H}" width="100%" style="margin-top:8px"><line x1="6" x2="${W - 6}" y1="${y(c.start)}" y2="${y(c.start)}" stroke="#8b98a5" stroke-dasharray="4 4"/><line x1="6" x2="${W - 6}" y1="${y(s.floor)}" y2="${y(s.floor)}" stroke="#e5534b" stroke-dasharray="6 4"/><polyline fill="none" stroke="#4c8dff" stroke-width="2" points="${line}"/><text x="8" y="${y(s.floor) - 3}" style="fill:#e5534b;font-size:8px">loss-limit floor</text><text x="8" y="${y(c.start) - 3}" style="font-size:8px">start</text></svg>`;
  }
  return t;
}
function btHtml(h) {
  const all = stats(sim.past(sim.i), sim.c);
  const r = (n, s) => `<tr><td>${n}</td><td>${s.n}</td><td>${s.n ? pct(s.pTP) : '-'}</td><td>${s.n ? pct(s.sl / s.n) : '-'}</td><td>${s.n ? pct(s.oth / s.n) : '-'}</td><td>${s.n ? pct(s.low) : '-'}</td><td>${s.n ? pct(s.be) : '-'}</td><td class="${cls(s.exp)}">${s.n ? usd(s.exp) : '-'}</td><td>${s.n ? (s.pf === Infinity ? '&infin;' : s.pf.toFixed(2)) : '-'}</td></tr>`;
  const c = sim.c;
  return '<table class="nw"><tr><th>Sample</th><th>Trades</th><th>Hit target</th><th>Hit stop</th><th>Other</th><th>TP low bound</th><th>Breakeven</th><th>Per contract</th><th>Profit factor</th></tr>' + r('All past', all) + r('First 70%', h.isS) + r('Last 30%', h.oosS) + '</table>' +
    `<div class="note">Only trades that had already finished before the current candle are counted, so this never peeks at the future. A setup is approved when there are at least ${c.minN} past trades, the TP-hit rate (lower bound at z=${c.z}) beats the breakeven rate, and past expectancy per contract is above $0. Gate mode: <b>${c.gate}</b>${c.gate === 'advisory' ? ' (rejected setups are still traded)' : ''}. Large gaps between the first-70% and last-30% rows are a sign of overfitting.</div>`;
}

function render() {
  if (!sim) return;
  const h = sim.health(), bar = sim.bars[Math.max(0, sim.i - 1)];
  $('src').textContent = srcLabel + ' · ' + sim.c.symbol; $('src').className = 'pill ' + (synthetic ? 'warn' : 'ok');
  $('overall').textContent = 'All systems: ' + STATUS_TXT[h.overall]; $('overall').className = 'pill ' + h.overall;
  if (isLive()) { const age = runner.dataAgeSec(); $('where').textContent = `LIVE · ${runner.contract.name} · ${sim.bars.length} candles · last candle opened ${tt(bar.t)} CT · last price ${p4(bar.c)} · ${age != null && age > 0 ? 'newest candle closed ' + Math.round(age / 60) + ' min ago' : 'up to date'}`; $('progBar').style.width = '100%'; }
  else { $('where').textContent = `Candle ${sim.i} of ${sim.bars.length}` + (bar ? ` · ${tt(bar.t)} CT · last price ${p4(bar.c)}` : ''); $('progBar').style.width = (sim.i / sim.bars.length * 100) + '%'; }
  let b = '';
  if (synthetic && !isLive()) b += '<div class="banner info">These are simulated random candles, not real prices. They show how the systems behave and are not evidence that the strategy works. Results on random data are luck. Load your own candles under Data to test on real prices.</div>';
  if (userMsg) b += `<div class="banner info">${esc(userMsg)}</div>`;
  if (sim.rules.failed) b += '<div class="banner red">Loss limit breached: in a real Combine the account would be failed. All systems are halted.</div>';
  else if (sim.kill) b += '<div class="banner amber">Kill switch is ON: no new orders will be placed.</div>';
  if (sim.paused) b += `<div class="banner amber">Paused by the Performance Manager: ${esc(sim.paused)}. <button class="small" onclick="resumePause()">Resume anyway</button></div>`;
  if (sim.i >= sim.bars.length && !isLive()) b += '<div class="banner info">End of data reached.</div>';
  $('banners').innerHTML = b;
  renderSystems(h.sys.slice().sort((a, c) => a.name.localeCompare(c.name))); setKpis(h);
  $('chart').innerHTML = chartSvg();
  { const cp = curPos(); $('chartNote').textContent = cp ? `${cp.side} ${cp.qty} @ ${p4(cp.entry)}, open P&L ${usd(isLive() ? (sim.realOpen || 0) : sim.ex.openPnl(bar.c))}` : 'flat'; }
  $('ticket').innerHTML = ticketHtml(); $('gauges').innerHTML = gaugesHtml(h);
  $('decisions').innerHTML = decisionsHtml(); $('orders').innerHTML = ordersHtml(); $('trades').innerHTML = tradesHtml();
  $('perf').innerHTML = perfHtml(h); $('bt').innerHTML = btHtml(h);
  $('bPlay').textContent = timer ? 'Pause' : 'Play';
  $('bKill').textContent = sim.kill ? 'Release kill switch' : 'Kill switch';
  if (window.__ui3) labRender();
}

// ---- controls ----
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
function tick() { acc += speed / 10; while (acc >= 1) { acc--; if (!sim.step()) { stopTimer(); break; } } if (sim.i >= sim.bars.length) stopTimer(); render(); }
function togglePlay() { if (timer) stopTimer(); else if (sim.i < sim.bars.length) timer = setInterval(tick, 100); render(); }
function stepN(n) { stopTimer(); for (let k = 0; k < n && sim.step(); k++); render(); }
function runEnd() { stopTimer(); while (sim.step()); render(); }
function doReset() { stopTimer(); sim.reset(); acc = 0; userMsg = ''; render(); }
function setSpeed(v) { speed = +v; }
function toggleKill() { if (sim.rules.failed) return; sim.setKill(!sim.kill); if (isLive() && sim.kill) runner.broker.manage(sim.bars[sim.bars.length - 1].c); render(); }
function resumePause() { sim.paused = null; sim.note(Math.max(0, sim.i - 1), 'performance', 'resume', 'Pause released by you.', true); render(); }
function newRandom() { stopTimer(); seedNo = Math.floor(Math.random() * 1e6); srcLabel = 'Synthetic random candles (seed ' + seedNo + ')'; synthetic = true; userMsg = ''; makeSim(genBars(6000, seedNo, sim.c.symbol)); render(); }
function loadCsv(ev) {
  const f = ev.target.files[0]; if (!f) return; const rd = new FileReader();
  rd.onload = () => {
    const r = parseCsv(rd.result);
    if (r.error || r.bars.length < 150) { userMsg = r.error || `Only ${r.bars.length} usable candles found. Load at least 150 (several weeks of 15-minute candles works best).`; render(); return; }
    stopTimer(); const gaps = r.bars.slice(1).map((b, k) => b.t - r.bars[k].t).sort((a, b) => a - b), med = gaps[Math.floor(gaps.length / 2)] / 60000;
    srcLabel = 'Your candles: ' + f.name; synthetic = false;
    userMsg = `Loaded ${r.bars.length} candles${r.skipped ? ` (skipped ${r.skipped} bad rows)` : ''}.` + (Math.abs(med - 15) > 0.5 ? ` These look like ${med}-minute candles, but the scanner settings and the time limits assume 15-minute candles.` : '') + priceWarn(r.bars, sim.c.symbol);
    makeSim(r.bars); render();
  };
  rd.readAsText(f); ev.target.value = '';
}
function loadPng(ev) {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  const hi = parseFloat($('pngHigh').value), lo = parseFloat($('pngLow').value), tf = parseFloat($('pngTf').value) || 15, lastT = parseTime($('pngTime').value.trim());
  const fail = m => { userMsg = m; render(); };
  if (!isFinite(hi) || !isFinite(lo) || hi <= lo) return fail('Enter the price of the highest wick and the lowest wick (highest must be larger), then choose the picture again.');
  if (!isFinite(lastT)) return fail('Enter the last candle\'s open time like 2026-11-19 11:00 (Central Time), then choose the picture again.');
  const url = URL.createObjectURL(f), img = new Image();
  img.onerror = () => fail('Could not open that picture. Use a PNG or JPG.');
  img.onload = () => {
    const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0); URL.revokeObjectURL(url);
    const d = cx.getImageData(0, 0, cv.width, cv.height), c = sim.c;
    const r = readChartImage(d.data, cv.width, cv.height, { high: hi, low: lo, tick: c.tick, dec: c.dec, tf, lastT });
    if (r.error) return fail(r.error);
    stopTimer(); srcLabel = 'Chart picture (approximate): ' + f.name; synthetic = false;
    userMsg = `Read ${r.bars.length} candles from the picture${r.dropped ? ` (${r.dropped} marks ignored)` : ''}. Prices are estimated from pixels, so treat results as a rough look.` + (r.bars.length < 150 ? ' This is too little history for the backtester to approve trades (it needs ' + c.minN + ' past setups first). Set the Backtester gate to advisory in Settings to see the scanner and executor work anyway.' : '') + priceWarn(r.bars, c.symbol);
    makeSim(r.bars); render();
  };
  img.src = url;
}
function copyTicket() {
  const t = sim.ticket; if (!t) return;
  const txt = `${t.side} ${t.qty} ${sim.c.symbol} at market | stop ${p4(t.stop)} | target ${p4(t.target)}`;
  try { navigator.clipboard.writeText(txt); userMsg = 'Ticket copied: ' + txt; } catch (e) { userMsg = txt; }
  render();
}
function downloadTrades() {
  const rows = ['closed_time,side,qty,entry,exit,reason,pnl,r'].concat(sim.ex.trades.map(t => [new Date(t.t).toISOString(), t.side, t.qty, t.entry, t.exit, t.reason, t.pnl.toFixed(2), t.r.toFixed(3)].join(',')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' })); a.download = 'closed-trades.csv'; document.body.appendChild(a); a.click(); a.remove();
}

// ---- settings ----
const FIELDS = [
  ['Instrument'], ['symbol', 'Instrument (sets tick, $ per point, swing size)', ['MHG', 'MES', 'MNQ', 'MGC', 'MCL']],
  ['Topstep account rules'], ['start', 'Starting balance ($)', 100], ['maxLoss', 'Max loss limit ($)', 100], ['floorOverride', 'Loss-limit level now in TopstepX ($, 0 = estimate)', 50], ['profitTarget', 'Profit target ($)', 100], ['dailyStop', 'Your daily stop ($)', 50],
  ['consistencyPct', 'Consistency limit (%)', 5], ['minDays', 'Minimum trading days', 1], ['maxContracts', 'Max contracts', 1], ['entryCutoff', 'No new entries after (CT, hh:mm)', 'time'], ['flatTime', 'Flat by (CT, hh:mm)', 'time'],
  ['Position sizing'], ['maxRiskPerTrade', 'Max risk per trade ($)', 25], ['riskFracOfBuffer', 'Max risk as share of buffer', 0.01], ['maxTradesPerDay', 'Max trades per day', 1], ['bufferHaltPct', 'Halt when buffer below (%)', 1],
  ['Scanner (fib continuation)'], ['pivotLen', 'Swing length (bars each side)', 1], ['minLeg', 'Minimum leg size (price)', 0.01], ['zoneLo', 'Entry zone starts at', 0.01], ['zoneHi', 'Entry zone ends at', 0.01], ['stopLvl', 'Stop beyond this retracement', 0.01], ['stopBuf', 'Stop buffer (price)', 0.001],
  ['tpMode', 'Target', ['retest', 'ext']], ['minRR', 'Minimum reward/risk', 0.1], ['maxBars', 'Max bars in a trade', 4],
  ['Backtester gate'], ['minTP', 'Strategy Lab: minimum take-profit hit rate (0.5 = 50%)', 0.05], ['sessionOpen', 'Opening-range breakout: session open (CT, hh:mm)', 'time'], ['gate', 'Gate mode', ['enforce', 'advisory']], ['minN', 'Minimum past trades', 1], ['z', 'Confidence (z, 0 = off, 1.28 = ~90%)', 0.1], ['lookback', 'Past trades to use', 10],
  ['Costs and contract'], ['tick', 'Tick size', 0.0001], ['mult', '$ per 1.00 price move', 1], ['fee', 'Fee per contract per side ($)', 0.1], ['slipTicks', 'Slippage (ticks)', 1]
];
function buildSettings() {
  $('settings').innerHTML = FIELDS.map(f => {
    if (f.length === 1) return `<h4>${esc(f[0])}</h4>`;
    const [k, label, kind] = f, v = sim.c[k];
    if (Array.isArray(kind)) return `<label>${esc(label)}<select onchange="applySetting('${k}',this.value)">${kind.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
    return `<label>${esc(label)}<input value="${esc(v)}" ${kind === 'time' ? '' : `type="number" step="${kind}"`} onchange="applySetting('${k}',this.value)"></label>`;
  }).join('');
}
function applySetting(k, raw) {
  if (k === 'symbol' && isLive()) { userMsg = 'The instrument is chosen when you connect. Disconnect (reload the page) to change it.'; buildSettings(); render(); return; }
  if (k === 'symbol') {
    const I = INSTR[raw], o = loadOverrides(); Object.assign(o, { symbol: raw, tick: I.tick, mult: I.mult, dec: I.dec, minLeg: I.minLeg, stopBuf: I.stopBuf }); saveOverrides(o); stopTimer();
    if (synthetic) { makeSim(genBars(6000, seedNo, raw)); userMsg = `Switched to ${raw} (${I.name}); new random candles at its price level. Check the contract details against CME.`; }
    else { makeSim(sim.bars); userMsg = `Switched to ${raw} (${I.name}).` + priceWarn(sim.bars, raw); }
    buildSettings(); render(); return;
  }
  const f = FIELDS.find(x => x[0] === k), kind = f[2]; let v = raw;
  if (kind === 'time') { if (!/^\d{1,2}:\d{2}$/.test(raw)) { userMsg = 'Times need the form hh:mm, for example 14:30.'; buildSettings(); render(); return; } }
  else if (!Array.isArray(kind)) { v = parseFloat(raw); if (!isFinite(v)) { userMsg = 'That setting needs a number.'; buildSettings(); render(); return; } }
  const o = loadOverrides(); o[k] = v; saveOverrides(o);
  if (isLive()) { sim.c[k] = v; if (k === 'floorOverride') sim.applyFloor(); userMsg = 'Setting changed. It applies to live trading immediately.'; buildSettings(); render(); return; }
  stopTimer(); userMsg = 'Setting changed, so the replay restarted from the beginning.'; makeSim(sim.bars); buildSettings(); render();
}
function resetSettings() { if (isLive()) { userMsg = 'Restore defaults is only available in Replay (it would change live limits mid-session).'; render(); return; } saveOverrides({}); stopTimer(); userMsg = 'Defaults restored, replay restarted.'; makeSim(sim.bars); buildSettings(); render(); }

makeSim(genBars(6000, seedNo, loadOverrides().symbol || 'MHG')); buildSettings(); render();
