// ===== Runs first: keeps a copy of everything the dashboard saves in the app's folder, and puts it back if the browser lost it =====
(function () {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol) || !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  const mine = k => /^(ccL_|tradingControlCenter)/.test(k);
  let disk = {};
  try { const x = new XMLHttpRequest(); x.open('GET', '/app/kv-all', false); x.send(); if (x.status === 200) disk = JSON.parse(x.responseText); } catch (e) { }
  const pending = {}; let timer = null;
  const flush = beacon => {
    for (const k of Object.keys(pending)) {
      const v = pending[k]; delete pending[k]; const url = '/app/kv?key=' + encodeURIComponent(k);
      try { if (v === null) fetch(url, { method: 'DELETE', keepalive: !!beacon }); else if (beacon && navigator.sendBeacon && v.length < 60000) navigator.sendBeacon(url, new Blob([v], { type: 'text/plain' })); else fetch(url, { method: 'POST', body: v, keepalive: !!beacon && v.length < 60000 }); } catch (e) { }
    }
  };
  const queue = (k, v) => { pending[k] = v; if (!timer) timer = setTimeout(() => { timer = null; flush(false); }, 2000); };
  try {
    for (const k of Object.keys(disk)) if (mine(k) && localStorage.getItem(k) === null) localStorage.setItem(k, disk[k]);   // the browser lost it: put it back
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (mine(k) && disk[k] !== localStorage.getItem(k)) queue(k, localStorage.getItem(k)); }   // newer in the browser: copy to disk
  } catch (e) { }
  const set = Storage.prototype.setItem, del = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) { set.call(this, k, v); if (this === window.localStorage && mine(k)) queue(k, String(v)); };
  Storage.prototype.removeItem = function (k) { del.call(this, k); if (this === window.localStorage && mine(k)) queue(k, null); };
  window.addEventListener('pagehide', () => { try { if (typeof runner !== 'undefined' && runner && runner.saveHist) runner.saveHist(); } catch (e) { } flush(true); });
  window.__diskCopy = { restored: Object.keys(disk).length };
})();
