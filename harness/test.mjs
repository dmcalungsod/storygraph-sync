import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createMockServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_JS_PATH = path.resolve(__dirname, '..', 'storygraph-sync.crosspoint-plugin', 'plugin.js');

// Minimal HTML tree + CSS selector DOMParser shim for Node tests
const VOID_TAGS = new Set(['meta', 'input', 'img', 'br', 'hr', 'link']);

function parseAttrs(raw) {
  const attrs = {};
  const rx = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = rx.exec(raw))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

class MiniElement {
  constructor(tagName, attrs = {}, parent = null) {
    this.tagName = tagName.toLowerCase();
    this.attrs = attrs;
    this.parentElement = parent;
    this.children = [];
    this._textParts = [];
  }
  getAttribute(name) {
    const k = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  get textContent() {
    let out = '';
    for (const item of this._textParts) {
      out += typeof item === 'string' ? item : item.textContent;
    }
    return out;
  }
  matchesSimple(sel) {
    let rest = sel.trim();
    if (!rest) return false;
    const tagMatch = rest.match(/^[a-zA-Z0-9_-]+/);
    if (tagMatch) {
      if (this.tagName !== tagMatch[0].toLowerCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    while (rest.length > 0) {
      if (rest[0] === '.') {
        const cm = rest.slice(1).match(/^[a-zA-Z0-9_-]+/);
        if (!cm) return false;
        const classes = (this.attrs.class || '').split(/\s+/);
        if (!classes.includes(cm[0])) return false;
        rest = rest.slice(1 + cm[0].length);
      } else if (rest[0] === '#') {
        const im = rest.slice(1).match(/^[a-zA-Z0-9_-]+/);
        if (!im || this.attrs.id !== im[0]) return false;
        rest = rest.slice(1 + im[0].length);
      } else if (rest[0] === '[') {
        let end = -1;
        let quote = '';
        for (let i = 1; i < rest.length; i++) {
          const ch = rest[i];
          if (quote) {
            if (ch === quote) quote = '';
          } else if (ch === '"' || ch === "'") {
            quote = ch;
          } else if (ch === ']') {
            end = i;
            break;
          }
        }
        if (end === -1) return false;
        const inner = rest.slice(1, end);
        const am = inner.match(/^([a-zA-Z0-9_:-]+)(?:\s*([\^*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?$/);
        if (!am) return false;
        const attrVal = this.getAttribute(am[1]);
        if (attrVal === null) return false;
        const op = am[2];
        const expected = am[3] ?? am[4] ?? am[5] ?? '';
        if (op === '=' && attrVal !== expected) return false;
        if (op === '^=' && !attrVal.startsWith(expected)) return false;
        if (op === '*=' && !attrVal.includes(expected)) return false;
        rest = rest.slice(end + 1);
      } else {
        return false;
      }
    }
    return true;
  }
  matchesGroup(selectorList) {
    for (const part of selectorList.split(',')) {
      const tokens = part.trim().split(/\s+/);
      if (tokens.length === 0) continue;
      if (!this.matchesSimple(tokens[tokens.length - 1])) continue;
      let cur = this.parentElement;
      let ok = true;
      for (let i = tokens.length - 2; i >= 0; i--) {
        while (cur && !cur.matchesSimple(tokens[i])) {
          cur = cur.parentElement;
        }
        if (!cur) {
          ok = false;
          break;
        }
        cur = cur.parentElement;
      }
      if (ok) return true;
    }
    return false;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const ch of node.children) {
        if (ch.matchesGroup(selector)) out.push(ch);
        walk(ch);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  closest(selector) {
    let cur = this;
    while (cur && cur.tagName !== '#root') {
      if (cur.matchesGroup(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
}

class MiniDOMParser {
  parseFromString(html) {
    const root = new MiniElement('#root', {}, null);
    let cur = root;
    const tokenRx = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z0-9_-]+)\s*>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>/gi;
    let lastIndex = 0;
    let m;
    while ((m = tokenRx.exec(html))) {
      if (m.index > lastIndex) {
        cur._textParts.push(html.slice(lastIndex, m.index));
      }
      lastIndex = tokenRx.lastIndex;
      if (m[1]) {
        const closeTag = m[1].toLowerCase();
        let scan = cur;
        while (scan && scan.tagName !== '#root' && scan.tagName !== closeTag) {
          scan = scan.parentElement;
        }
        if (scan && scan.tagName === closeTag) cur = scan.parentElement;
      } else if (m[2]) {
        const tag = m[2].toLowerCase();
        const el = new MiniElement(tag, parseAttrs(m[3] || ''), cur);
        cur.children.push(el);
        cur._textParts.push(el);
        if (!m[4] && !VOID_TAGS.has(tag)) {
          cur = el;
        }
      }
    }
    if (lastIndex < html.length) {
      cur._textParts.push(html.slice(lastIndex));
    }
    return root;
  }
}

async function runTests() {
  let registeredPlugin = null;
  const code = await fs.readFile(PLUGIN_JS_PATH, 'utf8');
  const sandbox = {
    DOMParser: MiniDOMParser,
    URLSearchParams,
    TextEncoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    CrossPoint: {
      registerPlugin(fn) {
        registeredPlugin = fn;
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'plugin.js' });

  assert.equal(typeof registeredPlugin, 'function', 'CrossPoint.registerPlugin must be called synchronously');
  const sg = sandbox.__StoryGraphSync;
  assert.ok(sg, '__StoryGraphSync helper exports must exist');

  // 1. UTF-8 Base64 & pluginPath
  assert.equal(sg.pluginPath('/.crosspoint/plugins/storygraph-sync/', '/storygraph-map.json'),
    '/.crosspoint/plugins/storygraph-sync/storygraph-map.json');
  const roundTrip = Buffer.from(sg.utf8ToBase64('Café — 日本語'), 'base64').toString('utf8');
  assert.equal(roundTrip, 'Café — 日本語');

  // 2. Cookie parsing, serialization & rotation
  const cm = sg.parseCookieHeader('_storygraph_session=s1; remember_user_token=r1; cf_clearance=cf1');
  assert.equal(cm._storygraph_session, 's1');
  assert.equal(cm.remember_user_token, 'r1');
  assert.equal(cm.cf_clearance, 'cf1');
  const rotated = sg.mergeSetCookieHeaders(cm, [
    ['Content-Type', 'text/javascript'],
    ['Set-Cookie', '_storygraph_session=s2; path=/; HttpOnly']
  ]);
  assert.equal(rotated.changed, true);
  assert.equal(rotated.map._storygraph_session, 's2');
  assert.equal(rotated.map.remember_user_token, 'r1');
  const serialized = sg.serializeCookieMap(rotated.map);
  assert.ok(serialized.includes('cookies_popup_seen=yes'));
  assert.ok(serialized.includes('_storygraph_session=s2'));

  // 2b. Header sizing, cookie trimming & 502/target helpers
  const smallHeaders = {
    Accept: 'text/javascript',
    'Accept-Encoding': 'gzip',
    Cookie: 'cookies_popup_seen=yes; _storygraph_session=s2; _ga=GA1.2.999'
  };
  assert.equal(
    sg.measureHeaderBytes(smallHeaders),
    ('Accept'.length + 'text/javascript'.length + 4) +
      ('Accept-Encoding'.length + 'gzip'.length + 4) +
      ('Cookie'.length + smallHeaders.Cookie.length + 4)
  );
  const passThroughHdrs = sg.fitHeadersForCrossInk(smallHeaders, {
    _storygraph_session: 's2',
    _ga: 'GA1.2.999'
  });
  assert.equal(passThroughHdrs.Cookie, smallHeaders.Cookie, 'Headers under 3900 B must pass through untouched');

  const bloatedMap = {
    _storygraph_session: 'sess_keep',
    remember_user_token: 'rem_keep',
    cf_clearance: 'cf_keep',
    __cf_bm: 'cfbm_keep',
    _ga: 'x'.repeat(2200),
    _gid: 'y'.repeat(2000)
  };
  const essentialCookieStr = sg.serializeEssentialCookies(bloatedMap);
  assert.ok(essentialCookieStr.includes('_storygraph_session=sess_keep'));
  assert.ok(essentialCookieStr.includes('remember_user_token=rem_keep'));
  assert.ok(essentialCookieStr.includes('cf_clearance=cf_keep'));
  assert.ok(essentialCookieStr.includes('__cf_bm=cfbm_keep'));
  assert.ok(!essentialCookieStr.includes('_ga='));
  assert.ok(!essentialCookieStr.includes('_gid='));

  const trimmedHdrs = sg.fitHeadersForCrossInk(
    {
      Accept: 'text/javascript',
      'Accept-Encoding': 'gzip',
      Cookie: sg.serializeCookieMap(bloatedMap)
    },
    bloatedMap
  );
  assert.ok(sg.measureHeaderBytes(trimmedHdrs) <= 4096);
  assert.ok(trimmedHdrs.Cookie.includes('_storygraph_session=sess_keep'));
  assert.ok(trimmedHdrs.Cookie.includes('cf_clearance=cf_keep'));
  assert.ok(!trimmedHdrs.Cookie.includes('_ga='));

  const hugeEssentialMap = { _storygraph_session: 'z'.repeat(4200), cf_clearance: 'cf1' };
  assert.throws(
    () => sg.fitHeadersForCrossInk({ Cookie: sg.serializeCookieMap(hugeEssentialMap) }, hugeEssentialMap),
    /4 KB limit/
  );

  assert.equal(sg.isRelay502Error(Object.assign(new Error('fail'), { status: 502 })), true);
  assert.equal(sg.isRelay502Error(new Error('/api/relay 502: relay failed; large bodies need /api/fetch')), true);
  assert.equal(sg.isRelay502Error(new Error('/api/fetch: HTTP 403')), false);
  assert.equal(sg.isRelay502Error(null), false);

  assert.equal(
    sg.didBookReachProgressTarget({ status: 'currently-reading', lastReachedPercent: 89 }, { usePages: false, progressValue: 89, devicePercent: 89 }),
    true
  );
  assert.equal(
    sg.didBookReachProgressTarget({ status: 'currently-reading', lastReachedPercent: 88 }, { usePages: false, progressValue: 89, devicePercent: 89 }),
    false
  );
  assert.equal(
    sg.didBookReachProgressTarget({ status: 'currently-reading', lastReachedPages: 345, lastReachedPercent: 83 }, { usePages: true, progressValue: 345, devicePercent: 83 }),
    true
  );
  assert.equal(
    sg.didBookReachProgressTarget({ status: 'currently-reading', lastReachedPages: null, lastReachedPercent: 84 }, { usePages: true, progressValue: 345, devicePercent: 83 }),
    true
  );
  assert.equal(
    sg.didBookReachProgressTarget({ status: 'currently-reading', lastReachedPages: 166, lastReachedPercent: 40 }, { usePages: true, progressValue: 345, devicePercent: 83 }),
    false
  );
  assert.equal(
    sg.didBookReachProgressTarget({ status: 'read', lastReachedPercent: 0 }, { usePages: false, progressValue: 100, devicePercent: 100 }),
    true
  );

  // 2c. Human-readable date formatting helpers
  assert.equal(sg.formatHumanDate('2026-10-19'), 'October 19, 2026');
  assert.equal(sg.formatHumanDate('2026-10-21'), 'October 21, 2026');
  assert.equal(sg.formatHumanDate('2026-11-02'), 'November 2, 2026');
  assert.equal(sg.formatHumanDate('2026-01-05'), 'January 5, 2026');
  assert.equal(sg.formatHumanDate(''), '');
  assert.equal(sg.formatHumanDate(null), '');
  assert.equal(sg.formatHumanDate('October 19, 2026'), 'October 19, 2026');

  assert.equal(
    sg.formatHumanDateRange('2026-10-19', '2026-10-21'),
    'October 19 → October 21, 2026'
  );
  assert.equal(
    sg.formatHumanDateRange('2026-10-31', '2026-11-02'),
    'October 31 → November 2, 2026'
  );
  assert.equal(
    sg.formatHumanDateRange('2025-12-30', '2026-01-02'),
    'December 30, 2025 → January 2, 2026'
  );
  assert.equal(
    sg.formatHumanDateRange('2026-10-30', '2026-10-30'),
    'October 30, 2026'
  );
  assert.equal(
    sg.formatHumanDateRange('', '2026-10-30'),
    'October 30, 2026'
  );
  assert.equal(
    sg.formatHumanDateRange('2026-10-30', ''),
    'October 30, 2026'
  );
  assert.equal(
    sg.formatHumanDateRange('', '', '2026-10-25'),
    'October 25, 2026'
  );

  // 3. events.jsonl reduction & compaction against real Phase 0 output
  const sampleJsonl = [
    '{"e":"reader.session","id":"bc-1","ts":1795220387,"vars":{"book":"/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub","document":"312e1b92000000000000000000000001","duration_seconds":"67","end_progress_bp":"8876","progress_scale":"10000"}}',
    '{"e":"reader.exit","id":"bc-2","ts":1795220387,"vars":{"book":"/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub","percent":"89"}}',
    '{"e":"reader.session","id":"bc-3","ts":1795220476,"vars":{"book":"/Books/Non-Fiction/Author Beta/Sample Non-Fiction B - Author Beta.epub","document":"b55812a3000000000000000000000002","duration_seconds":"64","end_progress_bp":"8331","progress_scale":"10000"}}',
    '{"e":"reader.exit","id":"bc-4","ts":1795220476,"vars":{"book":"/Books/Non-Fiction/Author Beta/Sample Non-Fiction B - Author Beta.epub","percent":"83"}}',
    '{"e":"reader.exit","id":"bc-5","ts":1795220510,"vars":{"book":"/Books/Light Novels/Sample Series/Sample Series Vol. 9 - Author Gamma.epub","percent":"81"}}',
    '{corrupt trailing line'
  ].join('\n');

  const reduced = sg.reduceEventsJsonl(sampleJsonl);
  assert.equal(reduced.size, 3);
  const laws = reduced.get('/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub');
  assert.equal(laws.percent, 89);
  assert.equal(laws.durationSeconds, 67);
  assert.equal(laws.documentHash, '312e1b92000000000000000000000001');
  assert.equal(reduced.get('/Books/Non-Fiction/Author Beta/Sample Non-Fiction B - Author Beta.epub').percent, 83);
  assert.equal(reduced.get('/Books/Light Novels/Sample Series/Sample Series Vol. 9 - Author Gamma.epub').percent, 81);

  const compacted = sg.compactEventsJsonl(sampleJsonl);
  assert.equal(compacted.trim().split('\n').length, 3);
  const reReduced = sg.reduceEventsJsonl(compacted);
  assert.equal(reReduced.get(laws.sdPath).percent, 89);
  assert.equal(reReduced.get(laws.sdPath).documentHash, '312e1b92000000000000000000000001');
  assert.equal(sg.compactEventsJsonl(''), '\n');

  const withoutLaws = sg.removeBookFromEventsJsonl(
    compacted,
    '/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub'
  );
  const reducedWithoutLaws = sg.reduceEventsJsonl(withoutLaws);
  assert.equal(reducedWithoutLaws.size, 2);
  assert.equal(reducedWithoutLaws.has('/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub'), false);
  assert.equal(reducedWithoutLaws.get('/Books/Non-Fiction/Author Beta/Sample Non-Fiction B - Author Beta.epub').percent, 83);

  // 3a. Trailing 0% reader.exit after finishing a book in /Books/ must NOT overwrite 100% session progress
  assert.equal(sg.computePercentFromVars({ end_progress_bp: '25', progress_scale: '10000' }), 1);
  assert.equal(sg.computePercentFromVars({ end_progress_bp: '0', progress_scale: '10000' }), 0);
  const vol10Path = '/Books/Light Novels/Sample Series/Sample Series Vol. 10 - Author Gamma.epub';
  const vol10TrailingZeroJsonl = [
    JSON.stringify({
      e: 'reader.session',
      id: 'v10-s1',
      ts: 1795308180,
      vars: { book: vol10Path, start_progress_bp: '3800', end_progress_bp: '10000', progress_scale: '10000', duration_seconds: '8687' }
    }),
    JSON.stringify({
      e: 'reader.exit',
      id: 'v10-e1',
      ts: 1795308186,
      vars: { book: vol10Path, percent: '0' }
    })
  ].join('\n');
  const vol10Reduced = sg.reduceEventsJsonl(vol10TrailingZeroJsonl).get(vol10Path);
  assert.equal(vol10Reduced.percent, 100, 'Trailing 0% reader.exit must not overwrite 100% reader.session');
  assert.equal(vol10Reduced.finished, true);
  const vol10Compacted = sg.compactEventsJsonl(vol10TrailingZeroJsonl);
  assert.equal(sg.reduceEventsJsonl(vol10Compacted).get(vol10Path).percent, 100);

  // Invariant 1 & 2: Non-zero exit decrease ignored, moved paths coalesced in reduceEventsJsonl, and history-aware compaction
  const nonZeroDropJsonl = [
    JSON.stringify({ e: 'reader.session', id: 'inv1-1', ts: 1795308100, vars: { book: '/Books/Sub/Alpha.epub', document: 'doc-alpha-1', end_progress_bp: '10000', progress_scale: '10000', duration_seconds: '500' } }),
    JSON.stringify({ e: 'reader.exit', id: 'inv1-2', ts: 1795308110, vars: { book: '/Books/Sub/Alpha.epub', percent: '95' } }),
    JSON.stringify({ e: 'reader.exit', id: 'inv1-3', ts: 1795308120, vars: { book: '/Read/Alpha.epub', document: 'doc-alpha-1', percent: '2' } })
  ].join('\n');
  const inv1Map = sg.reduceEventsJsonl(nonZeroDropJsonl);
  assert.equal(inv1Map.size, 1, 'Moved book events in events.jsonl must coalesce into 1 entry');
  assert.equal(inv1Map.get('/Read/Alpha.epub')?.percent, 100, 'Non-zero exit decrease must not downgrade 100% finished progress');
  assert.equal(inv1Map.get('/Read/Alpha.epub')?.finished, true);
  assert.equal(inv1Map.get('/Read/Alpha.epub')?.durationSeconds, 500);

  const lowOutbox = JSON.stringify({ e: 'reader.exit', id: 'inv2-1', ts: 1795308200, vars: { book: '/Books/Sub/Beta.epub', percent: '10' } });
  const higherHist = {
    version: 1,
    books: {
      '/Books/Sub/Beta.epub': {
        days: {
          '2026-11-22': { date: '2026-11-22', startPercent: 10, endPercent: 100, durationSeconds: 900, sessions: 1, syncedToJournal: false, seenIds: [] }
        }
      }
    }
  };
  const inv2Compacted = sg.compactEventsJsonl(lowOutbox, higherHist);
  assert.equal(sg.reduceEventsJsonl(inv2Compacted).get('/Books/Sub/Beta.epub')?.percent, 100, 'compactEventsJsonl must preserve 100% from reading-history.json');

  const zeroReadEvents = sg.reduceEventsJsonl([
    sampleJsonl,
    '{"e":"reader.exit","id":"bc-z1","ts":1795225600,"vars":{"book":"/Read/Mystery Example - Author Delta.epub","percent":"0"}}'
  ].join('\n'));
  const mergedBackfill = sg.mergeBackfillIntoEvents(zeroReadEvents, {
    version: 1,
    books: {
      '/Read/Mystery Example - Author Delta.epub': {
        sdPath: '/Read/Mystery Example - Author Delta.epub',
        title: 'Mystery Example',
        author: 'Author Delta',
        percent: 100,
        rawPercent: 92,
        finished: true,
        durationSeconds: 10051,
        pagesTurned: 452,
        sessions: 23,
        startDate: '2026-10-28',
        lastDate: '2026-10-20',
        lastReadTs: 1792497600
      },
      '/Read/Fantasy Example - Author Epsilon.epub': {
        sdPath: '/Read/Fantasy Example - Author Epsilon.epub',
        title: 'Fantasy Example',
        author: 'Author Epsilon',
        percent: 100,
        rawPercent: 100,
        finished: true,
        durationSeconds: 297,
        pagesTurned: 14,
        sessions: 1,
        lastDate: '2026-10-19',
        lastReadTs: 1792411200
      },
      '/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub': {
        sdPath: '/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub',
        percent: 55,
        durationSeconds: 210,
        pagesTurned: 9,
        lastDate: '2026-10-20',
        lastReadTs: 1792497600
      }
    }
  });
  assert.equal(mergedBackfill.size, 5);
  const spMerged = mergedBackfill.get('/Read/Mystery Example - Author Delta.epub');
  assert.equal(spMerged.percent, 100);
  assert.equal(spMerged.finished, true);
  assert.equal(spMerged.durationSeconds, 10051);
  assert.equal(spMerged.pagesTurned, 452);
  assert.equal(spMerged.startDate, '2026-10-28');
  assert.equal(spMerged.lastDate, '2026-10-20');
  const alchMerged = mergedBackfill.get('/Read/Fantasy Example - Author Epsilon.epub');
  assert.equal(alchMerged.percent, 100);
  assert.equal(alchMerged.pagesTurned, 14);
  const lawsMerged = mergedBackfill.get('/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub');
  assert.equal(lawsMerged.percent, 89, 'Active higher events.jsonl percent must not be downgraded by backfill');
  assert.equal(lawsMerged.durationSeconds, 210);
  assert.equal(lawsMerged.lastDate, '2026-10-20');

  // 3b. Books moved to /Read/ after an older backfill must be treated as 100% finished
  assert.equal(sg.isReadFolderPath('/Read/foo.epub'), true);
  assert.equal(sg.isReadFolderPath('/Books/foo.epub'), false);
  const vol9FinishTs = Math.floor(Date.UTC(2026, 10, 21, 12, 0, 0) / 1000);
  const vol9Events = sg.reduceEventsJsonl(
    JSON.stringify({
      e: 'reader.exit',
      id: '7757f0e3-1',
      ts: vol9FinishTs,
      vars: {
        book: '/Read/Sample Series Vol. 9 - Author Gamma.epub',
        percent: '0'
      }
    })
  );
  const vol9MergedMap = sg.mergeBackfillIntoEvents(vol9Events, {
    version: 1,
    books: {
      '/Books/Light Novels/Sample Series/Sample Series Vol. 9 - Author Gamma.epub': {
        sdPath: '/Books/Light Novels/Sample Series/Sample Series Vol. 9 - Author Gamma.epub',
        title: 'Sample Series Vol. 9',
        author: 'Author Gamma',
        percent: 81,
        rawPercent: 81,
        finished: false,
        durationSeconds: 15231,
        pagesTurned: 919,
        sessions: 9,
        startDate: '2026-11-19',
        lastDate: '2026-11-20',
        lastReadTs: Math.floor(Date.UTC(2026, 10, 20, 12, 0, 0) / 1000)
      }
    }
  });
  const vol9Merged = vol9MergedMap.get('/Read/Sample Series Vol. 9 - Author Gamma.epub');
  assert.ok(vol9Merged, 'Vol. 9 should remain keyed at its live /Read/ path');
  assert.equal(vol9Merged.percent, 100, 'Moved /Read/ book with 0% cache reset must show 100% (not 81% from older backfill)');
  assert.equal(vol9Merged.finished, true);
  assert.equal(vol9Merged.durationSeconds, 15231);
  assert.equal(vol9Merged.pagesTurned, 919);
  assert.equal(vol9Merged.startDate, '2026-11-19');
  assert.equal(vol9Merged.lastDate, '2026-11-21', 'Finish date should use the newer live /Read/ date when backfill was unfinished');

  // 4. Move-resilient mapping lookup
  const mapData = {
    books: {
      '/Books/Author Alpha/Sample Non-Fiction A - Author Alpha.epub': {
        bookId: 'book-daily-laws',
        title: 'Sample Non-Fiction A',
        author: 'Author Alpha',
        sdPath: '/Books/Author Alpha/Sample Non-Fiction A - Author Alpha.epub',
        documentHash: '312e1b92000000000000000000000001'
      }
    }
  };
  const foundMoved = sg.findMappingForBook(mapData, laws);
  assert.ok(foundMoved);
  assert.equal(foundMoved.migrated, true);
  assert.equal(foundMoved.entry.bookId, 'book-daily-laws');

  // 5. Book ID parser & form builder
  assert.equal(sg.parseBookIdInput('https://app.thestorygraph.com/books/abc-123?ref=1'), 'abc-123');
  assert.equal(sg.parseBookIdInput('abc-123'), 'abc-123');
  assert.equal(sg.parseBookIdInput('bad id with spaces'), null);
  const bodyParams = new URLSearchParams(sg.buildProgressFormBody({
    bookId: 'book-1',
    csrf: 'tok',
    progressValue: 208,
    progressType: 'pages',
    bookNumOfPages: 416
  }));
  assert.equal(bodyParams.get('read_status[progress_number]'), '208');
  assert.equal(bodyParams.get('read_status[progress_type]'), 'pages');
  assert.equal(bodyParams.get('read_status[book_num_of_pages]'), '416');
  assert.equal(bodyParams.get('authenticity_token'), 'tok');

  // 5a-dates. StoryGraph date-sync pure helpers
  assert.deepEqual({ ...sg.parseIsoDateParts('2026-10-19') }, {
    year: 2026,
    month: 10,
    day: 19,
    iso: '2026-10-19'
  });
  assert.deepEqual({ ...sg.parseIsoDateParts('2026/11/02') }, {
    year: 2026,
    month: 11,
    day: 2,
    iso: '2026-11-02'
  });
  assert.equal(sg.parseIsoDateParts('not-a-date'), null);
  assert.equal(sg.parseIsoDateParts('2026-13-01'), null);

  assert.equal(sg.parseStoryGraphDisplayDate('Finished Nov 21, 2026\n Click to edit'), '2026-11-21');
  assert.equal(sg.parseStoryGraphDisplayDate('Started Oct 29, 2026'), '2026-10-29');
  assert.equal(sg.parseStoryGraphDisplayDate('Finished Sept 3, 2026'), '2026-09-03');
  assert.equal(sg.parseStoryGraphDisplayDate('Finished November 15, 2026'), '2026-11-15');
  assert.equal(sg.parseStoryGraphDisplayDate('Add read date'), null);

  const clampedReadDates = sg.resolveBookTargetDates(
    { startDate: '2026-10-28', lastDate: '2026-10-20' },
    'read'
  );
  assert.equal(clampedReadDates.startDate.iso, '2026-10-20');
  assert.equal(clampedReadDates.finishDate.iso, '2026-10-20');

  const singleDateRead = sg.resolveBookTargetDates({ startDate: '', lastDate: '2026-10-30' }, 'read');
  assert.equal(singleDateRead.startDate.iso, '2026-10-30');
  assert.equal(singleDateRead.finishDate.iso, '2026-10-30');

  const crDates = sg.resolveBookTargetDates({ startDate: '', lastDate: '2026-11-11' }, 'currently-reading');
  assert.equal(crDates.startDate.iso, '2026-11-11');
  assert.equal(crDates.finishDate, null);

  const readInstParams = new URLSearchParams(sg.buildReadInstanceDateBody({
    bookId: '00000000-0000-4000-8000-000000000001',
    readInstanceId: '100000001',
    csrf: 'tok-ri',
    startDate: '2026-11-09',
    finishDate: '2026-11-15'
  }));
  assert.equal(readInstParams.get('_method'), 'patch');
  assert.equal(readInstParams.get('authenticity_token'), 'tok-ri');
  assert.equal(readInstParams.get('read_instance[start_day]'), '9');
  assert.equal(readInstParams.get('read_instance[start_month]'), '11');
  assert.equal(readInstParams.get('read_instance[start_year]'), '2026');
  assert.equal(readInstParams.get('read_instance[day]'), '15');
  assert.equal(readInstParams.get('read_instance[month]'), '11');
  assert.equal(readInstParams.get('read_instance[year]'), '2026');
  assert.equal(readInstParams.get('book_id'), '00000000-0000-4000-8000-000000000001');
  assert.equal(readInstParams.get('read_instance_id'), '100000001');
  assert.equal(readInstParams.get('commit'), 'Update');

  const journalParams = new URLSearchParams(sg.buildStartJournalDateBody({
    bookId: 'ebe7ae78',
    journalEntryId: 'b6a7de43',
    csrf: 'tok-je',
    startDate: '2026-11-11'
  }));
  assert.equal(journalParams.get('_method'), 'patch');
  assert.equal(journalParams.get('authenticity_token'), 'tok-je');
  assert.equal(journalParams.get('journal_entry[day]'), '11');
  assert.equal(journalParams.get('journal_entry[month]'), '11');
  assert.equal(journalParams.get('journal_entry[year]'), '2026');
  assert.equal(journalParams.get('book_id'), 'ebe7ae78');
  assert.equal(journalParams.get('journal_entry_id'), 'b6a7de43');
  assert.equal(journalParams.get('commit'), 'Update');

  const dateCandidates = sg.getDateSyncCandidateRows([
    {
      sdPath: '/r1.epub',
      startDate: '2026-10-19',
      lastDate: '2026-10-21',
      mapping: { bookId: 'b1', status: 'read' }
    },
    {
      sdPath: '/r2.epub',
      startDate: '2026-10-19',
      lastDate: '2026-10-21',
      mapping: { bookId: 'b2', status: 'read', lastSyncedStartDate: '2026-10-19', lastSyncedFinishDate: '2026-10-21' }
    },
    {
      sdPath: '/c1.epub',
      startDate: '2026-10-20',
      lastDate: '2026-11-21',
      mapping: { bookId: 'b3', status: 'currently-reading', lastSyncedStartDate: '2026-11-21' }
    },
    {
      sdPath: '/c2.epub',
      startDate: '2026-10-31',
      lastDate: '2026-11-21',
      mapping: { bookId: 'b4', status: 'rereading', lastSyncedStartDate: '2026-10-31' }
    }
  ]);
  assert.deepEqual(
    dateCandidates.map((r) => r.sdPath),
    ['/r1.epub', '/c1.epub']
  );

  // 5b. SD Library helper unit tests
  assert.equal(sg.isBookFileEntry({ name: 'Book - Author.epub', isDirectory: false, isEpub: true }), true);
  assert.equal(sg.isBookFileEntry({ name: 'Manga.xtc', isDirectory: false, isEpub: false }), true);
  assert.equal(sg.isBookFileEntry({ name: 'My Clippings.txt', isDirectory: false, isEpub: false }), false);
  assert.equal(sg.isBookFileEntry({ name: 'sleep.bmp', isDirectory: false, isEpub: false }), false);
  assert.equal(sg.isBookFileEntry({ name: 'autorun.inf', isDirectory: false, isEpub: false }), false);
  assert.equal(sg.isBookFileEntry({ name: '.hidden.epub', isDirectory: false, isEpub: true }), false);
  assert.equal(sg.isBookFileEntry({ name: 'Books', isDirectory: true, isEpub: false }), false);
  assert.equal(sg.joinSdPath('/', 'Books'), '/Books');
  assert.equal(sg.joinSdPath('/Books/', '/Non-Fiction/'), '/Books/Non-Fiction');
  assert.equal(sg.parentSdPath('/'), '/');
  assert.equal(sg.parentSdPath('/Books'), '/');
  assert.equal(sg.parentSdPath('/Books/Non-Fiction/'), '/Books');
  const sortedEntries = sg.filterAndSortSdEntries([
    { name: 'sleep.bmp', isDirectory: false, isEpub: false },
    { name: 'Dune.epub', isDirectory: false, isEpub: true },
    { name: '.crosspoint', isDirectory: true, isEpub: false },
    { name: 'Read', isDirectory: true, isEpub: false },
    { name: 'My Clippings.txt', isDirectory: false, isEpub: false },
    { name: 'Books', isDirectory: true, isEpub: false }
  ]);
  assert.deepEqual(
    Array.from(sortedEntries, (e) => e.name),
    ['Books', 'Read', 'Dune.epub']
  );

  // 6. HTML parsers + Mock CrossInk server integration
  const { server, virtualFiles, sgState } = createMockServer({ live: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const pluginsRes = await (await fetch(`${base}/api/plugins`)).json();
    assert.equal(pluginsRes[0].name, 'storygraph-sync');
    assert.equal(pluginsRes[0].mount, 'files');

    // Verify 403 on /.crosspoint/ download & 500 on /delete inside plugin space
    const dlForbidden = await fetch(`${base}/download?path=/.crosspoint/recent.json`);
    assert.equal(dlForbidden.status, 403);
    const delPlugin = await fetch(`${base}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'path=/.crosspoint/plugins/storygraph-sync/tmp-fetch.html'
    });
    assert.equal(delPlugin.status, 500);

    // Fetch homepage via /api/fetch -> tmp-fetch.html -> /plugin?file=tmp-fetch.html
    const fetchHome = await (await fetch(`${base}/api/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugin: 'storygraph-sync',
        url: 'https://app.thestorygraph.com/',
        dest: '/.crosspoint/plugins/storygraph-sync/tmp-fetch.html',
        headers: {}
      })
    })).json();
    assert.equal(fetchHome.status, 200);
    const homeHtml = await (await fetch(`${base}/plugin?name=storygraph-sync&file=tmp-fetch.html`)).text();
    const homeParsed = sg.parseStoryGraphHomepage(homeHtml);
    assert.equal(homeParsed.csrf, 'mock-csrf-token-123');
    assert.equal(homeParsed.currentReads.length, 2);
    assert.equal(homeParsed.currentReads[0].bookId, 'book-daily-laws');

    // Relay GET on large homepage must trigger 502 overflow
    const relayLarge = await fetch(`${base}/api/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugin: 'storygraph-sync',
        method: 'GET',
        url: 'https://app.thestorygraph.com/'
      })
    });
    assert.equal(relayLarge.status, 502);

    // Search parsing (audiobook excluded by default, included when flag=true)
    await fetch(`${base}/api/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugin: 'storygraph-sync',
        url: 'https://app.thestorygraph.com/browse?search_term=',
        dest: '/.crosspoint/plugins/storygraph-sync/tmp-fetch.html',
        headers: {}
      })
    });
    const searchHtml = await (await fetch(`${base}/plugin?name=storygraph-sync&file=tmp-fetch.html`)).text();
    assert.equal(sg.parseStoryGraphSearch(searchHtml, false).results.length, 2);
    assert.equal(sg.parseStoryGraphSearch(searchHtml, true).results.length, 3);

    // Book page parsing
    await fetch(`${base}/api/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugin: 'storygraph-sync',
        url: 'https://app.thestorygraph.com/books/book-daily-stoic',
        dest: '/.crosspoint/plugins/storygraph-sync/tmp-fetch.html',
        headers: {}
      })
    });
    const bookHtml = await (await fetch(`${base}/plugin?name=storygraph-sync&file=tmp-fetch.html`)).text();
    const bookParsed = sg.parseStoryGraphBookPage(bookHtml, 'book-daily-stoic');
    assert.equal(bookParsed.status, 'currently-reading');
    assert.equal(bookParsed.progressType, 'pages');
    assert.equal(bookParsed.bookNumOfPages, 416);
    assert.equal(bookParsed.lastReachedPages, 166);
    assert.equal(bookParsed.startJournalEntryId, 'je-stoic-1');
    assert.equal(bookParsed.startedDate, '2026-10-29');

    const readParsed = sg.parseStoryGraphBookPage(
      '<html><head><meta name="csrf-token" content="c1"></head><body><h3>Vol 3</h3>' +
        '<button class="read-status-label">read</button>' +
        '<a data-method="get" href="/edit-read-instance-from-book?book_id=00000001&amp;read_instance_id=100000001"><p>Finished Nov 15, 2026</p></a>' +
        '</body></html>',
      '00000001'
    );
    assert.equal(readParsed.status, 'read');
    assert.equal(readParsed.readInstanceId, '100000001');
    assert.equal(readParsed.finishedDate, '2026-11-15');

    // /api/plugin-fs rejects 0-byte body and accepts JSON
    const emptyForm = new FormData();
    emptyForm.append('file', new Blob([]), 'data');
    const emptyRes = await fetch(
      `${base}/api/plugin-fs?plugin=storygraph-sync&path=${encodeURIComponent('/.crosspoint/plugins/storygraph-sync/storygraph-map.json')}`,
      { method: 'POST', body: emptyForm }
    );
    assert.equal(emptyRes.status, 400);

    const mapForm = new FormData();
    mapForm.append('file', new Blob([Buffer.from(JSON.stringify(mapData), 'utf8')]), 'data');
    const okWrite = await fetch(
      `${base}/api/plugin-fs?plugin=storygraph-sync&path=${encodeURIComponent('/.crosspoint/plugins/storygraph-sync/storygraph-map.json')}`,
      { method: 'POST', body: mapForm }
    );
    assert.equal(okWrite.status, 200);

    // Relay POST update-progress -> CSRF check + Set-Cookie rotation
    const badPost = await fetch(`${base}/api/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugin: 'storygraph-sync',
        method: 'POST',
        url: 'https://app.thestorygraph.com/update-progress',
        headers: { 'X-CSRF-Token': 'wrong' },
        body: 'authenticity_token=wrong'
      })
    });
    assert.equal(badPost.headers.get('X-Relay-Status'), '422');

    // Relay POST without Accept-Encoding: gzip overflows 32 KB -> 502; with gzip succeeds -> 200 + Set-Cookie rotation
    const noGzipPost = await fetch(`${base}/api/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugin: 'storygraph-sync',
        method: 'POST',
        url: 'https://app.thestorygraph.com/update-progress',
        headers: { 'X-CSRF-Token': 'mock-csrf-token-123' },
        body: sg.buildProgressFormBody({
          bookId: 'book-daily-laws',
          csrf: 'mock-csrf-token-123',
          progressValue: 88,
          progressType: 'percentage',
          bookNumOfPages: 464
        })
      })
    });
    assert.equal(noGzipPost.status, 502);

    const hugeHeaderPost = await fetch(`${base}/api/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugin: 'storygraph-sync',
        method: 'POST',
        url: 'https://app.thestorygraph.com/update-progress',
        headers: {
          'Accept-Encoding': 'gzip',
          'X-CSRF-Token': 'mock-csrf-token-123',
          Cookie: '_storygraph_session=s1; _ga=' + 'x'.repeat(4200)
        },
        body: sg.buildProgressFormBody({
          bookId: 'book-daily-laws',
          csrf: 'mock-csrf-token-123',
          progressValue: 89,
          progressType: 'percentage',
          bookNumOfPages: 464
        })
      })
    });
    assert.equal(hugeHeaderPost.status, 502);

    const goodPost = await fetch(`${base}/api/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugin: 'storygraph-sync',
        method: 'POST',
        url: 'https://app.thestorygraph.com/update-progress',
        headers: {
          'Accept-Encoding': 'gzip',
          'X-CSRF-Token': 'mock-csrf-token-123'
        },
        body: sg.buildProgressFormBody({
          bookId: 'book-daily-laws',
          csrf: 'mock-csrf-token-123',
          progressValue: 89,
          progressType: 'percentage',
          bookNumOfPages: 464
        })
      })
    });
    assert.equal(goodPost.headers.get('X-Relay-Status'), '200');
    assert.equal(sgState.books['book-daily-laws'].lastReachedPercent, 89);
    const hdrPairs = JSON.parse(goodPost.headers.get('X-Relay-Headers'));
    assert.equal(sg.mergeSetCookieHeaders(cm, hdrPairs).map._storygraph_session, 'rotated_sess_999');

    // 7. v0.2.0 helpers: getPendingSyncRows & Sign-In helpers
    const pendingRows = sg.getPendingSyncRows([
      { sdPath: '/a.epub', devicePercent: 50, mapping: { bookId: 'b1', status: 'currently-reading', lastSyncedPercent: 40 } },
      { sdPath: '/b.epub', devicePercent: 60, mapping: { bookId: 'b2', status: 'currently-reading', lastSyncedPercent: 60 } },
      { sdPath: '/c.epub', devicePercent: null, mapping: { bookId: 'b3', status: 'currently-reading', lastSyncedPercent: 10 } },
      { sdPath: '/d.epub', devicePercent: 25, mapping: null },
      { sdPath: '/Read/done.epub', devicePercent: 0, mapping: { bookId: 'b4', status: 'currently-reading', lastSyncedPercent: 100 } },
      { sdPath: '/Read/read.epub', devicePercent: 40, mapping: { bookId: 'b5', status: 'read', lastSyncedPercent: 100 } }
    ]);
    assert.equal(pendingRows.length, 1);
    assert.equal(pendingRows[0].sdPath, '/a.epub');

    // 7b. UI filter/classify/sort helper unit tests
    const uiRowsSample = [
      {
        key: '/read.epub',
        sdPath: '/read.epub',
        title: 'Alpha Finished',
        author: 'Author A',
        devicePercent: 100,
        lastReadTs: 1794000000,
        startDate: '2026-10-19',
        lastDate: '2026-10-21',
        mapping: { bookId: 'b-read', status: 'read', lastSyncedPercent: 100, lastSyncedStartDate: '2026-10-19', lastSyncedFinishDate: '2026-10-21' }
      },
      {
        key: '/uptodate.epub',
        sdPath: '/uptodate.epub',
        title: 'Beta Current',
        author: 'Author B',
        devicePercent: 50,
        lastReadTs: 1794500000,
        startDate: '2026-10-25',
        lastDate: '2026-10-30',
        mapping: { bookId: 'b-cur', status: 'currently-reading', lastSyncedPercent: 50, lastSyncedStartDate: '2026-10-25' }
      },
      {
        key: '/needssync.epub',
        sdPath: '/needssync.epub',
        title: 'Zeta Needs Sync',
        author: 'Author C',
        devicePercent: 75,
        lastReadTs: 1794200000,
        startDate: '2026-10-20',
        lastDate: '2026-11-21',
        mapping: { bookId: 'b-ns', status: 'currently-reading', lastSyncedPercent: 40 }
      },
      {
        key: '/unlinked.epub',
        sdPath: '/unlinked.epub',
        title: 'Gamma Unlinked',
        author: 'Author D',
        devicePercent: 20,
        lastReadTs: 1794600000,
        mapping: null
      }
    ];
    assert.equal(sg.classifyBookRow(uiRowsSample[0]), 'read');
    assert.equal(sg.classifyBookRow(uiRowsSample[1]), 'reading');
    assert.equal(sg.classifyBookRow(uiRowsSample[3]), 'unlinked');
    assert.equal(sg.isRowNeedsSync(uiRowsSample[1]), false);
    assert.equal(sg.isRowNeedsSync(uiRowsSample[2]), true);
    assert.equal(sg.isRowNeedsDateSync(uiRowsSample[0]), false);
    assert.equal(sg.isRowNeedsDateSync(uiRowsSample[2]), true);
    assert.deepEqual(
      sg.filterAndSortBookRows(uiRowsSample, { filter: 'all', sort: 'smart' }).map((r) => r.key),
      ['/needssync.epub', '/uptodate.epub', '/unlinked.epub', '/read.epub']
    );
    assert.deepEqual(
      sg.filterAndSortBookRows(uiRowsSample, { filter: 'reading', sort: 'recent' }).map((r) => r.key),
      ['/uptodate.epub', '/needssync.epub']
    );
    assert.deepEqual(
      sg.filterAndSortBookRows(uiRowsSample, { filter: 'needs-sync' }).map((r) => r.key),
      ['/needssync.epub']
    );
    assert.deepEqual(
      sg.filterAndSortBookRows(uiRowsSample, { filter: 'read' }).map((r) => r.key),
      ['/read.epub']
    );
    assert.deepEqual(
      sg.filterAndSortBookRows(uiRowsSample, { filter: 'unlinked' }).map((r) => r.key),
      ['/unlinked.epub']
    );
    assert.deepEqual(
      sg.filterAndSortBookRows(uiRowsSample, { filter: 'all', query: 'author b' }).map((r) => r.key),
      ['/uptodate.epub']
    );
    assert.deepEqual(
      sg.filterAndSortBookRows(uiRowsSample, { filter: 'all', sort: 'title' }).map((r) => r.key),
      ['/read.epub', '/uptodate.epub', '/unlinked.epub', '/needssync.epub']
    );
    assert.deepEqual(
      sg.filterAndSortBookRows(uiRowsSample, { filter: 'all', sort: 'progress' }).map((r) => r.key),
      ['/read.epub', '/needssync.epub', '/uptodate.epub', '/unlinked.epub']
    );

    // 7c. Per-day reading history, StoryGraph journal parser & CrossPoint Sync import helpers
    assert.equal(sg.parseStoryGraphJournalDate('2 January 2025 Edit'), '2025-01-02');
    assert.equal(sg.parseStoryGraphJournalDate('20 October 2026'), '2026-10-20');
    assert.equal(sg.parseStoryGraphJournalDate('November 21, 2026'), '2026-11-21');
    assert.equal(sg.parseStoryGraphJournalDate('No date here'), null);

    const parsedJournal = sg.parseStoryGraphJournalPage(
      '<html><body><span class="journal-entry-panes">' +
        '<div class="mb-3"><div class="col-span-4"><div class="mb-4"><p class="font-semibold">19 October 2026 <a href="/journal_entries/j1/edit">Edit</a></p></div><div class="mt-2"><span>Started reading</span></div></div></div>' +
        '<div class="mb-3"><div class="col-span-4"><div class="mb-4"><p class="font-semibold">20 October 2026 <a href="/journal_entries/j2/edit">Edit</a></p></div><div class="mt-2"><div class="inline">20%</div><p>(93 pages out of 464)</p></div></div></div>' +
        '</span></body></html>'
    );
    assert.equal(parsedJournal.entries.length, 2);
    assert.equal(parsedJournal.entries[0].date, '2026-10-19');
    assert.equal(parsedJournal.entries[0].isStatus, true);
    assert.equal(parsedJournal.entries[1].date, '2026-10-20');
    assert.equal(parsedJournal.entries[1].isStatus, false);
    assert.equal(parsedJournal.entries[1].percent, 20);
    assert.equal(parsedJournal.entries[1].pages, 93);

    assert.equal(sg.isJournalDayAlreadyOnStoryGraph(parsedJournal.entries, '2026-10-19', 10, false), false);
    assert.equal(sg.isJournalDayAlreadyOnStoryGraph(parsedJournal.entries, '2026-10-20', 20, false), true);
    assert.equal(sg.isJournalDayAlreadyOnStoryGraph(parsedJournal.entries, '2026-10-20', 25, false), false);
    assert.equal(sg.isJournalDayAlreadyOnStoryGraph(parsedJournal.entries, '2026-10-20', 93, true), true);

    const datedBody = new URLSearchParams(sg.buildDatedProgressFormBody({
      bookId: 'book-1',
      csrf: 'tok-j',
      date: '2026-10-22',
      progressValue: 255,
      progressType: 'pages',
      bookNumOfPages: 464,
      lastReachedPages: 93,
      lastReachedPercent: 20,
      note: '45m read on CrossPoint',
      returnTo: 'https://app.thestorygraph.com/books/book-1'
    }));
    assert.equal(datedBody.get('progress_update_date[day]'), '22');
    assert.equal(datedBody.get('progress_update_date[month]'), '10');
    assert.equal(datedBody.get('progress_update_date[year]'), '2026');
    assert.equal(datedBody.get('progress_number'), '255');
    assert.equal(datedBody.get('progress_type'), 'pages');
    assert.equal(datedBody.get('note'), '45m read on CrossPoint');

    const day1Noon = Math.floor(Date.UTC(2026, 9, 20, 12, 0, 0) / 1000);
    const day2Noon = Math.floor(Date.UTC(2026, 9, 22, 12, 0, 0) / 1000);
    const histSampleJsonl = [
      JSON.stringify({ e: 'reader.session', id: 'h1', ts: day1Noon, vars: { book: '/b.epub', start_progress_bp: '1000', end_progress_bp: '2000', progress_scale: '10000', duration_seconds: '600' } }),
      JSON.stringify({ e: 'reader.session', id: 'h2', ts: day1Noon + 60, vars: { book: '/b.epub', start_progress_bp: '2000', end_progress_bp: '3500', progress_scale: '10000', duration_seconds: '900' } }),
      JSON.stringify({ e: 'reader.exit', id: 'h3', ts: day2Noon, vars: { book: '/b.epub', percent: '55', duration_seconds: '120' } })
    ].join('\n');
    const hist1 = sg.mergeEventsIntoHistory({ version: 1, books: {} }, histSampleJsonl);
    assert.equal(hist1.changed, true);
    const bDays = sg.getBookHistoryDays(hist1.history, { sdPath: '/b.epub' });
    assert.equal(bDays.length, 2);
    assert.equal(bDays[0].date, '2026-10-20');
    assert.equal(bDays[0].startPercent, 10);
    assert.equal(bDays[0].endPercent, 35);
    assert.equal(bDays[0].durationSeconds, 1500);
    assert.equal(bDays[0].sessions, 2);
    assert.equal(bDays[1].date, '2026-10-22');
    assert.equal(bDays[1].endPercent, 55);

    const hist2 = sg.mergeEventsIntoHistory(hist1.history, histSampleJsonl);
    assert.equal(hist2.changed, false, 'Re-merging same event IDs must be strictly idempotent');
    const compactedLine = sg.compactEventsJsonl(histSampleJsonl);
    const hist3 = sg.mergeEventsIntoHistory(hist2.history, compactedLine);
    assert.equal(
      sg.getBookHistoryDays(hist3.history, { sdPath: '/b.epub' })[0].durationSeconds,
      1500,
      'Compacted line must preserve multi-day history and never overwrite higher duration'
    );

    const readZeroPath = '/Read/Sample Series Vol. 9 - Author Gamma.epub';
    const staleSeedHist = {
      version: 1,
      books: {
        [readZeroPath]: {
          days: {
            '2026-11-21': {
              date: '2026-11-21',
              startPercent: null,
              endPercent: 0,
              durationSeconds: 0,
              sessions: 0,
              syncedToJournal: false,
              seenIds: ['7757f0e3-1']
            }
          }
        }
      }
    };
    assert.equal(sg.getBookHistoryDays(staleSeedHist, { sdPath: readZeroPath }).length, 0, 'Empty 0%/0s history days must be excluded from UI list');
    const cleanedHist = sg.mergeEventsIntoHistory(
      staleSeedHist,
      JSON.stringify({ e: 'reader.exit', id: '7757f0e3-2', ts: Math.floor(Date.UTC(2026, 10, 21, 12, 0, 0) / 1000), vars: { book: readZeroPath, percent: '0' } })
    );
    assert.equal(cleanedHist.changed, true, 'Stale 0%/0s history placeholder must be pruned');
    assert.equal(sg.getBookHistoryDays(cleanedHist.history, { sdPath: readZeroPath }).length, 0);
    assert.equal(cleanedHist.history.books[readZeroPath], undefined);

    const movedHist = sg.mergeEventsIntoHistory(
      { version: 1, books: {} },
      JSON.stringify({ e: 'reader.session', id: 'mv-1', ts: day1Noon, vars: { book: '/Books/Sub/MovedBook - Author.epub', percent: '45', duration_seconds: '600' } })
    ).history;
    const movedDays = sg.getBookHistoryDays(movedHist, { sdPath: '/Read/MovedBook - Author.epub' });
    assert.equal(movedDays.length, 1, 'getBookHistoryDays must find history after moving EPUB into /Read/');
    assert.equal(movedDays[0].endPercent, 45);

    const bfDisplayMulti = sg.getBookDisplayHistoryDays(
      { version: 1, books: {} },
      {
        sdPath: '/Read/Sample Series Vol. 9.epub',
        startDate: '2026-11-19',
        lastDate: '2026-11-21',
        devicePercent: 100,
        durationSeconds: 17820,
        pagesTurned: 1141,
        sessions: 11,
        mapping: { status: 'read', lastSyncedStartDate: '2026-11-19' }
      }
    );
    assert.equal(bfDisplayMulti.length, 2, 'Backfilled multi-day finished book must show start + summary entries');
    assert.equal(bfDisplayMulti[0].date, '2026-11-19');
    assert.equal(bfDisplayMulti[0].isStartMilestone, true);
    assert.equal(bfDisplayMulti[1].date, '2026-11-21');
    assert.equal(bfDisplayMulti[1].endPercent, 100);
    assert.equal(bfDisplayMulti[1].durationSeconds, 17820);
    assert.equal(bfDisplayMulti[1].pagesTurned, 1141);
    assert.equal(bfDisplayMulti[1].sessions, 11);

    const bfDisplaySingle = sg.getBookDisplayHistoryDays(
      { version: 1, books: {} },
      {
        sdPath: '/Read/SameDay.epub',
        startDate: '2026-11-15',
        lastDate: '2026-11-15',
        devicePercent: 100,
        durationSeconds: 3600,
        pagesTurned: 200,
        sessions: 2,
        mapping: { status: 'read' }
      }
    );
    assert.equal(bfDisplaySingle.length, 1, 'Same-day finished book must show 1 summary entry');
    assert.equal(bfDisplaySingle[0].date, '2026-11-15');

    const cpImport = sg.importSessionHistoryPayload(
      { version: 1, books: {} },
      {
        sessions: [
          {
            id: 'cp-1',
            document: 'hash123',
            end_time: Math.floor(Date.UTC(2026, 9, 15, 12, 0, 0) / 1000),
            start_progress_bp: 0,
            end_progress_bp: 4200,
            progress_scale: 10000,
            duration_seconds: 1800
          }
        ]
      },
      [{ sdPath: '/Books/Imported.epub', documentHash: 'hash123', title: 'Imported' }]
    );
    assert.equal(cpImport.importedSessions, 1);
    assert.equal(cpImport.importedBooks, 1);
    assert.equal(sg.getBookHistoryDays(cpImport.history, { sdPath: '/Books/Imported.epub' })[0].endPercent, 42);

    // 7c. parseSessionHistoryText & flexible CrossPoint Sync / JSONL / fenced formats
    const lineA = JSON.stringify({ e: 'reader.session', id: 'p-1', ts: day1Noon, vars: { book: '/Books/Imported.epub', percent: '25', duration_seconds: '300' } });
    const lineB = JSON.stringify({ e: 'reader.exit', id: 'p-2', ts: day2Noon, vars: { book: '/Books/Imported.epub', percent: '60', duration_seconds: '420' } });
    const parsedJsonl = sg.parseSessionHistoryText(lineA + '\n' + lineB);
    assert.equal(Array.isArray(parsedJsonl) && parsedJsonl.length, 2, 'Multi-line JSONL should parse into array');
    const parsedSingleLineConcat = sg.parseSessionHistoryText(lineA + ' ' + lineB);
    assert.equal(Array.isArray(parsedSingleLineConcat) && parsedSingleLineConcat.length, 2, 'Space-concatenated objects (single-line paste) must parse');
    const parsedFenced = sg.parseSessionHistoryText('\uFEFF```json\n' + JSON.stringify({ sessions: [{ book: '/Books/Imported.epub', date: '2026-10-19', percent: 33 }] }) + '\n```');
    assert.equal(parsedFenced.sessions.length, 1);
    assert.throws(() => sg.parseSessionHistoryText('not json at all'), /Invalid session history JSON/);
    assert.throws(() => sg.parseSessionHistoryText('{"a": 1'), /incomplete\/truncated/);

    const rawEventsImp = sg.importSessionHistoryPayload(
      { version: 1, books: {} },
      parsedSingleLineConcat,
      [{ sdPath: '/Books/Imported.epub', title: 'Imported' }]
    );
    assert.equal(rawEventsImp.importedSessions, 2);
    assert.equal(sg.getBookHistoryDays(rawEventsImp.history, { sdPath: '/Books/Imported.epub' })[0].endPercent, 25);
    assert.equal(sg.getBookHistoryDays(rawEventsImp.history, { sdPath: '/Books/Imported.epub' })[1].endPercent, 60);

    const nestedBooksImp = sg.importSessionHistoryPayload(
      { version: 1, books: {} },
      {
        books: [
          {
            title: 'Imported',
            sessions: [
              { ended_at: '2026-10-19T12:00:00Z', progress: 35, duration: 600 },
              { timestamp: Math.floor(Date.UTC(2026, 9, 20, 12, 0, 0)), progressPercent: 70, seconds: 900 }
            ]
          }
        ]
      },
      [{ sdPath: '/Books/Imported.epub', title: 'Imported' }]
    );
    assert.equal(nestedBooksImp.importedSessions, 2);
    assert.equal(sg.getBookHistoryDays(nestedBooksImp.history, { sdPath: '/Books/Imported.epub' })[0].endPercent, 35);
    assert.equal(sg.getBookHistoryDays(nestedBooksImp.history, { sdPath: '/Books/Imported.epub' })[1].endPercent, 70);

    const rsFileImp = sg.importSessionHistoryPayload(
      { version: 1, books: {} },
      {
        reading_sessions: [
          { path: '/OtherFolder/Imported.epub', endedAt: '2026-10-21', end_pct: 88, duration_sec: 500 }
        ]
      },
      [{ sdPath: '/Books/Imported.epub', title: 'Imported' }]
    );
    assert.equal(rsFileImp.importedSessions, 1);
    assert.equal(sg.getBookHistoryDays(rsFileImp.history, { sdPath: '/Books/Imported.epub' })[0].endPercent, 88);

    // 8. UI regression test: Browser cookie flow, cookie badge, and Cloudflare/empty-cookie errors
    class MockUiElement {
      constructor(tagName = 'div', attrs = {}, parent = null) {
        this.tagName = tagName.toLowerCase();
        this.attrs = { ...attrs };
        this.parentElement = parent;
        this.children = [];
        this._text = '';
        this._listeners = Object.create(null);
        this.style = {};
        this.value = attrs.value != null ? String(attrs.value) : '';
        this.checked = Object.prototype.hasOwnProperty.call(attrs, 'checked');
        this.disabled = Object.prototype.hasOwnProperty.call(attrs, 'disabled');
        this.open = Object.prototype.hasOwnProperty.call(attrs, 'open');
        this.dataset = {};
        for (const [k, v] of Object.entries(this.attrs)) {
          if (k.startsWith('data-')) {
            const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            this.dataset[camel] = v;
          }
        }
        const self = this;
        this.classList = {
          contains(cls) {
            return String(self.attrs.class || '').split(/\s+/).filter(Boolean).includes(cls);
          },
          add(...classes) {
            const set = new Set(String(self.attrs.class || '').split(/\s+/).filter(Boolean));
            for (const c of classes) if (c) set.add(c);
            self.attrs.class = Array.from(set).join(' ');
          },
          remove(...classes) {
            const set = new Set(String(self.attrs.class || '').split(/\s+/).filter(Boolean));
            for (const c of classes) set.delete(c);
            self.attrs.class = Array.from(set).join(' ');
          },
          toggle(cls, force) {
            const has = this.contains(cls);
            const next = force !== undefined ? Boolean(force) : !has;
            if (next) this.add(cls);
            else this.remove(cls);
            return next;
          }
        };
      }
      get id() { return this.attrs.id || ''; }
      get className() { return this.attrs.class || ''; }
      set className(val) { this.attrs.class = String(val || ''); }
      get textContent() {
        if (this._parts && this._parts.length > 0) {
          return this._parts.map((p) => (typeof p === 'string' ? p : p.textContent)).join('');
        }
        if (this.children.length === 0) return this._text;
        return this.children.map((c) => c.textContent).join('');
      }
      set textContent(val) {
        this.children = [];
        this._parts = null;
        this._text = String(val == null ? '' : val);
      }
      set innerHTML(html) {
        const cleaned = String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '');
        const parsed = new MiniDOMParser().parseFromString(cleaned);
        const convert = (node, parent) => {
          const out = new MockUiElement(node.tagName, node.attrs, parent);
          const parts = [];
          for (const item of node._textParts || []) {
            if (typeof item === 'string') {
              parts.push(item);
            } else {
              const chEl = convert(item, out);
              out.children.push(chEl);
              parts.push(chEl);
            }
          }
          out._parts = parts;
          if (out.children.length === 0) {
            out._text = node.textContent;
          }
          return out;
        };
        this.children = parsed.children.map((ch) => convert(ch, this));
        this._parts = null;
        this._text = '';
      }
      get innerHTML() { return ''; }
      getAttribute(name) {
        const k = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
      }
      setAttribute(name, val) {
        this.attrs[String(name).toLowerCase()] = String(val);
      }
      matchesSimple(sel) {
        for (const part of String(sel).split(',')) {
          const s = part.trim();
          if (!s) continue;
          if (s.startsWith('#') && this.id === s.slice(1)) return true;
          if (s.startsWith('.') && this.classList.contains(s.slice(1))) return true;
          if (/^[a-z0-9_-]+$/i.test(s) && this.tagName === s.toLowerCase()) return true;
          if (MiniElement.prototype.matchesSimple.call(this, s)) return true;
        }
        return false;
      }
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          for (const ch of node.children) {
            if (ch.matchesSimple(sel)) out.push(ch);
            walk(ch);
          }
        };
        walk(this);
        return out;
      }
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      }
      closest(sel) {
        let cur = this;
        while (cur && cur.tagName !== '#root') {
          if (cur.matchesSimple(sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      }
      addEventListener(type, fn) {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
      }
      async trigger(type, extra = {}) {
        const handlers = this._listeners[type] || [];
        const ev = Object.assign({ target: this, currentTarget: this, preventDefault() {} }, extra);
        for (const fn of handlers) {
          await fn(ev);
        }
      }
      focus() {}
      select() {}
      setSelectionRange() {}
    }

    const store = new Map();
    const toasts = [];
    let sdApiCalls = 0;
    let tmpFetchReadCount = 0;
    let confirmCalls = 0;
    let confirmResult = true;
    let uiRegisteredPlugin = null;
    const nodeFetch = globalThis.fetch;
    const uiSandbox = {
      __SG_FETCH_RETRY_DELAYS_MS: [10, 20],
      __SG_CLEAN_PACING_MS: 10,
      DOMParser: MiniDOMParser,
      URLSearchParams,
      TextEncoder,
      FormData,
      Blob,
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      navigator: { userAgent: 'MockTestUA/1.0' },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); }
      },
      window: { confirm: () => true },
      document: { createElement: (tag) => new MockUiElement(tag) },
      showWebConfirm: async () => {
        confirmCalls += 1;
        return confirmResult;
      },
      showWebToast: (msg, isErr) => { toasts.push({ msg, isErr }); },
      fetch: (url, opts) => {
        const s = String(url);
        if (s.includes('/api/files')) sdApiCalls += 1;
        if (s.includes('tmp-fetch.html')) tmpFetchReadCount += 1;
        return nodeFetch(s.startsWith('http') ? s : base + s, opts);
      },
      CrossPoint: {
        registerPlugin(fn) {
          uiRegisteredPlugin = fn;
        }
      }
    };
    uiSandbox.globalThis = uiSandbox;
    vm.runInNewContext(code, uiSandbox, { filename: 'plugin.js' });
    assert.equal(typeof uiRegisteredPlugin, 'function', 'UI test must register plugin');

    let forceCloudflare = false;
    let force502AfterApply = false;
    let force502BeforeApply = false;
    let fetchToSdInterceptor = null;
    const fetchToSdCalls = [];
    const mockContainer = new MockUiElement('div', { id: 'plugin-storygraph-sync' });
    const mockApi = {
      name: 'storygraph-sync',
      dir: '/.crosspoint/plugins/storygraph-sync',
      pluginFile: (f) => `/plugin?name=storygraph-sync&file=${encodeURIComponent(f)}`,
      async relay(method, url, headers = {}, body = '') {
        let hdrs = headers;
        if (forceCloudflare) hdrs = Object.assign({}, hdrs, { 'X-Mock-Cloudflare': '1' });
        if (force502AfterApply) hdrs = Object.assign({}, hdrs, { 'X-Mock-Force-502-After-Apply': '1' });
        if (force502BeforeApply) hdrs = Object.assign({}, hdrs, { 'X-Mock-Relay-Fail-Before-Apply': '1' });
        const r = await nodeFetch(`${base}/api/relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plugin: 'storygraph-sync', method, url, headers: hdrs, body })
        });
        if (!r.ok) {
          let detail = '';
          try { detail = (await r.json()).error || ''; } catch (_) {}
          const err = new Error('/api/relay ' + r.status + (detail ? ': ' + detail : ''));
          err.status = r.status;
          throw err;
        }
        return {
          status: Number(r.headers.get('X-Relay-Status')),
          headers: JSON.parse(r.headers.get('X-Relay-Headers') || '[]'),
          body: await r.text()
        };
      },
      async fetchToSd(url, dest, headers = {}) {
        fetchToSdCalls.push({ url, dest });
        if (typeof fetchToSdInterceptor === 'function') {
          const custom = await fetchToSdInterceptor(url, dest, headers);
          if (custom !== undefined) return custom;
        }
        const hdrs = forceCloudflare ? { ...headers, 'X-Mock-Cloudflare': '1' } : headers;
        const r = await nodeFetch(`${base}/api/fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plugin: 'storygraph-sync', url, dest, headers: hdrs, offset: 0, maxBytes: 2 * 1024 * 1024 })
        });
        return r.json();
      },
      async writeFile(pPath, dataB64) {
        const bytes = Buffer.from(dataB64 || '', 'base64');
        const form = new FormData();
        form.append('file', new Blob([bytes]), 'data');
        const r = await nodeFetch(
          `${base}/api/plugin-fs?plugin=storygraph-sync&path=${encodeURIComponent(pPath)}`,
          { method: 'POST', body: form }
        );
        return r.json();
      },
      async crypto() { return {}; },
      registerAction() {}
    };

    await uiRegisteredPlugin(mockContainer, mockApi);

    const bannerEl = mockContainer.querySelector('#sg-banner');
    const verifyBtn = mockContainer.querySelector('#sg-verify');
    const cookieBadge = mockContainer.querySelector('#sg-cookie-badge');
    const cookieInput = mockContainer.querySelector('#sg-cookie-input');
    assert.ok(bannerEl && verifyBtn && cookieBadge && cookieInput, 'UI elements must render');
    assert.equal(mockContainer.querySelector('#sg-sign-in'), null, '#sg-sign-in must be removed');
    assert.equal(mockContainer.querySelector('#sg-login-email'), null, '#sg-login-email must be removed');
    assert.equal(mockContainer.querySelector('#sg-login-password'), null, '#sg-login-password must be removed');
    assert.equal(cookieBadge.textContent, '_storygraph_session: missing');
    assert.ok(!cookieBadge.textContent.includes('remember_user_token'));

    // Verify with empty cookies must show error in #sg-banner and unlock buttons
    await verifyBtn.trigger('click');
    assert.ok(bannerEl.className.includes('sg-err'), `Expected error banner, got class="${bannerEl.className}"`);
    assert.ok(
      bannerEl.textContent.includes('Account Settings'),
      `Expected Account Settings prompt in banner, got "${bannerEl.textContent}"`
    );
    assert.ok(toasts.some((t) => t.isErr && t.msg.includes('Account Settings')), 'Expected error toast for empty cookies');
    assert.equal(verifyBtn.disabled, false);

    // Pasting cookies updates badge without mentioning remember_user_token when absent
    cookieInput.value = '_storygraph_session=sess1; cf_clearance=cf1';
    await cookieInput.trigger('input');
    assert.equal(cookieBadge.textContent, '_storygraph_session: set · +1 extra');
    assert.ok(!cookieBadge.textContent.includes('remember_user_token'));

    // Verify hitting Cloudflare 403 must show error in #sg-banner and unlock verifyBtn
    forceCloudflare = true;
    await verifyBtn.trigger('click');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (verifyBtn.disabled || bannerEl.className.includes('sg-muted'))) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(bannerEl.className.includes('sg-err'), `Expected error banner on CF 403, got class="${bannerEl.className}"`);
    assert.ok(
      bannerEl.textContent.includes('403') && bannerEl.textContent.includes('Cloudflare'),
      `Expected 403/Cloudflare error in banner, got "${bannerEl.textContent}"`
    );
    assert.equal(verifyBtn.disabled, false);
    assert.ok(
      toasts.some((t) => t.isErr && t.msg.includes('403') && t.msg.includes('Cloudflare')),
      'Expected error toast for Cloudflare 403'
    );

    // Browse SD Library: on-demand only (0 eager scans on load), filters hidden/non-books, stages & links
    assert.equal(sdApiCalls, 0, 'Must NOT call /api/files automatically on plugin load');
    const sdDetails = mockContainer.querySelector('#sg-sd-details');
    const sdBrowserEl = mockContainer.querySelector('#sg-sd-browser');
    const booksListEl = mockContainer.querySelector('#sg-books-list');
    assert.ok(sdDetails && sdBrowserEl && booksListEl, 'SD Library elements must render');
    assert.equal(sdDetails.open, false, '#sg-sd-details must start collapsed');

    sdDetails.open = true;
    await sdDetails.trigger('toggle');
    const waitFor = async (pred, msg) => {
      const end = Date.now() + 2000;
      while (Date.now() < end) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(msg);
    };
    await waitFor(
      () => sdBrowserEl.querySelectorAll('button').some((b) => b.getAttribute('data-sd-act') === 'open-dir' && b.getAttribute('data-path') === '/Read'),
      'Expected root SD folders to load on toggle'
    );
    assert.equal(sdApiCalls, 1);
    assert.ok(sdBrowserEl.textContent.includes('Books'));
    assert.ok(sdBrowserEl.textContent.includes('Read'));
    assert.ok(!sdBrowserEl.textContent.includes('My Clippings.txt'));
    assert.ok(!sdBrowserEl.textContent.includes('sleep.bmp'));
    assert.ok(!sdBrowserEl.textContent.includes('.crosspoint'));

    const readDirBtn = sdBrowserEl.querySelectorAll('button').find(
      (b) => b.getAttribute('data-sd-act') === 'open-dir' && b.getAttribute('data-path') === '/Read'
    );
    await sdBrowserEl.trigger('click', { target: readDirBtn });
    await waitFor(
      () => sdBrowserEl.querySelectorAll('button').some((b) => b.getAttribute('data-sd-act') === 'add-book' && b.getAttribute('data-path') === '/Read/Project Hail Mary - Andy Weir.epub'),
      'Expected /Read folder book entry to load'
    );
    assert.ok(sdBrowserEl.textContent.includes('Project Hail Mary'));

    const addPhmBtn = sdBrowserEl.querySelectorAll('button').find(
      (b) => b.getAttribute('data-sd-act') === 'add-book' && b.getAttribute('data-path') === '/Read/Project Hail Mary - Andy Weir.epub'
    );
    await sdBrowserEl.trigger('click', { target: addPhmBtn });
    assert.ok(booksListEl.textContent.includes('Project Hail Mary'));
    const directIdInput = booksListEl.querySelectorAll('input').find(
      (el) => el.getAttribute('data-role') === 'direct-id' && el.getAttribute('data-key') === '/Read/Project Hail Mary - Andy Weir.epub'
    );
    const removePhmBtn = booksListEl.querySelectorAll('button').find(
      (el) => el.getAttribute('data-act') === 'remove-staged' && el.getAttribute('data-key') === '/Read/Project Hail Mary - Andy Weir.epub'
    );
    const linkDirectBtn = booksListEl.querySelectorAll('button').find(
      (el) => el.getAttribute('data-act') === 'link-direct' && el.getAttribute('data-key') === '/Read/Project Hail Mary - Andy Weir.epub'
    );
    assert.ok(directIdInput && removePhmBtn && linkDirectBtn, 'Expected inline linker + Remove button for staged book');

    directIdInput.value = 'book-phm-1';
    await booksListEl.trigger('click', { target: linkDirectBtn });
    await waitFor(
      () => bannerEl.textContent.includes('Linked') && !sdBrowserEl.querySelectorAll('button').some((b) => b.getAttribute('data-sd-act') === 'add-book' && b.getAttribute('data-path') === '/Read/Project Hail Mary - Andy Weir.epub'),
      'Expected staged book to link and update SD Library badge'
    );
    assert.ok(sdBrowserEl.textContent.includes('Linked'));
    const savedMap = JSON.parse(virtualFiles.get('storygraph-map.json').toString('utf8'));
    assert.equal(savedMap.books['/Read/Project Hail Mary - Andy Weir.epub']?.bookId, 'book-phm-1');

    const upBtn = sdBrowserEl.querySelectorAll('button').find(
      (b) => b.getAttribute('data-sd-act') === 'open-dir' && b.textContent === 'Up'
    );
    await sdBrowserEl.trigger('click', { target: upBtn });
    await waitFor(
      () => sdBrowserEl.querySelectorAll('button').some((b) => b.getAttribute('data-sd-act') === 'open-dir' && b.getAttribute('data-path') === '/Books'),
      'Expected Up navigation back to /'
    );
    const booksDirBtn = sdBrowserEl.querySelectorAll('button').find(
      (b) => b.getAttribute('data-sd-act') === 'open-dir' && b.getAttribute('data-path') === '/Books'
    );
    await sdBrowserEl.trigger('click', { target: booksDirBtn });
    await waitFor(
      () => sdBrowserEl.querySelectorAll('button').some((b) => b.getAttribute('data-sd-act') === 'add-book' && b.getAttribute('data-path') === '/Books/Dune - Frank Herbert.epub'),
      'Expected /Books/Dune entry to load'
    );
    const addDuneBtn = sdBrowserEl.querySelectorAll('button').find(
      (b) => b.getAttribute('data-sd-act') === 'add-book' && b.getAttribute('data-path') === '/Books/Dune - Frank Herbert.epub'
    );
    await sdBrowserEl.trigger('click', { target: addDuneBtn });
    assert.ok(booksListEl.textContent.includes('Dune'));
    const removeDuneBtn = booksListEl.querySelectorAll('button').find(
      (el) => el.getAttribute('data-act') === 'remove-staged' && el.getAttribute('data-key') === '/Books/Dune - Frank Herbert.epub'
    );
    assert.ok(removeDuneBtn, 'Expected Remove button for staged Dune row');
    await booksListEl.trigger('click', { target: removeDuneBtn });
    assert.ok(!booksListEl.textContent.includes('Dune'), 'Expected staged Dune row to be removed cleanly');

    // 9. Sync All progress bar & single per-batch confirmation (plus Overwrite lower/0% toggle)
    forceCloudflare = false;
    const syncAllBtn = mockContainer.querySelector('#sg-sync-all');
    const refreshBtn = mockContainer.querySelector('#sg-refresh');
    const overwriteCheck = mockContainer.querySelector('#sg-overwrite-lower');
    const syncProgEl = mockContainer.querySelector('#sg-sync-progress');
    const syncFillEl = mockContainer.querySelector('#sg-sync-fill');
    const syncTextEl = mockContainer.querySelector('#sg-sync-text');
    const wrapEl = mockContainer.querySelector('.sg-wrap');
    assert.ok(
      syncAllBtn && refreshBtn && overwriteCheck && syncProgEl && syncFillEl && syncTextEl && wrapEl,
      'Sync progress bar and overwrite toggle must render'
    );

    const seedBothLower = async (lawsSynced = 95, stoicSynced = 95) => {
      const mapPayload = {
        version: 1,
        books: {
          '/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub': {
            bookId: 'book-daily-laws',
            title: 'Sample Non-Fiction A',
            author: 'Author Alpha',
            sdPath: '/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub',
            trackingMode: 'percentage',
            pageCount: 464,
            status: 'currently-reading',
            lastSyncedPercent: lawsSynced,
            lastSyncedAt: '2026-01-01T00:00:00.000Z'
          },
          '/Books/Non-Fiction/Author Beta/Sample Non-Fiction B - Author Beta.epub': {
            bookId: 'book-daily-stoic',
            title: 'Sample Non-Fiction B',
            author: 'Author Beta',
            sdPath: '/Books/Non-Fiction/Author Beta/Sample Non-Fiction B - Author Beta.epub',
            trackingMode: 'pages',
            pageCount: 416,
            status: 'currently-reading',
            lastSyncedPercent: stoicSynced,
            lastSyncedAt: '2026-01-01T00:00:00.000Z'
          }
        }
      };
      await mockApi.writeFile(
        '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
        Buffer.from(JSON.stringify(mapPayload), 'utf8').toString('base64')
      );
      await refreshBtn.trigger('click');
    };

    const waitForLong = async (pred, msg) => {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(msg);
    };

    // Case 1: Lower progress on 2 books asks AT MOST ONCE; Cancel skips all lower/0% books
    await seedBothLower(95, 95);
    assert.equal(syncAllBtn.disabled, false);
    confirmCalls = 0;
    confirmResult = false;
    await syncAllBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.textContent.includes('2 skipped'),
      'Expected Sync All cancel-batch to finish'
    );
    assert.equal(confirmCalls, 1, 'Expected at most 1 confirmation across 2 lower-progress books (Cancel)');
    assert.equal(syncProgEl.classList.contains('show'), true);
    assert.equal(syncFillEl.style.width, '100%');
    assert.ok(syncTextEl.textContent.includes('100%'));

    // Case 2: OK asks AT MOST ONCE across 2 lower-progress books and syncs both
    confirmCalls = 0;
    confirmResult = true;
    await syncAllBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-ok'),
      'Expected Sync All overwrite-batch to finish'
    );
    assert.equal(confirmCalls, 1, 'Expected at most 1 confirmation across 2 lower-progress books (OK)');
    assert.equal(syncProgEl.classList.contains('show'), true);
    assert.equal(syncFillEl.style.width, '100%');
    assert.ok(bannerEl.textContent.includes('2 synced'), `Expected 2 synced, got "${bannerEl.textContent}"`);

    // Case 3: Refresh hides completed progress bar; checked Overwrite toggle gives 0 prompts
    sgState.books['book-daily-laws'].lastReachedPercent = 50;
    sgState.books['book-daily-laws'].lastReachedPages = 232;
    sgState.books['book-daily-stoic'].lastReachedPercent = 40;
    sgState.books['book-daily-stoic'].lastReachedPages = 166;
    await seedBothLower(95, 95);
    assert.equal(syncProgEl.classList.contains('show'), false, 'Expected Refresh to hide completed progress bar');
    overwriteCheck.checked = true;
    await overwriteCheck.trigger('change');
    assert.equal(store.get('sgSync.overwriteLower'), '1');
    confirmCalls = 0;
    await syncAllBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-ok'),
      'Expected Sync All with overwrite toggle to finish'
    );
    assert.equal(confirmCalls, 0, 'Expected 0 prompts when Overwrite lower/0% without asking is checked');
    assert.equal(syncFillEl.style.width, '100%');

    // Case 4: Gzipped 45 KB StoryGraph POSTs: to-read -> currently-reading -> progress, and 100% to-read -> direct read in 1 POST
    sgState.books['book-mt-9'].statusLabel = 'to-read';
    sgState.books['book-mt-9'].lastReachedPercent = 0;
    sgState.books['book-mt-9'].lastReachedPages = 0;
    sgState.books['book-done-100'].statusLabel = 'to-read';
    sgState.books['book-done-100'].lastReachedPercent = 0;
    sgState.books['book-done-100'].lastReachedPages = 0;
    sgState.posts.length = 0;

    const mtPath = '/Books/Light Novels/Sample Series/Sample Series Vol. 9 - Author Gamma.epub';
    const donePath = '/Read/Finished Book Example.epub';
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from(
        [
          JSON.stringify({ e: 'reader.exit', id: 'c4-1', ts: 1795220510, vars: { book: mtPath, percent: '81' } }),
          JSON.stringify({ e: 'reader.exit', id: 'c4-2', ts: 1795220520, vars: { book: donePath, percent: '100' } })
        ].join('\n') + '\n',
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [mtPath]: {
              bookId: 'book-mt-9',
              title: 'Sample Series Vol. 9',
              author: 'Author Gamma',
              sdPath: mtPath,
              trackingMode: 'percentage',
              pageCount: 320,
              status: 'to-read',
              lastSyncedPercent: null,
              lastSyncedAt: null
            },
            [donePath]: {
              bookId: 'book-done-100',
              title: 'Finished Book Example',
              author: 'Author',
              sdPath: donePath,
              trackingMode: 'percentage',
              pageCount: 280,
              status: 'to-read',
              lastSyncedPercent: null,
              lastSyncedAt: null
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    assert.equal(syncAllBtn.textContent, 'Sync All (2)');
    await syncAllBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-ok'),
      'Expected Case 4 Sync All (to-read + 100% direct read) to finish'
    );
    assert.ok(bannerEl.textContent.includes('2 synced'), `Expected 2 synced, got "${bannerEl.textContent}"`);
    const mtPosts = sgState.posts.filter((p) => p.bid === 'book-mt-9');
    assert.equal(mtPosts.length, 2, 'Expected 2 POSTs for to-read mid-book (currently-reading + update-progress)');
    assert.equal(mtPosts[0].path, '/update-status.js');
    assert.equal(mtPosts[0].st, 'currently-reading');
    assert.ok(mtPosts[0].acceptEncoding.includes('gzip'));
    assert.equal(mtPosts[1].path, '/update-progress');
    assert.equal(mtPosts[1].val, 81);
    assert.ok(mtPosts[1].acceptEncoding.includes('gzip'));
    const donePosts = sgState.posts.filter((p) => p.bid === 'book-done-100');
    assert.equal(donePosts.length, 2, 'Expected direct status=read POST + read_instance date PATCH for 100% book');
    assert.equal(donePosts[0].path, '/update-status.js');
    assert.equal(donePosts[0].st, 'read');
    assert.ok(donePosts[0].acceptEncoding.includes('gzip'));
    assert.equal(donePosts[1].path, '/read_instances/900001');
    assert.equal(donePosts[1].method, 'patch');
    assert.ok(donePosts[1].acceptEncoding.includes('gzip'));
    assert.equal(sgState.books['book-mt-9'].lastReachedPercent, 81);
    assert.equal(sgState.books['book-done-100'].statusLabel, 'read');

    // Case 4b: Finishing an already currently-reading book at 100% must call status=read directly (0 /update-progress calls)
    sgState.posts.length = 0;
    const mtReadPath = '/Read/Sample Series Vol. 9 - Author Gamma.epub';
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from(
        JSON.stringify({ e: 'reader.exit', id: 'c4b-1', ts: 1795268657, vars: { book: mtReadPath, percent: '0' } }) + '\n',
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [mtReadPath]: {
              bookId: 'book-mt-9',
              title: 'Sample Series Vol. 9',
              author: 'Author Gamma',
              sdPath: mtReadPath,
              trackingMode: 'percentage',
              pageCount: 320,
              status: 'currently-reading',
              lastSyncedPercent: 81,
              lastSyncedAt: '2026-11-21T00:00:00.000Z'
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    await syncAllBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-ok'),
      'Expected Case 4b finishing currently-reading book to complete'
    );
    const mtFinishPosts = sgState.posts.filter((p) => p.bid === 'book-mt-9');
    assert.equal(mtFinishPosts.filter((p) => p.path === '/update-progress').length, 0, 'Must NOT post /update-progress at 100% right before status=read');
    assert.equal(mtFinishPosts[0].path, '/update-status.js');
    assert.equal(mtFinishPosts[0].st, 'read');
    assert.equal(sgState.books['book-mt-9'].statusLabel, 'read');
    assert.equal(sgState.books['book-mt-9'].lastReachedPercent, 100);

    // Case 5: Post-502 /api/fetch confirmation fallback succeeds when StoryGraph applied the update
    const lawsPath = '/Books/Non-Fiction/Author Alpha/Sample Non-Fiction A - Author Alpha.epub';
    sgState.books['book-daily-laws'].statusLabel = 'currently reading';
    sgState.books['book-daily-laws'].lastReachedPercent = 50;
    sgState.books['book-daily-laws'].lastReachedPages = 232;
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from(
        JSON.stringify({ e: 'reader.exit', id: 'c5-1', ts: 1795220600, vars: { book: lawsPath, percent: '89' } }) + '\n',
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [lawsPath]: {
              bookId: 'book-daily-laws',
              title: 'Sample Non-Fiction A',
              author: 'Author Alpha',
              sdPath: lawsPath,
              trackingMode: 'percentage',
              pageCount: 464,
              status: 'currently-reading',
              lastSyncedPercent: 50,
              lastSyncedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    force502AfterApply = true;
    await syncAllBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-ok'),
      'Expected Case 5 post-502 confirmation fallback to succeed'
    );
    force502AfterApply = false;
    assert.ok(bannerEl.textContent.includes('1 synced'), `Expected 1 synced via 502 fallback, got "${bannerEl.textContent}"`);
    const mapAfterFallback = JSON.parse(virtualFiles.get('storygraph-map.json').toString('utf8'));
    assert.equal(mapAfterFallback.books[lawsPath].lastSyncedPercent, 89);

    // Case 6: Pre-apply 502 failure must NOT falsely mark synced and must show step label
    sgState.books['book-daily-laws'].statusLabel = 'currently reading';
    sgState.books['book-daily-laws'].lastReachedPercent = 50;
    sgState.books['book-daily-laws'].lastReachedPages = 232;
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [lawsPath]: {
              bookId: 'book-daily-laws',
              title: 'Sample Non-Fiction A',
              author: 'Author Alpha',
              sdPath: lawsPath,
              trackingMode: 'percentage',
              pageCount: 464,
              status: 'currently-reading',
              lastSyncedPercent: 50,
              lastSyncedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    force502BeforeApply = true;
    await syncAllBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-err'),
      'Expected Case 6 pre-apply 502 to report error'
    );
    force502BeforeApply = false;
    assert.ok(
      bannerEl.textContent.includes('0 synced') &&
        bannerEl.textContent.includes('1 failed') &&
        bannerEl.textContent.includes('Progress update failed'),
      `Expected Progress update failed error banner, got "${bannerEl.textContent}"`
    );
    assert.equal(sgState.books['book-daily-laws'].lastReachedPercent, 50);
    const mapAfterFailure = JSON.parse(virtualFiles.get('storygraph-map.json').toString('utf8'));
    assert.equal(mapAfterFailure.books[lawsPath].lastSyncedPercent, 50);

    // Case 7: Automatic date syncing during Sync All + header Sync Dates batch button & 502 date fallback
    const syncDatesBtn = mockContainer.querySelector('#sg-sync-dates');
    assert.ok(syncDatesBtn, '#sg-sync-dates button must render');

    // Case 7a: Unstarted 100% book with backfill startDate/lastDate automatically syncs status=read + /read_instances PATCH
    sgState.books['book-done-100'].statusLabel = 'to-read';
    sgState.books['book-done-100'].readInstanceId = null;
    sgState.books['book-done-100'].finishedLabel = null;
    sgState.books['book-done-100'].startDate = null;
    sgState.books['book-done-100'].finishDate = null;
    sgState.posts.length = 0;

    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from(
        JSON.stringify({ e: 'reader.exit', id: 'c7-1', ts: 1795220700, vars: { book: donePath, percent: '100' } }) + '\n',
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/backfill.json',
      Buffer.from(
        JSON.stringify({
          books: {
            [donePath]: {
              sdPath: donePath,
              title: 'Finished Book Example',
              author: 'Author',
              percent: 100,
              rawPercent: 100,
              finished: true,
              startDate: '2026-10-19',
              lastDate: '2026-10-21',
              lastReadTs: 1792584000
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [donePath]: {
              bookId: 'book-done-100',
              title: 'Finished Book Example',
              author: 'Author',
              sdPath: donePath,
              trackingMode: 'percentage',
              pageCount: 280,
              status: 'to-read',
              lastSyncedPercent: null,
              lastSyncedAt: null
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    await syncAllBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-ok'),
      'Expected Case 7a auto date sync on Sync All to finish'
    );
    const c7aPosts = sgState.posts.filter((p) => p.bid === 'book-done-100');
    assert.equal(c7aPosts.length, 2);
    assert.equal(c7aPosts[0].path, '/update-status.js');
    assert.equal(c7aPosts[0].st, 'read');
    assert.equal(c7aPosts[1].path, '/read_instances/900001');
    assert.equal(c7aPosts[1].startDate, '2026-10-19');
    assert.equal(c7aPosts[1].finishDate, '2026-10-21');
    assert.equal(sgState.books['book-done-100'].finishedLabel, 'Oct 21, 2026');
    const mapAfterC7a = JSON.parse(virtualFiles.get('storygraph-map.json').toString('utf8'));
    assert.equal(mapAfterC7a.books[donePath].lastSyncedStartDate, '2026-10-19');
    assert.equal(mapAfterC7a.books[donePath].lastSyncedFinishDate, '2026-10-21');

    // Case 7b: Sync Dates batch button updates Read & Currently Reading dates while preserving earlier Started date on Non-Fiction B
    const stoicPath = '/Books/Non-Fiction/Author Beta/Sample Non-Fiction B - Author Beta.epub';
    sgState.books['book-done-100'].statusLabel = 'read';
    sgState.books['book-done-100'].readInstanceId = '100000002';
    sgState.books['book-done-100'].finishedLabel = 'Nov 21, 2026';
    sgState.books['book-done-100'].startDate = null;
    sgState.books['book-done-100'].finishDate = null;
    sgState.books['book-daily-laws'].statusLabel = 'currently reading';
    sgState.books['book-daily-laws'].startJournalEntryId = 'je-laws-1';
    sgState.books['book-daily-laws'].startedLabel = 'Nov 21, 2026';
    sgState.books['book-daily-laws'].startDate = null;
    sgState.books['book-daily-stoic'].statusLabel = 'currently reading';
    sgState.books['book-daily-stoic'].startJournalEntryId = 'je-stoic-1';
    sgState.books['book-daily-stoic'].startedLabel = 'Oct 29, 2026';
    sgState.books['book-daily-stoic'].startDate = null;
    sgState.posts.length = 0;

    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from(
        [
          JSON.stringify({ e: 'reader.exit', id: 'c7b-1', ts: 1795220800, vars: { book: donePath, percent: '100' } }),
          JSON.stringify({ e: 'reader.exit', id: 'c7b-2', ts: 1795220801, vars: { book: lawsPath, percent: '89' } }),
          JSON.stringify({ e: 'reader.exit', id: 'c7b-3', ts: 1795220802, vars: { book: stoicPath, percent: '83' } })
        ].join('\n') + '\n',
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/backfill.json',
      Buffer.from(
        JSON.stringify({
          books: {
            [donePath]: {
              sdPath: donePath,
              title: 'Finished Book Example',
              author: 'Author',
              percent: 100,
              rawPercent: 100,
              finished: true,
              startDate: '2026-11-15',
              lastDate: '2026-11-16',
              lastReadTs: 1794830400
            },
            [lawsPath]: {
              sdPath: lawsPath,
              title: 'Sample Non-Fiction A',
              author: 'Author Alpha',
              percent: 89,
              finished: false,
              startDate: '2026-10-20',
              lastDate: '2026-11-21',
              lastReadTs: 1795220801
            },
            [stoicPath]: {
              sdPath: stoicPath,
              title: 'Sample Non-Fiction B',
              author: 'Author Beta',
              percent: 83,
              finished: false,
              startDate: '2026-10-31',
              lastDate: '2026-11-21',
              lastReadTs: 1795220802
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [donePath]: {
              bookId: 'book-done-100',
              title: 'Finished Book Example',
              author: 'Author',
              sdPath: donePath,
              status: 'read',
              lastSyncedPercent: 100,
              lastSyncedAt: '2026-11-21T00:00:00.000Z'
            },
            [lawsPath]: {
              bookId: 'book-daily-laws',
              title: 'Sample Non-Fiction A',
              author: 'Author Alpha',
              sdPath: lawsPath,
              status: 'currently-reading',
              lastSyncedPercent: 89,
              lastSyncedAt: '2026-11-21T00:00:00.000Z'
            },
            [stoicPath]: {
              bookId: 'book-daily-stoic',
              title: 'Sample Non-Fiction B',
              author: 'Author Beta',
              sdPath: stoicPath,
              status: 'currently-reading',
              lastSyncedPercent: 83,
              lastSyncedAt: '2026-11-21T00:00:00.000Z'
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    assert.equal(syncDatesBtn.disabled, false);
    assert.equal(syncDatesBtn.textContent, 'Sync Dates (3)');

    await syncDatesBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-ok'),
      'Expected Case 7b Sync Dates batch to finish'
    );
    assert.ok(
      bannerEl.textContent.includes('2 updated') && bannerEl.textContent.includes('1 already matched'),
      `Expected 2 updated & 1 matched, got "${bannerEl.textContent}"`
    );
    assert.equal(syncDatesBtn.disabled, true, '#sg-sync-dates must disable once all dates are synced');
    assert.equal(syncDatesBtn.textContent, 'Sync Dates');

    const doneDatePost = sgState.posts.find((p) => p.bid === 'book-done-100');
    assert.ok(doneDatePost);
    assert.equal(doneDatePost.path, '/read_instances/100000002');
    assert.equal(doneDatePost.startDate, '2026-11-15');
    assert.equal(doneDatePost.finishDate, '2026-11-16');

    const lawsDatePost = sgState.posts.find((p) => p.bid === 'book-daily-laws');
    assert.ok(lawsDatePost);
    assert.equal(lawsDatePost.path, '/update-journal-entry-from-book');
    assert.equal(lawsDatePost.journalEntryId, 'je-laws-1');
    assert.equal(lawsDatePost.startDate, '2026-10-20');

    assert.equal(
      sgState.posts.filter((p) => p.bid === 'book-daily-stoic').length,
      0,
      'Earlier StoryGraph start date (Oct 29) must NOT be overwritten by later device date (Oct 31)'
    );
    assert.equal(sgState.books['book-daily-stoic'].startedLabel, 'Oct 29, 2026');

    // Case 7c: Post-502 fallback verification on a date PATCH succeeds when StoryGraph applied the date
    sgState.books['book-done-100'].finishedLabel = 'Nov 21, 2026';
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [donePath]: {
              bookId: 'book-done-100',
              title: 'Finished Book Example',
              author: 'Author',
              sdPath: donePath,
              status: 'read',
              lastSyncedPercent: 100,
              lastSyncedAt: '2026-11-21T00:00:00.000Z'
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    force502AfterApply = true;
    await syncDatesBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-ok'),
      'Expected Case 7c date PATCH post-502 fallback to succeed'
    );
    force502AfterApply = false;
    assert.ok(bannerEl.textContent.includes('1 updated'), `Expected 1 updated via 502 fallback, got "${bannerEl.textContent}"`);
    const mapAfterC7c = JSON.parse(virtualFiles.get('storygraph-map.json').toString('utf8'));
    assert.equal(mapAfterC7c.books[donePath].lastSyncedFinishDate, '2026-11-16');

    // Case 8: UI overhaul — filter tabs, collapsible sections, search/sort, state-aware actions, links & short dates
    const headerStatsEl = mockContainer.querySelector('#sg-header-stats');
    const tabsEl = mockContainer.querySelector('#sg-filter-tabs');
    const searchInput = mockContainer.querySelector('#sg-book-search');
    const sortSelect = mockContainer.querySelector('#sg-book-sort');
    assert.ok(headerStatsEl && tabsEl && searchInput && sortSelect, 'Toolbar tabs, search and sort controls must render');

    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from(
        [
          JSON.stringify({ e: 'reader.exit', id: 'c8-1', ts: 1795220800, vars: { book: donePath, percent: '100' } }),
          JSON.stringify({ e: 'reader.exit', id: 'c8-2', ts: 1795220801, vars: { book: lawsPath, percent: '89' } }),
          JSON.stringify({ e: 'reader.exit', id: 'c8-3', ts: 1795220802, vars: { book: stoicPath, percent: '83' } }),
          JSON.stringify({ e: 'reader.exit', id: 'c8-4', ts: 1795220803, vars: { book: mtPath, percent: '81' } })
        ].join('\n') + '\n',
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/backfill.json',
      Buffer.from(
        JSON.stringify({
          books: {
            [donePath]: {
              sdPath: donePath,
              title: 'Finished Book Example',
              author: 'Author',
              percent: 100,
              rawPercent: 100,
              finished: true,
              startDate: '2026-11-15',
              lastDate: '2026-11-16',
              lastReadTs: 1794830400
            },
            [lawsPath]: {
              sdPath: lawsPath,
              title: 'Sample Non-Fiction A',
              author: 'Author Alpha',
              percent: 89,
              finished: false,
              startDate: '2026-10-20',
              lastDate: '2026-11-21',
              lastReadTs: 1795220801
            },
            [stoicPath]: {
              sdPath: stoicPath,
              title: 'Sample Non-Fiction B',
              author: 'Author Beta',
              percent: 83,
              finished: false,
              startDate: '2026-10-31',
              lastDate: '2026-11-21',
              lastReadTs: 1795220802
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [donePath]: {
              bookId: 'book-done-100',
              title: 'Finished Book Example',
              author: 'Author',
              sdPath: donePath,
              status: 'read',
              lastSyncedPercent: 100,
              lastSyncedStartDate: '2026-11-15',
              lastSyncedFinishDate: '2026-11-16',
              lastSyncedAt: '2026-11-21T00:00:00.000Z'
            },
            [lawsPath]: {
              bookId: 'book-daily-laws',
              title: 'Sample Non-Fiction A',
              author: 'Author Alpha',
              sdPath: lawsPath,
              status: 'currently-reading',
              lastSyncedPercent: 50,
              lastSyncedAt: '2026-11-21T00:00:00.000Z'
            },
            [stoicPath]: {
              bookId: 'book-daily-stoic',
              title: 'Sample Non-Fiction B',
              author: 'Author Beta',
              sdPath: stoicPath,
              status: 'currently-reading',
              lastSyncedPercent: 83,
              lastSyncedStartDate: '2026-10-31',
              lastSyncedAt: '2026-11-21T00:00:00.000Z'
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');

    assert.ok(headerStatsEl.textContent.includes('2 reading') && headerStatsEl.textContent.includes('1 read') && headerStatsEl.textContent.includes('1 unlinked'));
    const tabButtons = tabsEl.querySelectorAll('button');
    const getTab = (f) => tabButtons.find((b) => b.getAttribute('data-filter') === f);
    assert.equal(getTab('all').textContent, 'All (4)');
    assert.equal(getTab('reading').textContent, 'Reading (2)');
    assert.equal(getTab('needs-sync').textContent, 'Needs Sync (1)');
    assert.equal(getTab('read').textContent, 'Read (1)');
    assert.equal(getTab('unlinked').textContent, 'Unlinked (1)');

    // Collapsible sections on All view
    const readingSec = booksListEl.querySelector('details[data-section="reading"]');
    const unlinkedSec = booksListEl.querySelector('details[data-section="unlinked"]');
    const readSec = booksListEl.querySelector('details[data-section="read"]');
    assert.ok(readingSec && unlinkedSec && readSec, 'All view must group into collapsible Reading, Unlinked & Read sections');
    assert.equal(readingSec.open, true);
    assert.equal(unlinkedSec.open, true);
    assert.equal(readSec.open, false, 'Read section must collapse by default when active/unlinked books exist');

    // Persisting collapsed/expanded toggle across re-renders
    readSec.open = true;
    await readSec.trigger('toggle');
    await refreshBtn.trigger('click');
    assert.equal(booksListEl.querySelector('details[data-section="read"]').open, true, 'Read section toggle state should persist');

    // Shortened same-year dates + clickable StoryGraph links + state-aware actions + backfilled Reading History
    assert.ok(booksListEl.textContent.includes('October 20 → November 21, 2026'), 'Expected shortened same-year range on Sample Non-Fiction A');
    assert.ok(booksListEl.textContent.includes('November 15 → November 16, 2026'), 'Expected shortened same-year range on Finished Book Example');
    const doneHistDet = booksListEl.querySelectorAll('details').find((d) => d.getAttribute('data-history-key') === donePath);
    assert.ok(doneHistDet, 'Finished Book Example must render collapsible Reading history from backfill dates');
    assert.ok(
      doneHistDet.textContent.includes('Started reading') &&
        doneHistDet.textContent.includes('November 15, 2026') &&
        doneHistDet.textContent.includes('November 16, 2026'),
      `Expected backfill milestones in Reading history, got "${doneHistDet.textContent}"`
    );
    const sgLinks = booksListEl.querySelectorAll('a.sg-book-link');
    assert.ok(sgLinks.some((a) => a.getAttribute('href') === 'https://app.thestorygraph.com/books/book-daily-laws'));

    const lawsSyncBtn = booksListEl.querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'sync' && b.getAttribute('data-key') === lawsPath);
    assert.ok(lawsSyncBtn.className.includes('sg-btn-primary') && lawsSyncBtn.textContent === 'Sync Now');

    const stoicSyncBtn = booksListEl.querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'sync' && b.getAttribute('data-key') === stoicPath);
    assert.ok(!stoicSyncBtn.className.includes('sg-btn-primary') && stoicSyncBtn.textContent === 'Re-sync');

    const doneSyncBtn = booksListEl.querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'sync' && b.getAttribute('data-key') === donePath);
    const doneMarkReadBtn = booksListEl.querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'mark-read' && b.getAttribute('data-key') === donePath);
    assert.ok(doneSyncBtn && !doneSyncBtn.className.includes('sg-btn-primary') && doneSyncBtn.textContent === 'Re-sync');
    assert.equal(doneMarkReadBtn, undefined, 'Read book card must hide redundant Mark Read button');

    // Filter tabs switch cleanly between flat filtered views
    await tabsEl.trigger('click', { target: getTab('read') });
    assert.equal(booksListEl.querySelectorAll('details[data-section]').length, 0);
    assert.ok(booksListEl.textContent.includes('Finished Book Example') && !booksListEl.textContent.includes('Sample Non-Fiction A'));

    await tabsEl.trigger('click', { target: getTab('needs-sync') });
    assert.ok(booksListEl.textContent.includes('Sample Non-Fiction A') && !booksListEl.textContent.includes('Sample Non-Fiction B'));

    await tabsEl.trigger('click', { target: getTab('unlinked') });
    assert.ok(booksListEl.textContent.includes('Sample Series') && !booksListEl.textContent.includes('Sample Non-Fiction A'));

    // Search + sort
    await tabsEl.trigger('click', { target: getTab('all') });
    searchInput.value = 'Author Beta';
    await searchInput.trigger('input');
    assert.equal(booksListEl.querySelectorAll('details[data-section]').length, 0);
    assert.ok(booksListEl.textContent.includes('Sample Non-Fiction B') && !booksListEl.textContent.includes('Sample Non-Fiction A'));

    searchInput.value = '';
    await searchInput.trigger('input');
    sortSelect.value = 'title';
    await sortSelect.trigger('change');
    const readingTitles = booksListEl
      .querySelector('details[data-section="reading"]')
      .querySelectorAll('a.sg-book-link')
      .map((a) => a.textContent);
    assert.deepEqual(readingTitles, ['Sample Non-Fiction A↗', 'Sample Non-Fiction B↗']);

    // Case 9: Persistent per-day reading history UI, /update-progress-with-note journal sync & deduplication, and Compact preservation
    sortSelect.value = 'smart';
    await sortSelect.trigger('change');
    sgState.books['book-daily-laws'].statusLabel = 'currently reading';
    sgState.books['book-daily-laws'].progressType = 'percentage';
    sgState.books['book-daily-laws'].lastReachedPercent = 20;
    sgState.books['book-daily-laws'].lastReachedPages = 93;
    sgState.books['book-daily-laws'].journalEntries = [
      { date: '2026-10-20', percent: 20, pages: 93, note: '' }
    ];
    sgState.books['book-mt-9'].statusLabel = 'to-read';
    sgState.books['book-mt-9'].lastReachedPercent = 0;
    sgState.books['book-mt-9'].lastReachedPages = 0;
    sgState.books['book-mt-9'].journalEntries = [];
    sgState.posts.length = 0;

    const c9D1 = Math.floor(Date.UTC(2026, 9, 20, 12, 0, 0) / 1000);
    const c9D2 = Math.floor(Date.UTC(2026, 9, 22, 12, 0, 0) / 1000);
    const c9D3 = Math.floor(Date.UTC(2026, 9, 25, 12, 0, 0) / 1000);
    const c9M1 = Math.floor(Date.UTC(2026, 10, 18, 12, 0, 0) / 1000);
    const c9M2 = Math.floor(Date.UTC(2026, 10, 20, 12, 0, 0) / 1000);

    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/reading-history.json',
      Buffer.from(JSON.stringify({ version: 1, books: {} }), 'utf8').toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/backfill.json',
      Buffer.from(JSON.stringify({ books: {} }), 'utf8').toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from(
        [
          JSON.stringify({ e: 'reader.session', id: 'c9-1', ts: c9D1, vars: { book: lawsPath, start_progress_bp: '0', end_progress_bp: '2000', progress_scale: '10000', duration_seconds: '600' } }),
          JSON.stringify({ e: 'reader.session', id: 'c9-2', ts: c9D2, vars: { book: lawsPath, start_progress_bp: '2000', end_progress_bp: '5500', progress_scale: '10000', duration_seconds: '1200' } }),
          JSON.stringify({ e: 'reader.exit', id: 'c9-3', ts: c9D3, vars: { book: lawsPath, percent: '89' } }),
          JSON.stringify({ e: 'reader.session', id: 'c9-4', ts: c9M1, vars: { book: mtPath, start_progress_bp: '0', end_progress_bp: '4000', progress_scale: '10000', duration_seconds: '900' } }),
          JSON.stringify({ e: 'reader.session', id: 'c9-5', ts: c9M2, vars: { book: mtPath, start_progress_bp: '4000', end_progress_bp: '8100', progress_scale: '10000', duration_seconds: '1500' } })
        ].join('\n') + '\n',
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [lawsPath]: {
              bookId: 'book-daily-laws',
              title: 'Sample Non-Fiction A',
              author: 'Author Alpha',
              sdPath: lawsPath,
              status: 'currently-reading',
              lastSyncedPercent: 20,
              lastSyncedStartDate: '2026-10-20'
            },
            [mtPath]: {
              bookId: 'book-mt-9',
              title: 'Sample Series Vol. 9',
              author: 'Author Gamma',
              sdPath: mtPath,
              status: 'to-read',
              lastSyncedPercent: null
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');

    const lawsHistDet = booksListEl
      .querySelectorAll('details')
      .find((d) => d.getAttribute('data-history-key') === lawsPath);
    assert.ok(lawsHistDet, 'Expected collapsible Reading history details on Sample Non-Fiction A');
    assert.ok(lawsHistDet.textContent.includes('Reading history · 3 days'));
    assert.ok(lawsHistDet.textContent.includes('October 25, 2026'));

    // Click Sync Journal on Sample Non-Fiction A -> skips existing 2026-10-20, posts 2026-10-22 (55%) & 2026-10-25 (89%)
    const syncJournalBtn = booksListEl
      .querySelectorAll('button')
      .find((b) => b.getAttribute('data-act') === 'sync-journal' && b.getAttribute('data-key') === lawsPath);
    assert.ok(syncJournalBtn && syncJournalBtn.textContent.includes('Sync Journal (3)'));
    await booksListEl.trigger('click', { target: syncJournalBtn });
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.textContent.includes('Journal synced'),
      'Expected Sync Journal on Sample Non-Fiction A to finish'
    );
    const lawsJournalPosts = sgState.posts.filter((p) => p.bid === 'book-daily-laws' && p.path === '/update-progress-with-note');
    assert.equal(lawsJournalPosts.length, 2, 'Existing StoryGraph journal entry (2026-10-20) must not be duplicated');
    assert.equal(lawsJournalPosts[0].date, '2026-10-22');
    assert.equal(lawsJournalPosts[0].val, 55);
    assert.equal(lawsJournalPosts[1].date, '2026-10-25');
    assert.equal(lawsJournalPosts[1].val, 89);

    // Enable optional duration notes and run Sync All -> auto-syncs Sample Series Vol. 9 multi-day journal with duration notes + compacts outbox while preserving reading-history.json
    const journalNotesCheck = mockContainer.querySelector('#sg-journal-notes');
    assert.ok(journalNotesCheck);
    journalNotesCheck.checked = true;
    await journalNotesCheck.trigger('change');

    sgState.posts.length = 0;
    await syncAllBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.textContent.includes('Sync All complete'),
      'Expected Case 9 Sync All multi-day auto-journal to finish'
    );
    const mtJournalPosts = sgState.posts.filter((p) => p.bid === 'book-mt-9' && p.path === '/update-progress-with-note');
    assert.equal(mtJournalPosts.length, 2, 'Expected both multi-day sessions posted chronologically during Sync All');
    assert.equal(mtJournalPosts[0].date, '2026-11-18');
    assert.equal(mtJournalPosts[0].val, 40);
    assert.equal(mtJournalPosts[0].note, '15m read on CrossPoint');
    assert.equal(mtJournalPosts[1].date, '2026-11-20');
    assert.equal(mtJournalPosts[1].val, 81);
    assert.equal(mtJournalPosts[1].note, '25m read on CrossPoint');
    assert.equal(
      sgState.posts.filter((p) => p.bid === 'book-mt-9' && p.path === '/update-progress').length,
      0,
      'Must skip redundant /update-progress when /update-progress-with-note already pushed final 81%'
    );

    const savedHistJson = JSON.parse(virtualFiles.get('reading-history.json').toString('utf8'));
    assert.equal(Object.keys(savedHistJson.books[lawsPath].days).length, 3, 'All 3 days must survive Auto-Compact in reading-history.json');
    assert.equal(savedHistJson.books[lawsPath].days['2026-10-20'].syncedToJournal, true);
    assert.equal(savedHistJson.books[lawsPath].days['2026-10-22'].syncedToJournal, true);
    assert.equal(savedHistJson.books[lawsPath].days['2026-10-25'].syncedToJournal, true);
    assert.equal(savedHistJson.books[mtPath].days['2026-11-18'].syncedToJournal, true);
    assert.equal(savedHistJson.books[mtPath].days['2026-11-20'].syncedToJournal, true);

    // Inline multi-line Session History importer (replaces single-line window.prompt)
    const importHistBtn = mockContainer.querySelector('#sg-import-history');
    const importHistBox = mockContainer.querySelector('#sg-history-import-box');
    const importHistTa = mockContainer.querySelector('#sg-history-textarea');
    const importHistRunBtn = mockContainer.querySelector('#sg-history-import-run');
    const importHistCancelBtn = mockContainer.querySelector('#sg-history-import-cancel');
    assert.ok(importHistBtn && importHistBox && importHistTa && importHistRunBtn && importHistCancelBtn, 'Inline history importer UI elements must exist');
    assert.equal(importHistBox.classList.contains('show'), false);

    await importHistBtn.trigger('click');
    assert.equal(importHistBox.classList.contains('show'), true, 'Clicking Import Session History must reveal inline box');

    importHistTa.value = [
      JSON.stringify({ e: 'reader.session', id: 'ui-imp-1', ts: Math.floor(Date.UTC(2026, 9, 18, 12, 0, 0) / 1000), vars: { book: lawsPath, percent: '12', duration_seconds: '480' } }),
      JSON.stringify({ title: 'Sample Non-Fiction A', ended_at: '2026-10-19T12:00:00Z', progress: 18, duration: 300 })
    ].join('\n');
    await importHistRunBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.textContent.includes('Imported 2 session(s)'),
      'Expected inline multi-line session history import to succeed'
    );
    assert.ok(bannerEl.className.includes('sg-ok'));
    assert.equal(importHistBox.classList.contains('show'), false, 'Inline importer box should close after successful import');
    const afterImpHist = JSON.parse(virtualFiles.get('reading-history.json').toString('utf8'));
    assert.equal(afterImpHist.books[lawsPath].days['2026-10-18'].endPercent, 12);
    assert.equal(afterImpHist.books[lawsPath].days['2026-10-19'].endPercent, 18);

    // Even if events.jsonl was compacted with percent: "0", buildBookRows must roll up 100% from reading-history.json
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from(
        JSON.stringify({ e: 'reader.exit', id: 'compact-z', ts: 1795308186, vars: { book: mtPath, percent: '0', duration_seconds: '2400' } }) + '\n',
        'utf8'
      ).toString('base64')
    );
    afterImpHist.books[mtPath].days['2026-11-22'] = {
      date: '2026-11-22',
      startPercent: 81,
      endPercent: 100,
      durationSeconds: 3600,
      sessions: 1,
      syncedToJournal: true,
      seenIds: ['v10-100']
    };
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/reading-history.json',
      Buffer.from(JSON.stringify(afterImpHist), 'utf8').toString('base64')
    );
    await refreshBtn.trigger('click');
    assert.ok(booksListEl.textContent.includes('100% — Ready'), 'Expected 100% rolled up from reading-history.json despite 0% in events.jsonl');

    // Invariant 4 & 5: Clicking standalone Sync Journal on a 100% book delegates to syncBookCore (marks Read directly and never leaves book in Currently Reading)
    afterImpHist.books[mtPath].days['2026-11-22'].syncedToJournal = false;
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/reading-history.json',
      Buffer.from(JSON.stringify(afterImpHist), 'utf8').toString('base64')
    );
    await refreshBtn.trigger('click');
    sgState.posts.length = 0;
    const mtSyncJournalBtn = booksListEl
      .querySelectorAll('button')
      .find((b) => b.getAttribute('data-act') === 'sync-journal' && b.getAttribute('data-key') === mtPath);
    assert.ok(mtSyncJournalBtn, 'Expected Sync Journal button on 100% book with unsynced 100% day');
    await booksListEl.trigger('click', { target: mtSyncJournalBtn });
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && sgState.books['book-mt-9'].statusLabel === 'read',
      'Expected standalone Sync Journal on 100% book to mark book Read on StoryGraph'
    );
    assert.equal(
      sgState.posts.filter((p) => p.bid === 'book-mt-9' && p.path === '/update-progress-with-note' && p.val === 100).length,
      0,
      'Standalone Sync Journal must not post 100% progress-with-note before status=read'
    );
    assert.ok(
      sgState.posts.some((p) => p.bid === 'book-mt-9' && p.path === '/update-status.js' && p.st === 'read'),
      'Standalone Sync Journal on 100% book must transition status to read'
    );

    // Case 10: Automated Reading Journal cleanup (parseStoryGraphJournalPage + planJournalCleanup + #sg-clean-journals)
    const sampleCleanupJournalHtml = `<!DOCTYPE html><html><head><title>Journal</title><meta name="csrf-token" content="tok-clean"></head><body>
      <span class="journal-entry-panes">
        <div class="mb-3"><p>31 October 2026 <a href="/journal_entries/je-start/edit">Edit</a></p><span>Started reading</span></div>
        <div class="mb-3"><p>2 November 2026 <a href="/journal_entries/je-fin/edit">Edit</a></p><span>Finished</span><p>0 pages read <span class="font-normal">(203 pages out of 203)</span></p></div>
        <div class="mb-3"><p>21 November 2026 <a href="/journal_entries/je-stray-100/edit">Edit</a></p><div>100%</div><p>203 pages read <span class="font-normal">(203 pages out of 203)</span></p></div>
        <div class="mb-3"><p>22 November 2026 <a href="/journal_entries/je-zero/edit">Edit</a></p><div>0%</div><p>0 pages read <span class="font-normal">(0 pages out of 203)</span></p></div>
      </span>
    </body></html>`;
    const parsedCleanupJournal = sg.parseStoryGraphJournalPage(sampleCleanupJournalHtml);
    assert.equal(parsedCleanupJournal.csrf, 'tok-clean');
    assert.equal(parsedCleanupJournal.entries.length, 4);
    assert.equal(parsedCleanupJournal.entries[0].entryId, 'je-start');
    assert.equal(parsedCleanupJournal.entries[0].statusKind, 'started');
    assert.equal(parsedCleanupJournal.entries[0].isStatus, true);
    assert.equal(parsedCleanupJournal.entries[1].entryId, 'je-fin');
    assert.equal(parsedCleanupJournal.entries[1].statusKind, 'finished');
    assert.equal(parsedCleanupJournal.entries[1].isStatus, true);
    assert.equal(parsedCleanupJournal.entries[1].pagesDelta, 0);
    assert.equal(parsedCleanupJournal.entries[1].totalPages, 203);
    assert.equal(parsedCleanupJournal.entries[2].entryId, 'je-stray-100');
    assert.equal(parsedCleanupJournal.entries[2].isStatus, false);
    assert.equal(parsedCleanupJournal.entries[2].percent, 100);
    assert.equal(parsedCleanupJournal.entries[2].pagesDelta, 203);
    assert.equal(parsedCleanupJournal.entries[3].entryId, 'je-zero');
    assert.equal(parsedCleanupJournal.entries[3].percent, 0);

    const cleanupPlanA = sg.planJournalCleanup(parsedCleanupJournal.entries);
    assert.equal(cleanupPlanA.updates.length, 1, 'Expected 1 update transferring page credit to Finished entry');
    assert.equal(cleanupPlanA.updates[0].entryId, 'je-fin');
    assert.equal(cleanupPlanA.updates[0].pagesRead, 203);
    assert.equal(cleanupPlanA.updates[0].pagesReadTotal, 203);
    assert.deepEqual(
      Array.from(cleanupPlanA.deletes, (d) => d.entryId),
      ['je-zero', 'je-stray-100'],
      'Expected bogus 0% and stray 100% entries marked for deletion'
    );

    // Same-day intermediate entry alongside Finished that already credits full book pages
    const cleanupPlanB = sg.planJournalCleanup([
      { entryId: 'je-s', date: '2026-11-19', statusKind: 'started', isStatus: true, percent: null, pages: null, pagesDelta: null, totalPages: null },
      { entryId: 'je-81', date: '2026-11-21', statusKind: null, isStatus: false, percent: 81, pages: 254, pagesDelta: 254, totalPages: 314 },
      { entryId: 'je-f', date: '2026-11-21', statusKind: 'finished', isStatus: true, percent: 100, pages: 314, pagesDelta: 314, totalPages: 314 }
    ]);
    assert.equal(cleanupPlanB.updates.length, 0);
    assert.deepEqual(Array.from(cleanupPlanB.deletes, (d) => d.entryId), ['je-81']);

    // UI button #sg-clean-journals end-to-end execution
    const cleanJournalsBtn = mockContainer.querySelector('#sg-clean-journals');
    assert.ok(cleanJournalsBtn, '#sg-clean-journals button must render');
    sgState.books['book-mt-9'].journalEntries = [
      { entryId: 'je-mt-start', date: '2026-11-01', statusKind: 'started', isStatus: true },
      { entryId: 'je-mt-fin', date: '2026-11-05', statusKind: 'finished', isStatus: true, pagesDelta: 0, pages: 320, totalPages: 320 },
      { entryId: 'je-mt-stray100', date: '2026-11-21', statusKind: null, isStatus: false, percent: 100, pagesDelta: 320, pages: 320, totalPages: 320 },
      { entryId: 'je-mt-zero', date: '2026-11-22', statusKind: null, isStatus: false, percent: 0, pagesDelta: 0, pages: 0, totalPages: 320 }
    ];
    sgState.posts.length = 0;
    await cleanJournalsBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.textContent.includes('Journal cleanup complete'),
      'Expected #sg-clean-journals batch cleanup to complete'
    );
    assert.ok(
      bannerEl.textContent.includes('2 redundant/0% entry(s) deleted') &&
        bannerEl.textContent.includes('1 Finished page credit(s) repaired'),
      `Expected cleanup summary banner, got "${bannerEl.textContent}"`
    );
    assert.equal(sgState.books['book-mt-9'].journalEntries.length, 2, 'Only Started and Finished entries should remain');
    assert.equal(sgState.books['book-mt-9'].journalEntries[1].pagesDelta, 320, 'Finished entry should receive 320 pages credit');

    // Case 11: All 15 Per-Session Reading Diary Acceptance Criteria (v3)
    // Helper to build local Unix timestamps on 2026-11-22 at specific local hours/minutes
    const localTs = (year, month, day, hour, minute, second = 0) =>
      Math.floor(new Date(year, month - 1, day, hour, minute, second).getTime() / 1000);

    const t0915 = localTs(2026, 11, 22, 9, 15, 0);
    const t1340 = localTs(2026, 11, 22, 13, 40, 0);
    const t2010 = localTs(2026, 11, 22, 20, 10, 0);

    // Acceptance Test 1, 2, 3, 4:
    // - Three sessions on one day (15s, 12m, 45m)
    // - Two sessions with identical progress (32% -> 32%)
    // - Two sessions with identical duration (15s and 15s)
    // - 15-second session with 0% progress change (0% -> 0% and 32% -> 32%)
    // - Test 9: Progress checkpoint without session (reader.exit advancing % with no reader.session)
    const threeSessEvents = [
      JSON.stringify({
        e: 'reader.session',
        id: 's-day-1',
        ts: t0915 + 15,
        vars: {
          book: lawsPath,
          start_time: String(t0915),
          end_time: String(t0915 + 15),
          duration_seconds: '15',
          start_progress_bp: '3200',
          end_progress_bp: '3200',
          progress_scale: '10000'
        }
      }),
      JSON.stringify({
        e: 'reader.session',
        id: 's-day-2',
        ts: t1340 + 720,
        vars: {
          book: lawsPath,
          start_time: String(t1340),
          end_time: String(t1340 + 720),
          duration_seconds: '720',
          start_progress_bp: '3200',
          end_progress_bp: '3500',
          progress_scale: '10000'
        }
      }),
      JSON.stringify({
        e: 'reader.session',
        id: 's-day-3',
        ts: t2010 + 2700,
        vars: {
          book: lawsPath,
          start_time: String(t2010),
          end_time: String(t2010 + 2700),
          duration_seconds: '2700',
          start_progress_bp: '3500',
          end_progress_bp: '4200',
          progress_scale: '10000'
        }
      }),
      JSON.stringify({
        e: 'reader.exit',
        id: 's-chk-4',
        ts: t2010 + 3600,
        vars: {
          book: lawsPath,
          percent: '45'
        }
      })
    ].join('\n') + '\n';

    const mergedThree = sg.mergeEventsIntoHistory({ version: 2, books: {} }, threeSessEvents);
    const lawsSessions = Array.from(mergedThree.history.books[lawsPath].sessions);
    assert.equal(lawsSessions.length, 4, 'Test 1 & 9: Expected 3 reading_session records + 1 progress_checkpoint');
    assert.equal(lawsSessions[0].recordType, 'reading_session');
    assert.equal(lawsSessions[0].durationSeconds, 15);
    assert.equal(lawsSessions[0].startPercent, 32);
    assert.equal(lawsSessions[0].endPercent, 32);
    assert.equal(lawsSessions[1].recordType, 'reading_session');
    assert.equal(lawsSessions[1].durationSeconds, 720);
    assert.equal(lawsSessions[2].recordType, 'reading_session');
    assert.equal(lawsSessions[2].durationSeconds, 2700);
    assert.equal(lawsSessions[3].recordType, 'progress_checkpoint');
    assert.equal(lawsSessions[3].endPercent, 45);
    assert.equal(mergedThree.history.books[lawsPath].days['2026-11-22'].durationSeconds, 3435, 'Derived daily total must equal 57m 15s (3435s)');
    assert.equal(mergedThree.history.books[lawsPath].days['2026-11-22'].sessions, 3);

    // Test 4: 15-second session at 0% -> 0% on page 1 is preserved
    const zeroPctSess = sg.mergeEventsIntoHistory(
      { version: 2, books: {} },
      JSON.stringify({
        e: 'reader.session',
        id: 's-zero-15s',
        ts: t0915 + 15,
        vars: {
          book: lawsPath,
          start_time: String(t0915),
          end_time: String(t0915 + 15),
          duration_seconds: '15',
          start_progress_bp: '0',
          end_progress_bp: '0',
          progress_scale: '10000'
        }
      })
    );
    assert.equal(zeroPctSess.history.books[lawsPath].sessions.length, 1, 'Test 4: 15s session at 0% must be preserved');
    assert.equal(zeroPctSess.history.books[lawsPath].sessions[0].durationSeconds, 15);
    assert.equal(zeroPctSess.history.books[lawsPath].sessions[0].endPercent, 0);

    // Test 8: Historical import with reordered & repeated identical records produces deterministic sessionIds and 0 duplicates
    const impLineA = { title: 'Sample Non-Fiction A', started_at: '2026-11-20T09:00:00Z', ended_at: '2026-11-20T09:15:00Z', progress: 25, duration: 900 };
    const impLineB = { title: 'Sample Non-Fiction A', started_at: '2026-11-20T14:00:00Z', ended_at: '2026-11-20T14:15:00Z', progress: 25, duration: 900 };
    const impLineBClone = { title: 'Sample Non-Fiction A', started_at: '2026-11-20T14:00:00Z', ended_at: '2026-11-20T14:15:00Z', progress: 25, duration: 900 };
    const knownRowsMock = [{ sdPath: lawsPath, title: 'Sample Non-Fiction A' }];
    const impOrder1 = sg.importSessionHistoryPayload({ version: 2, books: {} }, [impLineA, impLineB, impLineBClone], knownRowsMock);
    const impOrder2 = sg.importSessionHistoryPayload({ version: 2, books: {} }, [impLineB, impLineA, impLineBClone], knownRowsMock);
    const idsOrder1 = Array.from(impOrder1.history.books[lawsPath].sessions, (s) => s.sessionId).sort();
    const idsOrder2 = Array.from(impOrder2.history.books[lawsPath].sessions, (s) => s.sessionId).sort();
    assert.equal(idsOrder1.length, 3, 'Test 8: Expected 3 sessions including 2 identical keyless records');
    assert.deepEqual(idsOrder1, idsOrder2, 'Test 8: Reordering import file must yield identical deterministic sessionIds');
    const reImp = sg.importSessionHistoryPayload(impOrder1.history, [impLineB, impLineA, impLineBClone], knownRowsMock);
    assert.equal(reImp.history.books[lawsPath].sessions.length, 3, 'Test 8: Re-importing same records must create 0 duplicates');

    // Test 14: Migration from v1 daily history creates legacy_daily_summary without inventing fake sessions
    const migratedV1 = sg.cloneHistoryData({
      version: 1,
      books: {
        [lawsPath]: {
          days: {
            '2026-11-10': {
              date: '2026-11-10',
              startPercent: 10,
              endPercent: 30,
              durationSeconds: 3435,
              sessions: 3,
              syncedToJournal: true,
              seenIds: ['old-1', 'old-2', 'old-3']
            }
          }
        }
      }
    });
    assert.equal(migratedV1.books[lawsPath].sessions.length, 1, 'Test 14: v1 daily aggregate must migrate as 1 legacy_daily_summary');
    assert.equal(migratedV1.books[lawsPath].sessions[0].recordType, 'legacy_daily_summary');
    assert.equal(migratedV1.books[lawsPath].sessions[0].legacySessionCount, 3);

    // Test 15: Session spanning midnight (23:40 Nov 21 -> 00:25 Nov 22)
    const tMidStart = localTs(2026, 11, 21, 23, 40, 0);
    const tMidEnd = localTs(2026, 11, 22, 0, 25, 0);
    const midHist = sg.mergeEventsIntoHistory(
      { version: 2, books: {} },
      JSON.stringify({
        e: 'reader.session',
        id: 's-midnight',
        ts: tMidEnd,
        vars: {
          book: lawsPath,
          start_time: String(tMidStart),
          end_time: String(tMidEnd),
          duration_seconds: '2700',
          start_progress_bp: '4000',
          end_progress_bp: '5000',
          progress_scale: '10000'
        }
      })
    );
    const midSess = midHist.history.books[lawsPath].sessions[0];
    assert.equal(midSess.startDate, '2026-11-21', 'Test 15: Midnight session must record startDate on Day 1');
    assert.equal(midSess.date, '2026-11-22', 'Test 15: Midnight session must assign canonical journal date on Day 2 (endTime)');
    const midNote = sg.formatSessionJournalNote(midSess, true);
    assert.equal(midNote, '23:40 (Nov 21)–00:25 · 45m read on CrossPoint', 'Test 15: Midnight note must show date crossover');
    assert.equal(
      sg.formatSessionJournalNote(midSess, true, 'X4 Pro'),
      '23:40 (Nov 21)–00:25 · 45m read on X4 Pro',
      'Custom deviceLabel must override default CrossPoint label'
    );

    // Test 1, 2, 3, 5, 7, 11: End-to-end UI rendering & StoryGraph sync of multiple same-day sessions (including identical progress/duration & disabled notes)
    sgState.books['book-daily-laws'].statusLabel = 'currently reading';
    sgState.books['book-daily-laws'].progressType = 'percentage';
    sgState.books['book-daily-laws'].lastReachedPercent = 32;
    sgState.books['book-daily-laws'].lastReachedPages = 148;
    sgState.books['book-daily-laws'].journalEntries = [];
    sgState.posts.length = 0;

    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/reading-history.json',
      Buffer.from(JSON.stringify({ version: 2, books: {} }), 'utf8').toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from(threeSessEvents, 'utf8').toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [lawsPath]: {
              bookId: 'book-daily-laws',
              title: 'Sample Non-Fiction A',
              author: 'Author Alpha',
              sdPath: lawsPath,
              status: 'currently-reading',
              lastSyncedPercent: 32
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');

    const lawsDiaryDet = booksListEl
      .querySelectorAll('details')
      .find((d) => d.getAttribute('data-history-key') === lawsPath);
    assert.ok(lawsDiaryDet, 'Expected Reading history details for 3 same-day sessions');
    assert.ok(
      lawsDiaryDet.textContent.includes('3 sessions') &&
        lawsDiaryDet.textContent.includes('57m 15s total') &&
        lawsDiaryDet.textContent.includes('Morning') &&
        lawsDiaryDet.textContent.includes('Afternoon') &&
        lawsDiaryDet.textContent.includes('Evening') &&
        lawsDiaryDet.textContent.includes('Reading session 1') &&
        lawsDiaryDet.textContent.includes('Reading session 2') &&
        lawsDiaryDet.textContent.includes('Reading session 3') &&
        lawsDiaryDet.textContent.includes('Progress checkpoint'),
      `Expected session-level diary UI with Morning/Afternoon/Evening, 57m 15s total & Progress checkpoint, got "${lawsDiaryDet.textContent}"`
    );

    const lawsDiarySyncBtn = booksListEl
      .querySelectorAll('button')
      .find((b) => b.getAttribute('data-act') === 'sync-journal' && b.getAttribute('data-key') === lawsPath);
    assert.ok(lawsDiarySyncBtn && lawsDiarySyncBtn.textContent.includes('Sync Journal (4)'));
    await booksListEl.trigger('click', { target: lawsDiarySyncBtn });
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.textContent.includes('Journal synced'),
      'Expected 3 same-day sessions + 1 checkpoint to sync to StoryGraph'
    );
    const diaryPosts = sgState.posts.filter((p) => p.bid === 'book-daily-laws' && p.path === '/update-progress-with-note');
    assert.equal(diaryPosts.length, 4, 'Test 1: All 3 same-day sessions + 1 progress checkpoint must be posted independently');
    assert.equal(diaryPosts[0].note, '09:15 · 15s read on CrossPoint');
    assert.equal(diaryPosts[1].note, '13:40–13:52 · 12m read on CrossPoint');
    assert.equal(diaryPosts[2].note, '20:10–20:55 · 45m read on CrossPoint');

    // Test 7: Repeated synchronization sends 0 duplicate POSTs
    sgState.posts.length = 0;
    await syncAllBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled,
      'Expected repeated sync to finish'
    );
    assert.equal(
      sgState.posts.filter((p) => p.bid === 'book-daily-laws' && p.path === '/update-progress-with-note').length,
      0,
      'Test 7: Repeated synchronization must post 0 duplicate journal entries'
    );

    // Test 5 & 11: Two identical sessions on the same day with duration notes disabled (empty notes) -> both posted, bound to distinct journalEntryIds, and both survive Clean Journals
    journalNotesCheck.checked = false;
    await journalNotesCheck.trigger('change');
    sgState.books['book-daily-laws'].journalEntries = [];
    sgState.posts.length = 0;

    const twoIdenticalEmptyNoteEvents = [
      JSON.stringify({
        e: 'reader.session',
        id: 's-ident-1',
        ts: t0915 + 15,
        vars: { book: lawsPath, duration_seconds: '15', start_progress_bp: '3200', end_progress_bp: '3200', progress_scale: '10000' }
      }),
      JSON.stringify({
        e: 'reader.session',
        id: 's-ident-2',
        ts: t0915 + 45,
        vars: { book: lawsPath, duration_seconds: '15', start_progress_bp: '3200', end_progress_bp: '3200', progress_scale: '10000' }
      })
    ].join('\n') + '\n';

    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/reading-history.json',
      Buffer.from(JSON.stringify({ version: 2, books: {} }), 'utf8').toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from(twoIdenticalEmptyNoteEvents, 'utf8').toString('base64')
    );
    await refreshBtn.trigger('click');
    const identSyncBtn = booksListEl
      .querySelectorAll('button')
      .find((b) => b.getAttribute('data-act') === 'sync-journal' && b.getAttribute('data-key') === lawsPath);
    await booksListEl.trigger('click', { target: identSyncBtn });
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.textContent.includes('Journal synced'),
      'Expected 2 identical empty-note sessions to sync'
    );
    const identPosts = sgState.posts.filter((p) => p.bid === 'book-daily-laws' && p.path === '/update-progress-with-note');
    assert.equal(identPosts.length, 2, 'Test 2, 3, 5, 11: Both identical empty-note sessions must be posted');
    assert.equal(identPosts[0].note, '');
    assert.equal(identPosts[1].note, '');
    const histAfterIdent = JSON.parse(virtualFiles.get('reading-history.json').toString('utf8'));
    const ledgerSessions = histAfterIdent.books[lawsPath].sessions;
    assert.equal(ledgerSessions.length, 2);
    assert.ok(ledgerSessions[0].journalEntryId && ledgerSessions[1].journalEntryId);
    assert.notEqual(ledgerSessions[0].journalEntryId, ledgerSessions[1].journalEntryId, 'Each identical session must bind a distinct journalEntryId');

    await cleanJournalsBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled,
      'Expected Clean Journals after identical empty-note sessions to finish'
    );
    assert.equal(
      sgState.books['book-daily-laws'].journalEntries.length,
      2,
      'Test 5 & 11: Clean Journals must preserve both ledger-bound identical sessions even with empty notes'
    );
    journalNotesCheck.checked = true;
    await journalNotesCheck.trigger('change');

    // Test 6 & 12: Interrupted synchronization reconciliation (single match vs ambiguous multiple matches)
    sgState.books['book-daily-laws'].journalEntries = [
      { entryId: 'je-pre-1', date: '2026-11-22', percent: 30, pages: 139, note: '' },
      { entryId: 'je-inflight-single', date: '2026-11-22', percent: 35, pages: 162, note: '12m read on CrossPoint' }
    ];
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from('\n', 'utf8').toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/reading-history.json',
      Buffer.from(
        JSON.stringify({
          version: 2,
          books: {
            [lawsPath]: {
              sessions: [
                {
                  sessionId: 's-interrupted-1',
                  recordType: 'reading_session',
                  date: '2026-11-22',
                  startPercent: 30,
                  endPercent: 35,
                  durationSeconds: 720,
                  syncStatus: 'in_flight',
                  syncedToJournal: false,
                  prePostRemoteIds: ['je-pre-1']
                }
              ]
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    sgState.posts.length = 0;
    const recSingleBtn = booksListEl
      .querySelectorAll('button')
      .find((b) => b.getAttribute('data-act') === 'sync-journal' && b.getAttribute('data-key') === lawsPath);
    await booksListEl.trigger('click', { target: recSingleBtn });
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled,
      'Expected single-match in_flight reconciliation to complete'
    );
    assert.equal(
      sgState.posts.filter((p) => p.bid === 'book-daily-laws' && p.path === '/update-progress-with-note').length,
      0,
      'Test 6: Single matching remote entry after interrupted sync must reconcile with 0 duplicate POSTs'
    );
    const histAfterSingleRec = JSON.parse(virtualFiles.get('reading-history.json').toString('utf8'));
    assert.equal(histAfterSingleRec.books[lawsPath].sessions[0].syncStatus, 'synced');
    assert.equal(histAfterSingleRec.books[lawsPath].sessions[0].journalEntryId, 'je-inflight-single');

    // Test 12: Ambiguous multiple remote matches after interrupted sync -> flags needs_reconciliation without guessing or re-posting
    sgState.books['book-daily-laws'].journalEntries = [
      { entryId: 'je-pre-1', date: '2026-11-22', percent: 30, pages: 139, note: '' },
      { entryId: 'je-ambig-a', date: '2026-11-22', percent: 40, pages: 186, note: '15m read on CrossPoint' },
      { entryId: 'je-ambig-b', date: '2026-11-22', percent: 40, pages: 186, note: '15m read on CrossPoint' }
    ];
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/reading-history.json',
      Buffer.from(
        JSON.stringify({
          version: 2,
          books: {
            [lawsPath]: {
              sessions: [
                {
                  sessionId: 's-interrupted-ambig',
                  recordType: 'reading_session',
                  date: '2026-11-22',
                  startPercent: 35,
                  endPercent: 40,
                  durationSeconds: 900,
                  syncStatus: 'in_flight',
                  syncedToJournal: false,
                  prePostRemoteIds: ['je-pre-1']
                }
              ]
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    sgState.posts.length = 0;
    const recAmbigBtn = booksListEl
      .querySelectorAll('button')
      .find((b) => b.getAttribute('data-act') === 'sync-journal' && b.getAttribute('data-key') === lawsPath);
    await booksListEl.trigger('click', { target: recAmbigBtn });
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled,
      'Expected ambiguous in_flight reconciliation to complete'
    );
    assert.equal(
      sgState.posts.filter((p) => p.bid === 'book-daily-laws' && p.path === '/update-progress-with-note').length,
      0,
      'Test 12: Ambiguous interrupted session must not re-post'
    );
    const histAfterAmbig = JSON.parse(virtualFiles.get('reading-history.json').toString('utf8'));
    assert.equal(histAfterAmbig.books[lawsPath].sessions[0].syncStatus, 'needs_reconciliation');
    assert.deepEqual(histAfterAmbig.books[lawsPath].sessions[0].candidateJournalEntryIds, ['je-ambig-a', 'je-ambig-b']);
    assert.ok(booksListEl.textContent.includes('Needs reconciliation'), 'Test 12: UI must display Needs reconciliation badge');

    // Test 10 & 13: Final 100% reading session with duration note is posted, retained alongside Read status, and preserved by Clean Journals
    sgState.books['book-mt-9'].statusLabel = 'currently reading';
    sgState.books['book-mt-9'].lastReachedPercent = 76;
    sgState.books['book-mt-9'].lastReachedPages = 243;
    sgState.books['book-mt-9'].journalEntries = [
      { entryId: 'je-mt10-start', date: '2026-11-21', statusKind: 'started', isStatus: true },
      { entryId: 'je-mt10-76', date: '2026-11-22', statusKind: null, isStatus: false, percent: 76, pages: 243, pagesDelta: 121, totalPages: 320, note: '40m read on CrossPoint' }
    ];
    sgState.posts.length = 0;
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/reading-history.json',
      Buffer.from(
        JSON.stringify({
          version: 2,
          books: {
            [mtPath]: {
              sessions: [
                {
                  sessionId: 's-final-100',
                  recordType: 'reading_session',
                  date: '2026-11-22',
                  startTime: t2010,
                  endTime: t2010 + 2700,
                  startPercent: 76,
                  endPercent: 100,
                  durationSeconds: 2700,
                  syncStatus: 'pending',
                  syncedToJournal: false
                }
              ]
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [mtPath]: {
              bookId: 'book-mt-9',
              title: 'Sample Series Vol. 9',
              author: 'Author Gamma',
              sdPath: mtPath,
              status: 'currently-reading',
              lastSyncedPercent: 76
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    const final100SyncBtn = booksListEl
      .querySelectorAll('button')
      .find((b) => b.getAttribute('data-act') === 'sync-journal' && b.getAttribute('data-key') === mtPath);
    await booksListEl.trigger('click', { target: final100SyncBtn });
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && sgState.books['book-mt-9'].statusLabel === 'read',
      'Expected final 100% reading session to post and mark book Read'
    );
    const final100Posts = sgState.posts.filter((p) => p.bid === 'book-mt-9' && p.path === '/update-progress-with-note' && p.val === 100);
    assert.equal(final100Posts.length, 1, 'Test 10: Genuine final 100% reading_session must be posted to StoryGraph journal');
    assert.equal(final100Posts[0].note, '20:10–20:55 · 45m read on CrossPoint');

    // Test 13: Even if StoryGraph also has a Finished status entry with duplicate pages, Clean Journals preserves the final 100% session and clears Finished duplicate page delta
    sgState.books['book-mt-9'].journalEntries.push({
      entryId: 'je-mt10-fin',
      date: '2026-11-22',
      statusKind: 'finished',
      isStatus: true,
      percent: 100,
      pages: 320,
      pagesDelta: 320,
      totalPages: 320
    });
    const planFinal100 = sg.planJournalCleanup(sgState.books['book-mt-9'].journalEntries, {
      claimedEntryIds: sg.collectClaimedJournalEntryIds(JSON.parse(virtualFiles.get('reading-history.json').toString('utf8')))
    });
    assert.equal(planFinal100.deletes.length, 0, 'Test 13: Clean Journals must never delete a genuine final 100% reading session');
    assert.equal(planFinal100.updates.length, 1, 'Test 13: Clean Journals must clear duplicate page credit on Finished alongside genuine 100% sitting');
    assert.equal(planFinal100.updates[0].entryId, 'je-mt10-fin');
    assert.equal(planFinal100.updates[0].pagesRead, 0);

    // Case 12: /api/fetch Reliability, Cleanup Verification Cache & Consistent Progress/Session Count (14 Acceptance Tests)
    // Pure helper unit checks (Tests 10, 11, 12, 13 & error classification)
    assert.equal(sg.isTransientFetchError(new Error('/api/fetch: transport failure')), true);
    assert.equal(sg.isTransientFetchError(new Error('socket ECONNRESET')), true);
    assert.equal(sg.isTransientFetchError(Object.assign(new Error('HTTP 502'), { status: 502 })), true);
    assert.equal(sg.isTransientFetchError(Object.assign(new Error('HTTP 504'), { status: 504 })), true);
    assert.equal(sg.isTransientFetchError(Object.assign(new Error('HTTP 401'), { status: 401 })), false);
    assert.equal(sg.isTransientFetchError(Object.assign(new Error('HTTP 403'), { status: 403 })), false);
    assert.equal(sg.isTransientFetchError(Object.assign(new Error('HTTP 503'), { status: 503 })), false);
    assert.equal(sg.isTransientFetchError(new Error('Cloudflare challenge detected')), false);

    // Acceptance Test 12 & 13: computePercentFromBp (15 bp -> 1%, 0 bp -> 0%) consistently across all paths
    assert.equal(sg.computePercentFromBp(15, 10000), 1, 'Test 12: 15 bp must convert to 1%');
    assert.equal(sg.computePercentFromBp(0, 10000), 0, 'Test 13: 0 bp must remain 0%');
    assert.equal(sg.computePercentFromBp(2380, 10000), 24);

    // normalizeSessionRecord via cloneHistoryData (including self-healing stored startPercent: 0 with startProgressBp: 15)
    const bpNormHist = sg.cloneHistoryData({
      version: 2,
      books: {
        [lawsPath]: {
          sessions: [
            {
              sessionId: 'bp-heal-1',
              recordType: 'reading_session',
              date: '2026-11-22',
              startProgressBp: 15,
              endProgressBp: 2380,
              progressScale: 10000,
              startPercent: 0,
              endPercent: 24,
              durationSeconds: 3315
            },
            {
              sessionId: 'bp-zero-1',
              recordType: 'reading_session',
              date: '2026-11-22',
              startProgressBp: 0,
              endProgressBp: 15,
              progressScale: 10000,
              durationSeconds: 28
            }
          ]
        }
      }
    });
    assert.equal(bpNormHist.books[lawsPath].sessions[0].startPercent, 1, 'Test 12: normalizeSessionRecord must compute/self-heal 15 bp -> 1%');
    assert.equal(bpNormHist.books[lawsPath].sessions[0].endPercent, 24);
    assert.equal(bpNormHist.books[lawsPath].sessions[1].startPercent, 0, 'Test 13: normalizeSessionRecord must keep 0 bp -> 0%');
    assert.equal(bpNormHist.books[lawsPath].sessions[1].endPercent, 1);

    // mergeEventsIntoHistory 15 bp -> 1%, 0 bp -> 0%
    const bpMergeRes = sg.mergeEventsIntoHistory(
      { version: 2, books: {} },
      [
        JSON.stringify({
          e: 'reader.session',
          id: 'bp-merge-15',
          ts: t0915 + 60,
          vars: { book: lawsPath, start_progress_bp: '15', end_progress_bp: '2380', progress_scale: '10000', duration_seconds: '60' }
        }),
        JSON.stringify({
          e: 'reader.session',
          id: 'bp-merge-0',
          ts: t0915 + 120,
          vars: { book: lawsPath, start_progress_bp: '0', end_progress_bp: '15', progress_scale: '10000', duration_seconds: '28' }
        })
      ].join('\n')
    );
    assert.equal(bpMergeRes.history.books[lawsPath].sessions[0].startPercent, 1, 'Test 12: mergeEventsIntoHistory must compute 15 bp -> 1%');
    assert.equal(bpMergeRes.history.books[lawsPath].sessions[1].startPercent, 0, 'Test 13: mergeEventsIntoHistory must keep 0 bp -> 0%');
    assert.equal(bpMergeRes.history.books[lawsPath].sessions[1].endPercent, 1);

    // importSessionHistoryPayload 15 bp -> 1%, 0 bp -> 0%
    const bpImportRes = sg.importSessionHistoryPayload(
      { version: 2, books: {} },
      [
        { sdPath: lawsPath, date: '2026-11-22', start_progress_bp: 15, end_progress_bp: 2380, progress_scale: 10000, duration_seconds: 60 },
        { sdPath: lawsPath, date: '2026-11-22', start_progress_bp: 0, end_progress_bp: 15, progress_scale: 10000, duration_seconds: 28 }
      ],
      [{ sdPath: lawsPath, title: 'Sample Non-Fiction A' }]
    );
    const bpImp15 = bpImportRes.history.books[lawsPath].sessions.find((s) => s.startProgressBp === 15);
    const bpImp0 = bpImportRes.history.books[lawsPath].sessions.find((s) => s.startProgressBp === 0);
    assert.ok(bpImp15 && bpImp0, 'Expected both imported bp records');
    assert.equal(bpImp15.startPercent, 1, 'Test 12: importSessionHistoryPayload must compute 15 bp -> 1%');
    assert.equal(bpImp15.endPercent, 24);
    assert.equal(bpImp0.startPercent, 0, 'Test 13: importSessionHistoryPayload must keep 0 bp -> 0%');
    assert.equal(bpImp0.endPercent, 1);

    // Acceptance Test 10: Single-event legacy migration retains legacy_daily_summary unless verified reader.session arrives
    const singleLegV1 = sg.cloneHistoryData({
      version: 1,
      books: {
        [lawsPath]: {
          days: {
            '2026-11-22': {
              date: '2026-11-22',
              startPercent: 0,
              endPercent: 1,
              durationSeconds: 28,
              sessions: 1,
              syncedToJournal: true,
              seenIds: ['orig-sess-1']
            }
          }
        }
      }
    });
    assert.equal(singleLegV1.books[lawsPath].sessions.length, 1);
    assert.equal(singleLegV1.books[lawsPath].sessions[0].recordType, 'legacy_daily_summary', 'Test 10: v1 single-event daily summary must remain legacy_daily_summary without fabricated reading_session');

    // A non-session reader.exit checkpoint with same id must NOT replace the legacy_daily_summary
    const afterExitOnly = sg.mergeEventsIntoHistory(
      singleLegV1,
      JSON.stringify({ e: 'reader.exit', id: 'orig-sess-1', ts: t0915 + 28, vars: { book: lawsPath, percent: '1' } })
    );
    assert.ok(
      afterExitOnly.history.books[lawsPath].sessions.some((s) => s.recordType === 'legacy_daily_summary'),
      'Test 10: reader.exit checkpoint must not replace legacy_daily_summary'
    );

    // A verified reader.session event with matching id replaces the legacy_daily_summary cleanly
    const afterVerifiedSession = sg.mergeEventsIntoHistory(
      singleLegV1,
      JSON.stringify({
        e: 'reader.session',
        id: 'orig-sess-1',
        ts: t0915 + 28,
        vars: { book: lawsPath, start_time: String(t0915), end_time: String(t0915 + 28), duration_seconds: '28', start_progress_bp: '0', end_progress_bp: '15', progress_scale: '10000' }
      })
    );
    assert.equal(afterVerifiedSession.history.books[lawsPath].sessions.length, 1, 'Test 10: Verified reader.session must replace single-event legacy_daily_summary');
    assert.equal(afterVerifiedSession.history.books[lawsPath].sessions[0].recordType, 'reading_session');
    assert.equal(afterVerifiedSession.history.books[lawsPath].sessions[0].sessionId, 'orig-sess-1');

    // Acceptance Test 11: Multiple-event legacy migration + mixed real/legacy UI session count display
    const multiLegV1 = sg.cloneHistoryData({
      version: 1,
      books: {
        [lawsPath]: {
          days: {
            '2026-11-22': {
              date: '2026-11-22',
              startPercent: 0,
              endPercent: 10,
              durationSeconds: 1800,
              sessions: 3,
              syncedToJournal: true,
              seenIds: ['m-1', 'm-2', 'm-3']
            }
          }
        }
      }
    });
    assert.equal(multiLegV1.books[lawsPath].sessions.length, 1);
    assert.equal(multiLegV1.books[lawsPath].sessions[0].recordType, 'legacy_daily_summary', 'Test 11: Multi-event v1 summary must remain legacy_daily_summary');
    assert.equal(multiLegV1.books[lawsPath].sessions[0].legacySessionCount, 3);

    // Verify UI renders honest session total for mixed real + legacy (1 real + 1 legacy = 2 sessions; 1 real + 3 legacy = 4 sessions)
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/events.jsonl',
      Buffer.from('\n', 'utf8').toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/reading-history.json',
      Buffer.from(
        JSON.stringify({
          version: 2,
          books: {
            [lawsPath]: {
              sessions: [
                {
                  sessionId: 'legacy:2026-11-22',
                  recordType: 'legacy_daily_summary',
                  date: '2026-11-22',
                  startPercent: 0,
                  endPercent: 1,
                  durationSeconds: 28,
                  legacySessionCount: 1,
                  seenIds: ['orig-1'],
                  syncStatus: 'synced',
                  syncedToJournal: true
                },
                {
                  sessionId: 'real-sess-2',
                  recordType: 'reading_session',
                  date: '2026-11-22',
                  startTime: t1340,
                  endTime: t1340 + 3315,
                  startProgressBp: 15,
                  endProgressBp: 2380,
                  progressScale: 10000,
                  startPercent: 0,
                  endPercent: 24,
                  durationSeconds: 3315,
                  syncStatus: 'synced',
                  syncedToJournal: true
                }
              ]
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/storygraph-map.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          books: {
            [lawsPath]: {
              bookId: 'book-daily-laws',
              title: 'Sample Non-Fiction A',
              author: 'Author Alpha',
              sdPath: lawsPath,
              status: 'currently-reading',
              lastSyncedPercent: 24
            }
          }
        }),
        'utf8'
      ).toString('base64')
    );
    await refreshBtn.trigger('click');
    assert.ok(
      booksListEl.textContent.includes('2 sessions · 55m 43s total'),
      `Test 11: Expected honest 2-session total in UI header, got "${booksListEl.textContent.slice(0, 400)}"`
    );
    assert.ok(
      booksListEl.textContent.includes('1% → 24%'),
      `Test 12: Expected self-healed 1% → 24% display for 15 bp start, got "${booksListEl.textContent.slice(0, 400)}"`
    );
    assert.ok(
      booksListEl.textContent.includes('Daily summary (1 session)'),
      'Test 10/11: Expected legacy daily summary to retain honest label'
    );

    // Acceptance Tests 1-5: fetchStoryGraphHtml retry, exhaustion, non-retryable HTTP 401/403/503, and stale tmp-fetch.html guard
    // Test 1: Transient transport failure on attempt 1, then success on attempt 2
    fetchToSdCalls.length = 0;
    let t1Count = 0;
    fetchToSdInterceptor = async (url) => {
      if (url.includes('/journal?book_id=')) {
        t1Count++;
        if (t1Count === 1) throw new Error('/api/fetch: transport failure');
      }
      return undefined;
    };
    sgState.books['book-daily-laws'].journalEntries = [
      { entryId: 'je-t1-ok', date: '2026-11-22', percent: 24, pages: 111, note: '55m 15s read on CrossPoint' }
    ];
    await cleanJournalsBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled,
      'Test 1: Expected transient transport failure to retry and succeed'
    );
    fetchToSdInterceptor = null;
    assert.equal(t1Count, 2, 'Test 1: Expected exactly 2 attempts (1 transient failure + 1 retry success)');
    assert.ok(
      !bannerEl.className.includes('sg-err') && bannerEl.textContent.includes('verified clean'),
      `Test 1: Expected successful recovery banner, got "${bannerEl.textContent}"`
    );

    // Test 2 & Test 5: Three consecutive transient failures with stale tmp-fetch.html on SD
    // Write a known stale HTML document to tmp-fetch.html before triggering failing fetch
    await mockApi.writeFile(
      '/.crosspoint/plugins/storygraph-sync/tmp-fetch.html',
      Buffer.from(
        '<!DOCTYPE html><html><head><meta name="csrf-token" content="stale-tok"></head><body><span class="journal-entry-panes"><div class="mb-3"><p>22 November 2026 <a href="/journal_entries/je-stale-zero/edit">Edit</a></p><div>0%</div></div></span></body></html>',
        'utf8'
      ).toString('base64')
    );
    let t2Count = 0;
    tmpFetchReadCount = 0;
    sgState.posts.length = 0;
    fetchToSdInterceptor = async () => {
      t2Count++;
      throw new Error('/api/fetch: transport failure');
    };
    await cleanJournalsBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-err'),
      'Test 2: Expected 3 consecutive transient failures to stop and report error'
    );
    fetchToSdInterceptor = null;
    assert.equal(t2Count, 3, 'Test 2: Must stop after exactly 3 attempts (initial + 2 retries)');
    assert.ok(
      bannerEl.textContent.includes('after 3 attempts') && bannerEl.textContent.includes('transport failure'),
      `Test 2: Expected error banner with attempt count, got "${bannerEl.textContent}"`
    );
    assert.equal(tmpFetchReadCount, 0, 'Test 5: Stale tmp-fetch.html must NEVER be read when fetchToSd fails');
    assert.equal(sgState.posts.length, 0, 'Test 5: No cleanup POSTs may be triggered from stale tmp-fetch.html');

    // Test 3: HTTP 401 and HTTP 403 fail immediately with 0 retries (attempts === 1)
    for (const nonRetryStatus of [401, 403, 503]) {
      let statusAttempts = 0;
      tmpFetchReadCount = 0;
      fetchToSdInterceptor = async () => {
        statusAttempts++;
        return { status: nonRetryStatus, bytes: 0, complete: false };
      };
      await cleanJournalsBtn.trigger('click');
      await waitForLong(
        () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-err'),
        `Test 3/4: Expected HTTP ${nonRetryStatus} to fail immediately`
      );
      fetchToSdInterceptor = null;
      assert.equal(statusAttempts, 1, `Test 3/4: HTTP ${nonRetryStatus} must fail immediately with 0 retries (attempts === 1)`);
      assert.equal(tmpFetchReadCount, 0, `Test 5: Stale tmp-fetch.html must never be read on HTTP ${nonRetryStatus}`);
      assert.ok(
        bannerEl.textContent.includes(String(nonRetryStatus)),
        `Test 3/4: Expected HTTP ${nonRetryStatus} in error banner, got "${bannerEl.textContent}"`
      );
    }

    // Acceptance Tests 6, 7, 8, 9, 14: Watermarked cleanup cache, invalidation, pending guard, failed stamp guard, and partial batch failure
    // Setup 3 linked Read books: Book 1 (book-done-100), Book 2 (book-mt-9), Book 3 (book-daily-stoic)
    const cleanHistBase = {
      version: 2,
      books: {
        [donePath]: {
          sessions: [
            { sessionId: 'b1-s1', recordType: 'reading_session', date: '2026-11-16', startPercent: 0, endPercent: 100, durationSeconds: 1200, syncStatus: 'synced', syncedToJournal: true, journalEntryId: 'je-b1-1' }
          ]
        },
        [mtPath]: {
          sessions: [
            { sessionId: 'b2-s1', recordType: 'reading_session', date: '2026-11-18', startPercent: 0, endPercent: 100, durationSeconds: 1800, syncStatus: 'synced', syncedToJournal: true, journalEntryId: 'je-b2-1' }
          ]
        },
        [stoicPath]: {
          sessions: [
            { sessionId: 'b3-s1', recordType: 'reading_session', date: '2026-11-20', startPercent: 0, endPercent: 100, durationSeconds: 900, syncStatus: 'synced', syncedToJournal: true, journalEntryId: 'je-b3-1' }
          ]
        }
      }
    };
    const threeReadMap = {
      version: 1,
      books: {
        [donePath]: { bookId: 'book-done-100', title: 'Finished Book Example', author: 'Author', sdPath: donePath, status: 'read', lastSyncedPercent: 100 },
        [mtPath]: { bookId: 'book-mt-9', title: 'Sample Series Vol. 9', author: 'Author Gamma', sdPath: mtPath, status: 'read', lastSyncedPercent: 100 },
        [stoicPath]: { bookId: 'book-daily-stoic', title: 'Sample Non-Fiction B', author: 'Author Beta', sdPath: stoicPath, status: 'read', lastSyncedPercent: 100 }
      }
    };
    sgState.books['book-done-100'].journalEntries = [
      { entryId: 'je-b1-1', date: '2026-11-16', statusKind: 'finished', isStatus: true, pagesDelta: 280, pages: 280, totalPages: 280 }
    ];
    sgState.books['book-mt-9'].journalEntries = [
      { entryId: 'je-b2-1', date: '2026-11-18', statusKind: 'finished', isStatus: true, pagesDelta: 320, pages: 320, totalPages: 320 }
    ];
    sgState.books['book-daily-stoic'].journalEntries = [
      { entryId: 'je-b3-1', date: '2026-11-20', statusKind: 'finished', isStatus: true, pagesDelta: 400, pages: 400, totalPages: 400 }
    ];
    await mockApi.writeFile('/.crosspoint/plugins/storygraph-sync/reading-history.json', Buffer.from(JSON.stringify(cleanHistBase), 'utf8').toString('base64'));
    await mockApi.writeFile('/.crosspoint/plugins/storygraph-sync/storygraph-map.json', Buffer.from(JSON.stringify(threeReadMap), 'utf8').toString('base64'));
    await mockApi.writeFile('/.crosspoint/plugins/storygraph-sync/backfill.json', Buffer.from(JSON.stringify({ books: {} }), 'utf8').toString('base64'));
    await refreshBtn.trigger('click');

    // Test 9 & Test 14: Partial batch failure (Book 1 ok, Book 2 fails 3 attempts, Book 3 ok)
    fetchToSdCalls.length = 0;
    fetchToSdInterceptor = async (url) => {
      if (url.includes('book_id=book-mt-9')) {
        throw new Error('/api/fetch: transport failure');
      }
      return undefined;
    };
    await cleanJournalsBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.className.includes('sg-err'),
      'Test 14: Expected partial batch cleanup to finish with 2 verified clean and 1 failed'
    );
    fetchToSdInterceptor = null;
    assert.ok(
      bannerEl.textContent.includes('2 verified clean') && bannerEl.textContent.includes('1 failed'),
      `Test 14: Expected 2 verified clean + 1 failed breakdown, got "${bannerEl.textContent}"`
    );
    const mapAfterPartial = JSON.parse(virtualFiles.get('storygraph-map.json').toString('utf8'));
    assert.ok(mapAfterPartial.books[donePath].lastJournalCleanedAt, 'Test 14: Book 1 must be stamped after verified success');
    assert.ok(mapAfterPartial.books[stoicPath].lastJournalCleanedAt, 'Test 14: Book 3 must complete and be stamped despite Book 2 failure');
    assert.equal(mapAfterPartial.books[mtPath].lastJournalCleanedAt, undefined, 'Test 9 & 14: Failed Book 2 must NOT be stamped with lastJournalCleanedAt');

    // Test 6: Next Clean Journals run skips Book 1 and Book 3 (cached clean) and only fetches Book 2
    fetchToSdCalls.length = 0;
    await cleanJournalsBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled,
      'Test 6: Expected cached cleanup run to finish'
    );
    assert.equal(fetchToSdCalls.length, 1, 'Test 6: Already-clean Read books (Book 1 & Book 3) must be skipped; only Book 2 fetched');
    assert.ok(fetchToSdCalls[0].url.includes('book_id=book-mt-9'), 'Test 6: Only previously failed Book 2 should be fetched');
    assert.ok(
      bannerEl.textContent.includes('1 verified clean, 2 skipped'),
      `Test 6: Expected "1 verified clean, 2 skipped" in banner, got "${bannerEl.textContent}"`
    );

    // Run once more with all 3 stamped -> 0 fetches (all 3 skipped)
    fetchToSdCalls.length = 0;
    await cleanJournalsBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled,
      'Test 6: Expected fully cached cleanup run to finish with 0 fetches'
    );
    assert.equal(fetchToSdCalls.length, 0, 'Test 6: All 3 verified-clean Read books must require 0 /api/fetch requests');
    assert.ok(bannerEl.textContent.includes('0 verified clean, 3 skipped'), `Expected 3 skipped, got "${bannerEl.textContent}"`);

    // Test 7: Importing a new session for Book 1 invalidates/mismatches watermark and causes re-scan
    const impTextArea = mockContainer.querySelector('#sg-history-textarea');
    const impRunBtn = mockContainer.querySelector('#sg-history-import-run');
    impTextArea.value = JSON.stringify([
      { sdPath: donePath, sessionId: 'b1-s2-new', date: '2026-11-22', startPercent: 95, endPercent: 100, durationSeconds: 300, syncedToJournal: true }
    ]);
    await impRunBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled && bannerEl.textContent.includes('Imported 1 session'),
      'Test 7: Expected session history import to complete'
    );
    const mapAfterImport = JSON.parse(virtualFiles.get('storygraph-map.json').toString('utf8'));
    assert.equal(mapAfterImport.books[donePath].lastJournalCleanedAt, undefined, 'Test 7: Importing new session must invalidate Book 1 cleanup cache');
    fetchToSdCalls.length = 0;
    await cleanJournalsBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled,
      'Test 7: Expected Clean Journals to re-scan Book 1 after new session import'
    );
    assert.equal(fetchToSdCalls.length, 1, 'Test 7: Only Book 1 (with new session) should be re-scanned');
    assert.ok(fetchToSdCalls[0].url.includes('book_id=book-done-100'));

    // Test 8: Pending or needs_reconciliation session on a Read book prevents skip even if watermark matches
    const histWithPending = JSON.parse(virtualFiles.get('reading-history.json').toString('utf8'));
    histWithPending.books[stoicPath].sessions[0].syncStatus = 'needs_reconciliation';
    histWithPending.books[stoicPath].sessions[0].syncedToJournal = false;
    const mapWithMatchingWatermark = JSON.parse(virtualFiles.get('storygraph-map.json').toString('utf8'));
    mapWithMatchingWatermark.books[stoicPath].lastJournalCleanedWatermark = sg.computeBookJournalWatermark(
      histWithPending,
      { sdPath: stoicPath, mapping: mapWithMatchingWatermark.books[stoicPath] }
    );
    assert.equal(
      sg.shouldSkipJournalCleanup({ sdPath: stoicPath, mapping: mapWithMatchingWatermark.books[stoicPath] }, histWithPending),
      false,
      'Test 8: Read book with needs_reconciliation session must NEVER skip cleanup'
    );
    await mockApi.writeFile('/.crosspoint/plugins/storygraph-sync/reading-history.json', Buffer.from(JSON.stringify(histWithPending), 'utf8').toString('base64'));
    await mockApi.writeFile('/.crosspoint/plugins/storygraph-sync/storygraph-map.json', Buffer.from(JSON.stringify(mapWithMatchingWatermark), 'utf8').toString('base64'));
    await refreshBtn.trigger('click');
    fetchToSdCalls.length = 0;
    await cleanJournalsBtn.trigger('click');
    await waitForLong(
      () => !wrapEl.classList.contains('sg-busy') && !verifyBtn.disabled,
      'Test 8: Expected Clean Journals to scan Read book with needs_reconciliation session'
    );
    assert.equal(fetchToSdCalls.length, 2, 'Test 8: Both Book 1 (pending imported session) and Book 3 (needs_reconciliation) must NOT be skipped, while clean Book 2 is skipped');
    assert.ok(fetchToSdCalls.some((c) => c.url.includes('book_id=book-done-100')), 'Test 8: Book 1 (pending) must be fetched');
    assert.ok(fetchToSdCalls.some((c) => c.url.includes('book_id=book-daily-stoic')), 'Test 8: Book 3 (needs_reconciliation) must be fetched');
    assert.ok(!fetchToSdCalls.some((c) => c.url.includes('book_id=book-mt-9')), 'Test 8: Clean synced Book 2 must remain skipped');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('ALL TESTS PASSED');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
