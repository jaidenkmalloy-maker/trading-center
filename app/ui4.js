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
  r.broker.onLog = kpFromBroker; r.sim.onNote = kpFromNote; kpWake();
  return keepTicker(() => { r.tick(); kpWatch(); }, 3000);
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
  el.innerHTML = `<div class="form"><label>Trading day<input id="lvDate" type="date" value="${esc(day)}" onchange="lvRenderLevels()"></label>${LV_KINDS.map(([k, n2]) => `<label>${n2}<input id="lv_${k}" type="number" step="0.25" value="${esc(val(k))}" placeholder="optional"></label>`).join('')}<label>Adjust (add to every number)<input id="lvOff" type="number" step="0.25" value="${cur ? cur.off : LV.off}"></label></div>
  <div class="row" style="margin:8px 0"><button class="primary small" onclick="lvSave()">Save these levels</button><button class="small" onclick="lvClear()">Clear this day</button></div>
  <div class="note"><b id="lvMsgBox">${esc(LV.msg)}</b><br>${last ? 'Last MES price: ' + last.toFixed(2) + '. ' : ''}Days recorded: <b>${n}</b> of ${MIN_LVL_DAYS} needed before the Backtester can test level trades${n >= MIN_LVL_DAYS ? ' (enough now: the Lab will include them)' : ''}. Fill in only the levels your TradingView indicator shows. Use the numbers as they appear on an ES or MES futures chart. If your indicator shows SPX prices instead, type the current difference (ES price minus SPX price) into Adjust. Enter them each morning before the open.</div>`;
}
function lvMsgShow(m) { LV.msg = m; const e = document.getElementById('lvMsgBox'); if (e) e.textContent = m; }
function lvSave() {
  const day = document.getElementById('lvDate').value || lvToday(), off = +document.getElementById('lvOff').value || 0, raw = {}, lv = [], last = sim && sim.bars && sim.bars.length ? sim.bars[sim.bars.length - 1].c : null;
  for (const [k] of LV_KINDS) { const v = document.getElementById('lv_' + k).value; if (v === '') continue; const x = +v; if (!(x > 0)) { return lvMsgShow('Level "' + k + '" is not a number.'); } raw[k] = x; lv.push({ k, p: x + off }); }
  if (!lv.length) return lvMsgShow('Type at least one level first.');
  if (last && lv.some(l => Math.abs(l.p - last) / last > 0.08) && day === lvToday()) return lvMsgShow('Not saved: a level is more than 8% away from the current MES price (' + last.toFixed(2) + '). Check the numbers and the Adjust box.');
  LV.byDay[day] = { off, raw, lv }; LV.off = off; LV.msg = 'Saved ' + lv.length + ' levels for ' + day + '.'; lvSaveStore(); if (sim && sim.c) sim.c.levelsByDay = LV.byDay; lvRenderLevels(); if (typeof render === 'function') render();
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
  else if (u.state === 'available') b.innerHTML = `<div class="banner info"><b>Update ready:</b> ${esc(u.msg)} ${pos ? '<br>You have an open position. Install after it closes.' : ''} <button class="small primary" ${APPST.busy || pos ? 'disabled' : ''} onclick="appInstall()">Install update</button><br><span class="mut">Installing reloads the page, so you will need to reconnect (your settings, levels and alert name are kept).</span></div>`;
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
function appHasPos() { const B = typeof runner !== 'undefined' && runner && runner.broker; return !!(B && (B.state || (B.realPos || []).length)); }
function confirmFlat() { const pos = appHasPos(); return !pos; }
if (IS_APP) {
  const gw = document.getElementById('lvBase'); if (gw) gw.value = location.origin + '/tsx';
  appPoll(); setInterval(appPoll, 60000);
}
