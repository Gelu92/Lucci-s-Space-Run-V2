// ============================================================
//  Lucci’s Space Race — funzionamento offline (Gelu Inc.)
// ------------------------------------------------------------
//  Tutte le app su gelu92.github.io condividono la stessa
//  memoria del browser. Questa versione:
//   1. cancella SOLO le copie vecchie di questa app
//      (non tocca più le altre app);
//   2. tiene una seconda copia dei file in un archivio tutto suo
//      (IndexedDB), così l'app si apre in modalità aereo anche se
//      qualcun altro svuota la memoria comune;
//   3. trova da sola i file dell'app (script, stile, icone):
//      se in futuro aggiungi un file non devi elencarlo qui.
//  I dati dell'app (turni, inventario, punteggi...) non stanno
//  qui e non vengono mai toccati.
//
//  QUANDO AGGIORNI L'APP: aumenta il numero in VERSIONE.
// ============================================================
const VERSIONE = 1;
const APP = 'space-race';
const PREFISSO = 'gelu-' + APP + '-';
const CACHE = PREFISSO + 'v' + VERSIONE;
const ARCHIVIO = 'gelu-copia-offline-' + APP;
const FILE_BASE = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
const SITI_ESTERNI = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com'];
const ATTESA_RETE_MS = 4000;          // con rete lenta, dopo 4 secondi usa la copia salvata
const RINFRESCO_MS = 6 * 3600 * 1000; // ricontrolla tutti i file al massimo ogni 6 ore

const SCOPE = self.registration.scope;

/* ---------- archivio IndexedDB ---------- */
function apri() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(ARCHIVIO, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('file');
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); ok(d); };
    r.onerror = () => ko(r.error);
    r.onblocked = () => ko(new Error('bloccato'));
  });
}
async function metti(chiave, valore) {
  const d = await apri();
  return new Promise((ok, ko) => {
    const t = d.transaction('file', 'readwrite');
    t.objectStore('file').put(valore, chiave);
    t.oncomplete = () => { d.close(); ok(); };
    t.onerror = () => { d.close(); ko(t.error); };
  });
}
async function prendi(chiave) {
  const d = await apri();
  return new Promise((ok, ko) => {
    const r = d.transaction('file').objectStore('file').get(chiave);
    r.onsuccess = () => { d.close(); ok(r.result); };
    r.onerror = () => { d.close(); ko(r.error); };
  });
}

/* stesso file = stessa chiave, con o senza ?v=… e con o senza index.html */
function chiave(url) {
  const u = new URL(url, SCOPE);
  if (u.origin !== location.origin) return u.href;
  let p = u.pathname;
  if (p.endsWith('/')) p += 'index.html';
  return u.origin + p;
}
const nostro = u => u.origin === location.origin && u.href.startsWith(SCOPE);
const esterno = u => SITI_ESTERNI.includes(u.hostname);

async function salva(req, res) {
  if (!res || res.status === 206) return;
  if (res.type !== 'opaque' && !res.ok) return;
  try { const c = await caches.open(CACHE); await c.put(req, res.clone()); } catch (e) {}
  if (res.type === 'opaque') return; // file esterni senza permessi: restano solo nella cache
  try {
    const body = await res.clone().blob();
    await metti(chiave(req.url), { body, tipo: res.headers.get('content-type') || '' });
  } catch (e) {}
}

async function copiaSalvata(req) {
  try { const r = await caches.match(req, { ignoreSearch: true }); if (r) return r; } catch (e) {}
  try { const r = await caches.match(req); if (r) return r; } catch (e) {}
  try {
    const x = await prendi(chiave(req.url));
    if (x) return new Response(x.body, { headers: { 'Content-Type': x.tipo } });
  } catch (e) {}
  return null;
}

/* ---------- trova e salva tutti i file dell'app ---------- */
function riferimenti(testo, base) {
  const out = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"'#]+)["']|url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"'\s]+\.(?:js|mjs|css|png|jpg|jpeg|webp|svg|gif|ico|json|webmanifest|mp3|ogg|wav|woff2?))["']/gi;
  let m;
  while ((m = re.exec(testo))) {
    const s = m[1] || m[2] || m[3];
    if (!s || /^(data:|blob:|mailto:|tel:|javascript:)/i.test(s)) continue;
    try { out.add(new URL(s, base).href); } catch (e) {}
  }
  return [...out];
}
async function prendiESalva(url, visti, coda) {
  if (visti.has(url)) return;
  visti.add(url);
  const u = new URL(url);
  if (!nostro(u) && !esterno(u)) return;
  let res;
  try {
    const req = new Request(url, nostro(u) ? { cache: 'reload' } : { mode: 'cors', credentials: 'omit' });
    res = await fetch(req);
    if (!res.ok) return;
    await salva(req, res.clone());
  } catch (e) {
    try { const req = new Request(url, { mode: 'no-cors' }); await salva(req, await fetch(req)); } catch (x) {}
    return;
  }
  const tipo = res.headers.get('content-type') || '';
  if (/html|css|manifest|json/.test(tipo) || /\.(css|webmanifest|json)$/.test(u.pathname)) {
    try { riferimenti(await res.text(), url).forEach(r => coda.push(r)); } catch (e) {}
  }
}
async function salvaTutto() {
  const visti = new Set(), coda = FILE_BASE.map(f => new URL(f, SCOPE).href);
  coda.unshift(SCOPE);
  while (coda.length) {
    const giro = coda.splice(0, 6);
    await Promise.all(giro.map(u => prendiESalva(u, visti, coda)));
    if (visti.size > 400) break;
  }
  try { await metti('__ultimo_rinfresco', Date.now()); } catch (e) {}
}
async function rinfrescaSeServe() {
  try {
    const t = await prendi('__ultimo_rinfresco');
    if (t && Date.now() - t < RINFRESCO_MS) return;
  } catch (e) {}
  await salvaTutto();
}

/* ---------- ciclo di vita ---------- */
self.addEventListener('install', e => {
  e.waitUntil(salvaTutto().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const nomi = await caches.keys();
    for (const n of nomi) {
      if (n === CACHE) continue;
      if (n.startsWith(PREFISSO)) { await caches.delete(n); continue; } // mie versioni vecchie
      // cache con altri nomi: tolgo solo i file di QUESTA app (vecchio sistema), il resto non lo tocco
      try {
        const c = await caches.open(n);
        for (const r of await c.keys()) if (r.url.startsWith(SCOPE)) await c.delete(r);
      } catch (x) {}
    }
    await self.clients.claim();
  })());
});

/* ---------- richieste ---------- */
function conLimite(p, ms) {
  return new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error('lenta')), ms);
    p.then(r => { clearTimeout(t); ok(r); }, x => { clearTimeout(t); ko(x); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const u = new URL(req.url);
  const mio = nostro(u), ext = esterno(u);
  if (!mio && !ext) return;

  // file esterni (caratteri, librerie): prima la copia salvata, poi la rete
  if (ext) {
    e.respondWith((async () => {
      const c = await copiaSalvata(req);
      if (c) return c;
      try { const r = await fetch(req); e.waitUntil(salva(req, r.clone())); return r; }
      catch (x) { return new Response('', { status: 504 }); }
    })());
    return;
  }

  // file dell'app: prima la rete (versione aggiornata), con rete assente o lenta la copia salvata
  e.respondWith((async () => {
    const rete = fetch(req);
    try {
      const r = await conLimite(rete, ATTESA_RETE_MS);
      if (r.ok) e.waitUntil(salva(req, r.clone()));
      if (req.mode === 'navigate') e.waitUntil(rinfrescaSeServe().catch(() => {}));
      return r;
    } catch (x) {
      const c = await copiaSalvata(req);
      if (c) { e.waitUntil(rete.then(r => r.ok && salva(req, r)).catch(() => {})); return c; }
      if (req.mode === 'navigate') {
        const home = await copiaSalvata(new Request(SCOPE));
        if (home) return home;
      }
      try { return await rete; } catch (y) {}   // rete lenta ma ancora in arrivo
      if (req.mode === 'navigate') {
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>Lucci’s Space Race</title><body style="font-family:system-ui;padding:32px 20px;background:#f4f6f8;color:#15212e">' +
          '<h2>Serve internet una volta</h2><p>Apri Lucci’s Space Race con la connessione attiva: si salva nel telefono e poi funziona anche in modalità aereo. I tuoi dati non sono andati persi.</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response('', { status: 504 });
    }
  })());
});
