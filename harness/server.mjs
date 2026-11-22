import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..', 'plugin');
const VIRTUAL_DIR = '/.crosspoint/plugins/storygraph-sync';
const RELAY_MAX_BODY_BYTES = 32768;
const MAX_HEADER_COUNT = 16;
const MAX_HEADER_BYTES = 4096;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'range']);

const DEFAULT_EVENTS_JSONL = [
  JSON.stringify({
    e: 'reader.session',
    id: 'bc155182-1',
    ts: 1795220387,
    vars: {
      book: '/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub',
      document: '312e1b92000000000000000000000001',
      start_time: '1795220320',
      end_time: '1795220387',
      duration_seconds: '67',
      start_progress_bp: '8810',
      end_progress_bp: '8876',
      progress_scale: '10000'
    }
  }),
  JSON.stringify({
    e: 'reader.exit',
    id: 'bc155182-2',
    ts: 1795220387,
    vars: {
      book: '/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub',
      percent: '89'
    }
  }),
  JSON.stringify({
    e: 'reader.session',
    id: 'bc155182-3',
    ts: 1795220476,
    vars: {
      book: '/Books/Non-Fiction/Author Beta/Sample Non-Fiction B - Author Beta.epub',
      document: 'b55812a3000000000000000000000002',
      start_time: '1795220412',
      end_time: '1795220476',
      duration_seconds: '64',
      start_progress_bp: '8290',
      end_progress_bp: '8331',
      progress_scale: '10000'
    }
  }),
  JSON.stringify({
    e: 'reader.exit',
    id: 'bc155182-4',
    ts: 1795220476,
    vars: {
      book: '/Books/Non-Fiction/Author Beta/Sample Non-Fiction B - Author Beta.epub',
      percent: '83'
    }
  }),
  JSON.stringify({
    e: 'reader.exit',
    id: 'bc155182-5',
    ts: 1795220510,
    vars: {
      book: '/Books/Light Novels/Sample Series/Sample Series Vol. 9 - Author Gamma.epub',
      percent: '81'
    }
  })
].join('\n') + '\n';

const PLUGIN_HOST_JS = `window.CrossPoint = window.CrossPoint || {
  _pending: null,
  registerPlugin(fn) { this._pending = fn; },
  _actions: Object.create(null),
  registerAction(pluginName, action, fn) {
    (this._actions[pluginName] = this._actions[pluginName] || Object.create(null))[action] = fn;
  },
  async _readResponse(r, path) {
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json()).error || ''; } catch (e) {}
      const err = new Error(path + ' ' + r.status + (detail ? ': ' + detail : ''));
      err.status = r.status;
      throw err;
    }
    return r.json();
  },
  async _post(path, body) {
    return this._readResponse(await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }), path);
  },
  async relay(plugin, method, url, headers, body) {
    const r = await fetch('/api/relay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugin, method, url, headers: headers || {}, body: body || '' })
    });
    if (!r.ok) return this._readResponse(r, '/api/relay');
    const raw = r.headers.get('X-Relay-Headers') || '[]';
    const list = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
    return { status: Number(r.headers.get('X-Relay-Status')), headers: list, body: await r.text() };
  },
  crypto(op, fields) { return this._post('/api/crypto', Object.assign({ op }, fields || {})); },
  async writeFile(plugin, path, dataB64) {
    const bytes = Uint8Array.from(atob(dataB64 || ''), (c) => c.charCodeAt(0));
    const url = '/api/plugin-fs?plugin=' + encodeURIComponent(plugin) + '&path=' + encodeURIComponent(path);
    const form = new FormData();
    form.append('file', new Blob([bytes]), 'data');
    const r = await fetch(url, { method: 'POST', body: form });
    return this._readResponse(r, '/api/plugin-fs');
  },
  async fetchToSd(plugin, url, dest, headers) {
    const result = await this._post('/api/fetch', {
      plugin, url, dest, headers: headers || {}, offset: 0, maxBytes: 2 * 1024 * 1024
    });
    if (result.error || !(result.status >= 200 && result.status < 300)) {
      throw new Error('/api/fetch: ' + (result.error || ('HTTP ' + result.status)));
    }
    return result;
  }
};
async function loadPlugins(mount) {
  const host = document.getElementById('plugin-container');
  if (!host) return;
  const list = await (await fetch('/api/plugins')).json();
  for (const p of list) {
    if (mount && (p.mount || 'settings') !== mount) continue;
    const container = document.createElement('div');
    container.className = 'card';
    container.id = 'plugin-' + p.name;
    host.appendChild(container);
    CrossPoint._pending = null;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/plugin?name=' + encodeURIComponent(p.name) + '&file=plugin.js';
      s.onload = resolve; s.onerror = reject;
      document.body.appendChild(s);
    });
    if (typeof CrossPoint._pending === 'function') {
      await CrossPoint._pending(container, {
        name: p.name,
        dir: p.dir,
        relay: (m, u, h, b) => CrossPoint.relay(p.name, m, u, h, b),
        crypto: (op, f) => CrossPoint.crypto(op, f),
        writeFile: (pPath, d) => CrossPoint.writeFile(p.name, pPath, d),
        fetchToSd: (u, dest, h) => CrossPoint.fetchToSd(p.name, u, dest, h),
        registerAction: (a, fn) => CrossPoint.registerAction(p.name, a, fn),
        pluginFile: (f) => '/plugin?name=' + encodeURIComponent(p.name) + '&file=' + encodeURIComponent(f)
      });
    }
  }
}`;

const SG_SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SG_FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatMockSgDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return '';
  const monthIdx = parseInt(m[2], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return '';
  return `${SG_SHORT_MONTHS[monthIdx]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

function formatMockJournalDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return '';
  const monthIdx = parseInt(m[2], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return '';
  return `${parseInt(m[3], 10)} ${SG_FULL_MONTHS[monthIdx]} ${m[1]}`;
}

function buildMockDateFromParts(yearStr, monthStr, dayStr) {
  const y = parseInt(yearStr, 10);
  const m = parseInt(monthStr, 10);
  const d = parseInt(dayStr, 10);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function buildMockStoryGraphHtml(urlStr, csrfToken, state) {
  const u = new URL(urlStr);
  if (u.pathname === '/' || u.pathname === '/currently-reading') {
    const pad = '<!-- padding -->'.repeat(5000); // > 64 KB to match real homepage size
    return `<!DOCTYPE html><html><head><title>The StoryGraph</title><meta name="csrf-token" content="${csrfToken}"></head><body>
      <h2>Current Reads</h2>
      <div>
        <div class="book-pane">
          <a class="book-page-link" href="/books/book-daily-laws"><img alt="Sample Non-Fiction A by Author Alpha" src="/cover1.jpg"></a>
          <p class="text-darkerGrey">Author Alpha</p>
          <span>${state.books['book-daily-laws'].lastReachedPercent}%</span>
        </div>
        <div class="book-pane">
          <a class="book-page-link" href="/books/book-daily-stoic"><img alt="Sample Non-Fiction B by Author Beta" src="/cover2.jpg"></a>
          <p class="text-darkerGrey">Author Beta</p>
          <span>${state.books['book-daily-stoic'].lastReachedPercent}%</span>
        </div>
      </div>
      ${pad}
    </body></html>`;
  }
  if (u.pathname === '/browse') {
    const q = (u.searchParams.get('search_term') || '').toLowerCase();
    const cards = [];
    if (!q || q.includes('non-fiction a') || q.includes('alpha')) {
      cards.push(`<div class="book-pane">
        <div class="book-title-author-and-series">
          <a href="/books/book-daily-laws">Sample Non-Fiction A</a>
          <a href="/authors/author-alpha">Author Alpha</a>
        </div>
        <p class="text-xs">464 pages</p>
        <div class="edition-info" data-book-id="book-daily-laws"><p>Format: Paperback</p></div>
      </div>`);
    }
    if (!q || q.includes('sample series') || q.includes('vol. 9')) {
      cards.push(`<div class="book-pane">
        <div class="book-title-author-and-series">
          <a href="/books/book-mt-9">Sample Series Vol. 9</a>
          <a href="/authors/author-gamma">Author Gamma</a>
        </div>
        <p class="text-xs">320 pages</p>
        <div class="edition-info" data-book-id="book-mt-9"><p>Format: Digital</p></div>
      </div>`);
    }
    cards.push(`<div class="book-pane">
      <div class="book-title-author-and-series">
        <a href="/books/book-audio-skip">Audio Edition Example</a>
        <a href="/authors/narrator">Narrator</a>
      </div>
      <div class="edition-info" data-book-id="book-audio-skip"><p>Format: Audiobook</p></div>
    </div>`);
    return `<!DOCTYPE html><html><head><title>Browse - The StoryGraph</title><meta name="csrf-token" content="${csrfToken}"></head><body>${cards.join('\n')}</body></html>`;
  }
  if (u.pathname.startsWith('/books/')) {
    const id = u.pathname.split('/')[2];
    const b = state.books[id] || {
      title: 'Mock Book',
      statusLabel: 'to-read',
      pages: 320,
      progressType: 'percentage',
      lastReachedPercent: 0,
      lastReachedPages: 0
    };
    let dateHtml = '';
    if (b.statusLabel === 'read' && b.readInstanceId) {
      dateHtml = `<a data-method="get" href="/edit-read-instance-from-book?book_id=${id}&amp;read_instance_id=${b.readInstanceId}"><p>Finished ${b.finishedLabel || 'Nov 21, 2026'}</p></a>`;
    } else if ((b.statusLabel === 'currently reading' || b.statusLabel === 'rereading') && b.startJournalEntryId) {
      dateHtml = `<a data-method="get" href="/edit-journal-entry-from-book?book_id=${id}&amp;journal_entry_id=${b.startJournalEntryId}"><p>Started ${b.startedLabel || 'Nov 21, 2026'}</p></a>`;
    }
    return `<!DOCTYPE html><html><head><title>${b.title} | The StoryGraph</title><meta name="csrf-token" content="${csrfToken}"></head><body>
      <h3>${b.title}</h3>
      <button class="read-status-label">${b.statusLabel}</button>
      ${dateHtml}
      <form action="/update-progress" method="post">
        <input type="hidden" name="authenticity_token" value="${csrfToken}">
        <input type="hidden" name="read_status[book_num_of_pages]" value="${b.pages}">
        <input type="hidden" name="read_status[last_reached_percent]" value="${b.lastReachedPercent}">
        <input type="hidden" name="read_status[last_reached_pages]" value="${b.lastReachedPages}">
        <select name="read_status[progress_type]">
          <option value="percentage" ${b.progressType === 'percentage' ? 'selected="selected"' : ''}>percentage</option>
          <option value="pages" ${b.progressType === 'pages' ? 'selected="selected"' : ''}>pages</option>
        </select>
      </form>
    </body></html>`;
  }
  if (u.pathname === '/journal') {
    const id = u.searchParams.get('book_id') || '';
    const b = state.books[id] || { title: 'Mock Book', pages: 320, journalEntries: [] };
    const panes = (b.journalEntries || [])
      .map((entry, idx) => {
        const eid = entry.entryId || `je-${idx + 1}`;
        const dStr = formatMockJournalDate(entry.date);
        const noteHtml = entry.note
          ? `<div class="clear-both trix-content text-xs md:text-sm"><div class="trix-content">${entry.note}</div></div>`
          : '';
        let body = '';
        if (entry.statusKind === 'finished') {
          const delta = entry.pagesDelta ?? 0;
          const tot = entry.totalPages ?? b.pages ?? 0;
          const pgs = entry.pages ?? tot;
          body = `<span>Finished</span><p class="mt-2 clear-both">${delta} pages read <span class="font-normal">(${pgs} pages out of ${tot})</span></p>${noteHtml}`;
        } else if (entry.isStatus || entry.statusKind === 'started') {
          body = '<span>Started reading</span>';
        } else {
          const tot = entry.totalPages ?? b.pages ?? 0;
          const pgs = entry.pages ?? 0;
          const delta = entry.pagesDelta ?? pgs;
          body = `<div class="inline">${entry.percent ?? 0}%</div><p class="clear-both">${delta} pages read <span class="font-normal">(${pgs} pages out of ${tot})</span></p>${noteHtml}`;
        }
        return `<div class="mb-3 grid grid-cols-4 md:grid-cols-6"><div class="col-span-4 md:col-span-4 ml-2 md:ml-2"><div class="mb-4"><p class="font-semibold text-xs md:text-sm">${dStr} <a href="/journal_entries/${eid}/edit">Edit</a></p></div><div class="mt-2 mb-4">${body}</div></div></div>`;
      })
      .join('\n');
    return `<!DOCTYPE html><html><head><title>${b.title} Journal | The StoryGraph</title><meta name="csrf-token" content="${csrfToken}"></head><body><h3>${b.title}</h3><span class="journal-entry-panes">${panes}</span></body></html>`;
  }
  return `<!DOCTYPE html><html><head><title>Not Found</title></head><body>404</body></html>`;
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extractMultipartFile(buf, contentType) {
  const m = String(contentType || '').match(/boundary=([^\s;]+)/i);
  if (!m) return null;
  const boundary = '--' + m[1].replace(/^"|"$/g, '');
  const raw = buf.toString('latin1');
  const idx = raw.indexOf(boundary);
  if (idx === -1) return null;
  const headerEnd = raw.indexOf('\r\n\r\n', idx);
  if (headerEnd === -1) return null;
  const nextBoundary = raw.indexOf('\r\n' + boundary, headerEnd + 4);
  if (nextBoundary === -1) return null;
  return buf.subarray(headerEnd + 4, nextBoundary);
}

function validatePluginHeaders(headersObj) {
  const entries = Object.entries(headersObj || {});
  if (entries.length > MAX_HEADER_COUNT) return false;
  let totalBytes = 0;
  for (const [k, v] of entries) {
    const lk = String(k || '').toLowerCase();
    if (!lk || FORBIDDEN_HEADERS.has(lk)) return false;
    totalBytes += String(k).length + String(v ?? '').length + 4;
  }
  return totalBytes <= MAX_HEADER_BYTES;
}

export function createMockServer({ live = false } = {}) {
  const validCsrf = 'mock-csrf-token-123';
  const virtualFiles = new Map([
    ['events.jsonl', Buffer.from(DEFAULT_EVENTS_JSONL, 'utf8')]
  ]);
  const sgState = {
    books: {
      'book-daily-laws': {
        title: 'Sample Non-Fiction A',
        statusLabel: 'currently reading',
        pages: 464,
        progressType: 'percentage',
        lastReachedPercent: 50,
        lastReachedPages: 232,
        startJournalEntryId: 'je-laws-1',
        startedLabel: 'Nov 21, 2026',
        journalEntries: [
          { date: '2026-10-20', percent: 20, pages: 93, note: '' }
        ]
      },
      'book-daily-stoic': {
        title: 'Sample Non-Fiction B',
        statusLabel: 'currently reading',
        pages: 416,
        progressType: 'pages',
        lastReachedPercent: 40,
        lastReachedPages: 166,
        startJournalEntryId: 'je-stoic-1',
        startedLabel: 'Oct 29, 2026',
        journalEntries: []
      },
      'book-mt-9': {
        title: 'Sample Series Vol. 9',
        statusLabel: 'to-read',
        pages: 320,
        progressType: 'percentage',
        lastReachedPercent: 0,
        lastReachedPages: 0
      },
      'book-done-100': {
        title: 'Finished Book Example',
        statusLabel: 'to-read',
        pages: 280,
        progressType: 'percentage',
        lastReachedPercent: 0,
        lastReachedPages: 0
      }
    },
    posts: []
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && u.pathname === '/files') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Files - Mock CrossInk</title>
        <style>:root{--font-color:#1f2933;--bg:#f3f4f6;--title-color:#111827;--card-bg:#fff;--label-color:#6b7280;--border-color:#e6e8ec;--accent-color:#6e9a82;--accent-hover-color:#5a8c73;--accent-soft:rgba(110,154,130,0.12);--danger-color:#dc2626}
        @media(prefers-color-scheme:dark){:root{--font-color:#e4e7eb;--bg:#16181d;--title-color:#f3f4f6;--card-bg:#21242a;--label-color:#9aa3af;--border-color:#343941;--accent-soft:rgba(110,154,130,0.2);color-scheme:dark}}
        body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:820px;margin:28px auto;padding:0 20px;background:var(--bg);color:var(--font-color)}.card{background:var(--card-bg);border:1px solid var(--border-color);border-radius:4px;padding:22px 24px}</style>
        <script src="/plugin-host.js"></script></head>
        <body><h1>Mock CrossInk File Manager</h1><div id="plugin-container"></div>
        <script>loadPlugins('files');</script></body></html>`);
      return;
    }

    if (req.method === 'GET' && u.pathname === '/plugin-host.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(PLUGIN_HOST_JS);
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: 'v2.0.0-0b939f4-RC',
        firmwareFamily: 'crosspoint',
        pluginApi: 1,
        pluginCapabilities: 'events.reader.open,events.reader.exit,events.reader.session,events.sleep.enter',
        mode: 'STA',
        freeHeap: 97484,
        device: 'xteink_x4_pro'
      }));
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/plugins') {
      const manifest = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        name: 'storygraph-sync',
        dir: VIRTUAL_DIR,
        title: manifest.title,
        mount: manifest.mount || 'files',
        hasPluginJs: true
      }]));
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/files') {
      const reqPath = (u.searchParams.get('path') || '/').replace(/\/+$/, '') || '/';
      const mockTree = {
        '/': [
          { name: 'Books', size: 0, isDirectory: true, isEpub: false },
          { name: 'Read', size: 0, isDirectory: true, isEpub: false },
          { name: '.crosspoint', size: 0, isDirectory: true, isEpub: false },
          { name: 'My Clippings.txt', size: 3021, isDirectory: false, isEpub: false },
          { name: 'sleep.bmp', size: 1152054, isDirectory: false, isEpub: false }
        ],
        '/Books': [
          { name: 'Non-Fiction', size: 0, isDirectory: true, isEpub: false },
          { name: 'Dune - Frank Herbert.epub', size: 1234567, isDirectory: false, isEpub: true }
        ],
        '/Books/Non-Fiction': [
          { name: 'Author Alpha', size: 0, isDirectory: true, isEpub: false }
        ],
        '/Books/Non-Fiction/Author Alpha': [
          { name: 'Sample Non-Fiction A - Author Alpha.epub', size: 500000, isDirectory: false, isEpub: true }
        ],
        '/Read': [
          { name: 'Project Hail Mary - Andy Weir.epub', size: 980000, isDirectory: false, isEpub: true }
        ]
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockTree[reqPath] || []));
      return;
    }

    if (req.method === 'GET' && u.pathname === '/plugin') {
      const file = u.searchParams.get('file') || '';
      if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) {
        res.writeHead(400);
        res.end('bad plugin path');
        return;
      }
      if (virtualFiles.has(file)) {
        const buf = virtualFiles.get(file);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(buf);
        return;
      }
      try {
        const diskBuf = await fs.readFile(path.join(PLUGIN_DIR, file));
        const ct = file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
        res.end(diskBuf);
      } catch (_) {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    if (req.method === 'GET' && u.pathname === '/download') {
      const target = u.searchParams.get('path') || '';
      if (target.startsWith('/.crosspoint')) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Access denied to protected path');
        return;
      }
      res.writeHead(404);
      res.end('Item not found');
      return;
    }

    if (req.method === 'POST' && u.pathname === '/delete') {
      const body = (await readBodyBuffer(req)).toString('utf8');
      const target = new URLSearchParams(body).get('path') || '';
      if (target.startsWith('/.crosspoint/plugins/')) {
        res.writeHead(500);
        res.end('Delete failed');
        return;
      }
      res.writeHead(200);
      res.end('OK');
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/plugin-fs') {
      const target = u.searchParams.get('path') || '';
      if (!target.startsWith(VIRTUAL_DIR + '/') || target.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad path' }));
        return;
      }
      const rel = target.slice(VIRTUAL_DIR.length + 1);
      if (rel.startsWith('.')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad path' }));
        return;
      }
      const raw = await readBodyBuffer(req);
      const data = extractMultipartFile(raw, req.headers['content-type']);
      if (!data) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing file part' }));
        return;
      }
      if (data.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'empty body' }));
        return;
      }
      if (data.length > 256 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'too large' }));
        return;
      }
      virtualFiles.set(rel, data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bytes: data.length }));
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/fetch') {
      const reqJson = JSON.parse((await readBodyBuffer(req)).toString('utf8'));
      if (!reqJson.url || !reqJson.dest || !reqJson.dest.startsWith(VIRTUAL_DIR + '/')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad url/dest' }));
        return;
      }
      if (!validatePluginHeaders(reqJson.headers)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid request' }));
        return;
      }
      const rel = reqJson.dest.slice(VIRTUAL_DIR.length + 1);
      if (live) {
        const up = await fetch(reqJson.url, { headers: reqJson.headers || {} });
        const buf = Buffer.from(await up.arrayBuffer());
        virtualFiles.set(rel, buf);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: up.status, bytes: buf.length, complete: true, total: buf.length }));
        return;
      }
      const reqHeadersLowerFetch = Object.fromEntries(
        Object.entries(reqJson.headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])
      );
      if (reqHeadersLowerFetch['x-mock-cloudflare'] === '1') {
        const cfBuf = Buffer.from('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-chl-bypass</body></html>', 'utf8');
        virtualFiles.set(rel, cfBuf);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 403, bytes: cfBuf.length, complete: true, total: cfBuf.length }));
        return;
      }
      const html = buildMockStoryGraphHtml(reqJson.url, validCsrf, sgState);
      const buf = Buffer.from(html, 'utf8');
      virtualFiles.set(rel, buf);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 200, bytes: buf.length, complete: true, total: buf.length }));
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/relay') {
      const reqJson = JSON.parse((await readBodyBuffer(req)).toString('utf8'));
      if (!reqJson.plugin || !reqJson.url) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing plugin/url' }));
        return;
      }
      if (!validatePluginHeaders(reqJson.headers)) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'relay failed; large bodies need /api/fetch' }));
        return;
      }
      if (live) {
        const up = await fetch(reqJson.url, {
          method: reqJson.method || 'GET',
          headers: reqJson.headers || {},
          body: reqJson.method === 'GET' || reqJson.method === 'HEAD' ? undefined : reqJson.body,
          redirect: 'manual'
        });
        const buf = Buffer.from(await up.arrayBuffer());
        const upEncoding = (up.headers.get('content-encoding') || '').toLowerCase();
        const wireSize = upEncoding.includes('gzip') ? gzipSync(buf).length : buf.length;
        if (wireSize > RELAY_MAX_BODY_BYTES) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'relay failed; large bodies need /api/fetch' }));
          return;
        }
        const pairs = Array.from(up.headers.entries());
        res.writeHead(200, {
          'X-Relay-Status': String(up.status),
          'X-Relay-Headers': JSON.stringify(pairs)
        });
        res.end(buf);
        return;
      }

      const target = new URL(reqJson.url);
      const reqHeadersLower = Object.fromEntries(
        Object.entries(reqJson.headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])
      );
      if (reqHeadersLower['x-mock-cloudflare'] === '1') {
        res.writeHead(200, {
          'X-Relay-Status': '403',
          'X-Relay-Headers': JSON.stringify([
            ['content-type', 'text/html; charset=UTF-8'],
            ['cf-mitigated', 'challenge'],
            ['server', 'cloudflare']
          ])
        });
        res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-chl-bypass</body></html>');
        return;
      }

      if (reqHeadersLower['x-mock-relay-fail-before-apply'] === '1') {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'relay failed; large bodies need /api/fetch' }));
        return;
      }

      if (reqJson.method === 'GET' && (target.pathname === '/' || target.pathname === '/currently-reading')) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'relay failed; large bodies need /api/fetch' }));
        return;
      }

      const params = new URLSearchParams(reqJson.body || '');
      const csrfHdr = reqHeadersLower['x-csrf-token'] || '';
      const csrfBody = params.get('authenticity_token') || '';
      if (csrfHdr !== validCsrf || csrfBody !== validCsrf) {
        res.writeHead(200, {
          'X-Relay-Status': '422',
          'X-Relay-Headers': JSON.stringify([['content-type', 'text/plain']])
        });
        res.end('InvalidAuthenticityToken');
        return;
      }

      const acceptEncoding = reqHeadersLower['accept-encoding'] || '';
      const isDatePatchRoute =
        target.pathname.startsWith('/read_instances/') ||
        target.pathname === '/update-journal-entry-from-book';
      if (target.pathname === '/update-status.js') {
        const bid = target.searchParams.get('book_id');
        const st = target.searchParams.get('status');
        if (sgState.books[bid]) {
          sgState.books[bid].statusLabel = st.replace(/-/g, ' ');
          if (st === 'read') {
            sgState.books[bid].lastReachedPercent = 100;
            if (sgState.books[bid].pages > 0) {
              sgState.books[bid].lastReachedPages = sgState.books[bid].pages;
            }
            sgState.books[bid].readInstanceId = sgState.books[bid].readInstanceId || '900001';
            sgState.books[bid].finishedLabel = 'Nov 21, 2026';
          } else if (st === 'currently-reading' || st === 'rereading') {
            sgState.books[bid].startJournalEntryId = sgState.books[bid].startJournalEntryId || ('je-' + bid);
            sgState.books[bid].startedLabel = sgState.books[bid].startedLabel || 'Nov 21, 2026';
          }
        }
        sgState.posts.push({ path: '/update-status.js', bid, st, acceptEncoding });
      } else if (target.pathname === '/update-progress') {
        const bid = params.get('book_id');
        const val = Number(params.get('read_status[progress_number]') || 0);
        const pType = params.get('read_status[progress_type]');
        if (sgState.books[bid]) {
          if (pType === 'pages' && sgState.books[bid].pages > 0) {
            sgState.books[bid].lastReachedPages = val;
            sgState.books[bid].lastReachedPercent = Math.round((val / sgState.books[bid].pages) * 100);
          } else {
            sgState.books[bid].lastReachedPercent = val;
          }
        }
        sgState.posts.push({ path: '/update-progress', bid, val, pType, acceptEncoding });
      } else if (target.pathname.startsWith('/read_instances/')) {
        const readInstanceId = target.pathname.split('/')[2] || '';
        const bid = params.get('book_id') || '';
        const startDate = buildMockDateFromParts(
          params.get('read_instance[start_year]'),
          params.get('read_instance[start_month]'),
          params.get('read_instance[start_day]')
        );
        const finishDate = buildMockDateFromParts(
          params.get('read_instance[year]'),
          params.get('read_instance[month]'),
          params.get('read_instance[day]')
        );
        if (sgState.books[bid]) {
          sgState.books[bid].startDate = startDate;
          sgState.books[bid].finishDate = finishDate;
          sgState.books[bid].finishedLabel = formatMockSgDate(finishDate) || sgState.books[bid].finishedLabel;
        }
        sgState.posts.push({
          path: target.pathname,
          method: params.get('_method') || 'post',
          bid,
          readInstanceId,
          startDate,
          finishDate,
          acceptEncoding
        });
      } else if (target.pathname === '/update-journal-entry-from-book') {
        const journalEntryId = params.get('journal_entry_id') || '';
        const bid = params.get('book_id') || '';
        const startDate = buildMockDateFromParts(
          params.get('journal_entry[year]'),
          params.get('journal_entry[month]'),
          params.get('journal_entry[day]')
        );
        if (sgState.books[bid]) {
          sgState.books[bid].startDate = startDate;
          sgState.books[bid].startedLabel = formatMockSgDate(startDate) || sgState.books[bid].startedLabel;
        }
        sgState.posts.push({
          path: target.pathname,
          method: params.get('_method') || 'post',
          bid,
          journalEntryId,
          startDate,
          acceptEncoding
        });
      } else if (target.pathname === '/update-progress-with-note') {
        const bid = params.get('book_id') || '';
        const date = buildMockDateFromParts(
          params.get('progress_update_date[year]'),
          params.get('progress_update_date[month]'),
          params.get('progress_update_date[day]')
        );
        const val = Number(params.get('progress_number') || 0);
        const pType = params.get('progress_type') || 'percentage';
        const note = params.get('note') || '';
        if (sgState.books[bid]) {
          const b = sgState.books[bid];
          let pct = val;
          let pgs = 0;
          if (pType === 'pages' && b.pages > 0) {
            pgs = val;
            pct = Math.round((val / b.pages) * 100);
          } else if (b.pages > 0) {
            pgs = Math.round((val / 100) * b.pages);
          }
          if (pct > (b.lastReachedPercent || 0)) b.lastReachedPercent = pct;
          if (pgs > (b.lastReachedPages || 0)) b.lastReachedPages = pgs;
          b.journalEntries = b.journalEntries || [];
          b.journalEntries.push({ date, percent: pct, pages: pgs, note });
        }
        sgState.posts.push({
          path: '/update-progress-with-note',
          bid,
          date,
          val,
          pType,
          note,
          acceptEncoding
        });
        if (reqHeadersLower['x-mock-force-502-after-apply'] === '1') {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'relay failed; large bodies need /api/fetch' }));
          return;
        }
        res.writeHead(200, {
          'X-Relay-Status': '302',
          'X-Relay-Headers': JSON.stringify([
            ['location', `https://app.thestorygraph.com/books/${bid}`],
            ['set-cookie', '_storygraph_session=rotated_sess_999; path=/; HttpOnly']
          ])
        });
        res.end('');
        return;
      } else if (target.pathname.startsWith('/journal_entries/')) {
        const entryId = target.pathname.split('/')[2] || '';
        const method = (params.get('_method') || 'post').toLowerCase();
        for (const [bid, b] of Object.entries(sgState.books)) {
          const list = b.journalEntries || [];
          const idx = list.findIndex((e, i) => (e.entryId || `je-${i + 1}`) === entryId);
          if (idx !== -1) {
            if (method === 'delete') {
              list.splice(idx, 1);
            } else if (method === 'put') {
              const date = buildMockDateFromParts(
                params.get('journal_entry[year]'),
                params.get('journal_entry[month]'),
                params.get('journal_entry[day]')
              );
              if (date) list[idx].date = date;
              if (params.has('journal_entry[pages_read]')) {
                list[idx].pagesDelta = Number(params.get('journal_entry[pages_read]') || 0);
              }
              if (params.has('journal_entry[pages_read_total]')) {
                list[idx].pages = Number(params.get('journal_entry[pages_read_total]') || 0);
              }
              if (params.has('journal_entry[percent_reached]')) {
                list[idx].percent = Number(params.get('journal_entry[percent_reached]') || 0);
              }
              if (params.has('journal_entry[note]')) {
                list[idx].note = params.get('journal_entry[note]') || '';
              }
            }
            sgState.posts.push({
              path: target.pathname,
              method,
              bid,
              entryId,
              pagesRead: params.has('journal_entry[pages_read]') ? Number(params.get('journal_entry[pages_read]')) : null,
              acceptEncoding
            });
            break;
          }
        }
        res.writeHead(200, {
          'X-Relay-Status': '302',
          'X-Relay-Headers': JSON.stringify([
            ['location', 'https://app.thestorygraph.com/journal'],
            ['set-cookie', '_storygraph_session=rotated_sess_999; path=/; HttpOnly']
          ])
        });
        res.end('');
        return;
      }

      if (target.pathname === '/update-status.js' || target.pathname === '/update-progress' || isDatePatchRoute) {
        const rawBody = Buffer.from(
          isDatePatchRoute
            ? `<turbo-stream action="replace" target="book-pane">${'<!-- turbo -->'.repeat(2500)}</turbo-stream>`
            : '// ok\n' + '/* book-pane-html */'.repeat(2300),
          'utf8'
        );
        const wantsGzip = acceptEncoding.toLowerCase().includes('gzip');
        if (reqHeadersLower['x-mock-force-502-after-apply'] === '1' || !wantsGzip) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'relay failed; large bodies need /api/fetch' }));
          return;
        }
        const gzBody = gzipSync(rawBody);
        res.writeHead(200, {
          'X-Relay-Status': '200',
          'X-Relay-Headers': JSON.stringify([
            ['content-type', isDatePatchRoute ? 'text/vnd.turbo-stream.html; charset=utf-8' : 'text/javascript'],
            ['content-encoding', 'gzip'],
            ['set-cookie', '_storygraph_session=rotated_sess_999; path=/; HttpOnly']
          ])
        });
        res.end(gzBody);
        return;
      }

      res.writeHead(200, {
        'X-Relay-Status': '200',
        'X-Relay-Headers': JSON.stringify([
          ['content-type', 'text/javascript'],
          ['set-cookie', '_storygraph_session=rotated_sess_999; path=/; HttpOnly']
        ])
      });
      res.end('// ok');
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return { server, virtualFiles, sgState };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const live = process.argv.includes('--live');
  const { server } = createMockServer({ live });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Mock CrossInk harness listening at http://127.0.0.1:${port}/files (live=${live})`);
  });
}
