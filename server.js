// Trading Control Center - local app server for Windows/Mac.
// Needs only Node.js (no extra packages). Runs on THIS computer only (127.0.0.1).
//  - serves the dashboard at http://localhost:PORT
//  - passes Topstep API calls through (only to the Topstep gateway), so the browser never blocks them
//  - checks for updates, verifies them, and installs them only when you click Install
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), { exec } = require('child_process');
const DIR = __dirname, APP = path.join(DIR, 'app'), STAGE = path.join(DIR, 'update-staging');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const CFG = Object.assign({ port: 7457, upstream: 'https://api.topstepx.com', updateUrl: '', openWindow: true, checkEveryMin: 60 }, readJson(path.join(DIR, 'config.json'), {}));
if (process.env.TCC_PORT) CFG.port = +process.env.TCC_PORT;
if (process.env.TCC_UPSTREAM) CFG.upstream = process.env.TCC_UPSTREAM;
if (process.env.TCC_UPDATE_URL != null) CFG.updateUrl = process.env.TCC_UPDATE_URL;
if (process.env.TCC_NO_OPEN) CFG.openWindow = false;
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const send = (res, code, body, type) => { res.writeHead(code, { 'content-type': type || 'application/json', 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = req => new Promise((ok, bad) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > 2e6) { bad(new Error('too big')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', bad); });

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
  if (CFG.updateUrl) { checkUpdate(); setInterval(checkUpdate, Math.max(5, CFG.checkEveryMin) * 60000); }
});
module.exports = { server, checkUpdate, applyUpdate, CFG, upd };
