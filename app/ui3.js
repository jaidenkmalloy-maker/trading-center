// ===== UI PART 3: Live (Topstep) view, mode gate, learning panel, chat with each system =====
const lsStore = { get: k => { try { return localStorage.getItem('ccL_' + k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem('ccL_' + k, v); } catch (e) { } } };
let replayStash = null, lvTimer = null, lvGateMode = null, lvLastHtml = {}, chatSys = 'all', chats = {};
const setHtml = (id, html) => { if (lvLastHtml[id] !== html) { lvLastHtml[id] = html; $(id).innerHTML = html; } };   // only touch the page when something changed (keeps menus and typing intact)
const lvMsg = (t, bad) => { $('lvMsg').innerHTML = t ? `<div class="banner ${bad ? 'red' : 'info'}">${esc(t)}</div>` : ''; };
const fmtT = ms => tt(ms);

function setView(v) {
  if (v === 'live' && view !== 'live') { replayStash = { sim, synthetic, srcLabel, userMsg }; view = 'live'; stopTimer(); if (runner && runner.sim) { sim = runner.sim; synthetic = false; srcLabel = 'LIVE · ' + runner.account.name; } }
  else if (v === 'replay' && view !== 'replay') { view = 'replay'; if (replayStash) { sim = replayStash.sim; synthetic = replayStash.synthetic; srcLabel = replayStash.srcLabel; } }
  syncView(); render(); lvRender(); chatRender(); labRender();
}
function syncView() {
  const L = view === 'live';
  $('liveWrap').style.display = L ? 'block' : 'none'; $('replayBtns').style.display = L ? 'none' : 'flex'; $('dataBox').style.display = L ? 'none' : 'block';
  $('tabReplay').className = 'small' + (L ? '' : ' primary'); $('tabLive').className = 'small' + (L ? ' primary' : '');
  $('tkSub').textContent = L ? 'what the Executor is sending' : 'to place by hand in TopstepX'; $('ordSub').textContent = L ? '(paper twin: simulated on the same candles)' : '';
  if (L && !lvLastHtml.userFilled) { lvLastHtml.userFilled = 1; const u = lsStore.get('user'); if (u && !$('lvUser').value) $('lvUser').value = u; }
}

// ---- connect ----
async function lvConnect() {
  const user = $('lvUser').value.trim(), key = $('lvKey').value, sym = $('lvSym').value, tf = parseInt($('lvTf').value, 10) || 15;
  if (!user || !key) return lvMsg('Enter your TopstepX username and API key.', true);
  lvMsg('Connecting to Topstep…');
  const cfg0 = Object.assign({}, loadOverrides()); delete cfg0.strategies; const r = new LiveRunner({ base: $('lvBase').value.trim() || undefined, tf, store: lsStore, cfg: cfg0 });
  try {
    const accs = await r.connect(user, key); $('lvKey').value = ''; lsStore.set('user', user);
    const usable = accs.filter(a => a.canTrade !== false); if (!usable.length) throw new Error('Connected, but no tradable accounts were found.');
    const cs = await r.findContracts(sym); if (!cs.length) throw new Error('No ' + sym + ' contract came back from Topstep (' + (r.lastSearch ? r.lastSearch.tried.join('; ') : '') + (r.lastSearch && r.lastSearch.names.length ? '; saw: ' + r.lastSearch.names.slice(0, 6).join(', ') : '') + '). Check that your market-data subscription is active in TopstepX, or try another instrument.');
    $('lvAcct').innerHTML = usable.map(a => `<option value="${a.id}">${esc(a.name)} · ${usd(a.balance)}</option>`).join('');
    $('lvContract').innerHTML = cs.map((c, k) => `<option value="${k}">${esc(c.name)} · ${esc(c.description || '')} · tick ${c.tickSize}, $${(c.tickValue / c.tickSize).toFixed(2)}/pt</option>`).join('');
    runner = r; runner._cs = cs; runner._sym = sym; $('connForm').style.display = 'none'; $('connStep2').style.display = 'grid';
    lvMsg('Connected. Choose the account (use your new Combine) and the contract, then start. Check the tick size and $ per point against TopstepX.');
  } catch (e) { lvMsg(e.message, true); }
}
async function lvStart() {
  const r = runner; if (!r) return; const accId = +$('lvAcct').value, c = r._cs[+$('lvContract').value];
  lvMsg('Downloading history. This can take a few seconds…');
  try {
    r.o.cfg = Object.assign({}, r.o.cfg, { levelsByDay: LV.byDay });
    const s = await r.start(accId, c, r._sym); sim = s; synthetic = false; srcLabel = 'LIVE · ' + r.account.name;
    r.onChange = () => { render(); lvRender(); }; r.onLearned = () => { };
    if (lvTimer) lvTimer.stop(); lvTimer = kpStartLive(r); kpRender(); lvRenderLevels(); expRender();
    $('connStep2').style.display = 'none'; $('lvCtlWrap').style.display = 'block';
    lvMsg(`Live and in Watch only mode. The Strategy Lab is testing strategies now. ${s.bars.length} candles loaded (${fmtT(s.bars[0].t)} to ${fmtT(s.bars[s.bars.length - 1].t)} CT). Nothing will be sent to Topstep until you change the mode.`);
    buildSettings(); render(); lvRender(); chatRender(); r.maybeLearn();
  } catch (e) { lvMsg(e.message, true); }
}

// ---- executor controls ----
function lvMode(m) {
  const B = runner && runner.broker; if (!B) return;
  if (m === 'watch' || m === 'dry') { lvGateMode = null; B.setMode(m); lvLastHtml.lvGate = null; setHtml('lvGate', ''); lvModeMsg(); lvRender(); return; }
  lvGateMode = m; lvGateRender(); lvGateFocus();
}
function lvGateFocus() { setTimeout(() => { const g = $('gateTxt'), w = $('lvGate'); if (w) w.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (g) g.focus(); }, 50); }
function lvGateRender() {
  const m = lvGateMode; if (!m) { setHtml('lvGate', ''); return; } const a = runner.account;
  lvLastHtml.lvGate = null;
  $('lvGate').innerHTML = `<div class="bigwarn"><b>${m === 'auto' ? 'Automatic' : 'Confirm-each-order'} mode sends REAL orders to ${esc(a.name)} (id ${esc(a.id)}, balance ${usd(a.balance)}).</b><br>
    Topstep treats API orders as final: there is no review or reversal. The bot will only trade MES-style setups approved by all five systems, with a stop and target on every trade, but it can still lose money, and a faulty assumption in this app could cost you the Combine.
    ${m === 'auto' ? '<br><b>Automatic mode places orders without asking.</b> Only use it after Dry run and Confirm mode have behaved well for several days.' : ''}
    <div class="row" style="margin-top:8px"><span>To confirm, type the account name exactly: <b style="user-select:all">${esc(a.name)}</b></span></div><div class="row" style="margin-top:6px"><input id="gateTxt" placeholder="${esc(a.name)}" style="min-width:260px" oninput="gateCheck()" onkeydown="if(event.key==='Enter'&&!$('gateBtn').disabled)gateGo()"><button id="gateBtn" class="danger" disabled onclick="gateGo()">Enable ${m === 'auto' ? 'Automatic' : 'Confirm'} mode</button><button onclick="lvMode('watch')">Cancel</button></div></div>`;
}
function gateCheck() { const norm = x => String(x).replace(/\s+/g, '').toLowerCase(); $('gateBtn').disabled = norm($('gateTxt').value) !== norm(runner.account.name); }
function gateGo() { const B = runner.broker; B.setMode(lvGateMode); lvGateMode = null; setHtml('lvGate', ''); lvModeMsg(); lvRender(); }
function lvModeMsg() { const m = runner && runner.broker ? runner.broker.o.mode : 'watch'; lvMsg(m === 'auto' ? 'Live and in Automatic mode: approved trades are sent to Topstep with a stop and target.' : m === 'confirm' ? 'Live and in Confirm mode: each trade waits for your approval before it is sent.' : m === 'dry' ? 'Live and in Dry run: orders are prepared and logged, nothing is sent.' : 'Live and in Watch only mode. Nothing will be sent to Topstep until you change the mode.'); }
async function lvApprove() { await runner.broker.approve(); lvRender(); render(); }
function lvReject() { runner.broker.reject(); lvRender(); }
async function lvFlatten() { const B = runner.broker; B.requestFlatten('you pressed Flatten'); if (!B.flatReq) { await B.flatten('you pressed Flatten'); } else await B.manage(sim.bars[sim.bars.length - 1].c); lvRender(); render(); }

function lvRender() {
  if (view !== 'live') return; const r = runner;
  if (!r || !r.sim) { $('lvStat').textContent = r ? 'connected' : 'not connected'; return; }
  const B = r.broker, S = r.sim, a = r.account, now = r.o.now();
  $('lvStat').textContent = (r.lastError ? 'problem: ' + r.lastError : 'connected') + ' · ' + a.name + ' · ' + usd(a.balance);
  const mb = (m, label, warn) => `<button class="${B.o.mode === m ? (warn ? 'warnon' : 'on') : ''}" onclick="lvMode('${m}')">${label}</button>`;
  let h = `<div class="row modes" style="margin-bottom:8px">${mb('watch', 'Watch only')}${mb('dry', 'Dry run')}${mb('confirm', 'Confirm each order', 1)}${mb('auto', 'Automatic', 1)}<button class="danger" onclick="lvFlatten()">Flatten now</button></div>`;
  h += `<div class="note" style="margin:0 0 8px">${{ watch: 'Nothing is ever sent. The systems analyse live candles and log what they would do.', dry: 'Orders are built and logged exactly as they would be sent, but nothing is sent.', confirm: 'Every approved trade waits for your click before anything is sent.', auto: 'Approved trades are sent automatically with stop and target attached.' }[B.o.mode]}</div>`;
  for (const al of B.alertsOn.slice(0, 3)) if (now - al.t < 6 * 3600000) h += `<div class="alert">${esc(fmtT(al.t))} · ${esc(al.msg)}</div>`;
  if (B.pending) { const p = B.pending, t = p.t; h += `<div class="pendcard"><b>Waiting for your OK:</b> ${t.side} ${t.qty} ${esc(S.c.symbol)} at market, stop ${p4(t.stop)}, target ${p4(t.target)} (risk about ${usd(t.risk)}). Expires in about ${Math.max(0, Math.round((p.exp - now) / 1000))}s.<div class="row" style="margin-top:6px"><button class="primary" onclick="lvApprove()">Send order</button><button onclick="lvReject()">Reject</button></div></div>`; }
  if (B.realPos.length) for (const p of B.realPos) h += `<div class="poscard"><b>Open position on Topstep:</b> ${esc(p.size)} @ ${p4(p.averagePrice)}${B.state ? ` · ${B.state.dir} · stop ${p4(B.state.stop)} · target ${p4(B.state.target)}` : ` · <b>your own trade</b> (${esc(B.dirOfType(p.type) || '')}) · the bot leaves it alone`} · open P&L <b class="${(S.realOpen || 0) >= 0 ? 'pos' : 'neg'}">${usd(S.realOpen || 0)}</b>${runner.livePrice != null ? ` · price ${p4(runner.livePrice)} (${Math.max(0, Math.round((Date.now() - runner.livePriceAt) / 1000))}s ago)` : ''}</div>`;
  else h += `<div class="poscard">Flat (no open position on this contract).</div>`;
  if (B.errors.length && now - B.errors[0].t < 600000) h += `<div class="note neg">Latest problem: ${esc(B.errors[0].msg)}</div>`;
  if (S.kill) h += `<div class="note neg">Kill switch is ON: no new orders.</div>`;
  h += `<div class="note">Rules Manager is fed your real balance (about ${usd(S.lastBal)}). Day start ${usd(S.dayStartBal)}. Data: ${r.dataAgeSec() != null ? Math.max(0, Math.round(r.dataAgeSec() / 60)) + ' min since the newest candle closed' : 'n/a'}.</div>`;
  setHtml('lvCtl', h);
  setHtml('lvLog', B.log.length ? `<table class="nw"><thead><tr><th>Time (CT)</th><th>Event</th><th>Detail</th></tr></thead><tbody>${B.log.slice(0, 40).map(l => `<tr><td>${esc(fmtT(l.t))}</td><td><span class="tag ${l.ok === true ? 'good' : l.ok === false ? 'bad' : ''}">${esc(l.kind)}</span></td><td style="white-space:normal">${esc(l.msg)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing yet.</div>');
  labRender();
}
// ---- Strategy Lab (the Backtester) ----
let replayLab = null;
function curLab() { if (isLive()) return runner.learner; if (!replayLab || replayLab.sim !== sim) replayLab = new Lab(sim); return replayLab; }
function labRender() {
  if (!sim) return; const L = curLab(), lr = L.lastRun, c = sim.c, live = isLive(), list = Array.isArray(c.strategies) ? c.strategies : null;
  let h = `<div class="row" style="margin-bottom:8px"><button class="primary" onclick="labRun()" ${L.running ? 'disabled' : ''}>${L.running ? 'Testing… ' + Math.round(L.progress * 100) + '%' : 'Run Strategy Lab now'}</button>`;
  if (live) h += `<label class="row" style="gap:6px">When it finds a change: <select onchange="runner.o.learnMode=this.value;labRender()"><option value="suggest" ${runner.o.learnMode === 'suggest' ? 'selected' : ''}>ask me first</option><option value="auto" ${runner.o.learnMode === 'auto' ? 'selected' : ''}>apply automatically</option></select></label>`;
  h += `</div><div class="note" style="margin:0 0 8px">${sim.bars.length.toLocaleString()} candles stored. The Lab tests ${L.combos().length} settings of ${Object.keys(STRATS).length} well-known strategies (${Object.values(STRATS).map(s => s.name).join(', ')}), one trade at a time with fees and slippage. A strategy is approved only if it was clearly profitable on the older two thirds of history, hits take-profit at least ${pct(c.minTP != null ? c.minTP : 0.5)} of the time (change this under Settings), and was also profitable on the newest third it was not chosen on. It can only change which strategies the Scanner watches for, never your risk limits.</div>`;
  h += `<div class="poscard"><b>In use now:</b> ${list === null ? 'the original Fib continuation scanner (Replay default)' : list.length ? list.map(s => esc(s.label || stratLabel(s.id, s.params))).join('<br>') : '<span class="neg">none. The Scanner has nothing to look for until the Lab approves a strategy.</span>'}</div>`;
  if (lr) {
    h += `<div class="note" style="margin:0 0 6px"><b>Last run:</b> ${esc(lr.why)}</div>`;
    h += `<table class="nw"><thead><tr><th>Strategy</th><th>Best setting</th><th>Trades</th><th>Hit TP</th><th>Per contract</th><th>Newest third</th><th>Verdict</th></tr></thead><tbody>${lr.perStrategy.map(p => `<tr><td>${esc(STRATS[p.id].name)}</td><td class="mut">${esc(Object.keys(p.params).sort().map(k => k + ' ' + p.params[k]).join(', '))}</td><td>${p.n}</td><td>${p.selN ? pct(p.pTP) : '-'}</td><td class="${cls(p.exp)}">${p.selN ? usd(p.exp) : '-'}</td><td class="${cls(p.holdExp || 0)}">${p.holdExp == null ? '-' : usd(p.holdExp)} (${p.holdN})</td><td style="white-space:normal;min-width:240px" class="vd ${p.ok ? 'ok' : 'no'}">${p.ok ? 'APPROVED' : esc(p.why)}</td></tr>`).join('')}</tbody></table>`;
    if (L.proposal) h += `<div class="pendcard" style="margin-top:8px"><b>Suggested:</b> trade ${L.proposal.approved.length ? esc(L.proposal.approved.map(a => a.label).join('; ')) : 'nothing (no strategy qualifies)'}. <div class="row" style="margin-top:6px"><button class="primary" onclick="labApply()">Use ${L.proposal.approved.length ? 'these' : 'none'}</button><button onclick="curLab().proposal=null;labRender()">Ignore</button></div></div>`;
    h += `<div class="note">${esc(lr.caution)}</div>`;
  } else h += '<div class="empty">Has not run yet. It needs about 1,500 candles.</div>';
  if (L.history.length) h += `<div class="note">History: ${L.history.slice(0, 4).map(x => x.applied ? 'applied ' + (x.to.length ? x.to.length + ' strategies' : 'none') : 'ran, ' + (x.approved.length || 'no') + ' approved').join(' · ')}</div>`;
  if (live && runner.probation) h += probHtml();
  setHtml('labBody', h);
}
function labRun() {
  const L = curLab(); L.run({ onProgress: p => { if (Math.round(p * 50) % 5 === 0) labRender(); } }).then(res => {
    if (res && live_() && runner.probation) runner.probation.consider(res);
    if (res && res.change && live_() && runner.o.learnMode === 'auto' && !runner.broker.busy()) L.apply(() => { }); labRender(); if (live_()) lvRender(); render();
  }); labRender();
}
const live_ = () => isLive();
function labApply() { const L = curLab(); if (live_() && runner.broker.busy()) { userMsg = 'Not while a trade is open or pending.'; render(); return; } L.apply(() => { }); stopTimer(); userMsg = live_() ? 'Scanner strategies updated.' : 'Strategies applied: the replay restarted using them.'; buildSettings(); render(); labRender(); if (live_()) lvRender(); }

// ---- chat ----
const CHAT_SYS = [['all', 'Overseer'], ['scanner', '1 Scanner'], ['backtester', '2 Backtester'], ['executor', '3 Executor'], ['rules', '4 Rules'], ['performance', '5 Performance']];
function chatCtx() { return { sim, broker: runner && runner.sim === sim ? runner.broker : null, learner: runner && runner.sim === sim ? runner.learner : null }; }
function chatRender() {
  $('ctabs').innerHTML = CHAT_SYS.map(([id, n]) => `<button class="small ${id === chatSys ? 'on' : ''}" onclick="chatPick('${id}')">${n}</button>`).join('');
  const m = chats[chatSys] || [{ who: 'bot', text: `Hi, I'm the ${CHAT_SYS.find(x => x[0] === chatSys)[1]}. Ask me about my status, why something happened, or my numbers.` }];
  $('chatBox').innerHTML = m.map((x, k) => `<div class="msg ${x.who}"><span class="who">${x.who === 'you' ? 'You' : esc(x.label || CHAT_SYS.find(y => y[0] === chatSys)[1])}</span>${esc(x.text)}${x.action ? `<br><button class="small" onclick="chatDo(${k})">${esc(x.action.label)}</button>` : ''}</div>`).join('');
  $('chatBox').scrollTop = 1e9;
}
function chatPick(id) { chatSys = id; chatRender(); }
async function chatAsk() {
  const q = $('chatIn').value.trim(); if (!q) return; $('chatIn').value = ''; const arr = chats[chatSys] = chats[chatSys] || []; arr.push({ who: 'you', text: q });
  const key = $('aiKey').value.trim(), ctx = chatCtx(); let a = assistantReply(chatSys, q, ctx);
  if (key && !a.cmd) {
    arr.push({ who: 'bot', text: 'Thinking…', label: 'AI' }); chatRender(); const idx = arr.length - 1;
    try { arr[idx] = { who: 'bot', text: await askClaude(key, chatSys, q, ctx), label: 'AI (Claude)' }; } catch (e) { arr[idx] = { who: 'bot', text: a.text + '\n(AI unavailable: ' + e.message + ')', label: 'rule-based', action: a.action }; }
  } else arr.push({ who: 'bot', text: a.text, action: a.action });
  chatRender();
}
async function askClaude(key, sysId, q, ctx) {
  const base = (typeof window !== 'undefined' && window.ANTHROPIC_BASE) || 'https://api.anthropic.com', snap = snapshotForAI(ctx.sim, ctx.broker, ctx.learner), hist = (chats[sysId] || []).filter(m => !m.action && m.text !== 'Thinking…').slice(-6, -1);
  const sys = SYS_PERSONA[sysId] + ' Answer in plain English for a non-technical day trader, in under 120 words, using only the state snapshot provided. You cannot place orders or change settings; if the user wants an action, tell them to type commands like "flatten", "kill" or "pause". Never give guarantees about profit. If the snapshot does not say, say you do not know.\n\nSTATE SNAPSHOT:\n' + JSON.stringify(snap);
  const msgs = hist.map(m => ({ role: m.who === 'you' ? 'user' : 'assistant', content: m.text })).concat([{ role: 'user', content: q }]);
  const res = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: $('aiModel').value.trim() || 'claude-sonnet-5-5', max_tokens: 500, system: sys, messages: msgs }) });
  const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + res.status);
  return (j.content || []).map(c => c.text || '').join('').trim() || '(empty reply)';
}
async function chatDo(k) {
  const m = (chats[chatSys] || [])[k]; if (!m || !m.action) return; const fn = m.action.fn, r = runner && runner.sim === sim ? runner : null; let done = 'Done.';
  if (fn === 'kill') { sim.setKill(true); if (r) await r.broker.manage(sim.bars[sim.bars.length - 1].c); done = 'Kill switch is ON.'; }
  else if (fn === 'unkill') { sim.setKill(false); done = 'Kill switch released.'; }
  else if (fn === 'flatten') { if (r) { await lvFlatten(); done = 'Flatten requested. See the Broker log.'; } else done = 'Nothing to flatten in replay.'; }
  else if (fn === 'resume') { resumePause(); done = 'Pause released.'; }
  else if (fn === 'pause') { sim.paused = 'paused by you from the chat'; done = 'New entries paused.'; }
  else if (fn.startsWith('mode:')) { if (r) { lvMode(fn.slice(5)); done = 'Mode changed.'; } else done = 'Modes only apply in Live.'; }
  m.action = null; chats[chatSys].push({ who: 'bot', text: done }); chatRender(); render(); lvRender();
}

chatRender(); syncView(); labRender(); window.__ui3 = true;
