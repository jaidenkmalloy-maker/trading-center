// ---- Keeper: phone alerts, keep-awake, and a ticker that browsers do not slow down ----
const KP = { topic: '', on: false, lastSend: 0, lastRes: 'Not set up yet.', seen: {}, day: null, dayStart: 0, sentSummary: null, wake: null, worker: null };
try { const s = JSON.parse(localStorage.getItem('ccL_alerts') || '{}'); KP.topic = s.topic || ''; KP.on = !!s.on; } catch (e) { }
const kpSave = () => { try { localStorage.setItem('ccL_alerts', JSON.stringify({ topic: KP.topic, on: KP.on })); } catch (e) { } };
const kpRandTopic = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = 'topstep-'; const r = (crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(14)) : Array.from({ length: 14 }, () => Math.random() * 256); for (let i = 0; i < 14; i++) s += a[r[i] % a.length]; return s; };
const KP_RULE = { error: [4, 'Problem'], flatten: [4, 'Flattened'], confirm: [4, 'Needs your OK'], fill: [3, 'Trade opened'], exit: [3, 'Trade closed'], order: [3, 'Order sent'], resize: [3, 'Position changed'], cleanup: [3, 'Cleanup'], mode: [2, 'Mode changed'] };
async function kpSend(title, msg, prio, force) {
  if (!KP.topic || (!KP.on && !force)) return false;
  const key = title + '|' + msg, now = Date.now(); if (!force && KP.seen[key] && now - KP.seen[key] < (title === 'Problem' ? 600000 : 60000)) return false; KP.seen[key] = now;
  try {
    const r = await fetch('https://ntfy.sh/' + encodeURIComponent(KP.topic), { method: 'POST', body: String(msg).slice(0, 900), headers: { Title: String(title).replace(/[^\x20-\x7e]/g, ''), Priority: String(prio || 3) } });
    KP.lastRes = r.ok ? 'Last alert sent ' + new Date().toLocaleTimeString() : 'The alert service answered with an error (' + r.status + ').'; kpRender(); return r.ok;
  } catch (e) { KP.lastRes = 'Could not reach the alert service (' + e.message + '). Check your internet connection.'; kpRender(); return false; }
}
function kpFromBroker(kind, msg, ok) { const r = KP_RULE[kind]; if (r) kpSend(r[1], msg, r[0]); }
function kpFromNote(sys, kind, msg) { if ((sys === 'rules' && kind === 'halt') || (sys === 'performance' && kind === 'pause')) kpSend(sys === 'rules' ? 'Rules Manager' : 'Performance Manager', msg, 4); }
function kpWatch() {   // once per tick: connection trouble and the end-of-day report
  const r = runner; if (!r || !sim || runner.sim !== sim) return;
  try { const L = r.learner; if (L && L.lastRunAt !== KP.labShown) { KP.labShown = L.lastRunAt; labRender(); } } catch (e) { }
  try { mktRender(); } catch (e) { }
  if (r.lastError) { if (!KP.errSince) KP.errSince = Date.now(); if (Date.now() - KP.errSince > 60000) kpSend('Problem', 'Connection trouble for over a minute: ' + r.lastError, 4); } else KP.errSince = null;
  const now = new Date(), ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' })), day = ct.toDateString(), mins = ct.getHours() * 60 + ct.getMinutes(), R = sim.rules;
  if (KP.day !== day) { KP.day = day; KP.dayStart = R.closed || 0; }
  if (mins >= hm(sim.c.flatTime) + 5 && KP.sentSummary !== day && ct.getDay() > 0 && ct.getDay() < 6) { KP.sentSummary = day; const d = (R.closed || 0) - KP.dayStart; kpSend('End of day', `Day P&L ${usd(d)}. Account is ${usd(R.closed || 0)} from the start. Systems are ${runner.broker.o.mode === 'watch' ? 'in watch mode' : 'running'}.`, 3, false); }
}
async function kpWake() { try { if (navigator.wakeLock && document.visibilityState === 'visible') KP.wake = await navigator.wakeLock.request('screen'); } catch (e) { KP.wake = null; } }
document.addEventListener('visibilitychange', () => { if (runner && document.visibilityState === 'visible') kpWake(); });
function keepTicker(fn, ms) {   // a background worker drives the ticks, so the browser does not slow them when the tab is hidden
  let w = null, iv = null;
  try { const url = URL.createObjectURL(new Blob(['setInterval(function(){postMessage(1)},' + ms + ')'], { type: 'text/javascript' })); w = new Worker(url); w.onmessage = fn; } catch (e) { w = null; iv = setInterval(fn, ms); }
  return { stop() { if (w) w.terminate(); if (iv) clearInterval(iv); } };
}
function kpStartLive(r) {
  r.broker.onLog = kpFromBroker; r.sim.onNote = kpFromNote; kpWake(); syncOffline();
  if (r.markets) r.markets.onSignal = (m, a) => kpSend('Setup on ' + m.sym, `${a.dir} (${a.name}): entry about ${a.entry}, stop ${a.stop}, target ${a.target}. Paper only, not traded.`, 3); setTimeout(() => gxSync(false), 500);
  return keepTicker(() => { r.tick(); kpWatch(); if (IS_APP && Date.now() - GX.syncedAt > 15 * 60000) gxSync(false); }, 3000);
}
function kpRender() {
  const el = document.getElementById('kpBody'); if (!el) return; const act = document.activeElement && document.activeElement.id === 'kpTopic';
  if (act) { const s = document.getElementById('kpStatus'); if (s) s.textContent = KP.lastRes; return; }
  el.innerHTML = `<div class="form"><label>Your private alert name<input id="kpTopic" value="${esc(KP.topic)}" onchange="kpSet(this.value)" placeholder="press Make one for me"></label></div>
  <div class="row" style="margin:8px 0"><button class="small" onclick="kpMake()">Make one for me</button><button class="small" onclick="kpTest()">Send a test alert</button><label class="row" style="gap:5px"><input type="checkbox" ${KP.on ? 'checked' : ''} onchange="kpToggle(this.checked)"> Send alerts to my phone</label></div>
  <div id="kpStatus" class="note">${esc(KP.lastRes)}</div>
  <div class="note"><b>One-time phone setup:</b> install the free <b>ntfy</b> app (App Store or Google Play), tap +, type exactly the alert name above, and subscribe. Then press "Send a test alert". Anyone who knows the name can read the alerts, so keep it private. You get alerts for: trades opening and closing, a trade waiting for your OK, problems, loss-limit and pause events, and a short end-of-day report.</div>`;
}
function kpSet(v) { KP.topic = v.trim(); kpSave(); }
function kpMake() { KP.topic = kpRandTopic(); KP.on = true; kpSave(); KP.lastRes = 'Name made. Subscribe to it in the ntfy app, then send a test.'; kpRender(); }
function kpToggle(on) { KP.on = on; kpSave(); }
async function kpTest() { if (!KP.topic) { KP.lastRes = 'Press "Make one for me" first.'; kpRender(); return; } const ok = await kpSend('Test', 'Hello from your trading control center. If you can read this on your phone, alerts work.', 3, true); if (!ok) kpRender(); }

// ---- Levels: the daily GEX / IV-wall numbers you copy from TradingView ----
const LV = { byDay: {}, off: 0, msg: '' };
try { const s = JSON.parse(localStorage.getItem('ccL_levels') || '{}'); LV.byDay = s.byDay || {}; LV.off = +s.off || 0; } catch (e) { }
const lvSaveStore = () => { try { localStorage.setItem('ccL_levels', JSON.stringify({ byDay: LV.byDay, off: LV.off })); } catch (e) { } };
const LV_KINDS = [['call', 'Call wall (top)'], ['ivHi', 'IV high (expected-move top)'], ['flip', 'Gamma flip (zero gamma)'], ['ivLo', 'IV low (expected-move bottom)'], ['put', 'Put wall (bottom)']];
const lvToday = () => ctInfo(Date.now()).day;
function lvRenderLevels(keepInputs) {
  const el = document.getElementById('lvlBody'); if (!el) return; if (keepInputs && el.querySelector('input:focus')) return;
  const day = (el.querySelector('#lvDate') && el.querySelector('#lvDate').value) || lvToday(), cur = LV.byDay[day], n = lvlDays({ levelsByDay: LV.byDay });
  const val = k => { const l = cur && cur.lv.find(x => x.k === k); return l && cur.raw && cur.raw[k] != null ? cur.raw[k] : ''; };
  const last = sim && sim.bars && sim.bars.length ? sim.bars[sim.bars.length - 1].c : null;
  el.innerHTML = gxHtml() + `<div class="form"><label>Trading day<input id="lvDate" type="date" value="${esc(day)}" onchange="lvRenderLevels()"></label>${LV_KINDS.map(([k, n2]) => `<label>${n2}<input id="lv_${k}" type="number" step="0.25" value="${esc(val(k))}" placeholder="optional"></label>`).join('')}<label>Adjust (add to every number)<input id="lvOff" type="number" step="0.25" value="${cur ? cur.off : LV.off}"></label></div>
  <div class="row" style="margin:8px 0"><button class="primary small" onclick="lvSave()">Save these levels</button><button class="small" onclick="lvClear()">Clear this day</button></div>
  <div class="note"><b id="lvMsgBox">${esc(LV.msg)}</b><br>${last ? 'Last MES price: ' + last.toFixed(2) + '. ' : ''}Days recorded: <b>${n}</b> of ${MIN_LVL_DAYS} needed before the Backtester can test level trades${n >= MIN_LVL_DAYS ? ' (enough now: the Lab will include them)' : ''}. Fill in only the levels your TradingView indicator shows. Use the numbers as they appear on an ES or MES futures chart. If your indicator shows SPX prices instead, type the current difference (ES price minus SPX price) into Adjust. Enter them each morning before the open.</div>`;
}
function lvMsgShow(m) { LV.msg = m; const e = document.getElementById('lvMsgBox'); if (e) e.textContent = m; }
function lvSave() {
  const day = document.getElementById('lvDate').value || lvToday(), off = +document.getElementById('lvOff').value || 0, raw = {}, lv = [], last = sim && sim.bars && sim.bars.length ? sim.bars[sim.bars.length - 1].c : null;
  for (const [k] of LV_KINDS) { const v = document.getElementById('lv_' + k).value; if (v === '') continue; const x = +v; if (!(x > 0)) { return lvMsgShow('Level "' + k + '" is not a number.'); } raw[k] = x; lv.push({ k, p: x + off }); }
  if (!lv.length) return lvMsgShow('Type at least one level first.');
  if (last && lv.some(l => Math.abs(l.p - last) / last > 0.08) && day === lvToday()) return lvMsgShow('Not saved: a level is more than 8% away from the current MES price (' + last.toFixed(2) + '). Check the numbers and the Adjust box.');
  LV.byDay[day] = { off, raw, lv, auto: false }; LV.off = off; LV.msg = 'Saved ' + lv.length + ' levels for ' + day + '.'; lvSaveStore(); if (sim && sim.c) sim.c.levelsByDay = LV.byDay; lvRenderLevels(); if (typeof render === 'function') render();
}
function lvClear() { const day = document.getElementById('lvDate').value || lvToday(); delete LV.byDay[day]; LV.msg = 'Cleared ' + day + '.'; lvSaveStore(); lvRenderLevels(); }

// ---- when running as the installed app (served from this computer by server.js) ----
const IS_APP = typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const APPST = { version: null, update: null, busy: false, msg: '' };
async function appPoll() {
  try { const r = await fetch('/app/status', { cache: 'no-store' }); const j = await r.json(); APPST.version = j.version; APPST.update = j.update; } catch (e) { APPST.update = { state: 'error', msg: 'The app program is not answering. Is its black window still open?' }; }
  appRender();
}
function appRender() {
  const v = document.getElementById('appVer'), b = document.getElementById('appBanner'); if (!v || !b) return;
  v.style.display = ''; v.textContent = 'App v' + (APPST.version || '?'); const u = APPST.update || {};
  const pos = appHasPos();
  if (APPST.msg) b.innerHTML = `<div class="banner info">${esc(APPST.msg)}</div>`;
  else if (u.state === 'available') b.innerHTML = `<div class="banner info"><b>Update ready:</b> ${esc(u.msg)} ${pos ? '<br>The bot has a trade open. Install after it closes.' : ''} <button class="small primary" ${APPST.busy || pos ? 'disabled' : ''} onclick="appInstall()">Install update</button><br><span class="mut">Installing reloads the page, so you will need to reconnect (your settings, levels and alert name are kept).</span></div>`;
  else if (u.state === 'error') b.innerHTML = `<div class="banner amber">${esc(u.msg)}</div>`;
  else b.innerHTML = '';
}
async function appInstall() {
  if (!confirmFlat()) return; APPST.busy = true; APPST.msg = 'Downloading and checking the update…'; appRender();
  try { const r = await (await fetch('/app/install', { method: 'POST' })).json(); APPST.busy = false;
    if (!r.ok) { APPST.msg = 'Update not installed: ' + r.msg; appRender(); setTimeout(() => { APPST.msg = ''; appPoll(); }, 15000); return; }
    APPST.msg = r.restart ? 'Installed version ' + r.version + '. Close the black app window and start the app again to finish.' : 'Installed version ' + r.version + '. Reloading…'; appRender();
    if (!r.restart) setTimeout(() => location.reload(), 1500);
  } catch (e) { APPST.busy = false; APPST.msg = 'Update failed: ' + e.message; appRender(); }
}
function appHasPos() { const B = typeof runner !== 'undefined' && runner && runner.broker; return !!(B && B.state); }   // only the bot's own trades block an update; yours are not touched by it
function confirmFlat() { const pos = appHasPos(); return !pos; }
if (IS_APP) {
  const gw = document.getElementById('lvBase'); if (gw) gw.value = location.origin + '/tsx';
  appPoll(); setInterval(appPoll, 60000);
}

// ---- automatic GEX levels (free Cboe data, computed by the app program) ----
const GX = { last: null, err: null, syncedAt: 0, busy: false };
function gxPriceAt(ms) { const b = sim && sim.bars; if (!b || !b.length) return null; let best = null; for (let i = b.length - 1; i >= 0; i--) { if (b[i].t <= ms) { best = b[i]; break; } } return best && ms - best.t < 3 * 3600e3 ? best.c : null; }
function gxBasis(s) {   // MES minus SPX, measured at a moment when both were really trading
  const q = (s.fetchedAt || 0) - 15 * 60000, m = ctInfo(q).mins, b = sim && sim.bars;
  if (m >= 510 && m < 900) { const mes = gxPriceAt(q); return mes == null ? null : Math.round((mes - s.spot) * 4) / 4; }   // stock market open: compare at the quote time
  // stock market closed (e.g. the 8:00 CT reading): Cboe's SPX price is the last close, so compare with MES at that same close (3:00 pm CT)
  if (!b) return null; for (let i = b.length - 1; i >= 0; i--) { if (b[i].t > q) continue; const bm = ctInfo(b[i].t).mins; if (bm === 885) return Math.round((b[i].c - s.spot) * 4) / 4; if (q - b[i].t > 4 * 864e5) break; }
  return null;
}
function gxApply(day, s) {
  if (!s || !s.spot) return false; const cur = LV.byDay[day]; if (cur && !cur.auto) return false;   // never overwrite levels you typed
  const off = gxBasis(s); if (off == null) return false;
  const raw = {}, lv = [];
  for (const [k, f] of [['call', 'callWall'], ['put', 'putWall'], ['flip', 'flip'], ['ivHi', 'ivHi'], ['ivLo', 'ivLo']]) if (s[f] > 0) { raw[k] = s[f]; lv.push({ k, p: Math.round((s[f] + off) * 4) / 4 }); }
  if (!lv.length) return false;
  LV.byDay[day] = { auto: true, off, raw, lv, spot: s.spot, regime: s.regime }; return true;
}
async function gxSync(force) {
  if (!IS_APP || GX.busy) return; GX.busy = true;
  try {
    let now = await (await fetch('/app/gex' + (force ? '?force=1' : ''), { cache: 'no-store' })).json();
    if (!now.fresh && now.cboeUrl) {   // the app program was turned away: fetch from this window (a real browser) and hand the data over
      try { const r = await fetch(now.cboeUrl, { cache: 'no-store' }); if (!r.ok) throw new Error('Cboe answered ' + r.status + ' (browser)');
        const ing = await (await fetch('/app/gex/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: await r.text() })).json(); if (!ing.ok) throw new Error(ing.error);
        now = await (await fetch('/app/gex', { cache: 'no-store' })).json();
      } catch (e) { now.error = (now.error || 'Could not get GEX data') + '; the browser route failed too (' + e.message + ')'; }
    }
    GX.last = now.levels; GX.err = now.fresh ? null : now.error; GX.today = now.today;
    const hist = (await (await fetch('/app/gex/history', { cache: 'no-store' })).json()).days || {}; let changed = false;
    for (const [day, s] of Object.entries(hist)) if (gxApply(day, s)) changed = true;
    if (changed) { lvSaveStore(); if (sim && sim.c) sim.c.levelsByDay = LV.byDay; }
    GX.syncedAt = Date.now(); lvRenderLevels(true);
  } catch (e) { GX.err = 'The app program did not answer: ' + e.message; }
  finally { GX.busy = false; }
}
function gxHtml() {
  if (!IS_APP) return '<div class="note">Automatic GEX levels work in the app version (Start Trading Center).</div>';
  const s = GX.last; if (!s && !GX.err) return '<div class="note">Getting free GEX data from Cboe…</div>';
  if (!s) return `<div class="note neg">${esc(GX.err)}</div>`;
  const f = x => x == null ? '-' : x.toFixed(2), td = LV.byDay[GX.today];
  return `<div class="gexbox"><div class="gexhd"><b>Auto GEX</b> <span class="tag ${s.regime === 'positive' ? 'good' : 'bad'}">${s.regime} gamma</span> <span class="mut">free Cboe data, about 15 min delayed, SPX ${f(s.spot)}</span></div>
    <div class="gexrow"><span>Call wall <b>${f(s.callWall)}</b></span><span>IV high <b>${f(s.ivHi)}</b></span><span>Flip <b>${f(s.flip)}</b></span><span>IV low <b>${f(s.ivLo)}</b></span><span>Put wall <b>${f(s.putWall)}</b></span></div>
    <div class="note">${td && td.auto ? 'Today\'s levels were set automatically from the 8:00 CT reading (shifted ' + (td.off >= 0 ? '+' : '') + td.off + ' to MES prices).' : td ? 'You typed today\'s levels yourself, so the automatic ones are not used today.' : 'Today\'s levels are saved from the first reading after 8:00 CT on trading days.'} Positive gamma tends to calm moves (bounces at walls); negative gamma tends to stretch them.${GX.err ? ' Last refresh failed: ' + esc(GX.err) : ''}</div></div>`;
}

// ---- probation lane in the Strategy Lab panel ----
function probHtml() {
  const P = runner.probation, rows = P.rows(), f = x => x == null ? '-' : x;
  let h = `<h3 class="subh">On probation <small>paper trading live, no real orders. Only setups after a strategy joined count. It needs ${PROB.promoteN} live trades that make money to be promoted.</small></h3>`;
  if (!rows.length) return h + '<div class="empty">Nothing on probation yet. Strategies that come close in the Lab are added here.</div>';
  h += `<table class="nw"><thead><tr><th>Strategy</th><th>Joined</th><th>Live trades</th><th>Hit TP</th><th>Per contract</th><th>In the Lab</th><th>Status</th><th></th></tr></thead><tbody>`;
  for (const r of rows) {
    const bar = Math.min(1, r.n / PROB.promoteN), col = r.status === 'ready' ? '#3ee6b0' : r.status === 'failed' ? '#f27272' : '#2bb7d6';
    h += `<tr><td style="white-space:normal;min-width:180px">${esc(r.label)}</td><td>${esc(fmtT(r.since).slice(0, 10))}</td><td><div class="pbar"><i style="width:${(bar * 100).toFixed(0)}%;background:${col}"></i></div>${r.n} / ${PROB.promoteN}</td><td>${r.pTP == null ? '-' : pct(r.pTP)}</td><td class="${cls(r.exp || 0)}">${r.exp == null ? '-' : usd(r.exp)}</td><td class="mut">${r.lab ? usd(r.lab.exp) + ', ' + pct(r.lab.pTP) + ' TP' : 'no history'}</td><td style="white-space:normal;min-width:200px" class="vd ${r.status === 'ready' ? 'ok' : 'no'}">${esc(r.verdict)}</td><td>${r.status === 'ready' ? `<button class="small primary" onclick="probUse('${esc(r.key)}')">Use it</button> ` : ''}<button class="small" onclick="probDrop('${esc(r.key)}')">${r.always ? 'Restart' : 'Remove'}</button></td></tr>`;
  }
  return h + '</tbody></table>';
}
function probUse(key) { if (runner && runner.probation && runner.probation.promote(key)) { lvRender(); labRender(); render(); } }
function probDrop(key) { if (runner && runner.probation && runner.probation.drop(key)) labRender(); }

// ---- the app opens straight to Live; the dashboard appears once connected ----
function syncOffline() { try { document.body.classList.toggle('offline', !(isLive() && runner && runner.sim && runner.sim === sim)); } catch (e) { } }
if (typeof document !== 'undefined') { try { setView('live'); } catch (e) { } syncOffline(); }

// ---- Markets table: every other Topstep market, scanned and tested on paper ----
function mktRender() {
  const el = document.getElementById('mktBody'); if (!el || !runner || !runner.markets) return; const W = runner.markets, S = W.summary();
  const chip = v => `<span class="tf ${v > 0 ? 'up' : v < 0 ? 'dn' : 'fl'}">${v > 0 ? '&#9650;' : v < 0 ? '&#9660;' : '&#9644;'}</span>`;
  const order = { ready: 0, testing: 0, loading: 1, queued: 2, thin: 3, absent: 4 };
  const rows = W.m.slice().sort((a, b) => ((b.sim && (b.sim.c.strategies || []).length) ? 1 : 0) - ((a.sim && (a.sim.c.strategies || []).length) ? 1 : 0) || order[a.status] - order[b.status] || a.sym.localeCompare(b.sym));
  let h = `<div class="note" style="margin:0 0 8px">Scanning <b>${S.live}</b> markets${S.absent ? ` (${S.absent} not offered on your account)` : ''} · <b>${S.approved}</b> with a strategy that passed the Lab. The first full round of testing takes a while; it runs one market at a time in the background. Setups found here are alerts and paper results only: the bot only ever trades your main market (${esc(runner.sym || '')}).</div>`;
  h += `<table class="nw"><thead><tr><th>Market</th><th>Price</th><th>15m 1h 4h D</th><th>Strategy Lab</th><th>Latest setup</th></tr></thead><tbody>`;
  for (const m of rows) {
    if (m.status === 'absent') continue;
    const last = m.sim ? m.sim.bars[m.sim.bars.length - 1] : null, ap = m.sim ? (m.sim.c.strategies || []) : [], a = m.alerts[0];
    const lab = m.status === 'testing' ? `testing… ${Math.round((m.lab.progress || 0) * 100)}%` : !m.sim ? esc(m.note) : ap.length ? `<span class="pos">approved: ${esc(ap.map(x => STRATS[x.id].name).join(', '))}</span>` : m.saved ? '<span class="mut">nothing passed' + (m.saved.best && m.saved.best.exp > 0 ? ' (closest: ' + esc(m.saved.best.label || '') + ')' : '') + '</span>' : '<span class="mut">waiting to be tested</span>';
    h += `<tr><td><b>${esc(m.sym)}</b> <span class="mut">${esc(m.contract ? m.contract.name : '')}</span></td><td>${last ? Number(last.c.toFixed(Math.min(m.sim.c.dec, 6))).toLocaleString('en-US', { maximumFractionDigits: 6 }) : '-'}</td><td>${m.trend ? chip(m.trend.m15) + chip(m.trend.h1) + chip(m.trend.h4) + chip(m.trend.d1) : '-'}</td><td style="white-space:normal;min-width:220px">${lab}</td><td>${a ? `<span class="tag ${a.dir === 'long' ? 'good' : 'bad'}">${a.dir}</span> ${esc(fmtT(a.t))} · ${esc(a.name)}` : '<span class="mut">none yet</span>'}</td></tr>`;
  }
  setHtml('mktBody', h + '</tbody></table>');
}

// ---- the chat history is remembered too ----
try { const c0 = JSON.parse(localStorage.getItem('ccL_chats') || 'null'); if (c0 && typeof c0 === 'object') { chats = c0; if (typeof chatRender === 'function') try { chatRender(); } catch (e) { } } } catch (e) { }
const chatSave = () => { try { const o = {}; for (const [k, v] of Object.entries(chats)) o[k] = (v || []).filter(m => !m.action && m.text !== 'Thinking…').slice(-40); localStorage.setItem('ccL_chats', JSON.stringify(o)); } catch (e) { } };
if (typeof window !== 'undefined') { setInterval(chatSave, 30000); window.addEventListener('pagehide', chatSave); }

// ---- Export data: 5-minute candles for every market, as far back as Topstep allows, in one zip file ----
const EXP = { busy: false, msg: '', stop: false };
const MCODES = 'FGHJKMNQUVXZ';
function olderIds(id, n) {   // CON.F.US.MES.Z26 -> the same market's earlier contract months
  const m = /^(.*\.)([FGHJKMNQUVXZ])(\d{2})$/.exec(id); if (!m) return [];
  let mi = MCODES.indexOf(m[2]), yy = +m[3]; const out = [];
  for (let k = 0; k < n; k++) { mi--; if (mi < 0) { mi = 11; yy--; } out.push(m[1] + MCODES[mi] + String(yy).padStart(2, '0')); }
  return out;
}
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = crcTable[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
async function deflateRaw(u) { if (typeof CompressionStream === 'undefined') return null; const cs = new CompressionStream('deflate-raw'); const out = new Response(new Blob([u]).stream().pipeThrough(cs)); return new Uint8Array(await out.arrayBuffer()); }
async function makeZip(files) {   // files: [{ name, text }]
  const enc = new TextEncoder(), parts = [], cdir = []; let off = 0;
  for (const f of files) {
    const data = enc.encode(f.text), crc = crc32(data), comp = await deflateRaw(data), method = comp ? 8 : 0, body = comp || data, name = enc.encode(f.name);
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, method, true); h.setUint32(14, crc, true); h.setUint32(18, body.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, body);
    const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(10, method, true); c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    cdir.push(new Uint8Array(c.buffer), name); off += 30 + name.length + body.length;
  }
  const csize = cdir.reduce((a, x) => a + x.length, 0), e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cdir, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
async function expBars(api, id, live, maxDays, cap) {
  const now = Date.now(), out = []; let end = now, empty = 0;
  for (let page = 0; page < 12 && end > now - maxDays * 864e5 && out.length < cap && !EXP.stop; page++) {
    let b = [];
    for (let tryN = 0; tryN < 2; tryN++) { try { b = await api.bars(id, end - 60 * 864e5, end, 5, live, 20000); break; } catch (e) { if (/429|too many/i.test(e.message) && tryN === 0) { EXP.msg = 'Topstep asked to slow down; waiting 30 seconds…'; expRender(); await sleep(30000); } else { b = []; break; } } }
    await sleep(EXP.gap);
    if (!b.length) { if (++empty >= 2) break; end -= 60 * 864e5; continue; }
    empty = 0; out.unshift(...b); end = b[0].t - 1;
  }
  return out;
}
async function exportData() {
  if (EXP.busy || !runner || !runner.api) return; EXP.busy = true; EXP.stop = false; EXP.gap = EXP.gap == null ? 700 : EXP.gap;
  const api = runner.api, live = runner.o.live, files = [], info = [], t0 = Date.now();
  const list = [{ sym: runner.sym, contract: runner.contract, live }];
  try {
    for (const m of (runner.markets ? runner.markets.m : [])) {   // markets not looked up yet are looked up now
      if (EXP.stop) break; let c = m.contract, lv = m.live;
      if (!c && m.status !== 'absent') { EXP.msg = 'Looking up ' + m.sym + ' on Topstep…'; expRender(); try { const f = await runner.markets.find(m.sym); if (f) { c = f.c; lv = f.live; } } catch (e) { } }
      if (c) list.push({ sym: m.sym, contract: c, live: lv });
    }
    for (let k = 0; k < list.length && !EXP.stop; k++) {
      const m = list[k], rows = [], got = [];
      for (const id of [m.contract.id].concat(olderIds(m.contract.id, 9))) {
        if (EXP.stop) break; EXP.msg = `Downloading ${m.sym} (${k + 1} of ${list.length}): ${id.split('.').pop()}…`; expRender();
        const b = await expBars(api, id, m.live, 400, 150000); if (!b.length) continue;
        got.push({ id, n: b.length, from: new Date(b[0].t).toISOString(), to: new Date(b[b.length - 1].t).toISOString() });
        for (const x of b) rows.push(id.split('.').pop() + ',' + new Date(x.t).toISOString() + ',' + x.o + ',' + x.h + ',' + x.l + ',' + x.c + ',' + (x.v || 0));
        if (rows.length > 300000) break;
      }
      if (rows.length) files.push({ name: m.sym + '_5min.csv', text: 'contract,time_utc,open,high,low,close,volume\n' + rows.join('\n') + '\n' });
      info.push({ market: m.sym, name: m.contract.name, description: m.contract.description, tickSize: m.contract.tickSize, tickValue: m.contract.tickValue, contracts: got, rows: rows.length });
    }
    let gex = {}; try { if (IS_APP) gex = (await (await fetch('/app/gex/history')).json()).days || {}; } catch (e) { }
    files.push({ name: 'gex_levels_by_day.json', text: JSON.stringify(gex, null, 1) });
    files.push({ name: 'levels_typed_or_auto.json', text: JSON.stringify(LV.byDay, null, 1) });
    files.push({ name: 'markets.json', text: JSON.stringify({ exported: new Date().toISOString(), timezone_note: 'times are UTC; Central Time is UTC-6 in winter, UTC-5 in summer', markets: info }, null, 1) });
    EXP.msg = 'Packing the file…'; expRender();
    const blob = await makeZip(files), name = 'topstep-data-' + new Date().toISOString().slice(0, 10) + '.zip';
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
    const total = info.reduce((s, x) => s + x.rows, 0);
    EXP.msg = `Done: ${info.filter(x => x.rows).length} markets, ${total.toLocaleString()} candles, ${(blob.size / 1e6).toFixed(1)} MB, saved to your Downloads folder as ${name}. Send that file to Claude.`; EXP.last = { name, size: blob.size, total, markets: info };
  } catch (e) { EXP.msg = 'Export stopped: ' + e.message; }
  finally { EXP.busy = false; expRender(); }
}
function expRender() {
  const el = document.getElementById('expBody'); if (!el) return;
  el.innerHTML = `<div class="row"><button class="primary" id="expBtn" onclick="exportData()" ${EXP.busy || !runner || !runner.sim ? 'disabled' : ''}>${EXP.busy ? 'Working…' : 'Export data'}</button><button id="expLong" onclick="exportLong()" ${EXP.busy ? 'disabled' : ''}>Download long history (Yahoo)</button>${EXP.busy ? '<button onclick="EXP.stop=true">Stop</button>' : ''}</div><div class="note">${esc(EXP.msg || 'Saves 5-minute candles for every market your account offers, going back as far as Topstep allows (up to about a year), plus the saved GEX levels, into one zip file in your Downloads folder. Download long history gets about 2 years of hourly and 20+ years of daily candles for the same markets from Yahoo Finance (free). Each takes a few minutes. Your login and account details are never included.')}</div>`;
}

// ---- Download long history (Yahoo Finance, free): about 2 years of hourly and 20+ years of daily candles ----
const YSYM = [['MES', 'ES=F'], ['MNQ', 'NQ=F'], ['MYM', 'YM=F'], ['M2K', 'RTY=F'], ['NKD', 'NKD=F'], ['MCL', 'CL=F'], ['NG', 'NG=F'], ['MGC', 'GC=F'], ['SIL', 'SI=F'], ['MHG', 'HG=F'], ['PL', 'PL=F'],
  ['M6E', '6E=F'], ['M6A', '6A=F'], ['M6B', '6B=F'], ['6J', '6J=F'], ['6C', '6C=F'], ['6S', '6S=F'], ['6M', '6M=F'], ['ZT', 'ZT=F'], ['ZF', 'ZF=F'], ['ZN', 'ZN=F'], ['ZB', 'ZB=F'], ['UB', 'UB=F'],
  ['ZC', 'ZC=F'], ['ZS', 'ZS=F'], ['ZW', 'ZW=F'], ['ZL', 'ZL=F'], ['ZM', 'ZM=F'], ['HE', 'HE=F'], ['LE', 'LE=F'], ['MBT', 'BTC=F'], ['MET', 'ETH=F'], ['VIX', '^VIX'], ['SPX', '^GSPC']];
async function exportLong() {
  if (EXP.busy) return; if (!IS_APP) { EXP.msg = 'This works in the app version (Start Trading Center).'; return expRender(); }
  EXP.busy = true; EXP.stop = false; const files = [], info = [], gap = EXP.gap == null ? 1200 : EXP.gap;
  try {
    for (let k = 0; k < YSYM.length && !EXP.stop; k++) {
      const [mk, ys] = YSYM[k], row = { market: mk, yahoo: ys, sets: [] };
      for (const [iv, rg] of [['1h', '730d'], ['1d', 'max']]) {
        if (EXP.stop) break; EXP.msg = `Downloading ${mk} (${k + 1} of ${YSYM.length}), ${iv === '1h' ? 'hourly' : 'daily'} candles…`; expRender();
        let j = null, err = null;
        for (let tryN = 0; tryN < 3 && !j; tryN++) {
          try { const r = await fetch(`/app/yahoo?s=${encodeURIComponent(ys)}&i=${iv}&r=${rg}`, { cache: 'no-store' }); if (r.status === 404 && tryN === 0) { err = 'the app program needs a restart to do this'; break; } const x = await r.json(); if (!r.ok) throw new Error(x.error || r.status); j = x; }
          catch (e) { err = e.message; if (/429/.test(err)) { EXP.msg = 'Yahoo asked to slow down; waiting 30 seconds…'; expRender(); await sleep(30000); } else await sleep(2000); }
        }
        await sleep(gap);
        const res = j && j.chart && j.chart.result && j.chart.result[0];
        if (!res || !res.timestamp) { row.sets.push({ interval: iv, rows: 0, error: err || (j && j.chart && j.chart.error && j.chart.error.description) || 'no data' }); if (err && /restart/.test(err)) throw new Error('Close the black app window and start the app again from the Desktop icon, then try once more.'); continue; }
        const q = res.indicators.quote[0], ts = res.timestamp, lines = [];
        for (let i = 0; i < ts.length; i++) { const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i]; if ([o, h, l, c].some(v => v == null)) continue; lines.push(new Date(ts[i] * 1000).toISOString() + ',' + o + ',' + h + ',' + l + ',' + c + ',' + (q.volume && q.volume[i] || 0)); }
        files.push({ name: `${mk}_${iv}.csv`, text: 'time_utc,open,high,low,close,volume\n' + lines.join('\n') + '\n' });
        row.sets.push({ interval: iv, rows: lines.length, from: lines.length ? lines[0].slice(0, 10) : null, to: lines.length ? lines[lines.length - 1].slice(0, 10) : null, exchangeTimezone: res.meta && res.meta.exchangeTimezoneName });
      }
      info.push(row);
    }
    files.push({ name: 'about.json', text: JSON.stringify({ source: 'Yahoo Finance continuous front-month futures (unofficial, for personal research)', exported: new Date().toISOString(), note: 'times are UTC; rolls between contract months can cause small jumps', markets: info }, null, 1) });
    EXP.msg = 'Packing the file…'; expRender();
    const blob = await makeZip(files), name = 'long-history-' + new Date().toISOString().slice(0, 10) + '.zip';
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
    const ok = info.filter(x => x.sets.some(s => s.rows)).length, rows = info.reduce((s, x) => s + x.sets.reduce((a, y) => a + (y.rows || 0), 0), 0);
    EXP.msg = `Done: ${ok} of ${YSYM.length} markets, ${rows.toLocaleString()} candles, ${(blob.size / 1e6).toFixed(1)} MB, saved to your Downloads folder as ${name}. Send that file to Claude.`;
  } catch (e) { EXP.msg = 'Download stopped: ' + e.message; }
  finally { EXP.busy = false; expRender(); }
}
