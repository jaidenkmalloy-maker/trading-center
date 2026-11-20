// Trading Control Center - local app server for Windows/Mac.
// Needs only Node.js (no extra packages). Runs on THIS computer only (127.0.0.1).
//  - serves the dashboard at http://localhost:PORT
//  - passes Topstep API calls through (only to the Topstep gateway), so the browser never blocks them
//  - checks for updates, verifies them, and installs them only when you click Install
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), { exec } = require('child_process');
const GEX = require('./gex.js');
const DIR = __dirname, APP = path.join(DIR, 'app'), STAGE = path.join(DIR, 'update-staging');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return d; } };
const CFG = Object.assign({ port: 7457, upstream: 'https://api.topstepx.com', updateUrl: '', openWindow: true, checkEveryMin: 60 }, readJson(path.join(DIR, 'config.json'), {}));
if (process.env.TCC_PORT) CFG.port = +process.env.TCC_PORT;
if (process.env.TCC_UPSTREAM) CFG.upstream = process.env.TCC_UPSTREAM;
if (process.env.TCC_UPDATE_URL != null) CFG.updateUrl = process.env.TCC_UPDATE_URL;
if (process.env.TCC_NO_OPEN) CFG.openWindow = false;
CFG.yahooBases = process.env.TCC_YAHOO_BASE ? [process.env.TCC_YAHOO_BASE] : ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
CFG.cboeUrl = process.env.TCC_CBOE_URL || CFG.cboeUrl || GEX.CBOE_URL;
const GDIR = path.join(DIR, 'data', 'gex');
const VERSION_FILE = path.join(DIR, 'version.json');
let current = readJson(VERSION_FILE, { version: '0.0.0', files: {} });
const upd = { state: CFG.updateUrl ? 'idle' : 'off', available: null, msg: CFG.updateUrl ? 'Not checked yet.' : 'Automatic updates are not set up (see README).', checkedAt: null };
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
const SAFE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

async function checkUpdate() {
  if (!CFG.updateUrl) return upd;
  try {
    upd.state = 'checking';
    const r = await fetch(CFG.updateUrl + (CFG.updateUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (r.status === 404) { upd.state = 'idle'; upd.msg = 'No updates published yet.'; upd.checkedAt = Date.now(); return upd; }
    if (!r.ok) throw new Error('update server answered ' + r.status);
    const v = await r.json(); upd.checkedAt = Date.now();
    if (!v.version || !v.files || typeof v.files !== 'object') throw new Error('update info is malformed');
    if (newer(v.version, current.version)) { upd.available = v; upd.state = 'available'; upd.msg = 'Version ' + v.version + ' is available' + (v.notes ? ': ' + v.notes : '.'); log('Update available:', v.version); }
    else { upd.available = null; upd.state = 'idle'; upd.msg = 'Up to date (version ' + current.version + ').'; }
  } catch (e) { upd.state = 'error'; upd.msg = 'Could not check for updates: ' + e.message; }
  return upd;
}
async function applyUpdate() {
  const v = upd.available; if (!v) throw new Error('No update to install.');
  const base = new URL('.', CFG.updateUrl).href, got = {};
  for (const [name, hash] of Object.entries(v.files)) {
    if (!SAFE.test(name) || name.includes('..')) throw new Error('Refused an unsafe file name in the update: ' + name);
    try { if (sha(fs.readFileSync(path.join(DIR, name))) === hash) continue; } catch (e) { }   // already have this piece
    const r = await fetch(base + name + '?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error('Could not download ' + name + ' (' + r.status + ')');
    const buf = Buffer.from(await r.arrayBuffer()); if (sha(buf) !== hash) throw new Error(name + ' failed its safety check (download damaged or changed). Nothing was installed.');
    got[name] = buf;
  }
  // everything downloaded and verified: back up, then install
  const bak = path.join(DIR, 'backup-' + current.version); fs.mkdirSync(bak, { recursive: true });
  for (const name of Object.keys(got)) {
    const dest = path.join(DIR, name); if (fs.existsSync(dest)) { fs.mkdirSync(path.dirname(path.join(bak, name)), { recursive: true }); fs.copyFileSync(dest, path.join(bak, name)); }
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest + '.new', got[name]); fs.renameSync(dest + '.new', dest);
  }
  current = { version: v.version, notes: v.notes || '', files: v.files }; fs.writeFileSync(VERSION_FILE, JSON.stringify(current, null, 2));
  const restart = Object.keys(got).some(n => n === 'server.js');
  if (!Object.keys(got).length) log('Nothing changed in the files themselves.');
  upd.available = null; upd.state = 'idle'; upd.msg = 'Installed version ' + v.version + '.' + (restart ? ' Close this program and start it again to finish.' : ''); log(upd.msg);
  return { version: v.version, restart };
}


// ---- free GEX levels ----
const gx = { last: null, at: 0, err: null, busy: null, via: null };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CB_HEADERS = { 'user-agent': UA, accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9', referer: 'https://www.cboe.com/', origin: 'https://www.cboe.com' };
function curlJson(url) {   // second route: the operating system's own curl (a different network fingerprint than Node)
  return new Promise((ok, bad) => {
    const { execFile } = require('child_process'), args = ['-sS', '-L', '--compressed', '-m', '45', '-w', '\n%{http_code}'];
    for (const [k, v] of Object.entries(CB_HEADERS)) args.push('-H', k + ': ' + v);
    args.push(url);
    execFile(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { maxBuffer: 200 * 1024 * 1024, windowsHide: true }, (e, out) => {
      if (e) return bad(new Error('curl: ' + e.message.split('\n')[0]));
      const k = out.lastIndexOf('\n'), code = +out.slice(k + 1), body = out.slice(0, k);
      if (code !== 200) return bad(new Error('Cboe answered ' + code + ' (curl)'));
      try { ok(JSON.parse(body)); } catch (x) { bad(new Error('curl got something that is not data')); }
    });
  });
}
function processGex(json, via) {
  const lv = GEX.computeGex(json, Date.now()), now = Date.now(), ct = GEX.ctNow(now);
  lv.fetchedAt = now; lv.day = ct.day; lv.via = via; gx.last = lv; gx.at = now; gx.err = null; gx.via = via;
  fs.mkdirSync(GDIR, { recursive: true }); fs.writeFileSync(path.join(GDIR, 'latest.json'), JSON.stringify(lv));
  const f = path.join(GDIR, ct.day + '.json'), weekday = !['Sat', 'Sun'].includes(ct.dow) || ct.mins >= 1020;
  const stale = fs.existsSync(f) && (readJson(f, {}).method || 1) < 2;   // a reading made with the older wall method is replaced
  if ((weekday && ct.mins >= 480 && ct.mins < 900 || process.env.TCC_GEX_ANYTIME) && (!fs.existsSync(f) || stale)) { fs.writeFileSync(f, JSON.stringify(lv)); log("Saved today's GEX levels (" + ct.day + ').'); }
  return lv;
}
async function getGex(force) {
  if (!force && gx.last && Date.now() - gx.at < 10 * 60000) return gx;
  if (gx.busy) return gx.busy;
  gx.busy = (async () => {
    const errs = [];
    try {
      let json = null;
      try { const r = await fetch(CFG.cboeUrl, { headers: CB_HEADERS, signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error('Cboe answered ' + r.status); json = await r.json(); processGex(json, 'app'); }
      catch (e1) { errs.push(e1.message); try { json = await curlJson(CFG.cboeUrl); processGex(json, 'curl'); } catch (e2) { errs.push(e2.message); throw new Error(errs.join('; ')); } }
    } catch (e) { gx.err = 'Could not get GEX data: ' + e.message; if (!gx.loggedErr || Date.now() - gx.loggedErr > 3600e3) { log(gx.err); gx.loggedErr = Date.now(); } }
    finally { gx.busy = null; }
    return gx;
  })();
  return gx.busy;
}
function gexHistory() { const out = {}; try { for (const f of fs.readdirSync(GDIR)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) out[f.slice(0, 10)] = readJson(path.join(GDIR, f), null); } catch (e) { } return out; }

// ---- saved data on disk (a copy of everything the dashboard saves, so clearing the browser loses nothing) ----
const KDIR = path.join(DIR, 'data', 'saved');
const kfile = k => path.join(KDIR, Buffer.from(String(k)).toString('hex') + '.txt');
function kvAll() { const out = {}; try { for (const f of fs.readdirSync(KDIR)) if (/^[0-9a-f]+\.txt$/.test(f)) { try { out[Buffer.from(f.slice(0, -4), 'hex').toString()] = fs.readFileSync(path.join(KDIR, f), 'utf8'); } catch (e) { } } } catch (e) { } return out; }
function kvSet(k, v) { fs.mkdirSync(KDIR, { recursive: true }); const f = kfile(k); fs.writeFileSync(f + '.tmp', v); fs.renameSync(f + '.tmp', f); }
function kvDel(k) { try { fs.unlinkSync(kfile(k)); } catch (e) { } }
const localOrigin = req => !req.headers.origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const send = (res, code, body, type) => { res.writeHead(code, { 'content-type': type || 'application/json', 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req, max) => new Promise((ok, bad) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > (max || 2e6)) { bad(new Error('too big')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', bad); });

const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').split(':')[0];
    if (host !== 'localhost' && host !== '127.0.0.1') return send(res, 403, { error: 'local use only' });
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/tsx/')) {   // Topstep pass-through: only POST, only to the configured gateway
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      if (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin)) return send(res, 403, { error: 'wrong origin' });
      const body = await readBody(req), h = { 'content-type': 'application/json', accept: 'application/json' };
      if (req.headers.authorization) h.authorization = req.headers.authorization;
      let r; try { r = await fetch(CFG.upstream + u.pathname.slice(4) + u.search, { method: 'POST', headers: h, body, signal: AbortSignal.timeout(20000) }); }
      catch (e) { return send(res, 502, { success: false, errorMessage: 'This computer could not reach Topstep: ' + e.message }); }
      const out = Buffer.from(await r.arrayBuffer()); return send(res, r.status, out, r.headers.get('content-type') || 'application/json');
    }
    if (u.pathname === '/app/gex') { const g = await getGex(u.searchParams.get('force') === '1'); const ct = GEX.ctNow(Date.now()); return send(res, 200, { ok: !!g.last, levels: g.last, error: g.err, cboeUrl: CFG.cboeUrl, fresh: !!g.last && !g.err && Date.now() - g.at < 20 * 60000, today: ct.day, todaySaved: fs.existsSync(path.join(GDIR, ct.day + '.json')) ? readJson(path.join(GDIR, ct.day + '.json'), null) : null }); }
    if (u.pathname === '/app/gex/ingest' && req.method === 'POST') {   // third route: the dashboard window (a real browser) fetched the data and hands it over
      if (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin)) return send(res, 403, { error: 'wrong origin' });
      try { const lv = processGex(JSON.parse((await readBody(req, 300e6)).toString('utf8')), 'browser'); return send(res, 200, { ok: true, levels: lv }); } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    if (u.pathname === '/app/gex/history') return send(res, 200, { days: gexHistory() });
    if (u.pathname === '/app/yahoo') {   // long price history for research: only Yahoo's chart data, only safe parameters
      const sym = u.searchParams.get('s') || '', iv = u.searchParams.get('i') || '', rg = u.searchParams.get('r') || '';
      if (!/^[\^A-Z0-9=.\-]{1,12}$/.test(sym) || !['5m', '15m', '1h', '1d', '1wk'].includes(iv) || !/^(\d{1,4}d|\d{1,2}y|max)$/.test(rg)) return send(res, 400, { error: 'bad request' });
      let last = 'no answer';
      for (const base of CFG.yahooBases) {
        try {
          const r = await fetch(base + '/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=' + iv + '&range=' + rg + '&includePrePost=true&events=div%2Csplit', { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
          if (r.ok) return send(res, 200, Buffer.from(await r.arrayBuffer()), 'application/json');
          last = 'Yahoo answered ' + r.status;
        } catch (e) { last = e.message; }
      }
      return send(res, 502, { error: last });
    }
    if (u.pathname === '/app/kv-all' && req.method === 'GET') return send(res, 200, kvAll());
    if (u.pathname === '/app/kv' && (req.method === 'POST' || req.method === 'DELETE')) {
      if (!localOrigin(req)) return send(res, 403, { error: 'wrong origin' }); const k = u.searchParams.get('key') || '';
      if (!k || k.length > 200) return send(res, 400, { error: 'bad key' });
      if (req.method === 'DELETE') { kvDel(k); return send(res, 200, { ok: true }); }
      kvSet(k, (await readBody(req, 60e6)).toString('utf8')); return send(res, 200, { ok: true });
    }
    if (u.pathname === '/app/status') return send(res, 200, { version: current.version, update: { state: upd.state, msg: upd.msg, version: upd.available && upd.available.version, notes: upd.available && upd.available.notes } });
    if (u.pathname === '/app/check' && req.method === 'POST') { await checkUpdate(); return send(res, 200, { state: upd.state, msg: upd.msg }); }
    if (u.pathname === '/app/install' && req.method === 'POST') { try { return send(res, 200, Object.assign({ ok: true }, await applyUpdate())); } catch (e) { upd.msg = e.message; return send(res, 200, { ok: false, msg: e.message }); } }
    // static files from ./app
    let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
    const f = path.normalize(path.join(APP, p)); if (!f.startsWith(APP + path.sep)) return send(res, 403, { error: 'no' });
    fs.readFile(f, (e, buf) => e ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(f)] || 'application/octet-stream'));
  } catch (e) { send(res, 500, { error: e.message }); }
});

function findBrowser() {
  const env = process.env, c = process.platform === 'win32' ? [
    path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : [];
  return c.find(p => { try { return p && fs.existsSync(p); } catch (e) { return false; } }) || null;
}
function openWindow(url) {
  if (!CFG.openWindow) return;
  const b = findBrowser();
  if (b) { const { spawn } = require('child_process'); try { spawn(b, ['--app=' + url], { detached: true, stdio: 'ignore' }).unref(); return; } catch (e) { } }
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => { });
  log('Opened in your normal browser. For an app-style window, install Google Chrome or Microsoft Edge.');
}
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log('The app is already running. Opening its window.'); openWindow(`http://localhost:${CFG.port}/`); setTimeout(() => process.exit(0), 1500); }
  else { log('Could not start:', e.message); }
});
server.listen(CFG.port, '127.0.0.1', () => {
  const url = `http://localhost:${CFG.port}/`;
  log(`Trading Control Center ${current.version} is running at ${url}`);
  log('Keep this window open while you trade. Closing it stops the app.');
  openWindow(url);
  getGex(); setInterval(() => getGex(true), 15 * 60000);
  if (CFG.updateUrl) { checkUpdate(); setInterval(checkUpdate, Math.max(5, CFG.checkEveryMin) * 60000); }
});
module.exports = { server, checkUpdate, applyUpdate, CFG, upd };
