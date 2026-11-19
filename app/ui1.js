// ===== UI PART 1: state, helpers, chart, system cards =====
const SKEY = 'tradingControlCenterV1';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tfmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const tt = ms => ms ? tfmt.format(new Date(ms)) : '';
const cls = n => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
const p4 = n => Number(n).toFixed(sim ? sim.c.dec : 4);
function priceWarn(bars, sym) {
  const cl = bars.map(b => b.c).sort((a, b) => a - b), med = cl[Math.floor(cl.length / 2)], I = INSTR[sym] || INSTR.MHG;
  return (med > I.p0 * 3 || med < I.p0 / 3) ? ` These prices (around ${med.toFixed(2)}) don't look like ${sym}, which usually trades nearer ${I.p0}. Check the instrument under Settings.` : '';
}

let view = 'replay', runner = null;
const isLive = () => view === 'live' && runner && runner.sim && runner.sim === sim;
function curPos() {
  if (isLive()) { const st = runner.broker.state; return st ? { side: st.dir === 'long' ? 'Buy' : 'Sell', qty: st.qty, entry: st.entry, stop: st.stop, target: st.target, openI: st.openI, s: st.dir === 'long' ? 1 : -1 } : null; }
  return sim.ex.pos;
}
let sim = null, timer = null, speed = 20, acc = 0, srcLabel = 'Synthetic random candles', synthetic = true, seedNo = 21, userMsg = '';
function loadOverrides() { try { return JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch (e) { return {}; } }
function saveOverrides(o) { try { localStorage.setItem(SKEY, JSON.stringify(o)); } catch (e) {} }
function makeSim(bars) { sim = new Sim(bars, loadOverrides()); acc = 0; }

// ---- chart ----
function chartSvg() {
  const W = 940, H = 350, pl = 8, pr = 64, pt = 10, pb = 22, N = 110;
  const last = Math.max(0, sim.i - 1), from = Math.max(0, last - N + 1), vis = sim.bars.slice(from, last + 1);
  if (!vis.length) return '<div class="empty">Press Play or Step to start the replay.</div>';
  const E = sim.ex, P = curPos(), g = sim.scan.leg, c = sim.c;
  const live = g && !g.dead && !g.used && g.R >= c.minLeg;
  let lo = Math.min(...vis.map(b => b.l)), hi = Math.max(...vis.map(b => b.h));
  const extra = [];
  if (live) extra.push(g.H, g.L);
  if (P) extra.push(P.entry, P.stop, P.target);
  for (const v of extra) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const padv = (hi - lo) * 0.05 || 0.01; lo -= padv; hi += padv;
  const slot = (W - pl - pr) / N, x = k => pl + (k - from + 0.5) * slot, y = v => pt + (hi - v) / (hi - lo) * (H - pt - pb);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Candlestick chart with fib zones and trades">`;
  for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; s += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#222a34"/><text x="${W - pr + 5}" y="${y(v) + 4}">${v.toFixed(Math.max(2, Math.min(3, sim.c.dec)))}</text>`; }
  for (let k = from; k <= last; k++) {
    const b = sim.bars[k], up = b.c >= b.o, col = up ? '#2ea66a' : '#e5534b', cx = x(k), w = Math.max(1.5, slot * 0.6);
    s += `<line x1="${cx}" x2="${cx}" y1="${y(b.h)}" y2="${y(b.l)}" stroke="${col}"/><rect x="${cx - w / 2}" y="${Math.min(y(b.o), y(b.c))}" width="${w}" height="${Math.max(1, Math.abs(y(b.o) - y(b.c)))}" fill="${col}"/>`;
    if (k % 22 === 0) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${tt(b.t).replace(',', '')}</text>`;
  }
  if (live) {
    const pr_ = r => g.dir === 'short' ? g.L + r * g.R : g.H - r * g.R, x0 = Math.max(pl, x(Math.max(from, g.p1)));
    const za = y(pr_(c.zoneLo)), zb = y(pr_(c.zoneHi));
    s += `<rect x="${x0}" y="${Math.min(za, zb)}" width="${W - pr - x0}" height="${Math.abs(za - zb)}" fill="#d29922" opacity=".16"/>`;
    s += `<line x1="${x0}" x2="${W - pr}" y1="${y(g.H)}" y2="${y(g.H)}" stroke="#8b98a5" stroke-dasharray="4 4"/><line x1="${x0}" x2="${W - pr}" y1="${y(g.L)}" y2="${y(g.L)}" stroke="#8b98a5" stroke-dasharray="4 4"/>`;
    s += `<line x1="${x0}" x2="${W - pr}" y1="${y(pr_(c.stopLvl))}" y2="${y(pr_(c.stopLvl))}" stroke="#e5534b" stroke-dasharray="2 3"/>`;
    s += `<text x="${W - pr + 5}" y="${y(g.H) + 4}" style="fill:#c8d1da">leg ${g.dir === 'short' ? 'high' : 'high'}</text><text x="${W - pr + 5}" y="${y(g.L) + 4}" style="fill:#c8d1da">leg low</text>`;
  }
  if (P) {
    const p = P, x0 = Math.max(pl, x(Math.max(from, p.openI)));
    [[p.entry, '#4c8dff', 'entry'], [p.stop, '#e5534b', 'stop'], [p.target, '#2ea66a', 'target']].forEach(([v, col, lb]) => {
      s += `<line x1="${x0}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="${col}" stroke-width="1.5"/><text x="${W - pr + 5}" y="${y(v) + 4}" style="fill:${col}">${lb}</text>`;
    });
  }
  for (const r of sim.sigs) if (r.sig.i >= from && r.sig.i <= last) {
    const cx = x(r.sig.i), cy = y(r.sig.planned), col = r.decision === 'approved' ? '#d29922' : '#6b7684';
    s += `<path d="M${cx} ${cy - 6}L${cx + 5} ${cy}L${cx} ${cy + 6}L${cx - 5} ${cy}Z" fill="${col}"><title>${r.sig.dir} setup, ${esc(r.decision)}${r.why ? ': ' + esc(r.why) : ''}</title></path>`;
  }
  const tr = E.trades.slice(-40);
  for (const t of tr) {
    if (t.openI >= from && t.openI <= last) { const cx = x(t.openI), cy = y(t.entry), up = t.side === 'Buy'; s += `<path d="${up ? `M${cx} ${cy - 7}L${cx + 5} ${cy + 2}L${cx - 5} ${cy + 2}Z` : `M${cx} ${cy + 7}L${cx + 5} ${cy - 2}L${cx - 5} ${cy - 2}Z`}" fill="#4c8dff"/>`; }
    if (t.closeI >= from && t.closeI <= last) s += `<circle cx="${x(t.closeI)}" cy="${y(t.exit)}" r="4.5" fill="${t.pnl >= 0 ? '#2ea66a' : '#e5534b'}" stroke="#0e1116"><title>${esc(t.reason)} ${t.pnl.toFixed(2)}</title></circle>`;
  }
  if (P && P.openI >= from) { const p = P, cx = x(p.openI), cy = y(p.entry), up = p.side === 'Buy'; s += `<path d="${up ? `M${cx} ${cy - 7}L${cx + 5} ${cy + 2}L${cx - 5} ${cy + 2}Z` : `M${cx} ${cy + 7}L${cx + 5} ${cy - 2}L${cx - 5} ${cy - 2}Z`}" fill="#4c8dff"/>`; }
  return s + '</svg>';
}

// ---- system cards ----
const MASCOT = {
  scanner:     { nm: 'Scout',  c: '#2dd4bf', c2: '#0f766e', say: { ok: 'Eyes open. Scanning every candle!', warn: 'Hmm, something looks off...', halt: 'I need a hand here!', idle: 'Waiting for candles...' } },
  backtester:  { nm: 'Pip',    c: '#a78bfa', c2: '#6d28d9', say: { ok: 'Experiments are bubbling!', warn: 'The results need a look.', halt: 'The test tube cracked!', idle: 'Warming up the lab...' } },
  rules:       { nm: 'Sheriff', c: '#60a5fa', c2: '#1d4ed8', say: { ok: 'Everyone is within the rules.', warn: 'Getting close to a limit!', halt: 'STOP! A rule was broken.', idle: 'Reading the rulebook...' } },
  executor:    { nm: 'Dash',   c: '#fb923c', c2: '#c2410c', say: { ok: 'Ready to fire on your word!', warn: 'Holding back for now.', halt: 'Hands off the buttons!', idle: 'Waiting for orders...' } },
  performance: { nm: 'Coach',  c: '#f472b6', c2: '#be185d', say: { ok: 'The whole team is on track!', warn: 'Someone is slacking...', halt: 'Time out! Team trouble.', idle: 'Watching the team...' } }
};
function mascotSvg(id, st) {
  const m = MASCOT[id] || MASCOT.scanner, k = st === 'ok' || st === 'warn' || st === 'halt' ? st : 'idle', ink = '#1b1740';
  const eye = (x, y) => k === 'halt' ? `<path d="M${x - 4} ${y - 4}l8 8m0-8l-8 8" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>` : k === 'idle' ? `<path d="M${x - 4} ${y}h8" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>` : `<circle cx="${x}" cy="${y}" r="4.6" fill="#fff"/><circle class="pupil" cx="${x}" cy="${y}" r="2.3" fill="${ink}"/>`;
  const mouth = k === 'ok' ? `<path d="M32 51q8 8 16 0" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>` : k === 'warn' ? `<path d="M34 53h12" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>` : k === 'halt' ? `<path d="M32 56q8-8 16 0" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>` : `<circle cx="40" cy="53" r="2.4" fill="${ink}"/>`;
  const extra = { scanner: `<line x1="40" y1="14" x2="40" y2="6" stroke="${m.c2}" stroke-width="3"/><path class="radar" d="M32 6a8 8 0 0 1 16 0z" fill="${m.c}" stroke="${m.c2}" stroke-width="2"/>`,
    backtester: `<circle cx="29" cy="40" r="8" fill="none" stroke="${m.c2}" stroke-width="3"/><circle cx="51" cy="40" r="8" fill="none" stroke="${m.c2}" stroke-width="3"/><path d="M62 70l4-14h8l4 14z" fill="#c4b5fd" stroke="${m.c2}" stroke-width="2"/><circle class="bub" cx="68" cy="52" r="2.5" fill="#e9d5ff"/><circle class="bub b2" cx="73" cy="50" r="1.8" fill="#e9d5ff"/>`,
    rules: `<path d="M24 22q16-12 32 0l-4 6h-24z" fill="${m.c2}"/><path d="M40 14l2.4 4.8 5.2.8-3.8 3.6.9 5.2-4.7-2.5-4.7 2.5.9-5.2-3.8-3.6 5.2-.8z" fill="#fde047"/>`,
    executor: `<path d="M22 28q18-14 36 0v5H22z" fill="${m.c2}"/><path class="bolt" d="M42 14l-7 11h6l-3 9 9-12h-6z" fill="#fde047"/><path d="M6 42h10M4 50h12M8 58h8" stroke="${m.c}" stroke-width="2.5" stroke-linecap="round" opacity=".7" class="speed"/>`,
    performance: `<path d="M34 12h12v7H34z" fill="${m.c2}"/><path d="M40 20v4" stroke="${m.c2}" stroke-width="3"/><circle cx="40" cy="12" r="5" fill="#fde047" stroke="${m.c2}" stroke-width="2"/><path d="M60 62l5 8 5-8" fill="#fde047"/><circle cx="65" cy="62" r="6" fill="#fde047" stroke="${m.c2}" stroke-width="2"/>` }[id] || '';
  const ey = id === 'scanner' ? `<circle cx="40" cy="38" r="9" fill="#fff"/><circle class="pupil" cx="40" cy="38" r="4.5" fill="${ink}"/>` : eye(31, 40) + eye(49, 40);
  const sweat = k === 'warn' ? `<path class="sweat" d="M60 30q4 6 0 9q-4-3 0-9z" fill="#7dd3fc"/>` : '', zz = k === 'idle' ? `<text class="zz" x="58" y="24" style="fill:${m.c};font-weight:700;font-size:13px">z</text>` : '';
  return `<svg class="mas ${k}" viewBox="0 0 80 80" aria-hidden="true"><ellipse cx="40" cy="76" rx="20" ry="3.5" fill="#000" opacity=".25"/><g class="body"><rect x="14" y="62" width="14" height="10" rx="5" fill="${m.c2}"/><rect x="52" y="62" width="14" height="10" rx="5" fill="${m.c2}"/><rect x="16" y="24" width="48" height="44" rx="${id === 'scanner' ? 22 : 15}" fill="${m.c}" stroke="${m.c2}" stroke-width="3"/><ellipse cx="29" cy="31" rx="9" ry="3.5" fill="#fff" opacity=".3"/>${extra}${ey}<circle cx="23" cy="50" r="3.4" fill="#fb7185" opacity=".45"/><circle cx="57" cy="50" r="3.4" fill="#fb7185" opacity=".45"/>${mouth}${sweat}${zz}</g></svg>`;
}
const TF_NAMES = [['m15', '15m'], ['h1', '1h'], ['h4', '4h'], ['d1', 'Daily']];
function mtfStrip() {
  let v; try { v = mtfView(sim.bars, isLive() ? sim.bars.length : sim.i); } catch (e) { return ''; }
  return `<div class="mtf" title="Higher charts are built from your 15-minute candles. Only finished candles are used.">${TF_NAMES.map(([k, n]) => `<span class="tf ${v[k] > 0 ? 'up' : v[k] < 0 ? 'dn' : 'fl'}">${n} ${v[k] > 0 ? '&#9650;' : v[k] < 0 ? '&#9660;' : '&#9644;'}</span>`).join('')}</div>`;
}
function systemsHtml(h) {
  return h.sys.map(s => {
    const mets = s.m.map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
    const exps = s.e.map(e => {
      const ic = e.ok === true ? '<span class="ic t">&#10003;</span>' : e.ok === false ? '<span class="ic f">&#10007;</span>' : '<span class="ic n">&middot;</span>';
      return `<li>${ic}<span>${esc(e.l)}</span><span class="d">${esc(e.d)}</span></li>`;
    }).join('');
    const pillCls = s.status === 'idle' ? '' : s.status, M = MASCOT[s.id] || MASCOT.scanner, say = M.say[s.status] || M.say.idle;
    return `<div class="sys ${s.status}" style="--mc:${M.c}"><div class="mhead">${mascotSvg(s.id, s.status)}<div class="mtxt"><h3>${esc(s.name)}<span class="pill ${pillCls}">${STATUS_TXT[s.status]}</span></h3><div class="bubble"><b>${M.nm}:</b> ${esc(say)}</div></div></div><div class="role">${esc(s.role)} <a class="talk" onclick="talkTo('${s.id}')">Talk to ${M.nm}</a></div>${s.id === 'scanner' ? mtfStrip() : ''}<div class="met">${mets}</div><ul class="exp">${exps}</ul></div>`;
  }).join('');
}
function talkTo(id) { try { chatPick(id); const el = document.getElementById('chatBox'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); const i = document.getElementById('chatIn'); if (i) i.focus(); } catch (e) {} }

// ---- smooth dashboard: arc gauges, KPI strip, systems updated in place ----
function arcSvg(pct, color) {
  pct = Math.max(0, Math.min(1, pct || 0)); const L = Math.PI * 38;
  return `<svg class="arc" viewBox="0 0 92 62" aria-hidden="true"><path class="tr" d="M8 52 A38 38 0 0 1 84 52" fill="none" stroke-width="7" stroke-linecap="round"/><path class="fg" d="M8 52 A38 38 0 0 1 84 52" fill="none" stroke="${color}" style="color:${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${L.toFixed(1)}" stroke-dashoffset="${(L * (1 - pct)).toFixed(1)}"/><text x="46" y="50" text-anchor="middle">${Math.round(pct * 100)}%</text></svg>`;
}
const kcol = v => v > 0.5 ? '#3ee6b0' : v > 0.25 ? '#f2b84b' : '#f27272';
function kpiHtml(h) {
  const c = sim.c, s = h.snap, room = Math.max(0, (c.dailyStop + s.today) / c.dailyStop), okN = h.sys.filter(x => x.status === 'ok').length;
  const card = (label, val, sub, arc) => `<div class="kpi">${arc || ''}<div><div class="kl">${label}</div><div class="kv">${val}</div><div class="ks">${sub}</div></div></div>`;
  return card('Account P&amp;L', `<span class="${s.closed >= 0 ? 'pos' : 'neg'}">${usd(s.closed)}</span>`, 'today ' + usd(s.today), '')
    + card('Loss buffer', usd(s.buffer), 'above the floor', arcSvg(s.bufPct / 100, kcol(s.bufPct / 100)))
    + card('Daily room', usd(c.dailyStop + s.today), 'to the daily stop', arcSvg(room, kcol(room)))
    + card('Target', usd(Math.max(0, s.closed)), 'of ' + usd(c.profitTarget), arcSvg(s.progress, '#2bb7d6'))
    + card('Systems', `${okN}<span class="mut" style="font-size:16px"> / ${h.sys.length}</span>`, 'healthy now', arcSvg(okN / h.sys.length, kcol(okN / h.sys.length)));
}
function renderSystems(list) {
  const box = document.getElementById('systems'); if (!box) return;
  list.forEach((s, idx) => {
    let el = document.getElementById('sys-' + s.id); const M = MASCOT[s.id] || MASCOT.scanner;
    if (!el) { el = document.createElement('div'); el.id = 'sys-' + s.id; el.style.setProperty('--mc', M.c); el.innerHTML = '<div class="mhead"><div class="mwrap"></div><div class="mtxt"></div></div><div class="sbody"></div>'; }
    if (box.children[idx] !== el) box.insertBefore(el, box.children[idx] || null);
    el.className = 'sys ' + s.status;
    const mw = el.querySelector('.mwrap'); if (mw.dataset.st !== s.status) { mw.dataset.st = s.status; mw.innerHTML = mascotSvg(s.id, s.status); }
    const say = M.say[s.status] || M.say.idle, pillCls = s.status === 'idle' ? '' : s.status;
    const top = `<h3>${esc(s.name)}<span class="pill ${pillCls}">${STATUS_TXT[s.status]}</span></h3><div class="bubble"><b>${M.nm}:</b> ${esc(say)}</div>`;
    const mets = s.m.map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
    const exps = s.e.map(e => `<li>${e.ok === true ? '<span class="ic t">&#10003;</span>' : e.ok === false ? '<span class="ic f">&#10007;</span>' : '<span class="ic n">&middot;</span>'}<span>${esc(e.l)}</span><span class="d">${esc(e.d)}</span></li>`).join('');
    const body = `<div class="role">${esc(s.role)} <a class="talk" onclick="talkTo('${s.id}')">Talk to ${M.nm}</a></div>${s.id === 'scanner' ? mtfStrip() : ''}<div class="met">${mets}</div><ul class="exp">${exps}</ul>`;
    const t = el.querySelector('.mtxt'), b = el.querySelector('.sbody'); if (t.__h !== top) { t.innerHTML = top; t.__h = top; } if (b.__h !== body) { b.innerHTML = body; b.__h = body; }
  });
  while (box.children.length > list.length) box.removeChild(box.lastChild);
}
function setKpis(h) { const el = document.getElementById('kpis'); if (!el) return; const html = kpiHtml(h); if (el.__h === html) return; el.__h = html;
  if (!el.children.length) { el.innerHTML = html; return; }
  const tmp = document.createElement('div'); tmp.innerHTML = html;   // update numbers and arcs in place so the arcs glide instead of jumping
  [...tmp.children].forEach((k, i) => { const cur = el.children[i]; if (!cur) { el.appendChild(k); return; }
    const a = cur.querySelector('.arc .fg'), na = k.querySelector('.arc .fg'); if (a && na) { a.setAttribute('stroke-dashoffset', na.getAttribute('stroke-dashoffset')); a.setAttribute('stroke', na.getAttribute('stroke')); a.style.color = na.style.color; cur.querySelector('.arc text').textContent = k.querySelector('.arc text').textContent; }
    cur.lastElementChild.innerHTML = k.lastElementChild.innerHTML; });
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  document.documentElement.style.scrollBehavior = 'smooth';
  const spy = () => { let cur = null; document.querySelectorAll('.side a[data-sec]').forEach(a => { const t = document.getElementById(a.dataset.sec); if (t && t.offsetParent !== null && t.getBoundingClientRect().top < 140) cur = a; }); document.querySelectorAll('.side a').forEach(a => a.classList.toggle('on', a === cur)); };
  window.addEventListener('scroll', spy, { passive: true }); setTimeout(spy, 300);
  document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('.side a[data-sec="liveWrap"]'); if (a && typeof setView === 'function' && typeof view !== 'undefined' && view !== 'live') setView('live'); });
}
