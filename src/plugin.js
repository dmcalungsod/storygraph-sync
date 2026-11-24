// StoryGraph Sync — CrossPoint / CrossInk Browser Plugin (v1.0.1)
// Subscribes to reader.exit / reader.session via device.json -> events.jsonl,
// fetches StoryGraph HTML via api.fetchToSd(), and submits form updates via api.relay().
(function () {
  'use strict';

  const BASE_URL = 'https://app.thestorygraph.com';
  const LS_COOKIE_KEY = 'sgSync.cookieHeader';
  const LS_UA_KEY = 'sgSync.userAgent';
  const LS_AUTO_COMPACT_KEY = 'sgSync.autoCompact';
  const LS_OVERWRITE_LOWER_KEY = 'sgSync.overwriteLower';
  const LS_JOURNAL_NOTES_KEY = 'sgSync.journalNotes';
  const LS_DEVICE_LABEL_KEY = 'sgSync.deviceLabel';
  const DEFAULT_DEVICE_LABEL = 'CrossPoint';
  const MAP_FILE = 'storygraph-map.json';
  const HISTORY_FILE = 'reading-history.json';
  const EVENTS_FILE = 'events.jsonl';
  const BACKFILL_FILE = 'backfill.json';
  const FETCH_TMP_FILE = 'tmp-fetch.html';
  const OUTBOX_LIMIT_BYTES = 4096;
  const OUTBOX_WARN_BYTES = 3072;
  const FETCH_RETRY_DELAYS_MS = [900, 1800];
  const CLEAN_JOURNALS_PACING_MS = 600;

  function computePercentFromBp(bpVal, scaleVal) {
    const bp = toFiniteNumber(bpVal);
    if (bp === null) return null;
    if (bp <= 0) return 0;
    const scaleRaw = toFiniteNumber(scaleVal);
    const scale = scaleRaw && scaleRaw > 0 ? scaleRaw : 10000;
    return Math.max(1, Math.min(100, Math.round((bp / scale) * 100)));
  }

  function isTransientFetchError(err, fetchRes) {
    const st =
      (fetchRes && typeof fetchRes.status === 'number' ? fetchRes.status : null) ??
      (err && typeof err.status === 'number' ? err.status : null);
    if (st === 401 || st === 403 || st === 503 || st === 422) return false;
    const rawMsg =
      (fetchRes && fetchRes.error ? String(fetchRes.error) + ' ' : '') +
      (err && err.message ? String(err.message) : err ? String(err) : '');
    const lower = rawMsg.toLowerCase();
    if (
      lower.includes('cloudflare') ||
      lower.includes('sign_in') ||
      lower.includes('expired') ||
      lower.includes('blocked') ||
      /\b(401|403|503|422)\b/.test(lower)
    ) {
      return false;
    }
    if (st === 502 || st === 504 || st === 408 || st === 500) return true;
    if (fetchRes && fetchRes.complete === false) return true;
    return (
      lower.includes('transport failure') ||
      lower.includes('timeout') ||
      lower.includes('timed out') ||
      lower.includes('socket') ||
      lower.includes('econnreset') ||
      lower.includes('econnrefused') ||
      lower.includes('epipe') ||
      lower.includes('network') ||
      lower.includes('failed to fetch') ||
      lower.includes('incomplete') ||
      /\b(502|504)\b/.test(lower)
    );
  }

  function pluginPath(dir, filename) {
    const cleanDir =
      typeof dir === 'string' && dir.startsWith('/')
        ? dir.replace(/\/+$/, '')
        : '/.crosspoint/plugins/storygraph-sync';
    const cleanFile = String(filename || '').replace(/^\/+/, '');
    return `${cleanDir}/${cleanFile}`;
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(String(str ?? ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function toFiniteNumber(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function extractFilenameMeta(sdPath) {
    const raw = String(sdPath || '');
    const filename = raw.split('/').pop() || raw;
    const stem = filename.replace(/\.(epub|txt|xtc|kepub|pdf|md)$/i, '').trim();
    const sepIdx = stem.lastIndexOf(' - ');
    const title = sepIdx > 0 ? stem.slice(0, sepIdx).trim() : stem;
    const author = sepIdx > 0 ? stem.slice(sepIdx + 3).trim() : '';
    return {
      filename,
      title: title || filename,
      author,
      normFilename: normalizeText(filename),
      normTitle: normalizeText(title || filename),
      normAuthor: normalizeText(author)
    };
  }

  function isBookFileEntry(entry) {
    if (!entry || entry.isDirectory) return false;
    const name = String(entry.name || '').trim();
    if (!name || name.startsWith('.') || name.toLowerCase() === 'my clippings.txt') return false;
    return Boolean(entry.isEpub || /\.(epub|xtc|xtch|kepub|txt|md|pdf|fb2|mobi|cbz)$/i.test(name));
  }

  function joinSdPath(dirPath, name) {
    const rawDir = String(dirPath || '/').trim() || '/';
    const cleanDir = rawDir === '/' ? '/' : ('/' + rawDir.replace(/^\/+|\/+$/g, ''));
    const cleanName = String(name || '').trim().replace(/^\/+|\/+$/g, '');
    if (!cleanName) return cleanDir;
    return cleanDir === '/' ? '/' + cleanName : cleanDir + '/' + cleanName;
  }

  function parentSdPath(dirPath) {
    const clean = String(dirPath || '/').trim().replace(/\/+$/g, '');
    if (!clean || clean === '/') return '/';
    const idx = clean.lastIndexOf('/');
    return idx > 0 ? clean.slice(0, idx) : '/';
  }

  function filterAndSortSdEntries(entries) {
    const filtered = [];
    for (const entry of entries || []) {
      if (!entry) continue;
      const name = String(entry.name || '').trim();
      if (!name || name.startsWith('.')) continue;
      if (entry.isDirectory || isBookFileEntry(entry)) {
        filtered.push(entry);
      }
    }
    filtered.sort((a, b) => {
      if (Boolean(a.isDirectory) !== Boolean(b.isDirectory)) {
        return a.isDirectory ? -1 : 1;
      }
      return String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase());
    });
    return filtered;
  }

  function parseCookieHeader(rawInput) {
    const input = String(rawInput || '').trim();
    const map = {};
    if (!input) return map;

    // 1. Cookie-Editor JSON export: array of { name, value, domain? } or { cookies: [...] }
    if (input.startsWith('[') || input.startsWith('{')) {
      try {
        const parsed = JSON.parse(input);
        const list = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.cookies)
            ? parsed.cookies
            : null;
        if (list) {
          const sgOnly = list.filter(
            (c) => c && typeof c.domain === 'string' && /storygraph/i.test(c.domain)
          );
          const source = sgOnly.length > 0 ? sgOnly : list;
          for (const c of source) {
            if (!c || !c.name) continue;
            const name = String(c.name).trim();
            const value = c.value === undefined || c.value === null ? '' : String(c.value).trim();
            if (name && value) map[name] = value;
          }
          if (Object.keys(map).length > 0) return map;
        }
      } catch (_) {}
    }

    // 2. Netscape cookies.txt (tab-separated, 7+ columns; keep #HttpOnly_ lines)
    if (input.includes('\t')) {
      const lines = input.split(/\r?\n/);
      const netscapeRows = [];
      for (const rawLine of lines) {
        let line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
          if (/^#HttpOnly_/i.test(line)) line = line.slice('#HttpOnly_'.length);
          else continue;
        }
        const cols = line.split('\t');
        if (cols.length >= 7 && cols[5] && cols[6] !== undefined) {
          netscapeRows.push({
            domain: cols[0].trim(),
            name: cols[5].trim(),
            value: cols[6].trim()
          });
        }
      }
      if (netscapeRows.length > 0) {
        const sgRows = netscapeRows.filter((r) => /storygraph/i.test(r.domain));
        const source = sgRows.length > 0 ? sgRows : netscapeRows;
        for (const r of source) {
          if (r.name && r.value) map[r.name] = r.value;
        }
        if (Object.keys(map).length > 0) return map;
      }
    }

    // 3. Copy as cURL (-H 'cookie: ...' or -b '...' / --cookie "...")
    let headerStr = input;
    if (/^\s*curl\b/i.test(headerStr) || /(?:^|\s)(?:-H\s+['"]?cookie:|-b\s+|--cookie\s+)/i.test(headerStr)) {
      const hMatch = headerStr.match(/-H\s+(['"])\s*cookie\s*:\s*([\s\S]*?)\1/i);
      const bMatch = headerStr.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/i);
      const unquotedH = headerStr.match(/-H\s+cookie\s*:\s*([^\s]+)/i);
      if (hMatch) headerStr = hMatch[2];
      else if (bMatch) headerStr = bMatch[2];
      else if (unquotedH) headerStr = unquotedH[1];
    }

    // 4. DevTools "cookie:" / "Cookie:" prefix, wrapping quotes, and wrapped line breaks
    headerStr = headerStr
      .replace(/\r?\n/g, ' ')
      .trim()
      .replace(/^(?:request\s+)?cookie\s*:\s*/i, '')
      .trim();
    if (
      (headerStr.startsWith('"') && headerStr.endsWith('"')) ||
      (headerStr.startsWith("'") && headerStr.endsWith("'"))
    ) {
      headerStr = headerStr.slice(1, -1).trim();
    }
    if (!headerStr) return map;

    // 5. Bare session token or standard name=value; ... header
    if (!headerStr.includes('=') && !headerStr.includes(';')) {
      map._storygraph_session = headerStr;
      return map;
    }

    for (const part of headerStr.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (name && value) {
        map[name] = value;
      }
    }
    return map;
  }

  function serializeCookieMap(cookieMap) {
    const merged = Object.assign(
      { cookies_popup_seen: 'yes', plus_popup_seen: 'yes' },
      cookieMap || {}
    );
    const parts = [];
    for (const [k, v] of Object.entries(merged)) {
      if (k && v !== undefined && v !== null && String(v) !== '') {
        parts.push(`${k}=${String(v)}`);
      }
    }
    return parts.join('; ');
  }

  function mergeSetCookieHeaders(cookieMap, headerPairs) {
    const next = Object.assign({}, cookieMap || {});
    let changed = false;
    for (const pair of headerPairs || []) {
      const name = String(pair[0] || '').toLowerCase();
      if (name !== 'set-cookie') continue;
      const cookiePart = String(pair[1] || '').split(';', 1)[0];
      const eq = cookiePart.indexOf('=');
      if (eq <= 0) continue;
      const cName = cookiePart.slice(0, eq).trim();
      const cVal = cookiePart.slice(eq + 1).trim();
      if (cName && cVal && next[cName] !== cVal) {
        next[cName] = cVal;
        changed = true;
      }
    }
    return { map: next, changed };
  }

  function measureHeaderBytes(headers) {
    let total = 0;
    for (const [k, v] of Object.entries(headers || {})) {
      total += String(k).length + String(v ?? '').length + 4;
    }
    return total;
  }

  function serializeEssentialCookies(cookieMap) {
    const essential = {};
    for (const [k, v] of Object.entries(cookieMap || {})) {
      if (!k || v === undefined || v === null || String(v) === '') continue;
      if (
        k === '_storygraph_session' ||
        k === 'remember_user_token' ||
        k === 'cookies_popup_seen' ||
        k === 'plus_popup_seen' ||
        /^(__)?cf/i.test(k)
      ) {
        essential[k] = v;
      }
    }
    return serializeCookieMap(essential);
  }

  function fitHeadersForCrossInk(headers, cookieMap, maxBytes = 3900) {
    const next = Object.assign({}, headers || {});
    const cookieKey = Object.keys(next).find((k) => k.toLowerCase() === 'cookie');
    if (measureHeaderBytes(next) > maxBytes && cookieKey && next[cookieKey]) {
      next[cookieKey] = serializeEssentialCookies(cookieMap);
    }
    const bytes = measureHeaderBytes(next);
    if (Object.keys(next).length > 16 || bytes > 4096) {
      throw new Error(
        `Request headers (${bytes} B) exceed CrossInk's 4 KB limit. Trim extra cookies in Account Settings (keep _storygraph_session and cf_clearance).`
      );
    }
    return next;
  }

  function isRelay502Error(err) {
    if (!err) return false;
    if (err.status === 502) return true;
    const msg = String(err.message || err).toLowerCase();
    return msg.includes('/api/relay') && (msg.includes('502') || msg.includes('relay failed'));
  }

  function didBookReachProgressTarget(pageInfo, { usePages, progressValue, devicePercent } = {}) {
    if (!pageInfo) return false;
    if (devicePercent === 100 && pageInfo.status === 'read') return true;
    if (usePages) {
      if (pageInfo.lastReachedPages !== null && pageInfo.lastReachedPages !== undefined) {
        return pageInfo.lastReachedPages === progressValue;
      }
      if (pageInfo.lastReachedPercent !== null && pageInfo.lastReachedPercent !== undefined) {
        return Math.abs(pageInfo.lastReachedPercent - devicePercent) <= 1;
      }
      return false;
    }
    return (
      pageInfo.lastReachedPercent !== null &&
      pageInfo.lastReachedPercent !== undefined &&
      pageInfo.lastReachedPercent === devicePercent
    );
  }

  const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ];

  function formatHumanDate(val) {
    if (val === null || val === undefined || val === '') return '';
    if (typeof val === 'string') {
      const trimmed = val.trim();
      const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(trimmed);
      if (m) {
        const year = parseInt(m[1], 10);
        const month = parseInt(m[2], 10);
        const day = parseInt(m[3], 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
        }
      }
      if (/^[A-Za-z]+\s+\d{1,2},\s+\d{4}$/.test(trimmed)) {
        return trimmed;
      }
    }
    try {
      const d = typeof val === 'number' ? new Date(val * 1000) : new Date(val);
      if (Number.isNaN(d.getTime())) return typeof val === 'string' ? val : '';
      return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    } catch (_) {
      return typeof val === 'string' ? val : '';
    }
  }

  function formatHumanDateRange(startVal, endVal, fallbackVal) {
    const startParts = parseIsoDateParts(startVal);
    const endParts = parseIsoDateParts(endVal);
    if (startParts && endParts && startParts.iso !== endParts.iso) {
      if (startParts.year === endParts.year) {
        return `${MONTH_NAMES[startParts.month - 1]} ${startParts.day} → ${MONTH_NAMES[endParts.month - 1]} ${endParts.day}, ${endParts.year}`;
      }
      return `${MONTH_NAMES[startParts.month - 1]} ${startParts.day}, ${startParts.year} → ${MONTH_NAMES[endParts.month - 1]} ${endParts.day}, ${endParts.year}`;
    }
    const startStr = formatHumanDate(startVal);
    const endStr = formatHumanDate(endVal);
    const fallbackStr = formatHumanDate(fallbackVal);
    if (startStr && endStr && startStr !== endStr) {
      return `${startStr} → ${endStr}`;
    }
    return endStr || startStr || fallbackStr || '';
  }

  const SG_MONTH_MAP = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12
  };

  function pad2DatePart(n) {
    return String(n).padStart(2, '0');
  }

  function formatIsoDateParts(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return {
      year,
      month,
      day,
      iso: `${String(year).padStart(4, '0')}-${pad2DatePart(month)}-${pad2DatePart(day)}`
    };
  }

  function parseIsoDateParts(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'object' && val.year && val.month && val.day) {
      return formatIsoDateParts(Number(val.year), Number(val.month), Number(val.day));
    }
    const trimmed = String(val).trim();
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]|$)/.exec(trimmed);
    if (!m) return null;
    return formatIsoDateParts(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  }

  function parseStoryGraphDisplayDate(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    const m = /\b([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})\b/.exec(cleaned);
    if (!m) return null;
    const month = SG_MONTH_MAP[m[1].toLowerCase()];
    if (!month) return null;
    const parts = formatIsoDateParts(parseInt(m[3], 10), month, parseInt(m[2], 10));
    return parts ? parts.iso : null;
  }

  function resolveBookTargetDates(row, status) {
    let start = parseIsoDateParts(row && row.startDate);
    let end = parseIsoDateParts(row && row.lastDate);
    if (!start && !end) {
      const ts = toFiniteNumber(row && row.lastReadTs);
      if (ts !== null && ts > 0) {
        const d = new Date(ts * 1000);
        if (!Number.isNaN(d.getTime())) {
          end = formatIsoDateParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
        }
      }
    }
    if (start && end && start.iso > end.iso) {
      start = end;
    }
    if (status === 'read') {
      return {
        startDate: start || end || null,
        finishDate: end || start || null
      };
    }
    if (status === 'currently-reading' || status === 'rereading') {
      return {
        startDate: start || end || null,
        finishDate: null
      };
    }
    return { startDate: null, finishDate: null };
  }

  function buildReadInstanceDateBody({ bookId, readInstanceId, csrf, startDate, finishDate }) {
    const start = parseIsoDateParts(startDate);
    const finish = parseIsoDateParts(finishDate);
    const params = new URLSearchParams();
    params.set('_method', 'patch');
    params.set('authenticity_token', String(csrf || ''));
    params.set('read_instance[start_day]', start ? String(start.day) : '');
    params.set('read_instance[start_month]', start ? String(start.month) : '');
    params.set('read_instance[start_year]', start ? String(start.year) : '');
    params.set('read_instance[day]', finish ? String(finish.day) : '');
    params.set('read_instance[month]', finish ? String(finish.month) : '');
    params.set('read_instance[year]', finish ? String(finish.year) : '');
    params.set('book_id', String(bookId || ''));
    params.set('read_instance_id', String(readInstanceId || ''));
    params.set('commit', 'Update');
    return params.toString();
  }

  function buildStartJournalDateBody({ bookId, journalEntryId, csrf, startDate }) {
    const start = parseIsoDateParts(startDate);
    const params = new URLSearchParams();
    params.set('_method', 'patch');
    params.set('authenticity_token', String(csrf || ''));
    params.set('journal_entry[day]', start ? String(start.day) : '');
    params.set('journal_entry[month]', start ? String(start.month) : '');
    params.set('journal_entry[year]', start ? String(start.year) : '');
    params.set('book_id', String(bookId || ''));
    params.set('journal_entry_id', String(journalEntryId || ''));
    params.set('commit', 'Update');
    return params.toString();
  }

  function getDateSyncCandidateRows(rows) {
    return (rows || []).filter((r) => {
      if (!r || !r.mapping || !r.mapping.bookId) return false;
      const st = r.mapping.status;
      if (st === 'read') {
        const target = resolveBookTargetDates(r, 'read');
        if (!target.finishDate) return false;
        const targetStartIso = target.startDate ? target.startDate.iso : '';
        return (
          r.mapping.lastSyncedFinishDate !== target.finishDate.iso ||
          r.mapping.lastSyncedStartDate !== targetStartIso
        );
      }
      if (st === 'currently-reading' || st === 'rereading') {
        const target = resolveBookTargetDates(r, st);
        if (!target.startDate) return false;
        return r.mapping.lastSyncedStartDate !== target.startDate.iso;
      }
      return false;
    });
  }

  function getPendingSyncRows(rows) {
    return (rows || []).filter(isRowNeedsSync);
  }

  function classifyBookRow(row) {
    if (!row || !row.mapping || !row.mapping.bookId) return 'unlinked';
    return row.mapping.status === 'read' ? 'read' : 'reading';
  }

  // Unsynced journal sessions (row.unsyncedJournalCount) count as pending even when % is unchanged.
  function isRowNeedsSync(row) {
    return Boolean(
      row &&
        row.mapping &&
        row.mapping.bookId &&
        row.mapping.status !== 'read' &&
        row.devicePercent !== null &&
        row.devicePercent !== undefined &&
        row.devicePercent > 0 &&
        (row.devicePercent !== row.mapping.lastSyncedPercent || (row.unsyncedJournalCount || 0) > 0)
    );
  }

  function isRowNeedsDateSync(row) {
    return row ? getDateSyncCandidateRows([row]).length > 0 : false;
  }

  function rowDateSortKey(row) {
    if (!row) return 0;
    const ts = toFiniteNumber(row.lastReadTs);
    if (ts !== null && ts > 0) return ts;
    const dStr = row.lastDate || row.startDate;
    if (dStr) {
      const parsed = Date.parse(dStr);
      if (Number.isFinite(parsed)) return parsed / 1000;
    }
    return 0;
  }

  function filterAndSortBookRows(rows, opts = {}) {
    const filter = opts.filter || 'all';
    const q = String(opts.query || '').trim().toLowerCase();
    const sort = opts.sort || 'smart';

    const list = (rows || []).filter((r) => {
      if (!r) return false;
      if (filter === 'reading' && classifyBookRow(r) !== 'reading') return false;
      if (filter === 'needs-sync' && !isRowNeedsSync(r)) return false;
      if (filter === 'read' && classifyBookRow(r) !== 'read') return false;
      if (filter === 'unlinked' && classifyBookRow(r) !== 'unlinked') return false;
      if (q) {
        const hay = `${r.title || ''} ${r.author || ''} ${r.sdPath || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const smartPriority = (r) => {
      if (r.staged) return 0;
      if (isRowNeedsSync(r)) return 1;
      const cls = classifyBookRow(r);
      if (cls === 'reading') return 2;
      if (cls === 'unlinked') return 3;
      return 4;
    };

    return list.slice().sort((a, b) => {
      if (sort === 'title') {
        return String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
      }
      if (sort === 'progress') {
        const pctDiff = (b.devicePercent ?? -1) - (a.devicePercent ?? -1);
        if (pctDiff !== 0) return pctDiff;
      } else if (sort === 'smart') {
        const priDiff = smartPriority(a) - smartPriority(b);
        if (priDiff !== 0) return priDiff;
      } else if (Boolean(a.staged) !== Boolean(b.staged)) {
        return a.staged ? -1 : 1;
      }
      const timeDiff = rowDateSortKey(b) - rowDateSortKey(a);
      if (timeDiff !== 0) return timeDiff;
      return String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
    });
  }

  function localIsoDateFromTs(tsSec) {
    const n = toFiniteNumber(tsSec);
    if (n === null || n <= 0) return '';
    const sec = n > 1e12 ? Math.floor(n / 1000) : n;
    const d = new Date(sec * 1000);
    if (Number.isNaN(d.getTime())) return '';
    const parts = formatIsoDateParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return parts ? parts.iso : '';
  }

  function parseStoryGraphJournalDate(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    const dmy = /\b(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})\b/.exec(cleaned);
    if (dmy) {
      const month = SG_MONTH_MAP[dmy[2].toLowerCase()];
      if (month) {
        const parts = formatIsoDateParts(parseInt(dmy[3], 10), month, parseInt(dmy[1], 10));
        if (parts) return parts.iso;
      }
    }
    return parseStoryGraphDisplayDate(cleaned);
  }

  function extractNodeSpacedText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.nodeType === 3) return String(node.textContent || '');
    if (Array.isArray(node._textParts) && node._textParts.length > 0) {
      return node._textParts.map((part) => extractNodeSpacedText(part)).join(' ');
    }
    if (node.childNodes && node.childNodes.length > 0) {
      const parts = [];
      for (let i = 0; i < node.childNodes.length; i++) {
        parts.push(extractNodeSpacedText(node.childNodes[i]));
      }
      return parts.join(' ');
    }
    return String(node.textContent || '');
  }

  function parseStoryGraphJournalPage(html) {
    const doc = parseHtmlDocument(html);
    const guards = detectHtmlGuards(doc, html);
    const entries = [];
    const seenBlocks = new Set();

    for (const link of doc.querySelectorAll('a[href*="/journal_entries/"]')) {
      const block =
        link.closest('.mb-3') ||
        link.parentElement?.parentElement?.parentElement?.parentElement ||
        link.parentElement?.parentElement ||
        link.parentElement;
      if (!block || seenBlocks.has(block)) continue;
      seenBlocks.add(block);

      const href = link.getAttribute('href') || '';
      const idMatch = href.match(/\/journal_entries\/([^/?#"]+)\/edit/i);
      const entryId = idMatch ? idMatch[1] : null;

      const text = extractNodeSpacedText(block).replace(/\s+/g, ' ').trim();
      const date = parseStoryGraphJournalDate(text);
      if (!date) continue;

      const pctMatch = text.match(/\b(\d{1,3})%/);
      const rawPercent = pctMatch ? Number(pctMatch[1]) : null;
      const pagesMatch = text.match(/\((\d+)\s+pages?\s+out\s+of\s+(\d+)\)/i);
      const pages = pagesMatch ? Number(pagesMatch[1]) : null;
      const totalPages = pagesMatch ? Number(pagesMatch[2]) : null;
      const deltaMatch = text.match(/\b(\d+)\s+pages?\s+read\b/i);
      const pagesDelta = deltaMatch ? Number(deltaMatch[1]) : null;

      let statusKind = null;
      if (
        /\bEdit\s+Started reading\b/i.test(text) ||
        (rawPercent === null && pages === null && /\bStarted reading\b/i.test(text))
      ) {
        statusKind = 'started';
      } else if (
        /\bEdit\s+Finished\b/i.test(text) ||
        (rawPercent === null && /\bFinished\b/i.test(text))
      ) {
        statusKind = 'finished';
      } else if (/\bEdit\s+(Paused|Resumed|Did not finish)\b/i.test(text)) {
        statusKind = 'other-status';
      }
      const isStatus = Boolean(statusKind);
      const percent = rawPercent !== null ? rawPercent : statusKind === 'finished' ? 100 : null;

      let note = '';
      const trixEls = block.querySelectorAll('.trix-content');
      if (trixEls && trixEls.length > 0) {
        const lastTrix = trixEls[trixEls.length - 1];
        note = extractNodeSpacedText(lastTrix).replace(/\s+/g, ' ').trim();
      }

      entries.push({
        entryId,
        date,
        statusKind,
        isStatus,
        percent,
        pages,
        pagesDelta,
        totalPages,
        note
      });
    }

    return Object.assign({}, guards, { entries });
  }

  function buildJournalEntryUpdateBody({
    csrf,
    date,
    pagesRead,
    pagesReadTotal,
    percentReached,
    note,
    returnTo
  }) {
    const parts = parseIsoDateParts(date);
    const params = new URLSearchParams();
    params.set('_method', 'put');
    params.set('authenticity_token', String(csrf || ''));
    params.set('journal_entry[day]', parts ? String(parts.day) : '');
    params.set('journal_entry[month]', parts ? String(parts.month) : '');
    params.set('journal_entry[year]', parts ? String(parts.year) : '');
    params.set('journal_entry[pages_read]', String(pagesRead ?? 0));
    params.set('journal_entry[pages_read_total]', String(pagesReadTotal ?? 0));
    params.set('journal_entry[percent_reached]', String(percentReached ?? 100));
    params.set('journal_entry[note]', String(note || ''));
    params.set('return_to', String(returnTo || ''));
    return params.toString();
  }

  function buildJournalEntryDeleteBody(csrf) {
    const params = new URLSearchParams();
    params.set('_method', 'delete');
    params.set('authenticity_token', String(csrf || ''));
    return params.toString();
  }

  function planJournalCleanup(entries, opts = {}) {
    const list = Array.isArray(entries) ? entries.filter((e) => e && e.entryId && e.date) : [];
    const claimedSet =
      opts && opts.claimedEntryIds instanceof Set
        ? opts.claimedEntryIds
        : new Set(Array.isArray(opts && opts.claimedEntryIds) ? opts.claimedEntryIds : []);
    const hasZeroPctSession = Boolean(opts && opts.hasZeroPctSession);
    const updates = [];
    const deletes = [];
    const toDeleteIds = new Set();

    const markDelete = (entry, reason) => {
      if (!entry || !entry.entryId || toDeleteIds.has(entry.entryId) || claimedSet.has(entry.entryId)) return;
      toDeleteIds.add(entry.entryId);
      deletes.push({
        entryId: entry.entryId,
        date: entry.date,
        percent: entry.percent,
        pages: entry.pages,
        pagesDelta: entry.pagesDelta,
        reason
      });
    };

    const isGenuineFinalSession = (e) => {
      if (!e || e.isStatus) return false;
      if (e.entryId && claimedSet.has(e.entryId)) return true;
      if (e.note && String(e.note).trim().length > 0) return true;
      if (
        e.pagesDelta !== null &&
        e.pagesDelta !== undefined &&
        e.pagesDelta > 0 &&
        e.totalPages &&
        e.pagesDelta < e.totalPages
      ) {
        return true;
      }
      return false;
    };

    // Rule 1: Bogus 0% reset entries (un-ledgered, no note, 0% and 0 pages)
    if (!hasZeroPctSession) {
      for (const e of list) {
        if (
          !e.isStatus &&
          !claimedSet.has(e.entryId) &&
          !e.note &&
          e.percent === 0 &&
          (e.pages === 0 || e.pages === null) &&
          (e.pagesDelta === 0 || e.pagesDelta === null)
        ) {
          markDelete(e, '0% progress entry');
        }
      }
    }

    // Rule 2: 100% progress entries alongside a Finished status entry
    const finishedEntries = list.filter((e) => e.statusKind === 'finished');
    const hundredProgressEntries = list.filter(
      (e) =>
        !e.isStatus &&
        !toDeleteIds.has(e.entryId) &&
        (e.percent === 100 || (e.totalPages && e.pages === e.totalPages))
    );
    if (finishedEntries.length > 0 && hundredProgressEntries.length > 0) {
      const fin = finishedEntries[finishedEntries.length - 1];
      const genuineHundred = hundredProgressEntries.filter(isGenuineFinalSession);
      const strayHundred = hundredProgressEntries.filter((e) => !isGenuineFinalSession(e));

      if (genuineHundred.length > 0) {
        // Genuine final reading session(s) exist: preserve them and prevent Finished from double-counting pages
        if ((fin.pagesDelta || 0) > 0) {
          const totalPgs =
            fin.totalPages ||
            genuineHundred[genuineHundred.length - 1].totalPages ||
            fin.pages ||
            genuineHundred[genuineHundred.length - 1].pages ||
            0;
          updates.push({
            entryId: fin.entryId,
            date: fin.date,
            pagesRead: 0,
            pagesReadTotal: totalPgs,
            percentReached: 100,
            note: fin.note || '',
            reason: 'clear duplicate page credit on Finished alongside genuine final reading session'
          });
        }
        for (const h of strayHundred) {
          markDelete(h, 'duplicate 100% progress entry alongside Finished');
        }
      } else if (strayHundred.length > 0) {
        const strayWithPages = strayHundred.find((e) => (e.pagesDelta || 0) > 0);
        if ((fin.pagesDelta === 0 || fin.pagesDelta === null) && strayWithPages) {
          const totalPgs =
            fin.totalPages ||
            strayWithPages.totalPages ||
            fin.pages ||
            strayWithPages.pages ||
            strayWithPages.pagesDelta;
          updates.push({
            entryId: fin.entryId,
            date: fin.date,
            pagesRead: strayWithPages.pagesDelta,
            pagesReadTotal: totalPgs,
            percentReached: 100,
            note: fin.note || strayWithPages.note || '',
            reason: 'transfer page credit to Finished entry'
          });
        }
        for (const h of strayHundred) {
          markDelete(h, 'duplicate 100% progress entry alongside Finished');
        }
      }
    }

    // Rule 3: Same-day intermediate progress entry when Finished on that date credits full book pages
    for (const fin of finishedEntries) {
      const fullPages = fin.totalPages || fin.pages || 0;
      if (fullPages > 0 && fin.pagesDelta !== null && fin.pagesDelta >= fullPages) {
        const sameDayIntermediates = list.filter(
          (e) =>
            !e.isStatus &&
            !toDeleteIds.has(e.entryId) &&
            e.date === fin.date &&
            (e.pagesDelta || 0) > 0 &&
            (e.percent === null || e.percent < 100)
        );
        const genuineIntermediates = sameDayIntermediates.filter(
          (e) => claimedSet.has(e.entryId) || Boolean(e.note && String(e.note).trim())
        );
        if (genuineIntermediates.length > 0) {
          const lastGenuine = genuineIntermediates[genuineIntermediates.length - 1];
          const reachedPages = lastGenuine.pages || lastGenuine.pagesDelta || 0;
          const remainingDelta = Math.max(0, fullPages - reachedPages);
          if (fin.pagesDelta !== remainingDelta && !updates.some((u) => u.entryId === fin.entryId)) {
            updates.push({
              entryId: fin.entryId,
              date: fin.date,
              pagesRead: remainingDelta,
              pagesReadTotal: fullPages,
              percentReached: 100,
              note: fin.note || '',
              reason: 'adjust Finished sitting delta to preserve same-day intermediate session'
            });
          }
        }
        for (const e of sameDayIntermediates) {
          if (!claimedSet.has(e.entryId) && !(e.note && String(e.note).trim())) {
            markDelete(e, 'same-day progress already credited in Finished entry');
          }
        }
      }
    }

    return { updates, deletes };
  }

  function buildDatedProgressFormBody({
    bookId,
    csrf,
    date,
    progressValue,
    progressType,
    bookNumOfPages,
    lastReachedPages,
    lastReachedPercent,
    note,
    returnTo
  }) {
    const parts = parseIsoDateParts(date);
    const params = new URLSearchParams();
    params.set('authenticity_token', String(csrf || ''));
    params.set('progress_update_date[day]', parts ? String(parts.day) : '');
    params.set('progress_update_date[month]', parts ? String(parts.month) : '');
    params.set('progress_update_date[year]', parts ? String(parts.year) : '');
    params.set('progress_number', String(progressValue ?? 0));
    params.set('progress_type', progressType === 'pages' ? 'pages' : 'percentage');
    params.set('last_reached_pages', String(lastReachedPages ?? 0));
    params.set('book_num_of_pages', String(bookNumOfPages || 0));
    params.set('last_reached_percent', String(lastReachedPercent ?? 0));
    params.set('note', String(note || ''));
    params.set('book_id', String(bookId || ''));
    params.set('return_to', String(returnTo || ''));
    return params.toString();
  }

  function formatLocalClockFromTs(tsSeconds) {
    const n = toFiniteNumber(tsSeconds);
    if (n === null || n <= 0) return '';
    const d = new Date(n * 1000);
    if (!Number.isFinite(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function getTimeOfDayPeriodFromTs(tsSeconds) {
    const n = toFiniteNumber(tsSeconds);
    if (n === null || n <= 0) return '';
    const d = new Date(n * 1000);
    if (!Number.isFinite(d.getTime())) return '';
    const h = d.getHours();
    if (h >= 5 && h < 12) return 'Morning';
    if (h >= 12 && h < 17) return 'Afternoon';
    if (h >= 17 && h < 21) return 'Evening';
    return 'Night';
  }

  function formatShortMonthDay(isoDate) {
    const parts = parseIsoDateParts(isoDate);
    if (!parts) return '';
    const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${shortMonths[parts.month - 1]} ${parts.day}`;
  }

  function formatDurationLabel(sec) {
    const s = Math.round(Number(sec) || 0);
    if (s <= 0) return '';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}h ${remM}m`;
  }

  function formatSessionTimeRangeLabel(session) {
    if (!session) return '';
    const startClock = formatLocalClockFromTs(session.startTime);
    const endClock = formatLocalClockFromTs(session.endTime);
    if (!startClock && !endClock) return '';
    const startIso = session.startDate || (session.startTime ? localIsoDateFromTs(session.startTime) : '');
    const endIso = session.date || (session.endTime ? localIsoDateFromTs(session.endTime) : '');
    if (startClock && endClock) {
      if (startIso && endIso && startIso !== endIso) {
        return `${startClock} (${formatShortMonthDay(startIso)})–${endClock}`;
      }
      if (startClock !== endClock) {
        return `${startClock}–${endClock}`;
      }
    }
    return startClock || endClock;
  }

  function formatSessionJournalNote(session, includeDurationNotes, deviceLabel) {
    if (!includeDurationNotes || !session) return '';
    const label = String(deviceLabel || '').trim() || DEFAULT_DEVICE_LABEL;
    const durStr = formatDurationLabel(session.durationSeconds);
    const rangeStr = formatSessionTimeRangeLabel(session);
    if (rangeStr && durStr) {
      return `${rangeStr} · ${durStr} read on ${label}`;
    }
    if (durStr) {
      return `${durStr} read on ${label}`;
    }
    if (rangeStr) {
      return `${rangeStr} · read on ${label}`;
    }
    return '';
  }

  function compareSessionRecords(a, b) {
    const aStart = a.startTime ?? a.endTime ?? a.sortTs ?? 0;
    const bStart = b.startTime ?? b.endTime ?? b.sortTs ?? 0;
    const aDate = String(a.date || '');
    const bDate = String(b.date || '');
    if (aStart > 0 && bStart > 0 && aStart !== bStart) {
      return aStart - bStart;
    }
    if (aDate !== bDate) {
      return aDate.localeCompare(bDate);
    }
    const aEnd = a.endTime ?? a.startTime ?? a.sortTs ?? 0;
    const bEnd = b.endTime ?? b.startTime ?? b.sortTs ?? 0;
    if (aEnd !== bEnd) {
      return aEnd - bEnd;
    }
    return String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
  }

  function normalizeSessionRecord(raw, fallbackIdx = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const endTime = toFiniteNumber(raw.endTime ?? raw.end_time);
    const startTime = toFiniteNumber(raw.startTime ?? raw.start_time);
    const sortTs = toFiniteNumber(raw.sortTs ?? raw.ts) ?? endTime ?? startTime ?? null;
    const dateParts = parseIsoDateParts(raw.date);
    const date = (dateParts && dateParts.iso) || localIsoDateFromTs(endTime ?? sortTs ?? startTime);
    if (!date) return null;
    const startDateParts = parseIsoDateParts(raw.startDate);
    const startDate =
      (startDateParts && startDateParts.iso) ||
      (startTime !== null ? localIsoDateFromTs(startTime) || date : date);
    const recordType =
      raw.recordType === 'progress_checkpoint' ||
      raw.recordType === 'legacy_daily_summary' ||
      raw.recordType === 'reading_session'
        ? raw.recordType
        : 'reading_session';
    const durationSeconds = Math.max(0, Math.round(toFiniteNumber(raw.durationSeconds ?? raw.duration_seconds) || 0));
    const startProgressBp = toFiniteNumber(raw.startProgressBp ?? raw.start_progress_bp);
    const endProgressBp = toFiniteNumber(raw.endProgressBp ?? raw.end_progress_bp);
    const progressScale = toFiniteNumber(raw.progressScale ?? raw.progress_scale) || 10000;
    let startPercent = toFiniteNumber(raw.startPercent);
    if (startProgressBp !== null && (startPercent === null || (startPercent === 0 && startProgressBp > 0))) {
      startPercent = computePercentFromBp(startProgressBp, progressScale);
    }
    let endPercent = toFiniteNumber(raw.endPercent);
    if (endProgressBp !== null && (endPercent === null || (endPercent === 0 && endProgressBp > 0))) {
      endPercent = computePercentFromBp(endProgressBp, progressScale);
    }
    const synced = Boolean(raw.syncedToJournal || raw.syncStatus === 'synced');
    const syncStatus =
      raw.syncStatus === 'in_flight' || raw.syncStatus === 'needs_reconciliation'
        ? raw.syncStatus
        : synced
          ? 'synced'
          : 'pending';
    const sessionId = String(raw.sessionId || raw.id || `sess:${date}:${fallbackIdx}`);
    return {
      sessionId,
      id: sessionId,
      recordType,
      date,
      startDate,
      startTime,
      endTime,
      sortTs,
      durationSeconds,
      startProgressBp,
      endProgressBp,
      progressScale,
      startPercent,
      endPercent,
      legacySessionCount: toFiniteNumber(raw.legacySessionCount ?? raw.sessions) || 0,
      seenIds: Array.isArray(raw.seenIds) ? raw.seenIds.map(String).slice(-40) : [sessionId],
      syncStatus,
      journalEntryId: raw.journalEntryId ? String(raw.journalEntryId) : null,
      syncedToJournal: syncStatus === 'synced',
      prePostRemoteIds: Array.isArray(raw.prePostRemoteIds) ? raw.prePostRemoteIds.map(String) : null,
      candidateJournalEntryIds: Array.isArray(raw.candidateJournalEntryIds)
        ? raw.candidateJournalEntryIds.map(String)
        : null
    };
  }

  function rebuildDerivedDaysForBook(bookRec) {
    if (!bookRec || typeof bookRec !== 'object') return;
    const sessions = Array.isArray(bookRec.sessions) ? bookRec.sessions : [];
    sessions.sort(compareSessionRecords);
    const days = {};
    for (const s of sessions) {
      if (!s || !s.date) continue;
      if (
        s.recordType !== 'reading_session' &&
        (s.endPercent === null || s.endPercent === undefined || s.endPercent <= 0) &&
        !(s.durationSeconds > 0) &&
        !s.syncedToJournal
      ) {
        continue;
      }
      if (!days[s.date]) {
        days[s.date] = {
          date: s.date,
          startPercent: s.startPercent ?? null,
          endPercent: s.endPercent ?? null,
          durationSeconds: 0,
          sessions: 0,
          syncedToJournal: true,
          seenIds: []
        };
      }
      const d = days[s.date];
      if (s.startPercent !== null && s.startPercent !== undefined) {
        if (d.startPercent === null || s.startPercent < d.startPercent) {
          d.startPercent = s.startPercent;
        }
      }
      if (s.endPercent !== null && s.endPercent !== undefined) {
        if (d.endPercent === null || s.endPercent > d.endPercent) {
          d.endPercent = s.endPercent;
        }
      }
      d.durationSeconds += s.durationSeconds || 0;
      if (s.recordType === 'legacy_daily_summary') {
        d.sessions += Math.max(1, s.legacySessionCount || 1);
      } else if (s.recordType === 'reading_session') {
        d.sessions += 1;
      }
      if (!s.syncedToJournal && s.syncStatus !== 'synced') {
        d.syncedToJournal = false;
      }
      for (const sid of s.seenIds || [s.sessionId]) {
        if (sid && !d.seenIds.includes(sid)) {
          d.seenIds.push(sid);
        }
      }
      if (d.seenIds.length > 40) d.seenIds = d.seenIds.slice(-40);
    }
    bookRec.days = days;
  }

  function cloneHistoryData(historyData) {
    const out = { version: 2, books: {} };
    const srcBooks = historyData && historyData.books && typeof historyData.books === 'object' ? historyData.books : {};
    for (const [sdPath, rec] of Object.entries(srcBooks)) {
      if (!rec || typeof rec !== 'object') continue;
      const sessions = [];
      const bySessionId = new Map();
      const coveredDates = new Map();
      const realSessionSeenIds = new Set();

      if (Array.isArray(rec.sessions)) {
        for (let i = 0; i < rec.sessions.length; i++) {
          const norm = normalizeSessionRecord(rec.sessions[i], i + 1);
          if (!norm) continue;
          if (bySessionId.has(norm.sessionId)) continue;
          bySessionId.set(norm.sessionId, norm);
          sessions.push(norm);
          if (!coveredDates.has(norm.date)) coveredDates.set(norm.date, []);
          coveredDates.get(norm.date).push(norm);
          if (norm.recordType !== 'legacy_daily_summary') {
            realSessionSeenIds.add(norm.sessionId);
            for (const sid of norm.seenIds || []) realSessionSeenIds.add(sid);
          }
        }
      }

      if (rec.days && typeof rec.days === 'object') {
        for (const [dateKey, d] of Object.entries(rec.days)) {
          if (!d || typeof d !== 'object') continue;
          const iso = String(d.date || dateKey);
          if (!iso) continue;
          const existingForDate = coveredDates.get(iso) || [];
          const dEndPct = toFiniteNumber(d.endPercent);
          const dDur = toFiniteNumber(d.durationSeconds) || 0;
          const dSynced = Boolean(d.syncedToJournal);
          if (existingForDate.length > 0) {
            const maxSessPct = existingForDate.reduce(
              (acc, s) => (s.endPercent !== null && (acc === null || s.endPercent > acc) ? s.endPercent : acc),
              null
            );
            if (!dSynced && existingForDate.every((s) => s.syncedToJournal)) {
              for (const s of existingForDate) {
                s.syncedToJournal = false;
                s.syncStatus = 'pending';
                s.journalEntryId = null;
              }
            } else if (dSynced && existingForDate.some((s) => !s.syncedToJournal && s.syncStatus === 'pending')) {
              for (const s of existingForDate) {
                if (s.syncStatus === 'pending') {
                  s.syncedToJournal = true;
                  s.syncStatus = 'synced';
                }
              }
            }
            if (dEndPct !== null && (maxSessPct === null || dEndPct > maxSessPct)) {
              const legId = `legacy:${iso}:${dEndPct}`;
              if (!bySessionId.has(legId)) {
                const leg = normalizeSessionRecord({
                  sessionId: legId,
                  recordType: 'legacy_daily_summary',
                  date: iso,
                  startPercent: toFiniteNumber(d.startPercent),
                  endPercent: dEndPct,
                  durationSeconds: dDur,
                  legacySessionCount: toFiniteNumber(d.sessions) || 1,
                  seenIds: Array.isArray(d.seenIds) ? d.seenIds : [],
                  syncedToJournal: dSynced
                });
                if (leg) {
                  bySessionId.set(leg.sessionId, leg);
                  sessions.push(leg);
                }
              }
            }
            continue;
          }
          if ((dEndPct === null || dEndPct <= 0) && !(dDur > 0) && !dSynced) {
            continue;
          }
          const leg = normalizeSessionRecord({
            sessionId: `legacy:${iso}`,
            recordType: 'legacy_daily_summary',
            date: iso,
            startPercent: toFiniteNumber(d.startPercent),
            endPercent: dEndPct,
            durationSeconds: dDur,
            legacySessionCount: toFiniteNumber(d.sessions) || (dDur > 0 ? 1 : 0),
            seenIds: Array.isArray(d.seenIds) ? d.seenIds : [],
            syncedToJournal: dSynced
          });
          if (leg && !bySessionId.has(leg.sessionId)) {
            bySessionId.set(leg.sessionId, leg);
            sessions.push(leg);
          }
        }
      }

      // Filter out legacy_daily_summary records that have been superseded by real individual sessions covering their seenIds
      const filteredSessions = sessions.filter((s) => {
        if (s.recordType !== 'legacy_daily_summary') return true;
        const nonLegacyIds = (s.seenIds || []).filter((id) => !String(id).startsWith('legacy:'));
        if (nonLegacyIds.length > 0 && nonLegacyIds.every((id) => realSessionSeenIds.has(id))) {
          return false;
        }
        return true;
      });

      const bookRec = { sessions: filteredSessions, days: {} };
      rebuildDerivedDaysForBook(bookRec);
      if (bookRec.sessions.length > 0 || Object.keys(bookRec.days).length > 0) {
        out.books[sdPath] = bookRec;
      }
    }
    return out;
  }

  function upsertHistorySessionRecord(history, sdPath, rawSession) {
    if (!sdPath || !rawSession) return false;
    const norm = normalizeSessionRecord(rawSession);
    if (!norm) return false;
    if (
      norm.recordType !== 'reading_session' &&
      (norm.endPercent === null || norm.endPercent <= 0) &&
      !(norm.durationSeconds > 0) &&
      !norm.syncedToJournal
    ) {
      return false;
    }

    let changed = false;
    if (!history.books[sdPath]) {
      history.books[sdPath] = { sessions: [], days: {} };
      changed = true;
    }
    const bookRec = history.books[sdPath];
    if (!Array.isArray(bookRec.sessions)) {
      bookRec.sessions = [];
      changed = true;
    }

    const existing = bookRec.sessions.find(
      (s) => s.sessionId === norm.sessionId || (norm.sessionId && (s.seenIds || []).includes(norm.sessionId) && s.recordType !== 'legacy_daily_summary')
    );
    if (existing) {
      if (norm.endPercent !== null && (existing.endPercent === null || norm.endPercent > existing.endPercent)) {
        existing.endPercent = norm.endPercent;
        changed = true;
      }
      if (norm.startPercent !== null && existing.startPercent === null) {
        existing.startPercent = norm.startPercent;
        changed = true;
      }
      if (norm.durationSeconds > existing.durationSeconds) {
        existing.durationSeconds = norm.durationSeconds;
        changed = true;
      }
      if (norm.startTime !== null && existing.startTime === null) {
        existing.startTime = norm.startTime;
        existing.startDate = norm.startDate;
        changed = true;
      }
      if (norm.endTime !== null && existing.endTime === null) {
        existing.endTime = norm.endTime;
        changed = true;
      }
      if (changed) rebuildDerivedDaysForBook(bookRec);
      return changed;
    }

    // If a verified reading_session matches a legacy_daily_summary seenId, remove that seenId (and drop the legacy summary once all seenIds are covered)
    if (norm.recordType === 'reading_session') {
      for (let i = bookRec.sessions.length - 1; i >= 0; i--) {
        const s = bookRec.sessions[i];
        if (s.recordType === 'legacy_daily_summary' && Array.isArray(s.seenIds) && s.seenIds.includes(norm.sessionId)) {
          s.seenIds = s.seenIds.filter((id) => id !== norm.sessionId && !String(id).startsWith('legacy:'));
          if (s.seenIds.length === 0) {
            bookRec.sessions.splice(i, 1);
          } else if (s.legacySessionCount > 1) {
            s.legacySessionCount = Math.max(1, s.legacySessionCount - 1);
          }
          changed = true;
        }
      }
    }

    bookRec.sessions.push(norm);
    rebuildDerivedDaysForBook(bookRec);
    return true;
  }

  function mergeEventsIntoHistory(historyData, jsonlText) {
    const history = cloneHistoryData(historyData);
    const srcBookKeys =
      historyData && historyData.books && typeof historyData.books === 'object'
        ? Object.keys(historyData.books)
        : [];
    let changed = srcBookKeys.some((k) => !history.books[k]);

    for (const [bookPath, rec] of Object.entries(history.books)) {
      if (!rec) continue;
      const beforeLen = Array.isArray(rec.sessions) ? rec.sessions.length : 0;
      rec.sessions = (rec.sessions || []).filter(
        (s) =>
          s &&
          (s.recordType === 'reading_session' ||
            (s.endPercent !== null && s.endPercent !== undefined && s.endPercent > 0) ||
            (s.durationSeconds || 0) > 0 ||
            s.syncedToJournal)
      );
      if (rec.sessions.length !== beforeLen) {
        rebuildDerivedDaysForBook(rec);
        changed = true;
      }
      if (rec.sessions.length === 0) {
        delete history.books[bookPath];
        changed = true;
      }
    }

    if (!jsonlText) return { history, changed };

    for (const rawLine of String(jsonlText).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (!ev || typeof ev !== 'object') continue;
      const vars = ev.vars && typeof ev.vars === 'object' ? ev.vars : ev;
      const sdPath = vars.book || vars.path || vars.book_path || vars.sdPath;
      if (!sdPath || typeof sdPath !== 'string') continue;

      const startTime = toFiniteNumber(vars.start_time) ?? toFiniteNumber(ev.start_time);
      const endTime = toFiniteNumber(vars.end_time) ?? toFiniteNumber(ev.end_time);
      const evTs = toFiniteNumber(ev.ts);
      const canonicalTs = endTime ?? evTs ?? startTime;
      const date = localIsoDateFromTs(canonicalTs);
      if (!date) continue;
      const startDate = startTime !== null ? localIsoDateFromTs(startTime) || date : date;

      const endPct = computePercentFromVars(vars);
      let startPct = toFiniteNumber(vars.start_percent ?? vars.startPercent);
      const startBp = toFiniteNumber(vars.start_progress_bp);
      const endBp = toFiniteNumber(vars.end_progress_bp);
      const scaleRaw = toFiniteNumber(vars.progress_scale);
      const scale = scaleRaw && scaleRaw > 0 ? scaleRaw : 10000;
      if (startPct === null && startBp !== null) {
        startPct = computePercentFromBp(startBp, scale);
      }
      const dur = Math.max(0, Math.round(toFiniteNumber(vars.duration_seconds) || 0));
      const evId = ev.id ? String(ev.id) : '';
      const isCompact = evId.startsWith('compact-');
      const isSession = (ev.e || ev.event) === 'reader.session';

      if (!isSession && (endPct === null || endPct <= 0) && dur <= 0) continue;
      if (isSession && (endPct === null || endPct < 0) && dur <= 0 && startBp === null && endBp === null) continue;

      const bookRec = history.books[sdPath];
      const existingSessions = bookRec && Array.isArray(bookRec.sessions) ? bookRec.sessions : [];

      if (isCompact) {
        // Compact snapshot: only create/update a record if history has no record on or reaching this snapshot
        const maxPct = existingSessions.reduce(
          (acc, s) => (s.endPercent !== null && (acc === null || s.endPercent > acc) ? s.endPercent : acc),
          null
        );
        if (existingSessions.length > 0 && maxPct !== null && (endPct === null || maxPct >= endPct)) {
          const sameDateSess = existingSessions.filter((s) => s.date === date);
          if (sameDateSess.length === 1 && dur > (sameDateSess[0].durationSeconds || 0)) {
            sameDateSess[0].durationSeconds = dur;
            rebuildDerivedDaysForBook(bookRec);
            changed = true;
          }
          continue;
        }
        const compactId = evId || `compact:${date}:${endPct ?? 0}`;
        if (
          upsertHistorySessionRecord(history, sdPath, {
            sessionId: compactId,
            recordType: dur > 0 ? 'reading_session' : 'progress_checkpoint',
            date,
            startDate,
            startTime,
            endTime,
            sortTs: canonicalTs,
            durationSeconds: dur,
            startProgressBp: startBp,
            endProgressBp: endBp,
            progressScale: scale,
            startPercent: startPct,
            endPercent: endPct
          })
        ) {
          changed = true;
        }
        continue;
      }

      if (!isSession) {
        // Companion reader.exit check: if a reading_session from the same sitting already exists, attach seenId instead of duplicating
        const evPrefix = evId.includes('-') ? evId.split('-')[0] : '';
        const companion = existingSessions.find(
          (s) =>
            s.recordType === 'reading_session' &&
            ((evId && (s.seenIds || []).includes(evId)) ||
              (canonicalTs !== null && (s.endTime === canonicalTs || s.sortTs === canonicalTs) && s.endPercent === endPct) ||
              (evPrefix && String(s.sessionId || '').startsWith(evPrefix + '-') && s.date === date && s.endPercent === endPct))
        );
        if (companion) {
          if (evId && !companion.seenIds.includes(evId)) {
            companion.seenIds.push(evId);
            rebuildDerivedDaysForBook(bookRec);
            changed = true;
          }
          continue;
        }
        const maxPct = existingSessions.reduce(
          (acc, s) => (s.endPercent !== null && (acc === null || s.endPercent > acc) ? s.endPercent : acc),
          null
        );
        if (endPct !== null && maxPct !== null && endPct <= maxPct && dur <= 0) {
          continue;
        }
        const chkId = evId || `chk:${date}:${canonicalTs || 0}:${endPct ?? 0}`;
        if (
          upsertHistorySessionRecord(history, sdPath, {
            sessionId: chkId,
            recordType: 'progress_checkpoint',
            date,
            startDate,
            startTime: null,
            endTime: null,
            sortTs: canonicalTs,
            durationSeconds: dur,
            startProgressBp: startBp,
            endProgressBp: endBp,
            progressScale: scale,
            startPercent: startPct !== null ? startPct : maxPct,
            endPercent: endPct
          })
        ) {
          changed = true;
        }
        continue;
      }

      // Actual reader.session sitting
      const sessId =
        evId ||
        `sess:${startTime ?? canonicalTs ?? date}:${endTime ?? ''}:${dur}:${startBp ?? startPct ?? ''}:${endBp ?? endPct ?? ''}`;
      if (
        upsertHistorySessionRecord(history, sdPath, {
          sessionId: sessId,
          recordType: 'reading_session',
          date,
          startDate,
          startTime,
          endTime,
          sortTs: canonicalTs,
          durationSeconds: dur,
          startProgressBp: startBp,
          endProgressBp: endBp,
          progressScale: scale,
          startPercent: startPct,
          endPercent: endPct ?? 0
        })
      ) {
        changed = true;
      }
    }
    return { history, changed };
  }

  function parseSessionHistoryText(rawText) {
    let cleaned = String(rawText == null ? '' : rawText).replace(/^\uFEFF/, '').trim();
    if (!cleaned) {
      throw new Error('Paste session history JSON/JSONL or select a file first.');
    }
    const fenceMatch = cleaned.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }
    if (!cleaned) {
      throw new Error('Paste session history JSON/JSONL or select a file first.');
    }

    let firstErr = null;
    try {
      const direct = JSON.parse(cleaned);
      if (direct && typeof direct === 'object') {
        return direct;
      }
      firstErr = new Error('Expected JSON object, array, or JSONL lines.');
    } catch (err) {
      firstErr = err;
    }

    const items = [];
    let i = 0;
    const len = cleaned.length;
    while (i < len) {
      while (i < len && /[\s,]/.test(cleaned[i])) i++;
      if (i >= len) break;
      const openCh = cleaned[i];
      if (openCh !== '{' && openCh !== '[') {
        throw new Error('Invalid session history JSON: ' + (firstErr ? firstErr.message : 'unexpected character'));
      }
      const start = i;
      let depth = 0;
      let inString = false;
      let escaped = false;
      while (i < len) {
        const ch = cleaned[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
        } else {
          if (ch === '"') {
            inString = true;
          } else if (ch === '{' || ch === '[') {
            depth += 1;
          } else if (ch === '}' || ch === ']') {
            depth -= 1;
            if (depth === 0) {
              i += 1;
              break;
            }
          }
        }
        i += 1;
      }
      if (depth !== 0) {
        throw new Error('Invalid session history JSON: incomplete/truncated object or array.');
      }
      const chunk = cleaned.slice(start, i);
      let parsedChunk;
      try {
        parsedChunk = JSON.parse(chunk);
      } catch (chunkErr) {
        throw new Error('Invalid session history JSON: ' + chunkErr.message);
      }
      if (Array.isArray(parsedChunk)) {
        for (const el of parsedChunk) {
          if (el && typeof el === 'object') items.push(el);
        }
      } else if (parsedChunk && typeof parsedChunk === 'object') {
        items.push(parsedChunk);
      }
    }

    if (items.length === 0) {
      throw new Error('Invalid session history JSON: no JSON objects found.');
    }
    return items.length === 1 ? items[0] : items;
  }

  function importSessionHistoryPayload(historyData, payload, knownRows = []) {
    const history = cloneHistoryData(historyData);
    let changed = false;
    let importedSessions = 0;
    const touchedBooks = new Set();

    const knownPaths = new Set();
    const byHash = new Map();
    const byFile = new Map();
    const byTitle = new Map();
    for (const r of knownRows || []) {
      if (!r || !r.sdPath) continue;
      knownPaths.add(r.sdPath);
      if (r.documentHash) byHash.set(String(r.documentHash).toLowerCase(), r.sdPath);
      const meta = extractFilenameMeta(r.sdPath);
      if (meta.normFilename && !byFile.has(meta.normFilename)) byFile.set(meta.normFilename, r.sdPath);
      const nt = normalizeText(r.title || meta.title);
      if (nt && !byTitle.has(nt)) byTitle.set(nt, r.sdPath);
    }

    if (
      payload &&
      !Array.isArray(payload) &&
      typeof payload === 'object' &&
      payload.books &&
      !Array.isArray(payload.books) &&
      typeof payload.books === 'object'
    ) {
      for (const [sdPath, rec] of Object.entries(payload.books)) {
        if (!rec || typeof rec !== 'object') continue;
        if (Array.isArray(rec.sessions)) {
          for (let idx = 0; idx < rec.sessions.length; idx++) {
            const norm = normalizeSessionRecord(rec.sessions[idx], idx + 1);
            if (!norm) continue;
            if (upsertHistorySessionRecord(history, sdPath, norm)) {
              changed = true;
            }
            importedSessions += 1;
            touchedBooks.add(sdPath);
          }
        } else if (rec.days && typeof rec.days === 'object') {
          for (const [dateKey, d] of Object.entries(rec.days)) {
            const parts = parseIsoDateParts(d?.date || dateKey);
            if (!parts) continue;
            const didUpsert = upsertHistorySessionRecord(history, sdPath, {
              sessionId: `legacy:${parts.iso}`,
              recordType: 'legacy_daily_summary',
              date: parts.iso,
              startPercent: d.startPercent,
              endPercent: d.endPercent,
              durationSeconds: d.durationSeconds,
              legacySessionCount: toFiniteNumber(d.sessions) || 1,
              seenIds: Array.isArray(d.seenIds) ? d.seenIds : [],
              syncedToJournal: Boolean(d.syncedToJournal)
            });
            if (didUpsert) changed = true;
            importedSessions += 1;
            touchedBooks.add(sdPath);
          }
        }
      }
      return { history, importedSessions, importedBooks: touchedBooks.size, changed };
    }

    let rawList = null;
    if (Array.isArray(payload)) {
      rawList = payload;
    } else if (payload && typeof payload === 'object') {
      rawList =
        payload.sessions ||
        payload.reading_sessions ||
        payload.readingSessions ||
        payload.events ||
        payload.history ||
        payload.items ||
        payload.data ||
        (Array.isArray(payload.books) ? payload.books : null);
      if (
        !rawList &&
        (payload.sdPath ||
          payload.book ||
          payload.path ||
          payload.book_path ||
          payload.file_path ||
          payload.filePath ||
          payload.document ||
          payload.documentHash ||
          payload.book_hash ||
          payload.title ||
          payload.vars)
      ) {
        rawList = [payload];
      }
    }
    if (!Array.isArray(rawList)) {
      throw new Error('Expected a sessions array, JSONL lines, { sessions: [...] }, or reading-history.json object.');
    }

    const flatList = [];
    for (const entry of rawList) {
      if (!entry || typeof entry !== 'object') continue;
      const nested = Array.isArray(entry.sessions)
        ? entry.sessions
        : (Array.isArray(entry.reading_sessions)
            ? entry.reading_sessions
            : (Array.isArray(entry.readingSessions) ? entry.readingSessions : null));
      if (nested) {
        const parentBook = {
          sdPath: entry.sdPath || entry.book || entry.path || entry.book_path || entry.file_path || entry.filePath || '',
          document: entry.document || entry.documentHash || entry.book_hash || entry.hash || '',
          title: entry.title || entry.book_title || entry.bookTitle || '',
          author: entry.author || ''
        };
        for (const child of nested) {
          if (!child || typeof child !== 'object') continue;
          const mergedChild = Object.assign({}, child);
          if (!mergedChild.sdPath && !mergedChild.book && !mergedChild.path && !mergedChild.book_path && !mergedChild.file_path && !mergedChild.filePath && parentBook.sdPath) {
            mergedChild.sdPath = parentBook.sdPath;
          }
          if (!mergedChild.document && !mergedChild.documentHash && !mergedChild.book_hash && !mergedChild.hash && parentBook.document) {
            mergedChild.document = parentBook.document;
          }
          if (!mergedChild.title && !mergedChild.book_title && !mergedChild.bookTitle && parentBook.title) {
            mergedChild.title = parentBook.title;
          }
          if (!mergedChild.author && parentBook.author) {
            mergedChild.author = parentBook.author;
          }
          flatList.push(mergedChild);
        }
      } else {
        flatList.push(entry);
      }
    }

    const baseKeyOccurrences = new Map();

    for (let i = 0; i < flatList.length; i++) {
      const rawItem = flatList[i];
      if (!rawItem || typeof rawItem !== 'object') continue;
      let s = rawItem;
      let evType = '';
      if (rawItem.vars && typeof rawItem.vars === 'object') {
        evType = rawItem.e || rawItem.event || '';
        if (evType && evType !== 'reader.session' && evType !== 'reader.exit') continue;
        s = Object.assign({}, rawItem.vars, {
          id: rawItem.id !== undefined ? rawItem.id : rawItem.vars.id,
          ts: rawItem.ts !== undefined ? rawItem.ts : rawItem.vars.ts
        });
      }

      let sdPath = s.sdPath || s.book || s.path || s.book_path || s.file_path || s.filePath || '';
      if (!sdPath || (knownPaths.size > 0 && !knownPaths.has(sdPath))) {
        const hash = String(s.document || s.documentHash || s.book_hash || s.hash || '').toLowerCase();
        let matchedPath = '';
        if (hash && byHash.has(hash)) {
          matchedPath = byHash.get(hash);
        }
        if (!matchedPath) {
          const fileCandidate = sdPath || s.filename || s.file || s.file_name || '';
          if (fileCandidate) {
            const nf = extractFilenameMeta(fileCandidate).normFilename;
            if (nf && byFile.has(nf)) matchedPath = byFile.get(nf);
          }
        }
        if (!matchedPath) {
          const titleCandidate = s.title || s.book_title || s.bookTitle || '';
          if (titleCandidate) {
            const nt = normalizeText(titleCandidate);
            if (nt && byTitle.has(nt)) matchedPath = byTitle.get(nt);
          }
        }
        if (matchedPath) sdPath = matchedPath;
      }
      if (!sdPath) continue;

      const parseTsField = (val) => {
        let num = toFiniteNumber(val);
        if (num !== null) return num > 1e11 ? Math.floor(num / 1000) : num;
        if (typeof val === 'string') {
          const trimmed = val.trim();
          if (trimmed.includes('T') || /\d{2}:\d{2}/.test(trimmed)) {
            const ms = Date.parse(trimmed);
            if (Number.isFinite(ms)) return Math.floor(ms / 1000);
          }
        }
        return null;
      };

      const startTime = parseTsField(s.start_time ?? s.startTime ?? s.started_at ?? s.startedAt);
      const endTime = parseTsField(s.end_time ?? s.endTime ?? s.ended_at ?? s.endedAt);
      const tsRaw =
        s.end_time ??
        s.endTime ??
        s.ended_at ??
        s.endedAt ??
        s.ts ??
        s.timestamp ??
        s.start_time ??
        s.startTime ??
        s.started_at ??
        s.startedAt ??
        s.created_at ??
        s.createdAt;
      let ts = parseTsField(tsRaw);
      let dateParts = parseIsoDateParts(s.date);
      if (!dateParts && typeof tsRaw === 'string' && ts === null) {
        const trimmedTs = tsRaw.trim();
        dateParts = parseIsoDateParts(trimmedTs.slice(0, 10));
        if (!dateParts && trimmedTs) {
          const parsedMs = Date.parse(trimmedTs);
          if (Number.isFinite(parsedMs)) {
            ts = Math.floor(parsedMs / 1000);
          }
        }
      }
      const date = (dateParts && dateParts.iso) || localIsoDateFromTs(endTime ?? ts ?? startTime);
      if (!date) continue;
      const startDate = startTime !== null ? localIsoDateFromTs(startTime) || date : date;

      let endPct = computePercentFromVars(s);
      if (endPct === null) {
        const rawP = toFiniteNumber(
          s.progress ?? s.endPercent ?? s.end_pct ?? s.progress_percent ?? s.progressPercent
        );
        if (rawP !== null) endPct = Math.max(0, Math.min(100, Math.round(rawP)));
      }
      let startPct = toFiniteNumber(s.startPercent ?? s.start_pct ?? s.start_percent);
      const startBp = toFiniteNumber(s.start_progress_bp ?? s.startProgressBp);
      const endBp = toFiniteNumber(s.end_progress_bp ?? s.endProgressBp);
      const scaleRaw = toFiniteNumber(s.progress_scale ?? s.progressScale);
      const scale = scaleRaw && scaleRaw > 0 ? scaleRaw : 10000;
      if (startPct === null && startBp !== null) {
        startPct = computePercentFromBp(startBp, scale);
      }
      const dur = Math.max(
        0,
        Math.round(toFiniteNumber(s.duration_seconds ?? s.durationSeconds ?? s.duration_sec ?? s.duration ?? s.seconds) || 0)
      );
      const isSession = evType ? evType === 'reader.session' : (s.recordType ? s.recordType === 'reading_session' : true);
      const recordType = isSession ? 'reading_session' : 'progress_checkpoint';

      const explicitId = s.sessionId || s.session_id || s.id;
      let sessionId = '';
      if (explicitId) {
        sessionId = String(explicitId);
      } else {
        const baseKey = `imp:${sdPath}|${recordType}|${startTime ?? ts ?? date}|${endTime ?? ''}|${dur}|${startBp ?? startPct ?? ''}|${endBp ?? endPct ?? ''}`;
        const occ = (baseKeyOccurrences.get(baseKey) || 0) + 1;
        baseKeyOccurrences.set(baseKey, occ);
        sessionId = `${baseKey}#${occ}`;
      }

      if (
        upsertHistorySessionRecord(history, sdPath, {
          sessionId,
          recordType,
          date,
          startDate,
          startTime,
          endTime,
          sortTs: endTime ?? ts ?? startTime,
          durationSeconds: dur,
          startProgressBp: startBp,
          endProgressBp: endBp,
          progressScale: scale,
          startPercent: startPct,
          endPercent: endPct ?? 0
        })
      ) {
        changed = true;
      }
      importedSessions += 1;
      touchedBooks.add(sdPath);
    }

    return { history, importedSessions, importedBooks: touchedBooks.size, changed };
  }

  function getBookHistorySessions(historyData, row) {
    if (!historyData || !historyData.books || !row) return [];
    const targetPaths = new Set();
    if (row.sdPath) targetPaths.add(row.sdPath);
    if (row.mapping && row.mapping.sdPath) targetPaths.add(row.mapping.sdPath);
    const refPath = row.sdPath || (row.mapping && row.mapping.sdPath) || '';
    const targetNormFile = refPath ? extractFilenameMeta(refPath).normFilename : '';

    const bySessionId = new Map();
    for (const [bookPath, rec] of Object.entries(historyData.books)) {
      if (!rec || typeof rec !== 'object') continue;
      const matchesPath = targetPaths.has(bookPath);
      const matchesFile = Boolean(targetNormFile) && extractFilenameMeta(bookPath).normFilename === targetNormFile;
      if (!matchesPath && !matchesFile) continue;

      if (Array.isArray(rec.sessions) && rec.sessions.length > 0) {
        for (let i = 0; i < rec.sessions.length; i++) {
          const norm = normalizeSessionRecord(rec.sessions[i], i + 1);
          if (!norm) continue;
          if (!bySessionId.has(norm.sessionId)) {
            bySessionId.set(norm.sessionId, norm);
          }
        }
      } else if (rec.days && typeof rec.days === 'object') {
        for (const [dateKey, d] of Object.entries(rec.days)) {
          if (!d) continue;
          const iso = String(d.date || dateKey);
          if (!iso) continue;
          const leg = normalizeSessionRecord({
            sessionId: `legacy:${iso}`,
            recordType: 'legacy_daily_summary',
            date: iso,
            startPercent: d.startPercent,
            endPercent: d.endPercent,
            durationSeconds: d.durationSeconds,
            legacySessionCount: d.sessions,
            seenIds: d.seenIds,
            syncedToJournal: d.syncedToJournal
          });
          if (leg && !bySessionId.has(leg.sessionId)) {
            bySessionId.set(leg.sessionId, leg);
          }
        }
      }
    }

    const realSeenIds = new Set();
    for (const s of bySessionId.values()) {
      if (s.recordType !== 'legacy_daily_summary') {
        realSeenIds.add(s.sessionId);
        for (const sid of s.seenIds || []) realSeenIds.add(sid);
      }
    }

    const sorted = Array.from(bySessionId.values())
      .filter((s) => {
        if (!s || !s.date) return false;
        if (s.recordType === 'legacy_daily_summary') {
          const nonLeg = (s.seenIds || []).filter((id) => !String(id).startsWith('legacy:'));
          if (nonLeg.length > 0 && nonLeg.every((id) => realSeenIds.has(id))) return false;
        }
        return (
          s.recordType === 'reading_session' ||
          (s.endPercent !== null && s.endPercent > 0) ||
          (s.durationSeconds || 0) > 0 ||
          s.syncedToJournal
        );
      })
      .sort(compareSessionRecords);

    let sessionNum = 0;
    let runningPrevPct = null;
    for (const s of sorted) {
      if (s.recordType === 'reading_session') {
        sessionNum += 1;
        s.sessionNumber = sessionNum;
      } else {
        s.sessionNumber = null;
      }
      if (s.startPercent === null && runningPrevPct !== null) {
        s.startPercent = runningPrevPct;
      }
      if (s.endPercent !== null && s.endPercent !== undefined) {
        runningPrevPct = s.endPercent;
      }
    }
    return sorted;
  }

  function getBookHistoryDays(historyData, row) {
    const sessions = getBookHistorySessions(historyData, row);
    const mergedByDate = new Map();
    for (const s of sessions) {
      if (!s || !s.date) continue;
      const iso = s.date;
      if (!mergedByDate.has(iso)) {
        mergedByDate.set(iso, {
          date: iso,
          startPercent: s.startPercent ?? null,
          endPercent: s.endPercent ?? null,
          durationSeconds: 0,
          sessions: 0,
          syncedToJournal: true,
          seenIds: []
        });
      }
      const d = mergedByDate.get(iso);
      if (s.startPercent !== null && s.startPercent !== undefined) {
        if (d.startPercent === null || s.startPercent < d.startPercent) {
          d.startPercent = s.startPercent;
        }
      }
      if (s.endPercent !== null && s.endPercent !== undefined) {
        if (d.endPercent === null || s.endPercent > d.endPercent) {
          d.endPercent = s.endPercent;
        }
      }
      d.durationSeconds += s.durationSeconds || 0;
      if (s.recordType === 'legacy_daily_summary') {
        d.sessions += Math.max(1, s.legacySessionCount || 1);
      } else if (s.recordType === 'reading_session') {
        d.sessions += 1;
      }
      if (!s.syncedToJournal && s.syncStatus !== 'synced') {
        d.syncedToJournal = false;
      }
      for (const sid of s.seenIds || [s.sessionId]) {
        if (sid && !d.seenIds.includes(sid)) d.seenIds.push(sid);
      }
    }
    return Array.from(mergedByDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function getBookDisplayHistorySessions(historyData, row) {
    if (!row) return [];
    const realSessions = getBookHistorySessions(historyData, row);
    const startParts = parseIsoDateParts(row.startDate);
    const startIso = startParts ? startParts.iso : '';
    const endParts = parseIsoDateParts(row.lastDate);
    let endIso = endParts ? endParts.iso : '';
    if (!endIso && row.lastReadTs) {
      endIso = localIsoDateFromTs(row.lastReadTs);
    }
    if (!endIso) endIso = startIso;

    const ignoreExitOnlyReal =
      realSessions.length > 0 &&
      realSessions.every((s) => s.recordType !== 'reading_session' && !(s.durationSeconds > 0)) &&
      ((row.durationSeconds || 0) > 0 ||
        (row.sessions || 0) > 0 ||
        ((row.devicePercent === 100 || (row.mapping && row.mapping.status === 'read')) &&
          Boolean(endIso) &&
          endIso < realSessions[0].date));

    if (realSessions.length > 0 && !ignoreExitOnlyReal) {
      const out = realSessions.slice();
      const firstDate = out[0].startDate || out[0].date;
      if (startIso && firstDate && startIso < firstDate) {
        out.unshift({
          sessionId: `milestone:start:${startIso}`,
          date: startIso,
          isStartMilestone: true,
          synthetic: true,
          syncedToJournal: Boolean(
            row.mapping && (row.mapping.lastSyncedStartDate === startIso || row.mapping.status === 'read')
          )
        });
      }
      return out;
    }

    if (!startIso && !endIso) return [];
    const pct = toFiniteNumber(row.devicePercent);
    const dur = toFiniteNumber(row.durationSeconds) || 0;
    const pgs = toFiniteNumber(row.pagesTurned) || 0;
    const sess = toFiniteNumber(row.sessions) || 0;
    if ((pct === null || pct <= 0) && dur <= 0 && pgs <= 0) return [];

    const out = [];
    if (startIso && endIso && startIso < endIso) {
      out.push({
        sessionId: `milestone:start:${startIso}`,
        date: startIso,
        isStartMilestone: true,
        synthetic: true,
        syncedToJournal: Boolean(
          row.mapping && (row.mapping.lastSyncedStartDate === startIso || row.mapping.status === 'read')
        )
      });
    }
    out.push({
      sessionId: `milestone:summary:${endIso || startIso}`,
      date: endIso || startIso,
      startPercent: null,
      endPercent: pct,
      durationSeconds: dur,
      pagesTurned: pgs,
      sessions: sess,
      synthetic: true,
      isSummary: Boolean(startIso && endIso && startIso < endIso),
      syncedToJournal: Boolean(
        row.mapping &&
          (row.mapping.status === 'read' ||
            (pct !== null && row.mapping.lastSyncedPercent === pct))
      )
    });
    return out;
  }

  function getBookDisplayHistoryDays(historyData, row) {
    return getBookDisplayHistorySessions(historyData, row);
  }

  function getUnsyncedJournalSessions(historyData, row) {
    return getBookHistorySessions(historyData, row).filter(
      (s) =>
        !s.syncedToJournal &&
        s.syncStatus !== 'synced' &&
        s.syncStatus !== 'needs_reconciliation' &&
        (s.recordType === 'reading_session' || (s.endPercent !== null && s.endPercent > 0))
    );
  }

  function getUnsyncedJournalDays(historyData, row) {
    return getUnsyncedJournalSessions(historyData, row);
  }

  function updateHistorySessionLedger(historyData, row, sessionId, patch) {
    if (!historyData || !historyData.books || !row || !sessionId || !patch) return false;
    const targetPaths = new Set();
    if (row.sdPath) targetPaths.add(row.sdPath);
    if (row.mapping && row.mapping.sdPath) targetPaths.add(row.mapping.sdPath);
    const refPath = row.sdPath || (row.mapping && row.mapping.sdPath) || '';
    const targetNormFile = refPath ? extractFilenameMeta(refPath).normFilename : '';
    let changed = false;
    for (const [bookPath, rec] of Object.entries(historyData.books)) {
      if (!rec || typeof rec !== 'object') continue;
      const matchesPath = targetPaths.has(bookPath);
      const matchesFile = Boolean(targetNormFile) && extractFilenameMeta(bookPath).normFilename === targetNormFile;
      if (!matchesPath && !matchesFile) continue;
      if (Array.isArray(rec.sessions)) {
        for (const s of rec.sessions) {
          if (s && s.sessionId === sessionId) {
            Object.assign(s, patch);
            if (patch.syncStatus === 'synced') s.syncedToJournal = true;
            else if (patch.syncStatus && patch.syncStatus !== 'synced') s.syncedToJournal = false;
            else if (patch.syncedToJournal !== undefined) s.syncStatus = patch.syncedToJournal ? 'synced' : 'pending';
            changed = true;
          }
        }
      }
      if (changed) rebuildDerivedDaysForBook(rec);
    }
    return changed;
  }

  function markHistoryDaySynced(historyData, row, dateOrSessionId, journalEntryId = null) {
    if (!historyData || !historyData.books || !row || !dateOrSessionId) return false;
    const byId = updateHistorySessionLedger(historyData, row, dateOrSessionId, {
      syncStatus: 'synced',
      syncedToJournal: true,
      journalEntryId: journalEntryId || null,
      prePostRemoteIds: null,
      candidateJournalEntryIds: null
    });
    if (byId) return true;

    const targetPaths = new Set();
    if (row.sdPath) targetPaths.add(row.sdPath);
    if (row.mapping && row.mapping.sdPath) targetPaths.add(row.mapping.sdPath);
    const refPath = row.sdPath || (row.mapping && row.mapping.sdPath) || '';
    const targetNormFile = refPath ? extractFilenameMeta(refPath).normFilename : '';
    let changed = false;
    for (const [bookPath, rec] of Object.entries(historyData.books)) {
      if (!rec || typeof rec !== 'object') continue;
      const matchesPath = targetPaths.has(bookPath);
      const matchesFile = Boolean(targetNormFile) && extractFilenameMeta(bookPath).normFilename === targetNormFile;
      if (!matchesPath && !matchesFile) continue;
      if (Array.isArray(rec.sessions)) {
        for (const s of rec.sessions) {
          if (s && s.date === dateOrSessionId && !s.syncedToJournal) {
            s.syncedToJournal = true;
            s.syncStatus = 'synced';
            changed = true;
          }
        }
      }
      if (rec.days && rec.days[dateOrSessionId] && !rec.days[dateOrSessionId].syncedToJournal) {
        rec.days[dateOrSessionId].syncedToJournal = true;
        changed = true;
      }
      if (changed) rebuildDerivedDaysForBook(rec);
    }
    return changed;
  }

  function collectClaimedJournalEntryIds(historyData) {
    const claimed = new Set();
    if (!historyData || !historyData.books || typeof historyData.books !== 'object') return claimed;
    for (const rec of Object.values(historyData.books)) {
      if (!rec || !Array.isArray(rec.sessions)) continue;
      for (const s of rec.sessions) {
        if (s && s.journalEntryId) {
          claimed.add(String(s.journalEntryId));
        }
      }
    }
    return claimed;
  }

  function isJournalDayAlreadyOnStoryGraph(journalEntries, dateIso, targetVal, usePages) {
    return (journalEntries || []).some((e) => {
      if (!e || e.date !== dateIso) return false;
      if (e.statusKind === 'finished') return true;
      if (e.isStatus) return false;
      if (usePages && e.pages !== null && e.pages !== undefined) {
        return e.pages >= targetVal;
      }
      if (!usePages && e.percent !== null && e.percent !== undefined) {
        return e.percent >= targetVal;
      }
      return false;
    });
  }

  function isReadFolderPath(sdPath) {
    return /^\/read\//i.test(String(sdPath || ''));
  }

  function computePercentFromVars(vars) {
    if (!vars || typeof vars !== 'object') return null;
    const endPct = toFiniteNumber(vars.end_percent);
    if (endPct !== null) {
      return Math.max(0, Math.min(100, Math.round(endPct)));
    }
    const endBp = toFiniteNumber(vars.end_progress_bp);
    if (endBp !== null) {
      return computePercentFromBp(endBp, vars.progress_scale);
    }
    const pct = toFiniteNumber(vars.percent);
    if (pct !== null) {
      return Math.max(0, Math.min(100, Math.round(pct)));
    }
    return null;
  }

  function computeBookJournalWatermark(historyData, row) {
    const sessions = getBookHistorySessions(historyData, row);
    const tokens = sessions.map(
      (s) =>
        `${s.sessionId || ''}:${s.recordType || ''}:${s.syncStatus || (s.syncedToJournal ? 'synced' : 'pending')}:${s.journalEntryId || ''}:${s.endPercent ?? ''}:${s.durationSeconds || 0}`
    );
    return `v1|${sessions.length}|${tokens.join(';')}`;
  }

  function invalidateBookCleanupCache(mapping) {
    if (!mapping || typeof mapping !== 'object') return false;
    let changed = false;
    for (const k of [
      'lastJournalCleanedAt',
      'lastJournalCleanedBookId',
      'lastJournalCleanedSessionCount',
      'lastJournalCleanedWatermark'
    ]) {
      if (Object.prototype.hasOwnProperty.call(mapping, k)) {
        delete mapping[k];
        changed = true;
      }
    }
    return changed;
  }

  function stampBookCleanupVerified(mapping, historyData, row, timestampIso) {
    if (!mapping || typeof mapping !== 'object') return false;
    const sessions = getBookHistorySessions(historyData, row);
    mapping.lastJournalCleanedAt = timestampIso || new Date().toISOString();
    mapping.lastJournalCleanedBookId = mapping.bookId || '';
    mapping.lastJournalCleanedSessionCount = sessions.length;
    mapping.lastJournalCleanedWatermark = computeBookJournalWatermark(historyData, row);
    return true;
  }

  function shouldSkipJournalCleanup(row, historyData) {
    const mapping = row && row.mapping;
    if (!mapping || !mapping.bookId) return false;
    if (mapping.status !== 'read') return false;
    if (!mapping.lastJournalCleanedAt) return false;
    if (mapping.lastJournalCleanedBookId !== mapping.bookId) return false;
    const sessions = getBookHistorySessions(historyData, row);
    const hasActiveSyncState = sessions.some(
      (s) =>
        s &&
        (s.syncStatus === 'pending' ||
          s.syncStatus === 'in_flight' ||
          s.syncStatus === 'needs_reconciliation' ||
          (!s.syncedToJournal && s.syncStatus !== 'synced'))
    );
    if (hasActiveSyncState) return false;
    return mapping.lastJournalCleanedWatermark === computeBookJournalWatermark(historyData, row);
  }

  function reduceEventsJsonl(jsonlText) {
    const byBook = new Map();
    if (!jsonlText) return byBook;

    for (const rawLine of String(jsonlText).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (!ev || typeof ev !== 'object') continue;

      const vars = ev.vars && typeof ev.vars === 'object' ? ev.vars : ev;
      const sdPath = vars.book || vars.path || vars.book_path || vars.sdPath;
      if (!sdPath || typeof sdPath !== 'string') continue;

      const rawPercent = computePercentFromVars(vars);
      const endPct = toFiniteNumber(vars.end_percent);
      const inReadFolder = isReadFolderPath(sdPath);
      const isReadZeroReset = inReadFolder && (rawPercent === null || rawPercent === 0);
      const meta = extractFilenameMeta(sdPath);
      let prev = byBook.get(sdPath);
      if (!prev) {
        const docHash = vars.document ? String(vars.document) : '';
        for (const [oldKey, existing] of byBook.entries()) {
          if (
            (docHash && existing.documentHash && existing.documentHash === docHash) ||
            (meta.normFilename && existing.normFilename === meta.normFilename)
          ) {
            prev = existing;
            byBook.delete(oldKey);
            break;
          }
        }
      }
      let percent = isReadZeroReset ? 100 : rawPercent;
      if (prev && prev.percent !== null && (percent === null || percent < prev.percent)) {
        percent = prev.percent;
      }
      const isFinished = endPct === 100 || percent === 100 || isReadZeroReset || (prev?.finished ?? false);
      if (isFinished) {
        percent = 100;
      }
      const ts = toFiniteNumber(ev.ts) ?? toFiniteNumber(vars.end_time) ?? prev?.lastReadTs ?? null;

      byBook.set(sdPath, {
        sdPath,
        filename: meta.filename,
        title: meta.title || (prev ? prev.title : ''),
        author: meta.author || (prev ? prev.author : ''),
        normFilename: meta.normFilename,
        normTitle: meta.normTitle || (prev ? prev.normTitle : ''),
        normAuthor: meta.normAuthor || (prev ? prev.normAuthor : ''),
        documentHash: vars.document || prev?.documentHash || '',
        percent: percent !== null ? percent : (prev?.percent ?? null),
        finished: isFinished,
        inferredFromReadFolder: isReadZeroReset
          ? true
          : (rawPercent !== null && rawPercent > 0 ? false : Boolean(prev?.inferredFromReadFolder)),
        lastEvent: ev.e || ev.event || prev?.lastEvent || '',
        lastReadTs: ts,
        durationSeconds: (prev?.durationSeconds || 0) + (toFiniteNumber(vars.duration_seconds) || 0)
      });
    }
    return byBook;
  }

  function compactEventsJsonl(jsonlText, historyData) {
    const reduced = reduceEventsJsonl(jsonlText);
    if (reduced.size === 0) return '\n';
    const lines = [];
    let idx = 1;
    for (const book of reduced.values()) {
      let pct = book.percent;
      let fin = Boolean(book.finished);
      if (historyData && historyData.books) {
        const hDays = getBookHistoryDays(historyData, { sdPath: book.sdPath });
        for (const d of hDays) {
          if (d.endPercent !== null && d.endPercent !== undefined && (pct === null || d.endPercent > pct)) {
            pct = d.endPercent;
          }
        }
        if (pct === 100) fin = true;
      }
      const vars = { book: book.sdPath };
      if (pct !== null) vars.percent = String(pct);
      if (fin) vars.end_percent = '100';
      if (book.documentHash) vars.document = book.documentHash;
      if (book.durationSeconds > 0) vars.duration_seconds = String(Math.round(book.durationSeconds));
      lines.push(
        JSON.stringify({
          e: book.lastEvent || 'reader.exit',
          id: `compact-${idx++}`,
          ts: book.lastReadTs || 0,
          vars
        })
      );
    }
    return lines.join('\n') + '\n';
  }

  function removeBookFromEventsJsonl(jsonlText, targetSdPath) {
    if (!jsonlText || !targetSdPath) return jsonlText || '\n';
    const kept = [];
    for (const rawLine of String(jsonlText).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        const vars = ev && typeof ev.vars === 'object' && ev.vars ? ev.vars : ev;
        const sdPath = vars && (vars.book || vars.path || vars.book_path || vars.sdPath);
        if (sdPath === targetSdPath) continue;
      } catch (_) {}
      kept.push(line);
    }
    return kept.length > 0 ? kept.join('\n') + '\n' : '\n';
  }

  function mergeBackfillIntoEvents(eventsMap, backfillData) {
    const merged = new Map();
    if (eventsMap && typeof eventsMap.forEach === 'function') {
      eventsMap.forEach((v, k) => {
        merged.set(k, Object.assign({}, v));
      });
    }
    const books = backfillData && backfillData.books && typeof backfillData.books === 'object'
      ? backfillData.books
      : {};

    for (const entry of Object.values(books)) {
      if (!entry || typeof entry !== 'object' || !entry.sdPath) continue;
      const meta = extractFilenameMeta(entry.sdPath);
      const entryPct = toFiniteNumber(entry.percent);
      const entryRawPct = toFiniteNumber(entry.rawPercent);
      const entryDur = toFiniteNumber(entry.durationSeconds) || 0;
      const entryPages = toFiniteNumber(entry.pagesTurned) || 0;
      const entrySessions = toFiniteNumber(entry.sessions) || 0;
      const entryTs = toFiniteNumber(entry.lastReadTs);
      const entryStartDate = entry.startDate ? String(entry.startDate) : '';
      const entryDate = entry.lastDate ? String(entry.lastDate) : '';
      const entryFinished = Boolean(entry.finished) || entryPct === 100;

      let existingKey = merged.has(entry.sdPath) ? entry.sdPath : null;
      if (!existingKey) {
        for (const [k, existing] of merged.entries()) {
          if (
            existing.normFilename === meta.normFilename ||
            (meta.normTitle && existing.normTitle === meta.normTitle && existing.normAuthor === meta.normAuthor)
          ) {
            existingKey = k;
            break;
          }
        }
      }

      if (!existingKey) {
        merged.set(entry.sdPath, {
          sdPath: entry.sdPath,
          filename: meta.filename,
          title: entry.title || meta.title,
          author: entry.author || meta.author,
          normFilename: meta.normFilename,
          normTitle: meta.normTitle,
          normAuthor: meta.normAuthor,
          documentHash: entry.documentHash || '',
          percent: entryPct,
          rawPercent: entryRawPct,
          finished: entryFinished,
          lastEvent: 'backfill',
          lastReadTs: entryTs,
          startDate: entryStartDate,
          lastDate: entryDate,
          durationSeconds: entryDur,
          pagesTurned: entryPages,
          sessions: entrySessions
        });
      } else {
        const cur = merged.get(existingKey);
        const restoredFromBackfill =
          (cur.percent === null || cur.percent === undefined || cur.percent === 0) &&
          entryPct !== null &&
          entryPct > 0;
        if (restoredFromBackfill) {
          cur.percent = entryPct;
          cur.finished = entryFinished;
        }
        if (isReadFolderPath(existingKey)) {
          cur.finished = true;
          if (cur.percent === null || cur.percent === undefined || cur.percent === 0) {
            cur.percent = 100;
          }
        }
        cur.durationSeconds = Math.max(cur.durationSeconds || 0, entryDur);
        cur.pagesTurned = entryPages || cur.pagesTurned || 0;
        cur.sessions = entrySessions || cur.sessions || 0;
        if (cur.rawPercent === null || cur.rawPercent === undefined) {
          cur.rawPercent = entryRawPct;
        }
        if (!cur.startDate && entryStartDate) {
          cur.startDate = entryStartDate;
        }
        if (cur.inferredFromReadFolder) {
          if (entryFinished) {
            if (entryDate) cur.lastDate = entryDate;
            if (entryTs) cur.lastReadTs = entryTs;
          } else {
            const liveDate = localIsoDateFromTs(cur.lastReadTs);
            if (liveDate && (!entryDate || liveDate >= entryDate)) {
              cur.lastDate = liveDate;
            } else if (entryDate) {
              cur.lastDate = entryDate;
              if (entryTs) cur.lastReadTs = entryTs;
            }
          }
        } else {
          if ((!cur.lastDate || restoredFromBackfill) && entryDate) {
            cur.lastDate = entryDate;
          }
          if ((!cur.lastReadTs || restoredFromBackfill) && entryTs) {
            cur.lastReadTs = entryTs;
          }
        }
      }
    }
    return merged;
  }

  function findMappingForBook(mapData, book) {
    const books = (mapData && mapData.books && typeof mapData.books === 'object') ? mapData.books : {};
    if (books[book.sdPath]) {
      return { key: book.sdPath, entry: books[book.sdPath], migrated: false };
    }

    for (const [key, entry] of Object.entries(books)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.sdPath === book.sdPath) {
        return { key, entry, migrated: key !== book.sdPath };
      }
    }

    if (book.documentHash) {
      for (const [key, entry] of Object.entries(books)) {
        if (entry && entry.documentHash && entry.documentHash === book.documentHash) {
          return { key, entry, migrated: true };
        }
      }
    }

    if (book.normFilename) {
      for (const [key, entry] of Object.entries(books)) {
        if (!entry) continue;
        const entryNormFile = entry.normFilename || extractFilenameMeta(entry.sdPath || key).normFilename;
        if (entryNormFile && entryNormFile === book.normFilename) {
          return { key, entry, migrated: true };
        }
      }
    }

    if (book.normTitle) {
      for (const [key, entry] of Object.entries(books)) {
        if (!entry) continue;
        const meta = extractFilenameMeta(entry.sdPath || key);
        const entryTitle = normalizeText(entry.title || meta.title);
        const entryAuthor = normalizeText(entry.author || meta.author);
        if (
          entryTitle &&
          entryTitle === book.normTitle &&
          (!book.normAuthor || !entryAuthor || entryAuthor === book.normAuthor)
        ) {
          return { key, entry, migrated: true };
        }
      }
    }

    return null;
  }

  function parseBookIdInput(rawInput) {
    const val = String(rawInput || '').trim();
    if (!val) return null;
    const match = val.match(/\/books\/([^/?#\s]+)/i);
    if (match) return match[1];
    if (/^[a-zA-Z0-9_-]{4,128}$/.test(val)) return val;
    return null;
  }

  function buildProgressFormBody({ bookId, csrf, progressValue, progressType, bookNumOfPages }) {
    const params = new URLSearchParams();
    params.set('read_status[progress_number]', String(progressValue));
    params.set('read_status[progress_type]', progressType === 'pages' ? 'pages' : 'percentage');
    params.set('read_status[book_num_of_pages]', String(bookNumOfPages || 0));
    params.set('book_id', String(bookId));
    params.set('on_book_page', 'true');
    params.set('authenticity_token', String(csrf || ''));
    return params.toString();
  }

  function parseHtmlDocument(html) {
    if (typeof DOMParser === 'undefined') {
      throw new Error('DOMParser is unavailable in this environment');
    }
    return new DOMParser().parseFromString(String(html || ''), 'text/html');
  }

  function detectHtmlGuards(doc, rawHtml) {
    const text = String(rawHtml || '');
    const lower = text.toLowerCase();
    const title = (doc.querySelector('title')?.textContent || '').trim();
    const hasSignInForm = Boolean(doc.querySelector('form[action*="/users/sign_in"]'));
    const cloudflareBlocked =
      lower.includes('just a moment...') ||
      lower.includes('/cdn-cgi/challenge-platform') ||
      lower.includes('cf-chl-') ||
      lower.includes('enable javascript and cookies to continue');
    const redirectedToSignIn =
      hasSignInForm || (title.toLowerCase().includes('sign in') && lower.includes('the storygraph'));

    const csrfMeta = doc.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
    const csrfInput = doc.querySelector('input[name="authenticity_token"]')?.getAttribute('value') || '';
    const csrf = csrfMeta || csrfInput || null;

    return { title, csrf, cloudflareBlocked, redirectedToSignIn };
  }

  function parseStoryGraphHomepage(html) {
    const doc = parseHtmlDocument(html);
    const guards = detectHtmlGuards(doc, html);
    const currentReads = [];
    const seen = new Set();

    let heading = null;
    for (const h2 of doc.querySelectorAll('h2')) {
      if ((h2.textContent || '').toLowerCase().includes('current reads')) {
        heading = h2;
        break;
      }
    }

    if (heading) {
      let section = heading.parentElement;
      if (section && section.querySelectorAll('a[href^="/books/"]').length === 0 && section.parentElement) {
        section = section.parentElement;
      }
      if (section) {
        for (const link of section.querySelectorAll('a[href^="/books/"]')) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/^\/books\/([^/?#]+)/);
          if (!match) continue;
          const bookId = match[1];
          if (seen.has(bookId)) continue;
          seen.add(bookId);

          const card = link.closest('.book-pane, .current-read-card, div') || link.parentElement || section;
          const img = link.querySelector('img') || card.querySelector('img');
          let title = '';
          let author = '';
          if (img) {
            const alt = (img.getAttribute('alt') || '').trim();
            if (alt.includes(' by ')) {
              const idx = alt.lastIndexOf(' by ');
              title = alt.slice(0, idx).trim();
              author = alt.slice(idx + 4).trim();
            } else if (alt) {
              title = alt;
            }
          }
          if (!title) {
            const titleLink = card.querySelector('a.standard-link') || link;
            title = (titleLink.textContent || '').replace(/\s+/g, ' ').trim();
          }
          if (!author) {
            const authorEl = card.querySelector('a[href^="/authors/"], p.text-darkerGrey');
            author = (authorEl?.textContent || '').replace(/\s+/g, ' ').trim();
          }

          let percent = null;
          for (const span of card.querySelectorAll('span')) {
            const m = (span.textContent || '').trim().match(/^(\d{1,3})%$/);
            if (m) {
              percent = Number(m[1]);
              break;
            }
          }

          if (title) {
            currentReads.push({ bookId, title, author, percent });
          }
        }
      }
    }

    return Object.assign({}, guards, { currentReads });
  }

  function parseStoryGraphSearch(html, includeAudio) {
    const doc = parseHtmlDocument(html);
    const guards = detectHtmlGuards(doc, html);
    const results = [];
    const seen = new Set();

    const blocks = doc.querySelectorAll('.book-title-author-and-series');
    for (const el of blocks) {
      const titleLink = el.querySelector('a[href^="/books/"]');
      if (!titleLink) continue;
      const href = titleLink.getAttribute('href') || '';
      const match = href.match(/\/books\/([^/?#]+)/);
      if (!match) continue;
      const bookId = match[1];
      if (seen.has(bookId)) continue;
      seen.add(bookId);

      const title = (titleLink.textContent || '').replace(/\s+/g, ' ').trim();
      const authorLink = el.querySelector('a[href^="/authors/"]');
      const author = (authorLink?.textContent || '').replace(/\s+/g, ' ').trim() || 'Unknown Author';

      const pane = el.closest('.book-pane') || el.parentElement;
      let pages = 0;
      let format = '';
      if (pane) {
        for (const p of pane.querySelectorAll('p')) {
          const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
          const pm = t.match(/(\d+)\s+pages/i);
          if (pm && !pages) pages = Number(pm[1]) || 0;
          const fm = t.match(/Format:\s*(.+)$/i);
          if (fm && !format) format = fm[1].trim();
        }
      }
      const isAudio = /audio/i.test(format);
      if (title && (includeAudio || !isAudio)) {
        results.push({ bookId, title, author, pages, format, isAudio });
      }
    }

    if (results.length === 0) {
      for (const link of doc.querySelectorAll('a.book-list-option[href^="/books/"]')) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/books\/([^/?#]+)/);
        if (!match) continue;
        const bookId = match[1];
        if (seen.has(bookId)) continue;
        seen.add(bookId);

        const titleEl = link.querySelector('h1 span') || link.querySelector('h1') || link;
        const authorEl = link.querySelector('h2');
        const title = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
        const author = (authorEl?.textContent || '').replace(/\s+/g, ' ').trim() || 'Unknown Author';
        if (title) {
          results.push({ bookId, title, author, pages: 0, format: '', isAudio: false });
        }
      }
    }

    return Object.assign({}, guards, { results });
  }

  function mapStatusLabel(labelText) {
    const t = String(labelText || '').toLowerCase().trim();
    if (!t) return 'none';
    if (t.includes('currently reading')) return 'currently-reading';
    if (t.includes('rereading')) return 'rereading';
    if (t.includes('to-read') || t.includes('to read')) return 'to-read';
    if (t.includes('paused')) return 'paused';
    if (t.includes('did not finish')) return 'did-not-finish';
    if (t === 'read' || /\bread$/.test(t)) return 'read';
    return 'none';
  }

  function parseStoryGraphBookPage(html, bookId) {
    const doc = parseHtmlDocument(html);
    const guards = detectHtmlGuards(doc, html);

    const statusText = doc.querySelector('.read-status-label')?.textContent || '';
    const status = mapStatusLabel(statusText);

    const pagesInput = doc.querySelector(
      'input[name="read_status[book_num_of_pages]"], input.read-status-book-num-of-pages'
    );
    const bookNumOfPages = toFiniteNumber(pagesInput?.getAttribute('value')) || 0;

    const selectedOpt = doc.querySelector('select[name="read_status[progress_type]"] option[selected]');
    const progressType = selectedOpt?.getAttribute('value') === 'pages' ? 'pages' : 'percentage';

    let lastReachedPercent = null;
    const barDiv = doc.querySelector('.edit-progress div[style*="width"]');
    if (barDiv) {
      const m = (barDiv.getAttribute('style') || '').match(/width:\s*(\d+)%/i);
      if (m) lastReachedPercent = Number(m[1]);
    }
    if (lastReachedPercent === null) {
      const pctInput = doc.querySelector(
        'input[name="read_status[last_reached_percent]"], input.read-status-last-reached-percent'
      );
      lastReachedPercent = toFiniteNumber(pctInput?.getAttribute('value'));
    }

    const lastPagesInput = doc.querySelector(
      'input[name="read_status[last_reached_pages]"], input.read-status-last-reached-pages'
    );
    const lastReachedPages = toFiniteNumber(lastPagesInput?.getAttribute('value'));

    let otherEditionId = null;
    if (status === 'none') {
      for (const a of doc.querySelectorAll('a[href^="/books/"]')) {
        const txt = (a.textContent || '').toLowerCase();
        if (txt.includes('currently reading another edition') || txt.includes('want to read another edition')) {
          const m = (a.getAttribute('href') || '').match(/^\/books\/([^/?#]+)$/);
          if (m && m[1] !== bookId) {
            otherEditionId = m[1];
            break;
          }
        }
      }
    }

    let pageTitle = '';
    const h3 = doc.querySelector('h3');
    if (h3) pageTitle = (h3.textContent || '').replace(/\s+/g, ' ').trim();

    let readInstanceId = null;
    let finishedDate = null;
    const readInstLink = doc.querySelector('a[href*="/edit-read-instance-from-book"]');
    if (readInstLink) {
      const rawHref = (readInstLink.getAttribute('href') || '').replace(/&amp;/gi, '&');
      const qIdx = rawHref.indexOf('?');
      if (qIdx !== -1) {
        const rid = new URLSearchParams(rawHref.slice(qIdx + 1)).get('read_instance_id');
        if (rid) readInstanceId = rid.trim();
      }
      finishedDate = parseStoryGraphDisplayDate(readInstLink.textContent);
    }

    let startJournalEntryId = null;
    let startedDate = null;
    const startJournalLink = doc.querySelector('a[href*="/edit-journal-entry-from-book"]');
    if (startJournalLink) {
      const rawHref = (startJournalLink.getAttribute('href') || '').replace(/&amp;/gi, '&');
      const qIdx = rawHref.indexOf('?');
      if (qIdx !== -1) {
        const jid = new URLSearchParams(rawHref.slice(qIdx + 1)).get('journal_entry_id');
        if (jid) startJournalEntryId = jid.trim();
      }
      startedDate = parseStoryGraphDisplayDate(startJournalLink.textContent);
    }

    return Object.assign({}, guards, {
      bookId,
      pageTitle,
      status,
      bookNumOfPages,
      progressType,
      lastReachedPercent,
      lastReachedPages,
      otherEditionId,
      readInstanceId,
      finishedDate,
      startJournalEntryId,
      startedDate
    });
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__StoryGraphSync = {
      pluginPath,
      utf8ToBase64,
      toFiniteNumber,
      normalizeText,
      extractFilenameMeta,
      parseCookieHeader,
      serializeCookieMap,
      serializeEssentialCookies,
      measureHeaderBytes,
      fitHeadersForCrossInk,
      isRelay502Error,
      didBookReachProgressTarget,
      MONTH_NAMES,
      formatHumanDate,
      formatHumanDateRange,
      formatShortDate: formatHumanDate,
      parseIsoDateParts,
      parseStoryGraphDisplayDate,
      resolveBookTargetDates,
      buildReadInstanceDateBody,
      buildStartJournalDateBody,
      getDateSyncCandidateRows,
      mergeSetCookieHeaders,
      getPendingSyncRows,
      classifyBookRow,
      isRowNeedsSync,
      isRowNeedsDateSync,
      filterAndSortBookRows,
      localIsoDateFromTs,
      parseStoryGraphJournalDate,
      parseStoryGraphJournalPage,
      buildJournalEntryUpdateBody,
      buildJournalEntryDeleteBody,
      planJournalCleanup,
      FETCH_RETRY_DELAYS_MS,
      CLEAN_JOURNALS_PACING_MS,
      isTransientFetchError,
      computePercentFromBp,
      computeBookJournalWatermark,
      invalidateBookCleanupCache,
      stampBookCleanupVerified,
      shouldSkipJournalCleanup,
      buildDatedProgressFormBody,
      cloneHistoryData,
      mergeEventsIntoHistory,
      parseSessionHistoryText,
      importSessionHistoryPayload,
      formatLocalClockFromTs,
      getTimeOfDayPeriodFromTs,
      formatSessionTimeRangeLabel,
      formatSessionJournalNote,
      getBookHistorySessions,
      getBookDisplayHistorySessions,
      getUnsyncedJournalSessions,
      updateHistorySessionLedger,
      collectClaimedJournalEntryIds,
      getBookHistoryDays,
      getBookDisplayHistoryDays,
      getUnsyncedJournalDays,
      isJournalDayAlreadyOnStoryGraph,
      isReadFolderPath,
      computePercentFromVars,
      reduceEventsJsonl,
      compactEventsJsonl,
      removeBookFromEventsJsonl,
      mergeBackfillIntoEvents,
      findMappingForBook,
      parseBookIdInput,
      buildProgressFormBody,
      parseStoryGraphHomepage,
      parseStoryGraphSearch,
      parseStoryGraphBookPage,
      isBookFileEntry,
      joinSdPath,
      parentSdPath,
      filterAndSortSdEntries
    };
  }

  if (typeof CrossPoint === 'undefined' || !CrossPoint || typeof CrossPoint.registerPlugin !== 'function') {
    return;
  }

  CrossPoint.registerPlugin(async (container, api) => {
    const PLUGIN_NAME = (api && api.name) || 'storygraph-sync';
    const PLUGIN_DIR =
      api && typeof api.dir === 'string' && api.dir.startsWith('/')
        ? api.dir.replace(/\/+$/, '')
        : '/.crosspoint/plugins/' + PLUGIN_NAME;

    let cookieMap = loadCookieMap();
    let userAgent = lsGet(LS_UA_KEY, typeof navigator !== 'undefined' ? navigator.userAgent : '');
    let autoCompact = lsGet(LS_AUTO_COMPACT_KEY, '1') !== '0';
    let overwriteLowerInBatch = lsGet(LS_OVERWRITE_LOWER_KEY, '0') === '1';
    let includeJournalNotes = lsGet(LS_JOURNAL_NOTES_KEY, '1') !== '0';
    let deviceLabel = lsGet(LS_DEVICE_LABEL_KEY, DEFAULT_DEVICE_LABEL);
    let mapData = { version: 1, books: {} };
    let historyData = { version: 1, books: {} };
    let outboxBytes = 0;
    let outboxRaw = '';
    let outboxBooks = new Map();
    let stagedBooks = new Map();
    let sdBrowserPath = '/';
    let sdBrowserEntries = [];
    let sdBrowserLoaded = false;
    let sdBrowserLoading = false;
    let sdBrowserError = '';
    let currentReads = [];
    let sessionVerified = false;
    let activeLinkKey = null;
    let searchResultsByKey = Object.create(null);
    let busyLock = false;
    let activeFilter = 'all';
    let bookSearchQuery = '';
    let bookSort = 'smart';
    const sectionOpenState = { unlinked: true, reading: true, read: null };
    const historyOpenByKey = Object.create(null);

    function lsGet(key, fallback) {
      try {
        const val = localStorage.getItem(key);
        return val !== null ? val : fallback;
      } catch (_) {
        return fallback;
      }
    }

    function lsSet(key, val) {
      try {
        if (val) localStorage.setItem(key, val);
        else localStorage.removeItem(key);
      } catch (_) {}
    }

    function loadCookieMap() {
      return parseCookieHeader(lsGet(LS_COOKIE_KEY, ''));
    }

    function saveCookieMap(nextMap) {
      cookieMap = nextMap;
      const entries = Object.entries(nextMap || {}).filter(([, v]) => Boolean(v));
      const raw = entries.map(([k, v]) => `${k}=${v}`).join('; ');
      lsSet(LS_COOKIE_KEY, raw);
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;'
      }[ch]));
    }

    async function confirmAction(message) {
      if (typeof showWebConfirm === 'function') {
        return Boolean(await showWebConfirm(message));
      }
      return window.confirm(message);
    }

    function setBanner(text, kind) {
      const el = container.querySelector('#sg-banner');
      if (el) {
        el.textContent = text;
        el.className = 'sg-banner ' + (kind === 'err' ? 'sg-err' : kind === 'ok' ? 'sg-ok' : 'sg-muted');
      }
      if ((kind === 'ok' || kind === 'err') && typeof showWebToast === 'function') {
        showWebToast(text, kind === 'err');
      }
    }

    function setSyncProgress(percent, text) {
      const box = container.querySelector('#sg-sync-progress');
      const fill = container.querySelector('#sg-sync-fill');
      const label = container.querySelector('#sg-sync-text');
      const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      if (box) {
        box.classList.add('show');
        if (typeof box.setAttribute === 'function') {
          box.setAttribute('aria-valuenow', String(pct));
        }
      }
      if (fill) fill.style.width = `${pct}%`;
      if (label) label.textContent = String(text || '');
    }

    function hideSyncProgress() {
      const box = container.querySelector('#sg-sync-progress');
      const fill = container.querySelector('#sg-sync-fill');
      const label = container.querySelector('#sg-sync-text');
      if (box) {
        box.classList.remove('show');
        if (typeof box.setAttribute === 'function') {
          box.setAttribute('aria-valuenow', '0');
        }
      }
      if (fill) fill.style.width = '0%';
      if (label) label.textContent = '';
    }

    function setBusy(isBusy) {
      busyLock = isBusy;
      const wrap = container.querySelector('.sg-wrap');
      if (wrap) wrap.classList.toggle('sg-busy', isBusy);
      for (const btn of container.querySelectorAll('button')) {
        if (isBusy) {
          if (!btn.disabled) {
            btn.dataset.sgWasEnabled = '1';
            btn.disabled = true;
          }
        } else if (btn.dataset.sgWasEnabled === '1') {
          delete btn.dataset.sgWasEnabled;
          btn.disabled = false;
        }
      }
    }

    async function runExclusive(label, fn) {
      if (busyLock) {
        setBanner('Wait for the current StoryGraph request to finish.', 'err');
        return null;
      }
      setBusy(true);
      setBanner(label, 'muted');
      try {
        return await fn();
      } catch (err) {
        setBanner(String(err && err.message ? err.message : err), 'err');
        return null;
      } finally {
        setBusy(false);
      }
    }

    function buildHeaders(extra) {
      const headers = {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      };
      const ua = String(userAgent || '').trim();
      if (ua) headers['User-Agent'] = ua;
      const cookieStr = serializeCookieMap(cookieMap);
      if (cookieStr) headers.Cookie = cookieStr;
      return Object.assign(headers, extra || {});
    }

    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

    async function readPluginText(filename) {
      const res = await fetch(api.pluginFile(filename), { cache: 'no-store' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Read ${filename} failed: HTTP ${res.status}`);
      return res.text();
    }

    async function writePluginText(filename, text) {
      return api.writeFile(pluginPath(PLUGIN_DIR, filename), utf8ToBase64(text));
    }

    async function saveMapData() {
      await writePluginText(MAP_FILE, JSON.stringify(mapData, null, 2));
    }

    async function saveHistoryData() {
      await writePluginText(HISTORY_FILE, JSON.stringify(historyData, null, 2));
    }

    async function fetchStoryGraphHtml(url) {
      if (!cookieMap._storygraph_session) {
        throw new Error('Add your StoryGraph cookies in Account Settings first.');
      }
      const dest = pluginPath(PLUGIN_DIR, FETCH_TMP_FILE);
      const headers = fitHeadersForCrossInk(buildHeaders(), cookieMap);
      const retryDelays = Array.isArray(globalThis.__SG_FETCH_RETRY_DELAYS_MS)
        ? globalThis.__SG_FETCH_RETRY_DELAYS_MS
        : FETCH_RETRY_DELAYS_MS;
      const maxAttempts = 1 + retryDelays.length;
      let lastFetchErr = null;
      let attempts = 0;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        try {
          const fetchRes = await api.fetchToSd(url, dest, headers);
          const st = fetchRes && typeof fetchRes.status === 'number' ? fetchRes.status : null;
          if (st === 401) {
            sessionVerified = false;
            updateCookieBadge();
            const err = new Error('StoryGraph returned HTTP 401 (session expired). Re-paste your cookies.');
            err.status = 401;
            throw err;
          }
          if (st === 403 || st === 503) {
            const err = new Error(`StoryGraph returned HTTP ${st} (possible Cloudflare block).`);
            err.status = st;
            throw err;
          }
          if (fetchRes && fetchRes.error) {
            const err = new Error(String(fetchRes.error));
            if (st !== null) err.status = st;
            throw err;
          }
          if (st !== null && (st < 200 || st >= 300)) {
            const err = new Error(`StoryGraph fetch failed: HTTP ${st}`);
            err.status = st;
            throw err;
          }
          if (fetchRes && fetchRes.complete === false) {
            throw new Error('Incomplete fetch response written to SD card.');
          }
          lastFetchErr = null;
          break;
        } catch (err) {
          lastFetchErr = err;
          if (attempt < maxAttempts && isTransientFetchError(err, null)) {
            const delayMs = Number(retryDelays[attempt - 1]) || 0;
            if (delayMs > 0) await sleepMs(delayMs);
            continue;
          }
          const msg = String(err && err.message ? err.message : err);
          if (attempts > 1 && !msg.includes('attempt')) {
            const wrapped = new Error(`${msg} (after ${attempts} attempts)`);
            if (err && err.status) wrapped.status = err.status;
            throw wrapped;
          }
          throw err;
        }
      }
      if (lastFetchErr) {
        throw lastFetchErr;
      }

      const html = await readPluginText(FETCH_TMP_FILE);
      if (html === null) {
        throw new Error('Downloaded page could not be read back from SD card.');
      }
      const doc = parseHtmlDocument(html);
      const guards = detectHtmlGuards(doc, html);
      if (guards.cloudflareBlocked) {
        throw new Error('Cloudflare challenge detected. Refresh your browser cookies (including cf_clearance).');
      }
      if (guards.redirectedToSignIn) {
        sessionVerified = false;
        throw new Error('StoryGraph session expired (sign-in page returned). Re-paste your cookies.');
      }
      return html;
    }

    async function recheckBookPageAfter502(bookUrl, bookId) {
      await sleepMs(150);
      const html = await fetchStoryGraphHtml(bookUrl);
      return parseStoryGraphBookPage(html, bookId);
    }

    const TURBO_ACCEPT = 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml';

    function applyDateSyncToMapping(mapping, dateRes) {
      if (!mapping || !dateRes) return false;
      let changed = false;
      if (dateRes.syncedStartDate !== undefined && mapping.lastSyncedStartDate !== dateRes.syncedStartDate) {
        mapping.lastSyncedStartDate = dateRes.syncedStartDate;
        changed = true;
      }
      if (dateRes.syncedFinishDate !== undefined && mapping.lastSyncedFinishDate !== dateRes.syncedFinishDate) {
        mapping.lastSyncedFinishDate = dateRes.syncedFinishDate;
        changed = true;
      }
      return changed;
    }

    async function syncBookDates(row, pageInfo, activeBookUrl, opts = {}) {
      let info = pageInfo;
      if (!info) return { updated: false, skippedReason: 'no-page-info', pageInfo: info };

      if (info.status === 'read') {
        const target = resolveBookTargetDates(row, 'read');
        if (!target.finishDate) {
          return { updated: false, skippedReason: 'no-dates', pageInfo: info };
        }
        const targetStartIso = target.startDate ? target.startDate.iso : '';
        const targetFinishIso = target.finishDate.iso;

        if (!info.readInstanceId) {
          await sleepMs(150);
          const freshHtml = await fetchStoryGraphHtml(activeBookUrl);
          info = parseStoryGraphBookPage(freshHtml, info.bookId);
        }
        if (!info.readInstanceId) {
          return { updated: false, skippedReason: 'no-read-instance', pageInfo: info };
        }
        if (!info.csrf) {
          throw new Error('Could not find fresh CSRF token on book page.');
        }

        if (
          !opts.force &&
          info.finishedDate === targetFinishIso &&
          row.mapping &&
          row.mapping.lastSyncedFinishDate === targetFinishIso &&
          row.mapping.lastSyncedStartDate === targetStartIso
        ) {
          return {
            updated: false,
            skippedReason: 'already-synced',
            pageInfo: info,
            syncedStartDate: targetStartIso,
            syncedFinishDate: targetFinishIso
          };
        }

        await sleepMs(150);
        const body = buildReadInstanceDateBody({
          bookId: info.bookId,
          readInstanceId: info.readInstanceId,
          csrf: info.csrf,
          startDate: target.startDate,
          finishDate: target.finishDate
        });
        try {
          await postStoryGraphForm(
            `${BASE_URL}/read_instances/${encodeURIComponent(info.readInstanceId)}`,
            body,
            activeBookUrl,
            info.csrf,
            { accept: TURBO_ACCEPT }
          );
        } catch (err) {
          if (isRelay502Error(err)) {
            const recheck = await recheckBookPageAfter502(activeBookUrl, info.bookId);
            if (recheck.finishedDate === targetFinishIso) {
              info = recheck;
              return {
                updated: true,
                pageInfo: info,
                syncedStartDate: targetStartIso,
                syncedFinishDate: targetFinishIso
              };
            }
          }
          throw new Error('Read date update failed: ' + (err && err.message ? err.message : err));
        }

        return {
          updated: true,
          pageInfo: info,
          syncedStartDate: targetStartIso,
          syncedFinishDate: targetFinishIso
        };
      }

      if (info.status === 'currently-reading' || info.status === 'rereading') {
        const target = resolveBookTargetDates(row, info.status);
        if (!target.startDate) {
          return { updated: false, skippedReason: 'no-dates', pageInfo: info };
        }
        const targetStartIso = target.startDate.iso;

        if (!info.startJournalEntryId) {
          await sleepMs(150);
          const freshHtml = await fetchStoryGraphHtml(activeBookUrl);
          info = parseStoryGraphBookPage(freshHtml, info.bookId);
        }
        if (!info.startJournalEntryId) {
          return { updated: false, skippedReason: 'no-journal-entry', pageInfo: info };
        }
        if (!info.csrf) {
          throw new Error('Could not find fresh CSRF token on book page.');
        }

        if (info.startedDate && info.startedDate <= targetStartIso) {
          return {
            updated: false,
            skippedReason: 'already-earlier-or-equal',
            pageInfo: info,
            syncedStartDate: targetStartIso,
            syncedFinishDate: ''
          };
        }

        await sleepMs(150);
        const body = buildStartJournalDateBody({
          bookId: info.bookId,
          journalEntryId: info.startJournalEntryId,
          csrf: info.csrf,
          startDate: target.startDate
        });
        try {
          await postStoryGraphForm(
            `${BASE_URL}/update-journal-entry-from-book`,
            body,
            activeBookUrl,
            info.csrf,
            { accept: TURBO_ACCEPT }
          );
        } catch (err) {
          if (isRelay502Error(err)) {
            const recheck = await recheckBookPageAfter502(activeBookUrl, info.bookId);
            if (recheck.startedDate === targetStartIso) {
              info = recheck;
              return {
                updated: true,
                pageInfo: info,
                syncedStartDate: targetStartIso,
                syncedFinishDate: ''
              };
            }
          }
          throw new Error('Start date update failed: ' + (err && err.message ? err.message : err));
        }

        return {
          updated: true,
          pageInfo: info,
          syncedStartDate: targetStartIso,
          syncedFinishDate: ''
        };
      }

      return { updated: false, skippedReason: 'unsupported-status', pageInfo: info };
    }

    async function executeJournalCleanupPlan(bookId, journalParsed, fallbackCsrf, journalUrl, opts = {}) {
      const plan = planJournalCleanup(journalParsed && journalParsed.entries, opts);
      if (plan.updates.length === 0 && plan.deletes.length === 0) {
        return { updated: 0, deleted: 0, entries: (journalParsed && journalParsed.entries) || [] };
      }
      const csrf = (journalParsed && journalParsed.csrf) || fallbackCsrf;
      if (!csrf) {
        throw new Error('Could not find fresh CSRF token on journal page.');
      }
      const returnTo = `/journal?book_id=${encodeURIComponent(bookId)}`;
      let updated = 0;
      let deleted = 0;

      for (const u of plan.updates) {
        await sleepMs(150);
        const body = buildJournalEntryUpdateBody({
          csrf,
          date: u.date,
          pagesRead: u.pagesRead,
          pagesReadTotal: u.pagesReadTotal,
          percentReached: u.percentReached,
          note: u.note,
          returnTo
        });
        const entryUrl = `${BASE_URL}/journal_entries/${encodeURIComponent(u.entryId)}`;
        try {
          await postStoryGraphForm(entryUrl, body, journalUrl, csrf, {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          });
          updated++;
        } catch (err) {
          if (isRelay502Error(err)) {
            updated++;
          } else {
            throw new Error('Journal entry update failed: ' + (err && err.message ? err.message : err));
          }
        }
      }

      for (const d of plan.deletes) {
        await sleepMs(150);
        const body = buildJournalEntryDeleteBody(csrf);
        const entryUrl = `${BASE_URL}/journal_entries/${encodeURIComponent(d.entryId)}`;
        try {
          await postStoryGraphForm(entryUrl, body, journalUrl, csrf, {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          });
          deleted++;
        } catch (err) {
          if (isRelay502Error(err)) {
            deleted++;
          } else {
            throw new Error('Journal entry delete failed: ' + (err && err.message ? err.message : err));
          }
        }
      }

      const deletedSet = new Set(plan.deletes.map((d) => d.entryId));
      const remaining = ((journalParsed && journalParsed.entries) || []).filter(
        (e) => !e || !e.entryId || !deletedSet.has(e.entryId)
      );
      return { updated, deleted, entries: remaining };
    }

    async function cleanBookJournalCore(row) {
      const mapping = row && row.mapping;
      if (!mapping || !mapping.bookId) return { updated: 0, deleted: 0 };
      const journalUrl = `${BASE_URL}/journal?book_id=${encodeURIComponent(mapping.bookId)}`;
      const journalHtml = await fetchStoryGraphHtml(journalUrl);
      const journalParsed = parseStoryGraphJournalPage(journalHtml);
      const claimedEntryIds = collectClaimedJournalEntryIds(historyData);
      const rowSessions = getBookHistorySessions(historyData, row);
      const hasZeroPctSession = rowSessions.some(
        (s) => s.recordType === 'reading_session' && (s.endPercent === 0 || s.endPercent === null)
      );
      return executeJournalCleanupPlan(mapping.bookId, journalParsed, journalParsed.csrf, journalUrl, {
        claimedEntryIds,
        hasZeroPctSession
      });
    }

    async function syncBookJournalCore(row, pageInfo, activeBookUrl, opts = {}) {
      const allSessions = getBookHistorySessions(historyData, row);
      const unsynced = getUnsyncedJournalSessions(historyData, row);
      if (unsynced.length === 0) {
        return { posted: 0, skipped: 0, flaggedReconciliation: 0, lastPostedPercent: null, pageInfo };
      }
      const journalUrl = `${BASE_URL}/journal?book_id=${encodeURIComponent(pageInfo.bookId)}`;
      const journalHtml = await fetchStoryGraphHtml(journalUrl);
      let journalParsed = parseStoryGraphJournalPage(journalHtml);
      const claimedEntryIds = collectClaimedJournalEntryIds(historyData);
      const hasZeroPctSession = allSessions.some(
        (s) => s.recordType === 'reading_session' && (s.endPercent === 0 || s.endPercent === null)
      );
      const cleanRes = await executeJournalCleanupPlan(
        pageInfo.bookId,
        journalParsed,
        pageInfo.csrf,
        journalUrl,
        { claimedEntryIds, hasZeroPctSession }
      );
      if (cleanRes.deleted > 0 || cleanRes.updated > 0) {
        journalParsed.entries = cleanRes.entries;
      }
      const usePages = pageInfo.progressType === 'pages' && pageInfo.bookNumOfPages > 0;
      let lastPages = pageInfo.lastReachedPages || 0;
      let lastPct = pageInfo.lastReachedPercent || 0;
      let posted = 0;
      let skipped = 0;
      let flaggedReconciliation = 0;
      let lastPostedPercent = null;
      let histChanged = false;

      const entryMatchesTarget = (e, dateIso, targetVal, expectedNote) => {
        if (!e || e.date !== dateIso) return false;
        if (e.statusKind === 'finished') return false;
        if (e.isStatus) return false;
        if (usePages && e.pages !== null && e.pages !== undefined) {
          if (e.pages !== targetVal) return false;
        } else if (!usePages && e.percent !== null && e.percent !== undefined) {
          if (e.percent !== targetVal) return false;
        } else {
          return false;
        }
        if (expectedNote && e.note && e.note !== expectedNote) {
          return false;
        }
        return true;
      };

      // Count how many unsynced sessions share each (date, targetVal) tuple
      const computeSessionTargetVal = (sess) => {
        const pct = sess.endPercent ?? 0;
        if (!usePages) return pct;
        if (sess.endProgressBp !== null && sess.endProgressBp !== undefined) {
          return Math.max(
            0,
            Math.min(pageInfo.bookNumOfPages, Math.round((sess.endProgressBp / (sess.progressScale || 10000)) * pageInfo.bookNumOfPages))
          );
        }
        return pct > 0
          ? Math.max(1, Math.min(pageInfo.bookNumOfPages, Math.round((pct / 100) * pageInfo.bookNumOfPages)))
          : 0;
      };

      for (const session of unsynced) {
        const isGenuineFinalSitting =
          session.recordType === 'reading_session' && (session.durationSeconds || 0) > 0;
        if (
          opts &&
          opts.excludeHundredPercent &&
          !isGenuineFinalSitting &&
          session.endPercent !== null &&
          session.endPercent >= 100
        ) {
          if (markHistoryDaySynced(historyData, row, session.sessionId)) histChanged = true;
          skipped++;
          continue;
        }

        const targetVal = computeSessionTargetVal(session);
        const note = formatSessionJournalNote(session, includeJournalNotes, deviceLabel);

        // 1. Reconcile an interrupted 'in_flight' session (Issue B)
        if (session.syncStatus === 'in_flight') {
          const preSet = new Set(Array.isArray(session.prePostRemoteIds) ? session.prePostRemoteIds : []);
          const candidates = (journalParsed.entries || []).filter(
            (e) =>
              e &&
              e.entryId &&
              !claimedEntryIds.has(e.entryId) &&
              !preSet.has(e.entryId) &&
              entryMatchesTarget(e, session.date, targetVal, note)
          );
          if (candidates.length === 1) {
            const matchedId = candidates[0].entryId;
            claimedEntryIds.add(matchedId);
            if (
              updateHistorySessionLedger(historyData, row, session.sessionId, {
                syncStatus: 'synced',
                syncedToJournal: true,
                journalEntryId: matchedId,
                prePostRemoteIds: null,
                candidateJournalEntryIds: null
              })
            ) {
              histChanged = true;
            }
            skipped++;
            continue;
          } else if (candidates.length > 1) {
            if (
              updateHistorySessionLedger(historyData, row, session.sessionId, {
                syncStatus: 'needs_reconciliation',
                syncedToJournal: false,
                candidateJournalEntryIds: candidates.map((c) => c.entryId)
              })
            ) {
              histChanged = true;
            }
            flaggedReconciliation++;
            skipped++;
            continue;
          }
          // candidates.length === 0 -> previous POST never reached StoryGraph; proceed to submit
        }

        // 2. Check for an existing unclaimed remote entry from before ledger tracking
        const unclaimedMatches = (journalParsed.entries || []).filter((e, idx) => {
          const claimKey = e && (e.entryId || `${e.date}#${idx}`);
          if (!claimKey || claimedEntryIds.has(claimKey)) return false;
          if (e.date !== session.date) return false;
          if (e.statusKind === 'finished' && !isGenuineFinalSitting) return true;
          if (e.isStatus) return false;
          if (usePages && e.pages !== null && e.pages !== undefined) {
            return session.recordType === 'reading_session' ? e.pages === targetVal : e.pages >= targetVal;
          }
          if (!usePages && e.percent !== null && e.percent !== undefined) {
            return session.recordType === 'reading_session' ? e.percent === targetVal : e.percent >= targetVal;
          }
          return false;
        });

        if (unclaimedMatches.length === 1) {
          const matched = unclaimedMatches[0];
          const claimKey = matched.entryId || `${matched.date}#0`;
          claimedEntryIds.add(claimKey);
          if (
            updateHistorySessionLedger(historyData, row, session.sessionId, {
              syncStatus: 'synced',
              syncedToJournal: true,
              journalEntryId: matched.entryId || null,
              prePostRemoteIds: null,
              candidateJournalEntryIds: null
            })
          ) {
            histChanged = true;
          }
          skipped++;
          continue;
        }

        // 3. Snapshot current remote IDs and mark session in_flight before POST
        const prePostIds = (journalParsed.entries || []).map((e) => e && e.entryId).filter(Boolean);
        updateHistorySessionLedger(historyData, row, session.sessionId, {
          syncStatus: 'in_flight',
          prePostRemoteIds: prePostIds
        });
        histChanged = true;

        await sleepMs(150);
        const body = buildDatedProgressFormBody({
          bookId: pageInfo.bookId,
          csrf: pageInfo.csrf,
          date: session.date,
          progressValue: targetVal,
          progressType: usePages ? 'pages' : 'percentage',
          bookNumOfPages: pageInfo.bookNumOfPages,
          lastReachedPages: lastPages,
          lastReachedPercent: lastPct,
          note,
          returnTo: activeBookUrl
        });

        try {
          await postStoryGraphForm(`${BASE_URL}/update-progress-with-note`, body, activeBookUrl, pageInfo.csrf, {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          });
        } catch (err) {
          if (isRelay502Error(err)) {
            await sleepMs(150);
            const reHtml = await fetchStoryGraphHtml(journalUrl);
            const reParsed = parseStoryGraphJournalPage(reHtml);
            const preSet = new Set(prePostIds);
            const newMatches = (reParsed.entries || []).filter(
              (e) =>
                e &&
                e.entryId &&
                !claimedEntryIds.has(e.entryId) &&
                !preSet.has(e.entryId) &&
                entryMatchesTarget(e, session.date, targetVal, note)
            );
            if (newMatches.length === 1) {
              journalParsed = reParsed;
              const mintedId = newMatches[0].entryId;
              claimedEntryIds.add(mintedId);
              updateHistorySessionLedger(historyData, row, session.sessionId, {
                syncStatus: 'synced',
                syncedToJournal: true,
                journalEntryId: mintedId,
                prePostRemoteIds: null,
                candidateJournalEntryIds: null
              });
              lastPct = session.endPercent ?? lastPct;
              if (usePages) lastPages = targetVal;
              else if (pageInfo.bookNumOfPages > 0) lastPages = Math.round(((session.endPercent || 0) / 100) * pageInfo.bookNumOfPages);
              posted++;
              lastPostedPercent = session.endPercent ?? lastPostedPercent;
              continue;
            } else if (newMatches.length > 1) {
              updateHistorySessionLedger(historyData, row, session.sessionId, {
                syncStatus: 'needs_reconciliation',
                syncedToJournal: false,
                candidateJournalEntryIds: newMatches.map((m) => m.entryId)
              });
              flaggedReconciliation++;
              await saveHistoryData();
              throw new Error('Journal update ambiguous after 502; flagged for manual reconciliation.');
            }
          }
          if (histChanged) {
            try {
              await saveHistoryData();
            } catch (_) {}
          }
          throw new Error('Journal update failed: ' + (err && err.message ? err.message : err));
        }

        // Re-fetch journal to bind the newly minted journalEntryId into the ledger
        let mintedId = null;
        try {
          await sleepMs(100);
          const afterHtml = await fetchStoryGraphHtml(journalUrl);
          const afterParsed = parseStoryGraphJournalPage(afterHtml);
          journalParsed = afterParsed;
          const preSet = new Set(prePostIds);
          const mintedCandidates = (afterParsed.entries || []).filter(
            (e) => e && e.entryId && !claimedEntryIds.has(e.entryId) && !preSet.has(e.entryId)
          );
          if (mintedCandidates.length === 1) {
            mintedId = mintedCandidates[0].entryId;
          } else {
            const exact = mintedCandidates.find((e) => entryMatchesTarget(e, session.date, targetVal, note));
            if (exact) mintedId = exact.entryId;
          }
          if (mintedId) claimedEntryIds.add(mintedId);
        } catch (_) {}

        updateHistorySessionLedger(historyData, row, session.sessionId, {
          syncStatus: 'synced',
          syncedToJournal: true,
          journalEntryId: mintedId,
          prePostRemoteIds: null,
          candidateJournalEntryIds: null
        });
        histChanged = true;
        lastPct = session.endPercent ?? lastPct;
        if (usePages) lastPages = targetVal;
        else if (pageInfo.bookNumOfPages > 0) lastPages = Math.round(((session.endPercent || 0) / 100) * pageInfo.bookNumOfPages);
        posted++;
        lastPostedPercent = session.endPercent ?? lastPostedPercent;
      }

      if (histChanged) {
        await saveHistoryData();
      }

      return { posted, skipped, flaggedReconciliation, lastPostedPercent, pageInfo };
    }

    async function syncBookJournalAction(row) {
      const mapping = row.mapping;
      if (!mapping || !mapping.bookId) return;
      const unsynced = getUnsyncedJournalDays(historyData, row);
      if (unsynced.length === 0) {
        setBanner(`All reading sessions for "${row.title}" are already synced to StoryGraph.`, 'muted');
        return;
      }

      const reachesHundred =
        row.devicePercent === 100 ||
        mapping.status === 'read' ||
        unsynced.some((d) => d.endPercent !== null && d.endPercent >= 100);
      if (reachesHundred) {
        if (unsynced.some((d) => d.endPercent !== null && d.endPercent >= 100)) {
          row.devicePercent = 100;
        }
        await syncBook(row);
        return;
      }

      await runExclusive(`Syncing reading journal for "${row.title}"...`, async () => {
        try {
          setSyncProgress(15, `Loading "${row.title}" & journal from StoryGraph...`);
          const bookUrl = `${BASE_URL}/books/${encodeURIComponent(mapping.bookId)}`;
          const html = await fetchStoryGraphHtml(bookUrl);
          let pageInfo = parseStoryGraphBookPage(html, mapping.bookId);
          if (!pageInfo.csrf) throw new Error('Could not find fresh CSRF token on book page.');
          const activeBookUrl = `${BASE_URL}/books/${encodeURIComponent(pageInfo.bookId)}`;

          if (pageInfo.status === 'read') {
            let histMarked = false;
            for (const d of unsynced) {
              if (markHistoryDaySynced(historyData, row, d.date)) histMarked = true;
            }
            if (histMarked) await saveHistoryData();
            mapping.status = 'read';
            mapping.lastSyncedPercent = 100;
            mapping.lastSyncedAt = new Date().toISOString();
            invalidateBookCleanupCache(mapping);
            await saveMapData();
            renderBooks();
            const msg = `"${row.title}" is already marked Read on StoryGraph.`;
            setSyncProgress(100, msg);
            setBanner(msg, 'muted');
            return;
          }

          if (pageInfo.status !== 'currently-reading' && pageInfo.status !== 'rereading' && pageInfo.status !== 'read') {
            setSyncProgress(35, `Setting Currently Reading for "${row.title}"...`);
            await sleepMs(150);
            try {
              await postStoryGraphForm(
                `${BASE_URL}/update-status.js?book_id=${encodeURIComponent(pageInfo.bookId)}&status=currently-reading`,
                `authenticity_token=${encodeURIComponent(pageInfo.csrf)}`,
                activeBookUrl,
                pageInfo.csrf
              );
              pageInfo.status = 'currently-reading';
            } catch (err) {
              if (String(err && err.message ? err.message : err).includes('422')) {
                await postStoryGraphForm(
                  `${BASE_URL}/update-status.js?book_id=${encodeURIComponent(pageInfo.bookId)}&status=rereading`,
                  `authenticity_token=${encodeURIComponent(pageInfo.csrf)}`,
                  activeBookUrl,
                  pageInfo.csrf
                );
                pageInfo.status = 'rereading';
              } else {
                throw err;
              }
            }
          }

          setSyncProgress(60, `Posting ${unsynced.length} session(s) to "${row.title}" journal...`);
          const res = await syncBookJournalCore(row, pageInfo, activeBookUrl);
          let mapChanged = false;
          if (mapping.status !== pageInfo.status) {
            mapping.status = pageInfo.status;
            mapChanged = true;
          }
          if (res.lastPostedPercent !== null && (mapping.lastSyncedPercent === null || mapping.lastSyncedPercent === undefined || res.lastPostedPercent > mapping.lastSyncedPercent)) {
            mapping.lastSyncedPercent = res.lastPostedPercent;
            mapping.lastSyncedAt = new Date().toISOString();
            mapChanged = true;
          }
          if (res.posted > 0 && invalidateBookCleanupCache(mapping)) {
            mapChanged = true;
          }
          if (mapChanged) await saveMapData();
          renderBooks();
          const summary = `Journal synced for "${row.title}": ${res.posted} session(s) posted${res.skipped ? ', ' + res.skipped + ' already recorded' : ''}.`;
          setSyncProgress(100, summary);
          setBanner(summary, res.posted > 0 ? 'ok' : 'muted');
        } catch (err) {
          hideSyncProgress();
          throw err;
        }
      });
    }

    async function resolveReconciliation(row, sessionId, markSynced) {
      if (!row.mapping || !sessionId) return;
      const sess = getBookHistorySessions(historyData, row).find((s) => s.sessionId === sessionId);
      if (!sess || sess.syncStatus !== 'needs_reconciliation') return;
      const ok = await confirmAction(
        markSynced
          ? `Mark this "${row.title}" session as synced? Use this when the entry already appears in the StoryGraph Reading Journal. Nothing is posted.`
          : `Re-queue this "${row.title}" session? The next Sync posts it as a new journal entry. Only do this if it does NOT already appear in the StoryGraph Reading Journal, or it will be duplicated.`
      );
      if (!ok) return;
      await runExclusive('Updating reading history...', async () => {
        const cands = Array.isArray(sess.candidateJournalEntryIds) ? sess.candidateJournalEntryIds : [];
        const claimed = collectClaimedJournalEntryIds(historyData);
        const patch = markSynced
          ? { syncStatus: 'synced', journalEntryId: cands.find((id) => !claimed.has(String(id))) || null }
          : { syncStatus: 'pending', journalEntryId: null };
        patch.prePostRemoteIds = null;
        patch.candidateJournalEntryIds = null;
        if (updateHistorySessionLedger(historyData, row, sessionId, patch)) await saveHistoryData();
        if (invalidateBookCleanupCache(row.mapping)) await saveMapData();
        renderBooks();
        setBanner(
          markSynced
            ? `Marked session as synced for "${row.title}".`
            : `Re-queued session for "${row.title}" — click Sync Now or Sync Journal to post it.`,
          'ok'
        );
      });
    }

    async function postStoryGraphForm(url, bodyStr, refererUrl, csrf, opts) {
      if (!cookieMap._storygraph_session) {
        throw new Error('Add your StoryGraph cookies in Account Settings first.');
      }
      const acceptHdr =
        (opts && opts.accept) ||
        'text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01';
      const headers = fitHeadersForCrossInk(
        buildHeaders({
          Accept: acceptHdr,
          'Accept-Encoding': 'gzip',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-Token': csrf || '',
          Origin: BASE_URL,
          Referer: refererUrl || BASE_URL + '/'
        }),
        cookieMap
      );
      const res = await api.relay('POST', url, headers, bodyStr);
      const merged = mergeSetCookieHeaders(cookieMap, res.headers);
      if (merged.changed) {
        saveCookieMap(merged.map);
        updateCookieBadge();
      }

      let location = '';
      let cfMitigated = '';
      for (const [k, v] of res.headers || []) {
        const lk = String(k || '').toLowerCase();
        if (lk === 'location') location = String(v || '');
        if (lk === 'cf-mitigated') cfMitigated = String(v || '');
      }

      if (cfMitigated || res.status === 403 || res.status === 503) {
        throw new Error(`StoryGraph blocked POST (HTTP ${res.status}). Check cookies/Cloudflare.`);
      }
      if (res.status === 401 || location.includes('/users/sign_in')) {
        sessionVerified = false;
        throw new Error('StoryGraph session expired during POST. Re-paste your cookies.');
      }
      if (res.status === 422) {
        throw new Error('StoryGraph rejected CSRF token or form fields (HTTP 422). Refresh and retry.');
      }
      if (!((res.status >= 200 && res.status < 300) || res.status === 302 || res.status === 303)) {
        throw new Error(`StoryGraph POST failed: HTTP ${res.status}`);
      }
      return res;
    }

    async function loadLocalState() {
      const [eventsText, mapText, backfillText, historyText] = await Promise.all([
        readPluginText(EVENTS_FILE),
        readPluginText(MAP_FILE),
        readPluginText(BACKFILL_FILE),
        readPluginText(HISTORY_FILE)
      ]);

      outboxRaw = eventsText || '';
      outboxBytes = new TextEncoder().encode(outboxRaw).length;
      outboxBooks = reduceEventsJsonl(outboxRaw);

      if (backfillText) {
        try {
          const parsedBackfill = JSON.parse(backfillText);
          if (parsedBackfill && typeof parsedBackfill === 'object') {
            outboxBooks = mergeBackfillIntoEvents(outboxBooks, parsedBackfill);
          }
        } catch (_) {}
      }

      if (mapText) {
        try {
          const parsed = JSON.parse(mapText);
          if (parsed && typeof parsed === 'object' && parsed.books && typeof parsed.books === 'object') {
            mapData = parsed;
          }
        } catch (_) {}
      }

      if (historyText) {
        try {
          const parsedHist = JSON.parse(historyText);
          if (parsedHist && typeof parsedHist === 'object' && parsedHist.books && typeof parsedHist.books === 'object') {
            historyData = cloneHistoryData(parsedHist);
          }
        } catch (_) {}
      }
      const histMerge = mergeEventsIntoHistory(historyData, outboxRaw);
      if (histMerge.changed) {
        historyData = histMerge.history;
        try {
          await saveHistoryData();
        } catch (_) {}
      }

      // Migrate moved books (e.g., after organize_books.py or moving to /Read/) cleanly
      let migratedAny = false;
      let histMigratedAny = false;
      for (const book of outboxBooks.values()) {
        if (book.normFilename) {
          for (const [oldPath, oldRec] of Object.entries(historyData.books || {})) {
            if (!oldRec || oldPath === book.sdPath) continue;
            if (extractFilenameMeta(oldPath).normFilename !== book.normFilename) continue;
            const oldSessions = Array.isArray(oldRec.sessions) ? oldRec.sessions : [];
            if (oldSessions.length > 0) {
              for (const s of oldSessions) {
                upsertHistorySessionRecord(historyData, book.sdPath, s);
              }
            } else if (oldRec.days && typeof oldRec.days === 'object') {
              for (const [dKey, dVal] of Object.entries(oldRec.days)) {
                if (!dVal) continue;
                const iso = String(dVal.date || dKey);
                if (!iso) continue;
                upsertHistorySessionRecord(historyData, book.sdPath, {
                  sessionId: `legacy:${iso}`,
                  recordType: 'legacy_daily_summary',
                  date: iso,
                  startPercent: dVal.startPercent,
                  endPercent: dVal.endPercent,
                  durationSeconds: dVal.durationSeconds,
                  legacySessionCount: dVal.sessions,
                  seenIds: dVal.seenIds,
                  syncedToJournal: dVal.syncedToJournal
                });
              }
            }
            delete historyData.books[oldPath];
            histMigratedAny = true;
          }
        }
        const match = findMappingForBook(mapData, book);
        if (match && match.migrated) {
          if (match.key !== book.sdPath) {
            delete mapData.books[match.key];
          }
          mapData.books[book.sdPath] = Object.assign({}, match.entry, {
            sdPath: book.sdPath,
            normFilename: book.normFilename,
            documentHash: book.documentHash || match.entry.documentHash || ''
          });
          migratedAny = true;
        }
      }
      if (migratedAny) {
        await saveMapData();
      }
      if (histMigratedAny) {
        try {
          await saveHistoryData();
        } catch (_) {}
      }
    }

    function buildBookRows() {
      const rows = [];
      const seenKeys = new Set();

      for (const book of outboxBooks.values()) {
        const match = findMappingForBook(mapData, book);
        const mapping = match ? match.entry : null;
        seenKeys.add(book.sdPath);
        rows.push({
          key: book.sdPath,
          sdPath: book.sdPath,
          title: mapping?.title || book.title,
          author: mapping?.author || book.author,
          devicePercent: book.percent,
          rawPercent: book.rawPercent ?? null,
          durationSeconds: book.durationSeconds,
          pagesTurned: book.pagesTurned || 0,
          sessions: book.sessions || 0,
          lastReadTs: book.lastReadTs,
          startDate: book.startDate || '',
          lastDate: book.lastDate || '',
          documentHash: book.documentHash || mapping?.documentHash || '',
          fromBackfillOnly: book.lastEvent === 'backfill',
          mapping
        });
      }

      for (const [key, mapping] of Object.entries(mapData.books || {})) {
        if (!mapping || seenKeys.has(key) || seenKeys.has(mapping.sdPath)) continue;
        const meta = extractFilenameMeta(mapping.sdPath || key);
        rows.push({
          key: mapping.sdPath || key,
          sdPath: mapping.sdPath || key,
          title: mapping.title || meta.title,
          author: mapping.author || meta.author,
          devicePercent: null,
          rawPercent: null,
          durationSeconds: 0,
          pagesTurned: 0,
          sessions: 0,
          lastReadTs: null,
          startDate: '',
          lastDate: '',
          documentHash: mapping.documentHash || '',
          mapping
        });
      }

      for (const book of stagedBooks.values()) {
        if (!book || seenKeys.has(book.sdPath)) continue;
        seenKeys.add(book.sdPath);
        rows.push({
          key: book.sdPath,
          sdPath: book.sdPath,
          title: book.title,
          author: book.author,
          devicePercent: null,
          rawPercent: null,
          durationSeconds: 0,
          pagesTurned: 0,
          sessions: 0,
          lastReadTs: null,
          startDate: '',
          lastDate: '',
          documentHash: '',
          mapping: null,
          staged: true
        });
      }

      for (const row of rows) {
        if (!row || row.staged) continue;
        row.unsyncedJournalCount = row.mapping ? getUnsyncedJournalSessions(historyData, row).length : 0;
        const histSessions = getBookHistorySessions(historyData, row);
        const histDays = getBookHistoryDays(historyData, row);
        if (histDays.length > 0) {
          let maxHistPct = null;
          for (const d of histDays) {
            if (d.endPercent !== null && d.endPercent !== undefined) {
              if (maxHistPct === null || d.endPercent > maxHistPct) {
                maxHistPct = d.endPercent;
              }
            }
          }
          if (
            maxHistPct !== null &&
            (row.devicePercent === null || row.devicePercent === undefined || maxHistPct > row.devicePercent)
          ) {
            row.devicePercent = maxHistPct;
          }
          const histDur = histDays.reduce((sum, d) => sum + (d.durationSeconds || 0), 0);
          if (histDur > (row.durationSeconds || 0)) {
            row.durationSeconds = histDur;
          }
          const firstSessionStart =
            histSessions.length > 0 ? histSessions[0].startDate || histSessions[0].date : '';
          const firstDate = firstSessionStart || histDays[0].date;
          const latestDay = histDays[histDays.length - 1];
          const latestDate = latestDay.date;
          if (firstDate && (!row.startDate || firstDate < row.startDate)) {
            row.startDate = firstDate;
          }
          const hasActiveReading = (latestDay.durationSeconds || 0) > 0 || (latestDay.sessions || 0) > 0;
          if (latestDate && (!row.lastDate || (latestDate > row.lastDate && hasActiveReading))) {
            row.lastDate = latestDate;
          }
        }
        if (
          row.mapping &&
          row.mapping.status === 'read' &&
          row.mapping.lastSyncedPercent === 100 &&
          (row.devicePercent === null || row.fromBackfillOnly)
        ) {
          row.devicePercent = 100;
        }
      }

      rows.sort((a, b) => {
        if (Boolean(a.staged) !== Boolean(b.staged)) return a.staged ? -1 : 1;
        return (b.lastReadTs || 0) - (a.lastReadTs || 0);
      });
      return rows;
    }

    function formatDuration(sec) {
      const s = Math.round(Number(sec) || 0);
      if (s <= 0) return '';
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m`;
      return `${Math.floor(m / 60)}h ${m % 60}m`;
    }

    function formatShortDate(isoOrTs) {
      return formatHumanDate(isoOrTs);
    }

    function cookieSummaryText() {
      const keys = Object.keys(cookieMap || {}).filter((k) => Boolean(cookieMap[k]));
      if (keys.length === 0) return 'Not connected';
      const hasSess = Boolean(cookieMap._storygraph_session);
      if (!hasSess) return 'Missing _storygraph_session';
      if (sessionVerified) return `Connected (${keys.length} cookie${keys.length === 1 ? '' : 's'})`;
      return `Cookies saved (${keys.length}) · click Verify`;
    }

    function updateJournalNotePreview() {
      const el = container.querySelector('#sg-note-preview');
      if (!el) return;
      if (!includeJournalNotes) {
        el.textContent = 'Note preview: (blank — no duration note posted)';
        return;
      }
      const lbl = (deviceLabel || DEFAULT_DEVICE_LABEL).trim() || DEFAULT_DEVICE_LABEL;
      el.textContent = `Note preview: 21:05–21:38 · 33m read on ${lbl}`;
    }

    function updateCookieBadge() {
      const badge = container.querySelector('#sg-cookie-badge');
      if (badge) badge.textContent = cookieSummaryText();
      const pill = container.querySelector('#sg-session-pill');
      const keys = Object.keys(cookieMap || {}).filter((k) => Boolean(cookieMap[k]));
      const hasSess = Boolean(cookieMap._storygraph_session);
      if (pill) {
        if (!hasSess) {
          pill.textContent = keys.length > 0 ? 'Missing session' : 'No cookies';
          pill.className = 'sg-pill sg-pill-unlinked';
          pill.title = 'Expand Account Settings to paste StoryGraph cookies';
        } else if (sessionVerified) {
          pill.textContent = 'Connected';
          pill.className = 'sg-pill sg-pill-done';
          pill.title = 'StoryGraph session verified';
        } else {
          pill.textContent = 'Cookies saved';
          pill.className = 'sg-pill sg-pill-muted';
          pill.title = 'Click Verify Session in Account Settings to test';
        }
      }
      const hint = container.querySelector('#sg-cookie-hint');
      if (hint) {
        if (keys.length === 0) {
          hint.textContent = 'Accepts DevTools cookie header, Cookie-Editor JSON, Netscape cookies.txt, or cURL';
          hint.className = 'sg-muted';
        } else if (hasSess) {
          const cfNote = cookieMap.cf_clearance ? ' · cf_clearance included' : '';
          hint.textContent = `✓ Session cookie detected${cfNote}`;
          hint.className = 'sg-ok';
        } else {
          hint.textContent = '⚠ Missing _storygraph_session — copy all StoryGraph cookies';
          hint.className = 'sg-err';
        }
      }
      const meter = container.querySelector('#sg-header-meter');
      if (meter) {
        const bytes = measureHeaderBytes(buildHeaders());
        const kb = (bytes / 1024).toFixed(1);
        const note = bytes > 3900 ? ' (auto-trims non-essential)' : '';
        meter.textContent = `Headers: ${kb} / 4.0 KB${note}`;
        meter.className = bytes > 3900 ? 'sg-err' : bytes > 3200 ? 'sg-warn' : 'sg-muted';
      }
    }

    async function verifySession() {
      return runExclusive('Checking StoryGraph session via /api/fetch...', async () => {
        const html = await fetchStoryGraphHtml(BASE_URL + '/');
        const parsed = parseStoryGraphHomepage(html);
        if (!parsed.csrf) {
          throw new Error('Logged in check did not find a Rails CSRF token.');
        }
        sessionVerified = true;
        currentReads = parsed.currentReads || [];
        updateCookieBadge();
        renderBooks();
        setBanner(
          `Session verified. Found ${currentReads.length} Current Read(s) for quick linking.`,
          'ok'
        );
      });
    }

    async function linkBook(row, selection) {
      mapData.books[row.sdPath] = {
        bookId: selection.bookId,
        title: selection.title || row.title,
        author: selection.author || row.author,
        sdPath: row.sdPath,
        normFilename: extractFilenameMeta(row.sdPath).normFilename,
        documentHash: row.documentHash || '',
        trackingMode: selection.trackingMode || 'percentage',
        pageCount: selection.pages || 0,
        status: selection.status || 'currently-reading',
        lastSyncedPercent: selection.percent ?? null,
        lastSyncedAt: null
      };
      await saveMapData();
      stagedBooks.delete(row.sdPath);
      activeLinkKey = null;
      renderBooks();
      renderSdBrowser();
      setBanner(`Linked "${row.title}" to StoryGraph (${selection.bookId}).`, 'ok');
    }

    async function syncBookCore(row, opts = {}) {
      const mapping = row.mapping;
      if (!mapping || !mapping.bookId) return { outcome: 'skipped', summary: 'Unlinked' };
      const unsyncedAtStart = getUnsyncedJournalDays(historyData, row);
      for (const d of unsyncedAtStart) {
        if (
          d.endPercent !== null &&
          d.endPercent !== undefined &&
          (row.devicePercent === null || row.devicePercent === undefined || d.endPercent > row.devicePercent)
        ) {
          row.devicePercent = d.endPercent;
        }
      }
      if (row.devicePercent === null) {
        return { outcome: 'skipped', summary: 'No device reading event' };
      }

      const confirmRegression = async (singleMsg, batchDetail) => {
        if (typeof opts.confirmOverwrite === 'function') {
          return Boolean(await opts.confirmOverwrite(batchDetail));
        }
        return confirmAction(singleMsg);
      };

      if (row.devicePercent === 0) {
        const okZero = await confirmRegression(
          `Device progress for "${row.title}" is 0%. Sync 0% to StoryGraph?`,
          `"${row.title}" is at 0%`
        );
        if (!okZero) return { outcome: 'skipped', summary: 'Cancelled' };
      } else if (
        mapping.lastSyncedPercent !== null &&
        mapping.lastSyncedPercent !== undefined &&
        row.devicePercent < mapping.lastSyncedPercent
      ) {
        const okReg = await confirmRegression(
          `Device progress (${row.devicePercent}%) is lower than last synced (${mapping.lastSyncedPercent}%). Overwrite StoryGraph?`,
          `"${row.title}" is at ${row.devicePercent}% vs last synced ${mapping.lastSyncedPercent}%`
        );
        if (!okReg) return { outcome: 'skipped', summary: 'Cancelled' };
      }

      if (opts.onStage) opts.onStage('fetching');
      const bookUrl = `${BASE_URL}/books/${encodeURIComponent(mapping.bookId)}`;
      const html = await fetchStoryGraphHtml(bookUrl);
      let pageInfo = parseStoryGraphBookPage(html, mapping.bookId);

      if (pageInfo.status === 'none' && pageInfo.otherEditionId) {
        const otherHtml = await fetchStoryGraphHtml(
          `${BASE_URL}/books/${encodeURIComponent(pageInfo.otherEditionId)}`
        );
        const otherInfo = parseStoryGraphBookPage(otherHtml, pageInfo.otherEditionId);
        if (otherInfo.status !== 'none') {
          pageInfo = otherInfo;
          mapping.bookId = otherInfo.bookId;
          invalidateBookCleanupCache(mapping);
        }
      }

      if (!pageInfo.csrf) {
        throw new Error('Could not find fresh CSRF token on book page.');
      }

      if (pageInfo.status === 'read') {
        if (row.devicePercent === 100) {
          if (unsyncedAtStart.length > 0) {
            let histMarked = false;
            for (const d of unsyncedAtStart) {
              if (markHistoryDaySynced(historyData, row, d.date)) histMarked = true;
            }
            if (histMarked) {
              try {
                await saveHistoryData();
              } catch (_) {}
            }
          }
          mapping.status = 'read';
          mapping.lastSyncedPercent = 100;
          mapping.lastSyncedAt = new Date().toISOString();
          invalidateBookCleanupCache(mapping);
          await saveMapData();
          if (opts.onStage) opts.onStage('syncing-dates');
          const dateRes = await syncBookDates(row, pageInfo, bookUrl);
          if (applyDateSyncToMapping(mapping, dateRes)) {
            await saveMapData();
          }
          renderBooks();
          const dateNote = dateRes.updated ? ' (dates updated)' : '';
          return {
            outcome: 'synced',
            summary: `"${row.title}" is already marked Read on StoryGraph${dateNote}.`
          };
        }
        if (opts.batchMode || row.devicePercent <= 0) {
          return {
            outcome: 'skipped',
            summary: `Skipped "${row.title}" (already Read on StoryGraph)`
          };
        }
        const okReread = await confirmAction(
          `"${row.title}" is already marked Read on StoryGraph. Start a reread at ${row.devicePercent}%?`
        );
        if (!okReread) {
          return { outcome: 'skipped', summary: 'Cancelled reread' };
        }
      }

      if (
        pageInfo.lastReachedPercent !== null &&
        row.devicePercent < pageInfo.lastReachedPercent
      ) {
        const okRemote = await confirmRegression(
          `StoryGraph currently shows ${pageInfo.lastReachedPercent}%, which is higher than device ${row.devicePercent}%. Sync anyway?`,
          `"${row.title}" is at ${row.devicePercent}% vs StoryGraph ${pageInfo.lastReachedPercent}%`
        );
        if (!okRemote) {
          return { outcome: 'skipped', summary: 'Cancelled' };
        }
      }

      if (opts.onStage) opts.onStage('posting');
      await sleepMs(150);
      const activeBookUrl = `${BASE_URL}/books/${encodeURIComponent(pageInfo.bookId)}`;
      let currentStatus = pageInfo.status;

      const computeProgressTarget = (info) => {
        const useP = info.progressType === 'pages' && info.bookNumOfPages > 0;
        const val = useP
          ? Math.max(0, Math.min(info.bookNumOfPages, Math.round((row.devicePercent / 100) * info.bookNumOfPages)))
          : row.devicePercent;
        return { usePages: useP, progressValue: val };
      };

      let { usePages, progressValue } = computeProgressTarget(pageInfo);
      let didPriorPost = false;

      const todayIso = localIsoDateFromTs(Math.floor(Date.now() / 1000));
      const unsyncedJournalDays = getUnsyncedJournalSessions(historyData, row);
      const hasGenuineHundredSession = unsyncedJournalDays.some(
        (s) =>
          s.recordType === 'reading_session' &&
          (s.durationSeconds || 0) > 0 &&
          s.endPercent !== null &&
          s.endPercent >= 100
      );
      const isMultiDayHistory =
        unsyncedJournalDays.length > 1 ||
        hasGenuineHundredSession ||
        (unsyncedJournalDays.length > 0 &&
          unsyncedJournalDays.some(
            (d) =>
              d.date !== todayIso &&
              (d.recordType === 'reading_session' || (d.legacySessionCount || 0) > 0 || (d.durationSeconds || 0) > 0)
          )) ||
        (unsyncedJournalDays.length > 0 &&
          includeJournalNotes &&
          unsyncedJournalDays.some((d) => d.recordType === 'reading_session' || (d.durationSeconds || 0) > 0));
      const hasSub100JournalDays =
        isMultiDayHistory &&
        (hasGenuineHundredSession ||
          unsyncedJournalDays.some(
            (d) =>
              (d.endPercent !== null && d.endPercent > 0 && d.endPercent < 100) ||
              (d.recordType === 'reading_session' && (d.durationSeconds || 0) > 0)
          ));

      const postStatusRead = async () => {
        if (didPriorPost) await sleepMs(150);
        if (opts.onStage) opts.onStage('marking-read');
        const readUrl = `${BASE_URL}/update-status.js?book_id=${encodeURIComponent(pageInfo.bookId)}&status=read`;
        try {
          await postStoryGraphForm(
            readUrl,
            `authenticity_token=${encodeURIComponent(pageInfo.csrf)}`,
            activeBookUrl,
            pageInfo.csrf
          );
          currentStatus = 'read';
          didPriorPost = true;
        } catch (err) {
          if (isRelay502Error(err)) {
            const recheck = await recheckBookPageAfter502(activeBookUrl, pageInfo.bookId);
            if (recheck.status === 'read') {
              pageInfo = recheck;
              currentStatus = 'read';
              didPriorPost = true;
              return;
            }
          }
          throw new Error('Mark Read failed: ' + (err && err.message ? err.message : err));
        }
      };

      if (row.devicePercent === 100 && !hasSub100JournalDays) {
        if (currentStatus !== 'read') {
          await postStatusRead();
        }
        if (unsyncedJournalDays.length > 0) {
          let histMarked = false;
          for (const d of unsyncedJournalDays) {
            if (markHistoryDaySynced(historyData, row, d.sessionId || d.date)) histMarked = true;
          }
          if (histMarked) {
            try {
              await saveHistoryData();
            } catch (_) {}
          }
        }
      } else {
        if (currentStatus !== 'currently-reading' && currentStatus !== 'rereading') {
          const tryPostStatus = async (statusSlug) => {
            const statusUrl = `${BASE_URL}/update-status.js?book_id=${encodeURIComponent(pageInfo.bookId)}&status=${statusSlug}`;
            try {
              await postStoryGraphForm(
                statusUrl,
                `authenticity_token=${encodeURIComponent(pageInfo.csrf)}`,
                activeBookUrl,
                pageInfo.csrf
              );
              currentStatus = statusSlug;
              didPriorPost = true;
            } catch (err) {
              if (isRelay502Error(err)) {
                const recheck = await recheckBookPageAfter502(activeBookUrl, pageInfo.bookId);
                if (recheck.status === 'currently-reading' || recheck.status === 'rereading') {
                  pageInfo = recheck;
                  currentStatus = recheck.status;
                  ({ usePages, progressValue } = computeProgressTarget(pageInfo));
                  didPriorPost = true;
                  return;
                }
                throw new Error('Status update failed: ' + (err && err.message ? err.message : err));
              }
              throw err;
            }
          };

          try {
            await tryPostStatus('currently-reading');
          } catch (err) {
            if (String(err && err.message ? err.message : err).includes('422')) {
              await tryPostStatus('rereading');
            } else {
              throw err;
            }
          }
          if (!pageInfo.csrf) {
            throw new Error('Could not find fresh CSRF token on book page.');
          }
        }

        let progressHandledByJournal = false;
        if (isMultiDayHistory) {
          pageInfo.status = currentStatus;
          const jRes = await syncBookJournalCore(
            row,
            pageInfo,
            activeBookUrl,
            row.devicePercent === 100 ? { excludeHundredPercent: true } : {}
          );
          if (jRes.posted > 0) didPriorPost = true;
          if (jRes.lastPostedPercent !== null && jRes.lastPostedPercent >= row.devicePercent) {
            progressHandledByJournal = true;
            if (jRes.lastPostedPercent > row.devicePercent) {
              row.devicePercent = jRes.lastPostedPercent;
            }
          }
        }

        const alreadyAtTarget = didBookReachProgressTarget(pageInfo, {
          usePages,
          progressValue,
          devicePercent: row.devicePercent
        });
        if (row.devicePercent < 100 && !progressHandledByJournal && !alreadyAtTarget) {
          if (didPriorPost) await sleepMs(150);
          const body = buildProgressFormBody({
            bookId: pageInfo.bookId,
            csrf: pageInfo.csrf,
            progressValue,
            progressType: usePages ? 'pages' : 'percentage',
            bookNumOfPages: pageInfo.bookNumOfPages
          });
          try {
            await postStoryGraphForm(`${BASE_URL}/update-progress`, body, activeBookUrl, pageInfo.csrf);
            didPriorPost = true;
          } catch (err) {
            if (isRelay502Error(err)) {
              const recheck = await recheckBookPageAfter502(activeBookUrl, pageInfo.bookId);
              if (didBookReachProgressTarget(recheck, { usePages, progressValue, devicePercent: row.devicePercent })) {
                pageInfo = recheck;
                if (recheck.status === 'read') currentStatus = 'read';
                didPriorPost = true;
              } else {
                throw new Error('Progress update failed: ' + (err && err.message ? err.message : err));
              }
            } else {
              throw err;
            }
          }
        }

        if (!isMultiDayHistory && todayIso) {
          const tDays = getBookHistoryDays(historyData, row).filter(
            (d) => d.date === todayIso && !d.syncedToJournal && d.endPercent === row.devicePercent
          );
          if (tDays.length > 0 && markHistoryDaySynced(historyData, row, todayIso)) {
            try {
              await saveHistoryData();
            } catch (_) {}
          }
        }

        if (row.devicePercent === 100 && currentStatus !== 'read') {
          await postStatusRead();
        }
      }

      mapping.trackingMode = usePages ? 'pages' : 'percentage';
      mapping.pageCount = pageInfo.bookNumOfPages || mapping.pageCount || 0;
      mapping.status = currentStatus;
      mapping.lastSyncedPercent = row.devicePercent;
      mapping.lastSyncedAt = new Date().toISOString();
      invalidateBookCleanupCache(mapping);
      await saveMapData();

      if (opts.onStage) opts.onStage('syncing-dates');
      if (currentStatus === 'read' && pageInfo.status !== 'read') {
        pageInfo.readInstanceId = null;
      } else if (
        (currentStatus === 'currently-reading' || currentStatus === 'rereading') &&
        pageInfo.status !== currentStatus
      ) {
        pageInfo.startJournalEntryId = null;
      }
      pageInfo.status = currentStatus;
      const dateRes = await syncBookDates(row, pageInfo, activeBookUrl);
      if (applyDateSyncToMapping(mapping, dateRes)) {
        await saveMapData();
      }
      renderBooks();

      const unitNote = usePages ? ` (${progressValue}/${pageInfo.bookNumOfPages} pp)` : '';
      const statusNote = currentStatus === 'read' ? ' — Marked Read!' : '';
      const dateNote = dateRes.updated ? ' (dates synced)' : '';
      return {
        outcome: 'synced',
        summary: `Synced "${row.title}" → ${row.devicePercent}%${unitNote}${statusNote}${dateNote}`
      };
    }

    async function syncBook(row) {
      if (!row.mapping || !row.mapping.bookId) return;
      if (row.devicePercent === null) {
        setBanner('No device reading event recorded yet for this book.', 'err');
        return;
      }
      await runExclusive(`Syncing "${row.title}"...`, async () => {
        try {
          const res = await syncBookCore(row, {
            onStage(stage) {
              if (stage === 'fetching') {
                setSyncProgress(10, `Loading "${row.title}" from StoryGraph...`);
              } else if (stage === 'posting') {
                setSyncProgress(60, `Updating "${row.title}" to ${row.devicePercent}%...`);
              } else if (stage === 'marking-read') {
                setSyncProgress(82, `Marking "${row.title}" as Read...`);
              } else if (stage === 'syncing-dates') {
                setSyncProgress(92, `Syncing dates for "${row.title}"...`);
              }
            }
          });
          if (res.outcome === 'synced') {
            setSyncProgress(100, res.summary);
            setBanner(res.summary, 'ok');
          } else {
            hideSyncProgress();
            setBanner(res.summary, 'muted');
          }
        } catch (err) {
          hideSyncProgress();
          throw err;
        }
      });
    }

    async function syncAllPending() {
      const pending = getPendingSyncRows(buildBookRows());
      if (pending.length === 0) {
        setBanner('All linked books are already up to date.', 'muted');
        return;
      }

      const total = pending.length;
      await runExclusive(`Starting Sync All (${total} book(s))...`, async () => {
        let synced = 0;
        let skipped = 0;
        let failed = 0;
        let lastError = '';
        let batchOverwriteDecision = overwriteLowerInBatch ? 'overwrite' : null;

        const confirmOverwrite = async (detail) => {
          if (batchOverwriteDecision === 'overwrite') return true;
          if (batchOverwriteDecision === 'skip') return false;
          const ok = await confirmAction(
            `${detail}. Click OK to overwrite this and any other lower/0% books in this Sync All batch, or Cancel to skip all lower/0% books.`
          );
          batchOverwriteDecision = ok ? 'overwrite' : 'skip';
          return ok;
        };

        setSyncProgress(0, `Starting Sync All (0/${total})...`);

        for (let i = 0; i < total; i++) {
          const row = pending[i];
          if (i > 0) {
            await new Promise((r) => setTimeout(r, 400));
          }
          setBanner(`Syncing ${i + 1}/${total}: "${row.title}"...`, 'muted');
          try {
            const res = await syncBookCore(row, {
              batchMode: true,
              confirmOverwrite,
              onStage(stage) {
                if (stage === 'fetching') {
                  const pct = Math.round(((i + 0.15) / total) * 100);
                  setSyncProgress(pct, `Syncing ${i + 1} of ${total} (${pct}%) — "${row.title}" (loading page...)`);
                } else if (stage === 'posting') {
                  const pct = Math.round(((i + 0.65) / total) * 100);
                  setSyncProgress(pct, `Syncing ${i + 1} of ${total} (${pct}%) — "${row.title}" (saving ${row.devicePercent}%...)`);
                } else if (stage === 'marking-read') {
                  const pct = Math.round(((i + 0.82) / total) * 100);
                  setSyncProgress(pct, `Syncing ${i + 1} of ${total} (${pct}%) — "${row.title}" (marking Read...)`);
                } else if (stage === 'syncing-dates') {
                  const pct = Math.round(((i + 0.92) / total) * 100);
                  setSyncProgress(pct, `Syncing ${i + 1} of ${total} (${pct}%) — "${row.title}" (syncing dates...)`);
                }
              }
            });
            if (res.outcome === 'synced') synced++;
            else skipped++;
            const donePct = Math.round(((i + 1) / total) * 100);
            setSyncProgress(
              donePct,
              `${res.outcome === 'synced' ? 'Synced' : 'Skipped'} ${i + 1} of ${total} (${donePct}%) — "${row.title}"`
            );
          } catch (err) {
            failed++;
            lastError = String(err && err.message ? err.message : err);
            const lower = lastError.toLowerCase();
            if (lower.includes('expired') || lower.includes('cloudflare') || lower.includes('blocked')) {
              break;
            }
          }
        }

        let compactedNote = '';
        if (autoCompact && synced > 0 && failed === 0) {
          setSyncProgress(98, 'Saving reading history & compacting events.jsonl...');
          const preHist = mergeEventsIntoHistory(historyData, outboxRaw);
          if (preHist.changed) {
            historyData = preHist.history;
            await saveHistoryData();
          }
          await writePluginText(EVENTS_FILE, compactEventsJsonl(outboxRaw, historyData));
          await loadLocalState();
          renderAll();
          compactedNote = `, compacted outbox (${outboxBytes}/${OUTBOX_LIMIT_BYTES} B)`;
        }

        if (failed > 0) {
          const failPct = Math.min(99, Math.round(((synced + skipped) / total) * 100));
          setSyncProgress(
            failPct,
            `Sync All stopped: ${synced} synced, ${skipped} skipped, ${failed} failed`
          );
          setBanner(
            `Sync All finished: ${synced} synced, ${skipped} skipped, ${failed} failed (${lastError}).`,
            'err'
          );
        } else if (synced === 0) {
          setSyncProgress(100, `100% — Sync All finished: ${skipped} skipped`);
          setBanner(`Sync All finished: ${skipped} skipped.`, 'muted');
        } else {
          const skipPart = skipped ? `, ${skipped} skipped` : '';
          setSyncProgress(100, `100% — Sync All complete: ${synced} synced${skipPart}${compactedNote}`);
          setBanner(`Sync All complete: ${synced} synced${skipPart}${compactedNote}.`, 'ok');
        }
      });
    }

    async function syncAllDates() {
      const candidates = getDateSyncCandidateRows(buildBookRows());
      if (candidates.length === 0) {
        setBanner('All linked book dates are already synced.', 'muted');
        return;
      }

      const total = candidates.length;
      await runExclusive(`Starting Sync Dates (${total} book(s))...`, async () => {
        let updated = 0;
        let matched = 0;
        let failed = 0;
        let lastError = '';

        setSyncProgress(0, `Syncing Dates (0/${total})...`);

        for (let i = 0; i < total; i++) {
          const row = candidates[i];
          const mapping = row.mapping;
          if (!mapping || !mapping.bookId) continue;
          if (i > 0) {
            await sleepMs(400);
          }
          setBanner(`Syncing dates ${i + 1}/${total}: "${row.title}"...`, 'muted');
          try {
            const loadingPct = Math.round(((i + 0.2) / total) * 100);
            setSyncProgress(loadingPct, `Syncing dates ${i + 1} of ${total} (${loadingPct}%) — "${row.title}" (loading page...)`);
            const bookUrl = `${BASE_URL}/books/${encodeURIComponent(mapping.bookId)}`;
            const html = await fetchStoryGraphHtml(bookUrl);
            let pageInfo = parseStoryGraphBookPage(html, mapping.bookId);
            if (!pageInfo.csrf) {
              throw new Error('Could not find fresh CSRF token on book page.');
            }
            const postingPct = Math.round(((i + 0.7) / total) * 100);
            setSyncProgress(postingPct, `Syncing dates ${i + 1} of ${total} (${postingPct}%) — "${row.title}" (updating dates...)`);
            const dateRes = await syncBookDates(row, pageInfo, bookUrl);
            if (dateRes.updated) updated++;
            else matched++;
            if (applyDateSyncToMapping(mapping, dateRes)) {
              await saveMapData();
            }
            const donePct = Math.round(((i + 1) / total) * 100);
            setSyncProgress(
              donePct,
              `${dateRes.updated ? 'Updated dates' : 'Matched'} ${i + 1} of ${total} (${donePct}%) — "${row.title}"`
            );
          } catch (err) {
            failed++;
            lastError = String(err && err.message ? err.message : err);
            const lower = lastError.toLowerCase();
            if (lower.includes('expired') || lower.includes('cloudflare') || lower.includes('blocked')) {
              break;
            }
          }
        }

        renderBooks();

        if (failed > 0) {
          const failPct = Math.min(99, Math.round(((updated + matched) / total) * 100));
          setSyncProgress(
            failPct,
            `Date sync stopped: ${updated} updated, ${matched} already matched, ${failed} failed`
          );
          setBanner(
            `Date sync finished: ${updated} updated, ${matched} already matched, ${failed} failed (${lastError}).`,
            'err'
          );
        } else {
          setSyncProgress(100, `100% — Date sync complete: ${updated} updated, ${matched} already matched`);
          setBanner(`Date sync complete: ${updated} updated, ${matched} already matched.`, updated > 0 ? 'ok' : 'muted');
        }
      });
    }

    async function cleanAllJournals() {
      const linkedRows = buildBookRows().filter((r) => r && r.mapping && r.mapping.bookId);
      if (linkedRows.length === 0) {
        setBanner('Link at least one book to StoryGraph first.', 'muted');
        return;
      }

      const pacingMs =
        typeof globalThis.__SG_CLEAN_PACING_MS === 'number'
          ? globalThis.__SG_CLEAN_PACING_MS
          : CLEAN_JOURNALS_PACING_MS;
      const total = linkedRows.length;
      await runExclusive(`Scanning & cleaning journals (${total} book(s))...`, async () => {
        let skipped = 0;
        let verifiedClean = 0;
        let booksModified = 0;
        let totalDeleted = 0;
        let totalUpdated = 0;
        let failed = 0;
        let lastError = '';
        let fetchedCount = 0;
        let mapDirty = false;

        setSyncProgress(0, `Cleaning Journals (0/${total})...`);

        for (let i = 0; i < total; i++) {
          const row = linkedRows[i];
          if (shouldSkipJournalCleanup(row, historyData)) {
            skipped++;
            const donePct = Math.round(((i + 1) / total) * 100);
            setSyncProgress(donePct, `Skipped (cached clean) ${i + 1} of ${total} (${donePct}%) — "${row.title}"`);
            continue;
          }
          if (fetchedCount > 0 && pacingMs > 0) {
            await sleepMs(pacingMs);
          }
          fetchedCount++;
          const pct = Math.round(((i + 0.3) / total) * 100);
          setSyncProgress(pct, `Scanning journal ${i + 1} of ${total} (${pct}%) — "${row.title}"...`);
          setBanner(`Scanning journal ${i + 1}/${total}: "${row.title}"...`, 'muted');
          try {
            const res = await cleanBookJournalCore(row);
            if (res.deleted > 0 || res.updated > 0) {
              booksModified++;
              totalDeleted += res.deleted;
              totalUpdated += res.updated;
            } else {
              verifiedClean++;
            }
            stampBookCleanupVerified(row.mapping, historyData, row);
            mapDirty = true;
            const donePct = Math.round(((i + 1) / total) * 100);
            const actLabel =
              res.deleted > 0 || res.updated > 0
                ? `Cleaned (${res.deleted} deleted${res.updated ? ', ' + res.updated + ' repaired' : ''})`
                : 'Verified clean';
            setSyncProgress(donePct, `${actLabel} ${i + 1} of ${total} (${donePct}%) — "${row.title}"`);
          } catch (err) {
            failed++;
            lastError = String(err && err.message ? err.message : err);
            const lower = lastError.toLowerCase();
            if (
              lower.includes('expired') ||
              lower.includes('cloudflare') ||
              lower.includes('blocked') ||
              lower.includes('http 401') ||
              lower.includes('http 403')
            ) {
              break;
            }
          }
        }

        if (mapDirty) {
          try {
            await saveMapData();
          } catch (_) {}
        }

        const skipPart = skipped > 0 ? `, ${skipped} skipped` : '';
        if (failed > 0) {
          const failPct = Math.min(99, Math.round(((skipped + verifiedClean + booksModified) / total) * 100));
          setSyncProgress(
            failPct,
            `Journal cleanup finished: ${booksModified} modified, ${verifiedClean} verified clean${skipPart}, ${failed} failed`
          );
          setBanner(
            `Journal cleanup finished: ${totalDeleted} deleted, ${totalUpdated} repaired across ${booksModified} modified, ${verifiedClean} verified clean${skipPart}, ${failed} failed (${lastError}).`,
            'err'
          );
        } else if (totalDeleted === 0 && totalUpdated === 0) {
          const summary =
            skipped > 0
              ? `All ${total} linked book journal(s) are clean (${verifiedClean} verified clean, ${skipped} skipped).`
              : `All ${total} linked book journal(s) are already clean (${verifiedClean} verified clean).`;
          setSyncProgress(100, `100% — ${summary}`);
          setBanner(summary, 'muted');
        } else {
          const repairNote = totalUpdated > 0 ? `, ${totalUpdated} Finished page credit(s) repaired` : '';
          const cleanPart = verifiedClean > 0 ? `, ${verifiedClean} verified clean` : '';
          const msg = `Journal cleanup complete: ${totalDeleted} redundant/0% entry(s) deleted${repairNote} across ${booksModified} book(s)${cleanPart}${skipPart}.`;
          setSyncProgress(100, `100% — ${msg}`);
          setBanner(msg, 'ok');
        }
      });
    }

    async function cleanBookJournalAction(row) {
      if (!row || !row.mapping || !row.mapping.bookId) return;
      await runExclusive(`Scanning journal for "${row.title}"...`, async () => {
        try {
          setSyncProgress(30, `Scanning journal for "${row.title}"...`);
          const res = await cleanBookJournalCore(row);
          stampBookCleanupVerified(row.mapping, historyData, row);
          await saveMapData();
          renderBooks();
          const msg =
            res.deleted > 0 || res.updated > 0
              ? `Cleaned "${row.title}" journal: ${res.deleted} deleted${res.updated ? ', ' + res.updated + ' repaired' : ''}.`
              : `"${row.title}" journal is already clean.`;
          setSyncProgress(100, msg);
          setBanner(msg, res.deleted > 0 || res.updated > 0 ? 'ok' : 'muted');
        } catch (err) {
          hideSyncProgress();
          throw err;
        }
      });
    }

    async function markBookRead(row) {
      const mapping = row.mapping;
      if (!mapping || !mapping.bookId) return;
      const skipConfirm = overwriteLowerInBatch || /^\/read\//i.test(String(row.sdPath || ''));
      if (!skipConfirm) {
        const ok = await confirmAction(`Mark "${row.title}" as Read (100%) on StoryGraph?`);
        if (!ok) return;
      }

      await runExclusive(`Marking "${row.title}" as Read...`, async () => {
        try {
          setSyncProgress(20, `Loading "${row.title}" from StoryGraph...`);
          const bookUrl = `${BASE_URL}/books/${encodeURIComponent(mapping.bookId)}`;
          const html = await fetchStoryGraphHtml(bookUrl);
          let pageInfo = parseStoryGraphBookPage(html, mapping.bookId);
          if (!pageInfo.csrf) throw new Error('Could not find fresh CSRF token on book page.');

          if (pageInfo.status !== 'read') {
            setSyncProgress(65, `Marking "${row.title}" as Read...`);
            await sleepMs(150);
            const readUrl = `${BASE_URL}/update-status.js?book_id=${encodeURIComponent(pageInfo.bookId)}&status=read`;
            try {
              await postStoryGraphForm(
                readUrl,
                `authenticity_token=${encodeURIComponent(pageInfo.csrf)}`,
                bookUrl,
                pageInfo.csrf
              );
            } catch (err) {
              if (isRelay502Error(err)) {
                const recheck = await recheckBookPageAfter502(bookUrl, pageInfo.bookId);
                if (recheck.status !== 'read') {
                  throw new Error('Mark Read failed: ' + (err && err.message ? err.message : err));
                }
                pageInfo = recheck;
              } else {
                throw err;
              }
            }
          }

          mapping.status = 'read';
          mapping.lastSyncedPercent = 100;
          mapping.lastSyncedAt = new Date().toISOString();
          invalidateBookCleanupCache(mapping);
          await saveMapData();

          setSyncProgress(88, `Syncing dates for "${row.title}"...`);
          if (pageInfo.status !== 'read') {
            pageInfo.readInstanceId = null;
          }
          pageInfo.status = 'read';
          const dateRes = await syncBookDates(row, pageInfo, bookUrl);
          if (applyDateSyncToMapping(mapping, dateRes)) {
            await saveMapData();
          }

          if (outboxBooks.has(row.sdPath) && (outboxBooks.get(row.sdPath).percent ?? 0) < 100) {
            await writePluginText(EVENTS_FILE, removeBookFromEventsJsonl(outboxRaw, row.sdPath));
            await loadLocalState();
            renderAll();
          } else {
            renderBooks();
          }
          const dateNote = dateRes.updated ? ' (dates synced)' : '';
          setSyncProgress(100, `Marked "${row.title}" as Read on StoryGraph${dateNote}.`);
          setBanner(`Marked "${row.title}" as Read on StoryGraph${dateNote}.`, 'ok');
        } catch (err) {
          hideSyncProgress();
          throw err;
        }
      });
    }

    async function compactOutbox() {
      let ok = false;
      try {
        ok = await confirmAction(
          `Compact events.jsonl (${outboxBytes} B) down to the latest snapshot per book?`
        );
      } catch (err) {
        setBanner(String(err && err.message ? err.message : err), 'err');
        return;
      }
      if (!ok) return;
      await runExclusive('Saving history & compacting events.jsonl...', async () => {
        const preHist = mergeEventsIntoHistory(historyData, outboxRaw);
        if (preHist.changed) {
          historyData = preHist.history;
          await saveHistoryData();
        }
        const compacted = compactEventsJsonl(outboxRaw, historyData);
        await writePluginText(EVENTS_FILE, compacted);
        await loadLocalState();
        renderAll();
        setBanner(`Compacted events.jsonl (${outboxBytes} / ${OUTBOX_LIMIT_BYTES} B).`, 'ok');
      });
    }

    async function exportSettingsJson() {
      const ok = await confirmAction(
        'WARNING: The exported JSON includes your StoryGraph session cookies. Keep it private and never share it. Continue?'
      );
      if (!ok) return;
      const payload = JSON.stringify(
        {
          cookieHeader: lsGet(LS_COOKIE_KEY, ''),
          userAgent: userAgent || '',
          deviceLabel: deviceLabel || DEFAULT_DEVICE_LABEL
        },
        null,
        2
      );
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'storygraph-sync-settings.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setBanner('Exported browser settings JSON.', 'ok');
    }

    function importSettingsFromText(raw) {
      if (!raw || !String(raw).trim()) return;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.cookieHeader === 'string') {
          saveCookieMap(parseCookieHeader(parsed.cookieHeader));
          sessionVerified = false;
        }
        if (typeof parsed.userAgent === 'string') {
          userAgent = parsed.userAgent.trim();
          lsSet(LS_UA_KEY, userAgent);
        }
        if (typeof parsed.deviceLabel === 'string') {
          deviceLabel = parsed.deviceLabel.trim() || DEFAULT_DEVICE_LABEL;
          lsSet(LS_DEVICE_LABEL_KEY, deviceLabel);
        }
        syncSettingsInputs();
        setBanner('Imported browser settings.', 'ok');
      } catch (err) {
        setBanner('Invalid settings JSON: ' + err.message, 'err');
      }
    }

    function importSettingsJson() {
      const fileInput = container.querySelector('#sg-settings-file');
      if (fileInput && typeof fileInput.click === 'function') {
        fileInput.value = '';
        fileInput.click();
        return;
      }
      if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
        importSettingsFromText(window.prompt('Paste exported StoryGraph settings JSON:'));
      }
    }

    async function handleSettingsFileSelect(e) {
      const file = e && e.target && e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text =
          typeof file.text === 'function'
            ? await file.text()
            : await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
                reader.readAsText(file);
              });
        importSettingsFromText(text);
      } catch (err) {
        setBanner('Failed to read settings file: ' + (err && err.message ? err.message : err), 'err');
      }
    }

    function toggleSessionHistoryImportBox(forceOpen) {
      const box = container.querySelector('#sg-history-import-box');
      if (!box) return;
      const shouldOpen = forceOpen !== undefined ? Boolean(forceOpen) : !box.classList.contains('show');
      box.classList.toggle('show', shouldOpen);
      if (shouldOpen) {
        const ta = container.querySelector('#sg-history-textarea');
        if (ta && typeof ta.focus === 'function') ta.focus();
      }
    }

    async function handleSessionHistoryFileSelect(e) {
      const input = e && e.target;
      const file = input && input.files && input.files[0];
      const statusEl = container.querySelector('#sg-history-file-status');
      const ta = container.querySelector('#sg-history-textarea');
      if (!file) {
        if (statusEl) statusEl.textContent = '';
        return;
      }
      try {
        let text = '';
        if (typeof file.text === 'function') {
          text = await file.text();
        } else if (typeof FileReader !== 'undefined') {
          text = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
            reader.readAsText(file);
          });
        }
        if (ta) ta.value = text;
        if (statusEl) {
          statusEl.textContent = `Loaded ${file.name || 'file'} (${text.length} chars) — click Import`;
        }
        toggleSessionHistoryImportBox(true);
      } catch (err) {
        setBanner('Failed to read history file: ' + (err && err.message ? err.message : err), 'err');
      }
    }

    async function runSessionHistoryImport() {
      const ta = container.querySelector('#sg-history-textarea');
      const raw = ta ? String(ta.value || '').trim() : '';
      if (!raw) {
        setBanner('Paste session history JSON/JSONL or choose a file first.', 'err');
        if (ta && typeof ta.focus === 'function') ta.focus();
        return;
      }
      await runExclusive('Importing session history...', async () => {
        const parsed = parseSessionHistoryText(raw);
        const res = importSessionHistoryPayload(historyData, parsed, buildBookRows());
        historyData = res.history;
        await saveHistoryData();
        if (res.importedSessions > 0) {
          let mapInvalidated = false;
          for (const row of buildBookRows()) {
            if (
              row &&
              row.mapping &&
              row.mapping.lastJournalCleanedWatermark &&
              row.mapping.lastJournalCleanedWatermark !== computeBookJournalWatermark(historyData, row)
            ) {
              if (invalidateBookCleanupCache(row.mapping)) mapInvalidated = true;
            }
          }
          if (mapInvalidated) await saveMapData();
        }
        renderBooks();
        if (res.importedSessions > 0) {
          if (ta) ta.value = '';
          const fileInput = container.querySelector('#sg-history-file');
          const statusEl = container.querySelector('#sg-history-file-status');
          if (fileInput) fileInput.value = '';
          if (statusEl) statusEl.textContent = '';
          toggleSessionHistoryImportBox(false);
          setBanner(
            `Imported ${res.importedSessions} session(s) across ${res.importedBooks} book(s) into reading-history.json.`,
            'ok'
          );
        } else {
          setBanner(
            'Parsed valid JSON, but matched 0 reading session(s). Verify book path/hash/title and date/timestamp fields (or paste 1 sample line so its schema can be added).',
            'muted'
          );
        }
      });
    }

    function syncSettingsInputs() {
      const cInput = container.querySelector('#sg-cookie-input');
      const uInput = container.querySelector('#sg-ua-input');
      const acInput = container.querySelector('#sg-auto-compact');
      const owInput = container.querySelector('#sg-overwrite-lower');
      const jnInput = container.querySelector('#sg-journal-notes');
      const dlInput = container.querySelector('#sg-device-label');
      if (cInput) cInput.value = lsGet(LS_COOKIE_KEY, '');
      if (uInput) uInput.value = userAgent || '';
      if (acInput) acInput.checked = autoCompact;
      if (owInput) owInput.checked = overwriteLowerInBatch;
      if (jnInput) jnInput.checked = includeJournalNotes;
      if (dlInput) dlInput.value = deviceLabel || DEFAULT_DEVICE_LABEL;
      updateCookieBadge();
      updateJournalNotePreview();
    }

    function renderHeaderStats() {
      const statsEl = container.querySelector('#sg-header-stats');
      const rows = buildBookRows();
      const readingCount = rows.filter((r) => classifyBookRow(r) === 'reading').length;
      const readCount = rows.filter((r) => classifyBookRow(r) === 'read').length;
      const unlinkedCount = rows.filter((r) => classifyBookRow(r) === 'unlinked').length;
      const pendingCount = getPendingSyncRows(rows).length;
      const pendingDatesCount = getDateSyncCandidateRows(rows).length;
      if (statsEl) {
        const warn = outboxBytes >= OUTBOX_WARN_BYTES ? ' (near 4 KB cap!)' : '';
        if (rows.length === 0) {
          statsEl.textContent = `0 books · outbox ${outboxBytes}/${OUTBOX_LIMIT_BYTES} B${warn}`;
        } else {
          const parts = [`${readingCount} reading`, `${readCount} read`];
          if (unlinkedCount) parts.push(`${unlinkedCount} unlinked`);
          parts.push(`outbox ${outboxBytes}/${OUTBOX_LIMIT_BYTES} B${warn}`);
          statsEl.textContent = parts.join(' · ');
        }
        statsEl.className = outboxBytes >= OUTBOX_WARN_BYTES ? 'sg-err' : 'sg-muted';
      }
      const toolsBadge = container.querySelector('#sg-tools-badge');
      if (toolsBadge) {
        const nearCap = outboxBytes >= OUTBOX_WARN_BYTES;
        toolsBadge.textContent = nearCap
          ? `Outbox near 4 KB (${outboxBytes}/${OUTBOX_LIMIT_BYTES} B)!`
          : `Clean Journals · Outbox ${outboxBytes} B`;
        toolsBadge.className = nearCap ? 'sg-err' : 'sg-muted';
      }
      const tabsEl = container.querySelector('#sg-filter-tabs');
      if (tabsEl) {
        const counts = {
          all: rows.length,
          reading: readingCount,
          'needs-sync': pendingCount,
          read: readCount,
          unlinked: unlinkedCount
        };
        const labels = {
          all: 'All',
          reading: 'Reading',
          'needs-sync': 'Needs Sync',
          read: 'Read',
          unlinked: 'Unlinked'
        };
        for (const tabBtn of tabsEl.querySelectorAll('button')) {
          const f = tabBtn.getAttribute('data-filter');
          if (!f || !Object.prototype.hasOwnProperty.call(labels, f)) continue;
          const isActive = f === activeFilter;
          tabBtn.textContent = `${labels[f]} (${counts[f] ?? 0})`;
          tabBtn.classList.toggle('sg-tab-active', isActive);
          tabBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        }
      }
      const setBtnDisabled = (btn, shouldDisable) => {
        if (!btn) return;
        if (busyLock) {
          if (shouldDisable) delete btn.dataset.sgWasEnabled;
          else btn.dataset.sgWasEnabled = '1';
          btn.disabled = true;
        } else {
          btn.disabled = shouldDisable;
        }
      };
      const syncAllBtn = container.querySelector('#sg-sync-all');
      if (syncAllBtn) {
        syncAllBtn.textContent = pendingCount > 0 ? `Sync All (${pendingCount})` : 'Sync All';
        setBtnDisabled(syncAllBtn, pendingCount === 0);
      }
      const syncDatesBtn = container.querySelector('#sg-sync-dates');
      if (syncDatesBtn) {
        syncDatesBtn.textContent = pendingDatesCount > 0 ? `Sync Dates (${pendingDatesCount})` : 'Sync Dates';
        setBtnDisabled(syncDatesBtn, pendingDatesCount === 0);
      }
    }

    function renderBookCard(row) {
      const m = row.mapping;
      const syncedPct =
        m && m.lastSyncedPercent !== null && m.lastSyncedPercent !== undefined
          ? `${m.lastSyncedPercent}%`
          : '—';
      const dur = formatDuration(row.durationSeconds);
      const fallbackDate = formatHumanDate(row.lastReadTs);
      const dateRange = formatHumanDateRange(row.startDate, row.lastDate, fallbackDate);
      const metaLine = [
        row.author ? escapeHtml(row.author) : '',
        dur ? `${escapeHtml(dur)} read` : '',
        row.pagesTurned ? `${row.pagesTurned} pp` : '',
        dateRange ? `<span class="sg-nowrap">read ${escapeHtml(dateRange)}</span>` : '',
        !m && row.staged ? 'Added from SD · link to Mark Read or pre-link' : ''
      ]
        .filter(Boolean)
        .join(' · ');

      let pill = row.staged
        ? '<span class="sg-pill sg-pill-unlinked">From SD</span>'
        : '<span class="sg-pill sg-pill-unlinked">Unlinked</span>';
      if (m) {
        if (m.status === 'read') {
          pill = '<span class="sg-pill sg-pill-done">Read</span>';
        } else if (row.devicePercent !== null && row.devicePercent === 100) {
          pill = '<span class="sg-pill sg-pill-ready">100% — Ready</span>';
        } else if (row.devicePercent !== null && row.devicePercent === m.lastSyncedPercent && isRowNeedsSync(row)) {
          pill = `<span class="sg-pill sg-pill-pending" title="Progress matches StoryGraph, but ${row.unsyncedJournalCount} reading session(s) are not yet in the Reading Journal">Journal unsynced</span>`;
        } else if (row.devicePercent !== null && row.devicePercent === m.lastSyncedPercent) {
          pill = '<span class="sg-pill sg-pill-done">Up to date</span>';
        } else if (row.devicePercent !== null) {
          pill = '<span class="sg-pill sg-pill-pending">Needs sync</span>';
        } else {
          pill = '<span class="sg-pill sg-pill-muted">Linked</span>';
        }
      }
      const datesPill =
        m && isRowNeedsDateSync(row)
          ? '<span class="sg-pill sg-pill-dates" title="Device start/finish dates not yet pushed to StoryGraph">Dates unsynced</span>'
          : '';

      let actionsHtml = '';
      if (m) {
        const needsAction = isRowNeedsSync(row) || (row.devicePercent === 100 && m.status !== 'read');
        const syncClass = needsAction ? 'sg-btn sg-btn-sm sg-btn-primary' : 'sg-btn sg-btn-sm';
        const syncLabel = needsAction ? 'Sync Now' : 'Re-sync';
        const syncTitle = needsAction
          ? 'Push current device progress to StoryGraph'
          : 'Re-check status &amp; sync dates on StoryGraph';
        const markReadBtn =
          m.status === 'read'
            ? ''
            : `<button type="button" class="sg-btn sg-btn-sm" data-act="mark-read" data-key="${escapeHtml(row.key)}" title="Mark this book Read (100%) on StoryGraph">Mark Read</button>`;
        actionsHtml =
          `<button type="button" class="${syncClass}" data-act="sync" data-key="${escapeHtml(row.key)}" title="${syncTitle}" ${row.devicePercent === null ? 'disabled' : ''}>${syncLabel}</button>` +
          markReadBtn +
          `<button type="button" class="sg-btn sg-btn-sm sg-btn-ghost sg-btn-danger" data-act="unlink" data-key="${escapeHtml(row.key)}" title="Unlink from StoryGraph">Unlink</button>`;
      } else {
        const isOpen = activeLinkKey === row.key;
        actionsHtml =
          `<button type="button" class="sg-btn sg-btn-sm sg-btn-primary" data-act="toggle-link" data-key="${escapeHtml(row.key)}">${isOpen ? 'Close Linker' : 'Link Book'}</button>` +
          (row.staged
            ? `<button type="button" class="sg-btn sg-btn-sm sg-btn-ghost" data-act="remove-staged" data-key="${escapeHtml(row.key)}">Remove</button>`
            : '');
      }

      let linkerHtml = '';
      if (!m && activeLinkKey === row.key) {
        const defaultQuery = [row.title, row.author].filter(Boolean).join(' ');
        const results = searchResultsByKey[row.key] || [];
        const crHtml = currentReads.length
          ? '<div class="sg-subsec"><strong>Quick link from Current Reads:</strong><div class="sg-chip-list">' +
            currentReads
              .map(
                (cr) =>
                  `<button type="button" class="sg-btn sg-btn-sm" data-act="pick-cr" data-key="${escapeHtml(row.key)}" data-bookid="${escapeHtml(cr.bookId)}">${escapeHtml(cr.title)}${cr.author ? ' — ' + escapeHtml(cr.author) : ''}</button>`
              )
              .join('') +
            '</div></div>'
          : '';

        const resHtml = results.length
          ? '<div class="sg-results">' +
            results
              .map(
                (r) =>
                  `<div class="sg-res-row"><div><strong>${escapeHtml(r.title)}</strong> <span class="sg-muted">by ${escapeHtml(r.author)}${r.pages ? ' · ' + r.pages + ' pp' : ''}${r.format ? ' · ' + escapeHtml(r.format) : ''}</span></div>` +
                  `<button type="button" class="sg-btn sg-btn-sm sg-btn-primary" data-act="pick-res" data-key="${escapeHtml(row.key)}" data-bookid="${escapeHtml(r.bookId)}">Link</button></div>`
              )
              .join('') +
            '</div>'
          : '';

        linkerHtml =
          `<div class="sg-linker">` +
            crHtml +
            `<div class="sg-subsec">` +
              `<div class="sg-row">` +
                `<input type="text" class="sg-input" data-role="search-q" data-key="${escapeHtml(row.key)}" value="${escapeHtml(defaultQuery)}" placeholder="Search title / author..." />` +
                `<button type="button" class="sg-btn sg-btn-primary" data-act="search" data-key="${escapeHtml(row.key)}">Search</button>` +
              `</div>` +
              `<label class="sg-muted"><input type="checkbox" data-role="include-audio" data-key="${escapeHtml(row.key)}" /> Include audiobooks</label>` +
              resHtml +
            `</div>` +
            `<div class="sg-subsec sg-row">` +
              `<input type="text" class="sg-input" data-role="direct-id" data-key="${escapeHtml(row.key)}" placeholder="Or paste StoryGraph URL / book ID" />` +
              `<button type="button" class="sg-btn" data-act="link-direct" data-key="${escapeHtml(row.key)}">Link ID</button>` +
            `</div>` +
          `</div>`;
      }

      const titleHtml =
        m && m.bookId
          ? `<a class="sg-book-link" href="${BASE_URL}/books/${encodeURIComponent(m.bookId)}" target="_blank" rel="noopener noreferrer" title="Open on The StoryGraph (${escapeHtml(row.sdPath)})">${escapeHtml(row.title)}<span class="sg-ext" aria-hidden="true">↗</span></a>`
          : `<span class="sg-book-name" title="${escapeHtml(row.sdPath)}">${escapeHtml(row.title)}</span>`;

      let pctLabel = '';
      if (row.devicePercent !== null) {
        if (!m) {
          pctLabel = `<strong>${row.devicePercent}%</strong>`;
        } else if (row.devicePercent === m.lastSyncedPercent) {
          pctLabel = `<strong>${row.devicePercent}%</strong>`;
        } else if (m.lastSyncedPercent !== null && m.lastSyncedPercent !== undefined) {
          pctLabel = `<span class="sg-muted">${m.lastSyncedPercent}% synced →</span> <strong>${row.devicePercent}%</strong>`;
        } else {
          pctLabel = `<strong>${row.devicePercent}%</strong> <span class="sg-muted">· Not synced</span>`;
        }
      } else if (m) {
        pctLabel = `<span class="sg-muted">Synced ${escapeHtml(syncedPct)}</span>`;
      }

      const footHtml =
        row.devicePercent !== null || m
          ? `<div class="sg-book-foot">` +
              (row.devicePercent !== null
                ? `<div class="sg-progress" aria-hidden="true"><div class="sg-progress-fill" style="width:${row.devicePercent}%"></div></div>`
                : '') +
              `<div class="sg-book-pct">${pctLabel}</div>` +
            `</div>`
          : '';

      const realHistSessions = getBookHistorySessions(historyData, row);
      const realHistDays = getBookHistoryDays(historyData, row);
      const histItems = getBookDisplayHistorySessions(historyData, row);
      let historyHtml = '';
      if (histItems.length > 0) {
        const unsyncedHistCount = getUnsyncedJournalSessions(historyData, row).length;
        const reconcileCount = realHistSessions.filter((s) => s.syncStatus === 'needs_reconciliation').length;
        const isSyntheticOnly = histItems.every((d) => d.synthetic);
        const totalDurSec = realHistSessions.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
        const totalDurLabel = formatDurationLabel(totalDurSec);
        const rowsHtml = histItems
          .slice()
          .reverse()
          .map((d) => {
            let dateHeader = formatHumanDate(d.date);
            if (!d.synthetic && d.recordType === 'reading_session' && (d.startTime !== null || d.endTime !== null)) {
              const clockRange = formatSessionTimeRangeLabel(d);
              const period = getTimeOfDayPeriodFromTs(d.startTime ?? d.endTime);
              dateHeader = [dateHeader, clockRange, period].filter(Boolean).join(' · ');
            }
            let metaText = '';
            if (d.isStartMilestone) {
              const stLabel = !m ? '' : d.syncedToJournal ? '<span class="sg-ok">Synced</span>' : '<span class="sg-muted">Start date</span>';
              metaText = ['<strong>Started reading</strong>', stLabel].filter(Boolean).join(' · ');
            } else {
              const pctStr = d.endPercent !== null && d.endPercent !== undefined ? `${d.endPercent}%` : '—';
              const estPages =
                m && m.pageCount > 0 && d.endPercent !== null && d.endPercent !== undefined
                  ? ` (~${Math.round((d.endPercent / 100) * m.pageCount)}/${m.pageCount} pp)`
                  : '';
              const hasTransition =
                !d.synthetic &&
                d.startPercent !== null &&
                d.startPercent !== undefined &&
                d.endPercent !== null &&
                d.endPercent !== undefined;
              const deltaPct =
                d.startPercent !== null && d.startPercent !== undefined && d.endPercent !== null && d.endPercent > d.startPercent
                  ? ` (+${d.endPercent - d.startPercent}%)`
                  : '';
              const progDisplay = hasTransition
                ? `${escapeHtml(String(d.startPercent))}% → <strong>${escapeHtml(pctStr)}</strong>${escapeHtml(estPages)}${escapeHtml(deltaPct)}`
                : `<strong>${escapeHtml(pctStr)}</strong>${escapeHtml(estPages)}${escapeHtml(deltaPct)}`;
              const dayDurRaw = formatDurationLabel(d.durationSeconds);
              const dayDur = (d.isSummary || d.recordType === 'legacy_daily_summary') && dayDurRaw ? `${dayDurRaw} total` : dayDurRaw;
              let recordLabel = '';
              if (!d.synthetic) {
                if (d.recordType === 'reading_session') {
                  recordLabel = `<strong>Reading session${d.sessionNumber ? ' ' + d.sessionNumber : ''}</strong>`;
                } else if (d.recordType === 'progress_checkpoint') {
                  recordLabel = '<strong>Progress checkpoint</strong>';
                } else if (d.recordType === 'legacy_daily_summary') {
                  const legCnt = d.legacySessionCount || 0;
                  recordLabel = `<strong>Daily summary${legCnt > 0 ? ' (' + legCnt + ' session' + (legCnt === 1 ? '' : 's') + ')' : ''}</strong>`;
                }
              }
              const sessStr =
                d.synthetic && (d.sessions > 0 || d.pagesTurned > 0)
                  ? [
                      d.sessions > 0 ? `${d.sessions} session${d.sessions === 1 ? '' : 's'}` : '',
                      d.pagesTurned > 0 ? `${d.pagesTurned} pp turned` : ''
                    ]
                      .filter(Boolean)
                      .join(', ')
                  : '';
              let stText = '';
              if (d.syncStatus === 'needs_reconciliation') {
                stText = '<span class="sg-err">Needs reconciliation</span>';
                if (m) {
                  const sid = escapeHtml(d.sessionId);
                  const k = escapeHtml(row.key);
                  stText +=
                    ` <button type="button" class="sg-btn sg-btn-sm" data-act="recon-mark" data-key="${k}" data-sid="${sid}" title="The entry is already on StoryGraph: mark this session synced without posting again">Mark Synced</button>` +
                    `<button type="button" class="sg-btn sg-btn-sm sg-btn-ghost" data-act="recon-retry" data-key="${k}" data-sid="${sid}" title="The entry is missing on StoryGraph: re-queue this session so the next sync posts it">Retry</button>`;
                }
              } else if (m) {
                if (d.synthetic) {
                  if (m.status === 'read' && d.endPercent === 100) {
                    stText = '<span class="sg-ok">Finished</span>';
                  } else if (d.syncedToJournal) {
                    stText = '<span class="sg-ok">Synced</span>';
                  } else if (d.endPercent !== null && d.endPercent > 0) {
                    stText = '<span class="sg-muted">Pending</span>';
                  }
                } else if (d.syncedToJournal || d.syncStatus === 'synced') {
                  stText = '<span class="sg-ok">Journaled</span>';
                } else if (d.recordType === 'reading_session' || (d.endPercent !== null && d.endPercent > 0)) {
                  stText = '<span class="sg-muted">Pending</span>';
                }
              }
              metaText = [
                recordLabel,
                dayDur ? `<strong>${escapeHtml(dayDur)}</strong>` : '',
                progDisplay,
                sessStr ? escapeHtml(sessStr) : '',
                stText
              ]
                .filter(Boolean)
                .join(' · ');
            }
            return (
              `<div class="sg-history-row">` +
                `<span class="sg-history-date">${escapeHtml(dateHeader)}</span>` +
                `<span class="sg-history-meta">${metaText}</span>` +
              `</div>`
            );
          })
          .join('');
        const journalLinkHtml = m
          ? `<a class="sg-journal-link" href="${BASE_URL}/journal?book_id=${encodeURIComponent(m.bookId)}" target="_blank" rel="noopener noreferrer" title="Open this book's Reading Journal on StoryGraph">Open Journal<span class="sg-ext" aria-hidden="true">↗</span></a>`
          : '';
        const cleanJournalBtnHtml = m
          ? `<button type="button" class="sg-btn sg-btn-sm sg-btn-ghost" data-act="clean-journal" data-key="${escapeHtml(row.key)}" title="Scan and clean stray 0% or duplicate 100% entries in this book's StoryGraph journal">Clean Journal</button>`
          : '';
        const syncJournalBtnHtml =
          m && unsyncedHistCount > 0
            ? `<button type="button" class="sg-btn sg-btn-sm" data-act="sync-journal" data-key="${escapeHtml(row.key)}" title="Post unsynced reading sessions to StoryGraph Reading Journal">Sync Journal (${unsyncedHistCount})</button>`
            : '';
        const histBtnHtml =
          journalLinkHtml || cleanJournalBtnHtml || syncJournalBtnHtml
            ? `<div class="sg-history-foot">${journalLinkHtml}<div class="sg-row">${cleanJournalBtnHtml}${syncJournalBtnHtml}</div></div>`
            : '';
        const unsyncedBadge =
          reconcileCount > 0
            ? `<span class="sg-pill sg-pill-pending">${reconcileCount} needs reconciliation</span>`
            : m && unsyncedHistCount > 0
              ? `<span class="sg-pill sg-pill-pending">${unsyncedHistCount} unsynced</span>`
              : '';
        const dayCount = isSyntheticOnly ? histItems.length : realHistDays.length;
        const totalSessCount = realHistSessions.reduce(
          (sum, s) =>
            sum +
            (s.recordType === 'reading_session'
              ? 1
              : s.recordType === 'legacy_daily_summary'
                ? Math.max(1, s.legacySessionCount || 1)
                : 0),
          0
        );
        const durWord = totalDurSec > 0 && (row.durationSeconds || 0) > totalDurSec + 30 ? 'logged' : 'total';
        const sessSummary = isSyntheticOnly
          ? row.sessions > 0
            ? ` · ${row.sessions} session${row.sessions === 1 ? '' : 's'}`
            : ''
          : totalSessCount > 0
            ? ` · ${totalSessCount} session${totalSessCount === 1 ? '' : 's'}${totalDurLabel ? ' · ' + totalDurLabel + ' ' + durWord : ''}`
            : totalDurLabel
              ? ` · ${totalDurLabel} ${durWord}`
              : '';
        historyHtml =
          `<details class="sg-history" data-history-key="${escapeHtml(row.key)}"${historyOpenByKey[row.key] ? ' open' : ''}>` +
            `<summary class="sg-history-sum"><span class="sg-history-label">Reading history · ${dayCount} day${dayCount === 1 ? '' : 's'}${escapeHtml(sessSummary)}</span>${unsyncedBadge}</summary>` +
            `<div class="sg-history-list">${rowsHtml}${histBtnHtml}</div>` +
          `</details>`;
      }

      return (
        `<div class="sg-book">` +
          `<div class="sg-book-head">` +
            `<div class="sg-book-title-wrap">${titleHtml} ${pill}${datesPill ? ' ' + datesPill : ''}</div>` +
            `<div class="sg-book-actions">${actionsHtml}</div>` +
          `</div>` +
          `<div class="sg-book-meta">${metaLine || escapeHtml(row.sdPath)}</div>` +
          footHtml +
          historyHtml +
          linkerHtml +
        `</div>`
      );
    }

    function renderBooks() {
      renderHeaderStats();
      const listEl = container.querySelector('#sg-books-list');
      if (!listEl) return;
      const allRows = buildBookRows();

      if (allRows.length === 0) {
        listEl.innerHTML =
          '<p class="sg-muted">No reading events recorded yet. Open a book on your e-reader, read a few pages, and exit back to Home.</p>';
        return;
      }

      const filtered = filterAndSortBookRows(allRows, {
        filter: activeFilter,
        query: bookSearchQuery,
        sort: bookSort
      });

      if (filtered.length === 0) {
        const qTrim = bookSearchQuery.trim();
        const msg = qTrim
          ? `No books match "${escapeHtml(qTrim)}".`
          : 'No books in this category.';
        listEl.innerHTML = `<p class="sg-muted">${msg}</p>`;
        return;
      }

      if (activeFilter === 'all' && !bookSearchQuery.trim()) {
        const readingRows = filtered.filter((r) => classifyBookRow(r) === 'reading');
        const unlinkedRows = filtered.filter((r) => classifyBookRow(r) === 'unlinked');
        const readRows = filtered.filter((r) => classifyBookRow(r) === 'read');
        const unlinkedPriority = unlinkedRows.some(
          (r) => r.staged || (activeLinkKey && activeLinkKey === r.key)
        );
        const sections = unlinkedPriority
          ? [
              { key: 'unlinked', label: 'Unlinked & From SD', items: unlinkedRows, open: sectionOpenState.unlinked !== false },
              { key: 'reading', label: 'Currently Reading', items: readingRows, open: sectionOpenState.reading !== false },
              {
                key: 'read',
                label: 'Read',
                items: readRows,
                open: sectionOpenState.read === null ? (readingRows.length === 0 && unlinkedRows.length === 0) : Boolean(sectionOpenState.read)
              }
            ]
          : [
              { key: 'reading', label: 'Currently Reading', items: readingRows, open: sectionOpenState.reading !== false },
              { key: 'unlinked', label: 'Unlinked & From SD', items: unlinkedRows, open: sectionOpenState.unlinked !== false },
              {
                key: 'read',
                label: 'Read',
                items: readRows,
                open: sectionOpenState.read === null ? (readingRows.length === 0 && unlinkedRows.length === 0) : Boolean(sectionOpenState.read)
              }
            ];

        listEl.innerHTML = sections
          .filter((s) => s.items.length > 0)
          .map(
            (s) =>
              `<details class="sg-section" data-section="${s.key}"${s.open ? ' open' : ''}>` +
                `<summary class="sg-section-sum"><span class="sg-section-title">${s.label}</span><span class="sg-section-count">${s.items.length}</span></summary>` +
                `<div class="sg-section-body">${s.items.map(renderBookCard).join('')}</div>` +
              `</details>`
          )
          .join('');

        for (const det of listEl.querySelectorAll('details')) {
          det.addEventListener('toggle', () => {
            const sec = det.getAttribute('data-section');
            if (sec) sectionOpenState[sec] = Boolean(det.open);
            const hKey = det.getAttribute('data-history-key');
            if (hKey) historyOpenByKey[hKey] = Boolean(det.open);
          });
        }
      } else {
        listEl.innerHTML = filtered.map(renderBookCard).join('');
        for (const det of listEl.querySelectorAll('details')) {
          det.addEventListener('toggle', () => {
            const hKey = det.getAttribute('data-history-key');
            if (hKey) historyOpenByKey[hKey] = Boolean(det.open);
          });
        }
      }

      if (busyLock) {
        for (const btn of listEl.querySelectorAll('button')) {
          if (!btn.disabled) {
            btn.dataset.sgWasEnabled = '1';
            btn.disabled = true;
          }
        }
      }
    }

    async function loadSdFolder(dirPath) {
      if (sdBrowserLoading) return;
      const target = dirPath && String(dirPath).startsWith('/') ? String(dirPath).replace(/\/+$/, '') || '/' : '/';
      sdBrowserLoading = true;
      sdBrowserError = '';
      renderSdBrowser();
      try {
        const res = await fetch('/api/files?path=' + encodeURIComponent(target), { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Unexpected /api/files response');
        sdBrowserPath = target;
        sdBrowserEntries = filterAndSortSdEntries(data);
        sdBrowserLoaded = true;
      } catch (err) {
        sdBrowserError = String(err && err.message ? err.message : err);
        setBanner(`Could not list SD folder ${target}: ${sdBrowserError}`, 'err');
      } finally {
        sdBrowserLoading = false;
        renderSdBrowser();
      }
    }

    function renderSdBrowser() {
      const badge = container.querySelector('#sg-sd-badge');
      if (badge) {
        badge.textContent = sdBrowserLoading
          ? `loading ${sdBrowserPath}...`
          : sdBrowserLoaded
            ? sdBrowserPath
            : 'expand to pick older/finished books';
      }
      const box = container.querySelector('#sg-sd-browser');
      if (!box) return;

      const segs = sdBrowserPath === '/' ? [] : sdBrowserPath.slice(1).split('/').filter(Boolean);
      const crumbs = [
        `<button type="button" class="sg-btn" data-sd-act="open-dir" data-path="/">/</button>`
      ];
      let acc = '';
      for (const seg of segs) {
        acc += '/' + seg;
        crumbs.push(
          `<button type="button" class="sg-btn" data-sd-act="open-dir" data-path="${escapeHtml(acc)}">${escapeHtml(seg)}</button>`
        );
      }

      const upTarget = parentSdPath(sdBrowserPath);
      const barHtml =
        `<div class="sg-sd-bar">` +
          `<div class="sg-sd-crumbs">${crumbs.join('')}</div>` +
          `<div class="sg-row">` +
            `<button type="button" class="sg-btn" data-sd-act="open-dir" data-path="${escapeHtml(upTarget)}" ${sdBrowserPath === '/' || sdBrowserLoading ? 'disabled' : ''}>Up</button>` +
            `<button type="button" class="sg-btn" data-sd-act="reload" ${sdBrowserLoading ? 'disabled' : ''}>Reload</button>` +
          `</div>` +
        `</div>`;

      let bodyHtml = '';
      if (sdBrowserLoading) {
        bodyHtml = `<p class="sg-muted">Loading ${escapeHtml(sdBrowserPath)}...</p>`;
      } else if (sdBrowserError) {
        bodyHtml = `<p class="sg-err">Failed to read folder: ${escapeHtml(sdBrowserError)}</p>`;
      } else if (!sdBrowserLoaded) {
        bodyHtml = `<p class="sg-muted">Expand to load folders from your SD card.</p>`;
      } else if (sdBrowserEntries.length === 0) {
        bodyHtml = `<p class="sg-muted">No subfolders or supported books in this folder.</p>`;
      } else {
        const itemsHtml = sdBrowserEntries
          .map((entry) => {
            const fullPath = joinSdPath(sdBrowserPath, entry.name);
            if (entry.isDirectory) {
              return (
                `<div class="sg-sd-row">` +
                  `<button type="button" class="sg-btn sg-sd-dir" data-sd-act="open-dir" data-path="${escapeHtml(fullPath)}">📁 ${escapeHtml(entry.name)}</button>` +
                  `<span class="sg-muted">Folder</span>` +
                `</div>`
              );
            }
            const meta = extractFilenameMeta(fullPath);
            const mapped = Boolean(
              findMappingForBook(mapData, {
                sdPath: fullPath,
                documentHash: '',
                normFilename: meta.normFilename,
                normTitle: meta.normTitle,
                normAuthor: meta.normAuthor
              })
            );
            const inList = outboxBooks.has(fullPath) || stagedBooks.has(fullPath);
            let ctrlHtml = '';
            if (mapped) {
              ctrlHtml = `<span class="sg-pill sg-pill-done">Linked</span>`;
            } else if (inList) {
              ctrlHtml = `<button type="button" class="sg-btn" data-sd-act="add-book" data-path="${escapeHtml(fullPath)}">Open Linker</button>`;
            } else {
              ctrlHtml = `<button type="button" class="sg-btn sg-btn-primary" data-sd-act="add-book" data-path="${escapeHtml(fullPath)}">Add &amp; Link</button>`;
            }
            return (
              `<div class="sg-sd-row">` +
                `<div><strong>${escapeHtml(meta.title)}</strong>${meta.author ? ' <span class="sg-muted">by ' + escapeHtml(meta.author) + '</span>' : ''}</div>` +
                ctrlHtml +
              `</div>`
            );
          })
          .join('');
        bodyHtml = `<div class="sg-sd-list">${itemsHtml}</div>`;
      }

      const noteHtml =
        `<div class="sg-muted">Pick any book on your SD card to link and Mark Read, or pre-link before your next reading session. Progress % for untouched books appears after you open &amp; exit the book once on your e-reader.</div>`;

      box.innerHTML = noteHtml + barHtml + bodyHtml;

      if (busyLock) {
        for (const btn of box.querySelectorAll('button')) {
          if (!btn.disabled) {
            btn.dataset.sgWasEnabled = '1';
            btn.disabled = true;
          }
        }
      }
    }

    function renderAll() {
      renderBooks();
      renderSdBrowser();
      syncSettingsInputs();
    }

    container.innerHTML =
      '<style>' +
      '.sg-wrap{--b:var(--border-color,#d1d5db);--a:var(--accent-color,#6e9a82);--ah:var(--accent-hover-color,#5a8c73);--m:var(--label-color,#6b7280);--c:var(--card-bg,#fff);--g:var(--bg,#f3f4f6);--f:var(--font-color,#1f2933);--t:var(--title-color,#111827);--s:var(--accent-soft,rgba(110,154,130,0.12));display:flex;flex-direction:column;gap:10px;font-size:0.93em;color:var(--f)}' +
      '.sg-wrap.sg-busy{opacity:0.88}' +
      '.sg-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px}' +
      '.sg-head-title{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:2px}' +
      '.sg-head h2{margin:0;color:var(--t);font-size:1.22em}' +
      '.sg-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
      '.sg-btn{padding:6px 12px;border:1px solid var(--b);border-radius:6px;background:var(--g);color:var(--f);font:inherit;font-size:0.88em;font-weight:500;cursor:pointer;transition:background-color .15s,border-color .15s,color .15s}' +
      '.sg-btn:hover:not(:disabled){background:var(--s);border-color:var(--a)}' +
      '.sg-btn:focus-visible{outline:2px solid var(--a);outline-offset:2px}' +
      '.sg-btn:disabled{opacity:0.48;cursor:not-allowed}' +
      '.sg-btn-primary{background:var(--a);border-color:var(--a);color:#fff}' +
      '.sg-btn-primary:hover:not(:disabled){background:var(--ah);border-color:var(--ah)}' +
      '.sg-btn-sm{padding:4px 10px;font-size:0.82em}' +
      '.sg-btn-ghost{background:transparent;border-color:transparent;color:var(--m)}' +
      '.sg-btn-ghost:hover:not(:disabled){background:var(--g);border-color:var(--b);color:var(--f)}' +
      '.sg-btn-danger:hover:not(:disabled),.sg-btn-ghost.sg-btn-danger:hover:not(:disabled){background:rgba(220,38,38,0.12);border-color:var(--danger-color,#dc2626);color:var(--danger-color,#dc2626)}' +
      '.sg-input{flex:1;min-width:180px;padding:7px 10px;border:1px solid var(--b);border-radius:6px;background:var(--g);color:var(--f);font:inherit;font-size:0.94em}' +
      '.sg-input:focus{outline:none;border-color:var(--a);box-shadow:0 0 0 2px var(--s)}' +
      '.sg-select{padding:5px 9px;border:1px solid var(--b);border-radius:6px;background:var(--g);color:var(--f);font:inherit;font-size:0.84em;cursor:pointer}' +
      '.sg-select:focus{outline:none;border-color:var(--a)}' +
      '.sg-drawers{display:flex;flex-direction:column;gap:6px}' +
      '.sg-details{border:1px solid var(--b);border-radius:8px;padding:7px 12px;background:var(--c)}' +
      '.sg-details summary{cursor:pointer;font-weight:600;color:var(--t);font-size:0.94em}' +
      '.sg-subdetails{border:1px solid var(--b);border-radius:6px;padding:6px 10px;background:var(--g);margin:8px 0}' +
      '.sg-subdetails summary{cursor:pointer;font-size:0.86em;font-weight:600;color:var(--t)}' +
      '.sg-help-body{display:flex;flex-direction:column;gap:5px;margin-top:7px;font-size:0.84em;color:var(--m);line-height:1.45}' +
      '.sg-subblock{border-top:1px dashed var(--b);margin-top:10px;padding-top:10px}' +
      '.sg-field{display:flex;flex-direction:column;gap:4px;margin:10px 0}' +
      '.sg-field-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px}' +
      '.sg-field label{font-size:0.86em;color:var(--m)}' +
      '.sg-toolbar{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;padding:2px 0 0 0}' +
      '.sg-tabs{display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
      '.sg-tab{padding:5px 10px;border:1px solid var(--b);border-radius:999px;background:transparent;color:var(--m);font:inherit;font-size:0.82em;font-weight:500;cursor:pointer;transition:background-color .15s,border-color .15s,color .15s}' +
      '.sg-tab:hover:not(:disabled){color:var(--f);border-color:var(--a)}' +
      '.sg-tab-active,.sg-tab-active:hover:not(:disabled){background:var(--s);border-color:var(--a);color:var(--t);font-weight:600}' +
      '.sg-toolbar-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;flex:1;justify-content:flex-end;min-width:210px}' +
      '.sg-search-input{min-width:140px;max-width:230px;padding:5px 10px;font-size:0.86em}' +
      '#sg-books-list{display:flex;flex-direction:column;gap:10px}' +
      '.sg-section{border:1px solid var(--b);border-radius:8px;background:var(--g);overflow:hidden}' +
      '.sg-section-sum{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 14px;cursor:pointer;font-weight:600;color:var(--t);list-style:none;user-select:none}' +
      '.sg-section-sum::-webkit-details-marker,.sg-history-sum::-webkit-details-marker{display:none}' +
      '.sg-section-title{display:inline-flex;align-items:center;gap:7px}' +
      '.sg-section-title::before{content:"▸";font-size:0.85em;color:var(--m)}' +
      '.sg-section[open] .sg-section-title::before,.sg-history[open] .sg-history-label::before{content:"▾"}' +
      '.sg-section-count{font-size:0.8em;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--c);border:1px solid var(--b);color:var(--m)}' +
      '.sg-section-body{display:flex;flex-direction:column;gap:8px;padding:8px 10px 10px 10px;border-top:1px solid var(--b)}' +
      '.sg-book{border:1px solid var(--b);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:7px;background:var(--c);transition:border-color .15s}' +
      '.sg-book:hover{border-color:var(--a)}' +
      '.sg-book-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:10px}' +
      '.sg-book-title-wrap{flex:1;min-width:210px;display:flex;flex-wrap:wrap;align-items:center;gap:7px;font-weight:600;color:var(--t);line-height:1.35}' +
      '.sg-book-link{color:var(--t);text-decoration:none;display:inline-flex;align-items:baseline;gap:4px}' +
      '.sg-book-link:hover,.sg-journal-link:hover{color:var(--a);text-decoration:underline}' +
      '.sg-journal-link{color:var(--m);text-decoration:none;display:inline-flex;align-items:baseline;gap:3px;font-size:0.82em;font-weight:500}' +
      '.sg-ext{font-size:0.78em;opacity:0.62}' +
      '.sg-book-meta{color:var(--m);font-size:0.86em;line-height:1.45}' +
      '.sg-nowrap{white-space:nowrap}' +
      '.sg-book-foot{display:flex;align-items:center;gap:12px;margin-top:2px}' +
      '.sg-book-pct{font-size:0.86em;white-space:nowrap;color:var(--f)}' +
      '.sg-book-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;flex-shrink:0}' +
      '.sg-history{border-top:1px dashed var(--b);padding-top:7px;margin-top:2px}' +
      '.sg-history-sum{display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;font-size:0.82em;font-weight:500;color:var(--m);list-style:none;user-select:none}' +
      '.sg-history-sum:hover{color:var(--f)}' +
      '.sg-history-label{display:inline-flex;align-items:center;gap:5px}' +
      '.sg-history-label::before{content:"▸";font-size:0.85em}' +
      '.sg-history-list{display:flex;flex-direction:column;gap:5px;margin-top:7px;padding:8px 10px;border-radius:6px;background:var(--g);border:1px solid var(--b)}' +
      '.sg-history-row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;font-size:0.82em}' +
      '.sg-history-date{color:var(--f);font-weight:500;white-space:nowrap}' +
      '.sg-history-meta{color:var(--m)}' +
      '.sg-history-foot{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;margin-top:4px;padding-top:5px;border-top:1px solid var(--b)}' +
      '.sg-progress{flex:1;height:5px;border-radius:999px;background:var(--b);overflow:hidden;max-width:260px;min-width:80px}' +
      '.sg-progress-fill{height:100%;border-radius:999px;background:var(--a)}' +
      '.sg-linker{border-top:1px dashed var(--b);padding-top:10px;display:flex;flex-direction:column;gap:10px}' +
      '.sg-subsec{display:flex;flex-direction:column;gap:6px}' +
      '.sg-chip-list{display:flex;flex-wrap:wrap;gap:6px}' +
      '.sg-results{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto}' +
      '.sg-res-row,.sg-sd-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--b);border-radius:6px;background:var(--g)}' +
      '.sg-pill{font-size:0.74em;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid transparent;white-space:nowrap}' +
      '.sg-pill-done{background:rgba(22,163,74,0.14);border-color:rgba(22,163,74,0.3);color:#15803d}' +
      '.sg-pill-pending{background:rgba(217,119,6,0.14);border-color:rgba(217,119,6,0.3);color:#b45309}' +
      '.sg-pill-ready{background:rgba(37,99,235,0.14);border-color:rgba(37,99,235,0.3);color:#1d4ed8}' +
      '.sg-pill-dates{background:rgba(37,99,235,0.1);border-color:rgba(37,99,235,0.28);color:#1d4ed8}' +
      '.sg-pill-unlinked,.sg-pill-muted{background:var(--s);border-color:var(--b);color:var(--m)}' +
      '.sg-banner{padding:6px 10px;border-radius:6px;border:1px solid var(--b);background:var(--g);font-size:0.86em}' +
      '.sg-banner.sg-ok{background:rgba(22,163,74,0.1);border-color:rgba(22,163,74,0.35)}' +
      '.sg-banner.sg-err{background:rgba(220,38,38,0.1);border-color:rgba(220,38,38,0.35)}' +
      '.sg-sd-bar{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;margin:10px 0}' +
      '.sg-sd-crumbs{display:flex;flex-wrap:wrap;gap:4px;align-items:center}' +
      '.sg-sd-list{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}' +
      '.sg-sd-dir{font-weight:600}' +
      '.sg-sync-prog{display:none;margin-top:2px}' +
      '.sg-sync-prog.show{display:block}' +
      '.sg-sync-bar{width:100%;height:20px;background-color:var(--b);border-radius:999px;overflow:hidden}' +
      '.sg-sync-fill{height:100%;background-color:var(--a);width:0%;transition:width .3s}' +
      '.sg-sync-text{text-align:center;margin-top:5px;font-size:.88em;color:var(--m)}' +
      '.sg-import-box{display:none;margin-top:10px;padding:10px 12px;border-radius:6px;border:1px solid var(--b);background:var(--g);flex-direction:column;gap:8px}' +
      '.sg-import-box.show{display:flex}' +
      '.sg-textarea{width:100%;min-height:96px;padding:8px 10px;border:1px solid var(--b);border-radius:6px;background:var(--c);color:var(--f);box-sizing:border-box;font-family:monospace;font-size:0.84em;resize:vertical}' +
      '.sg-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer}' +
      '.sg-muted{color:var(--m);font-size:0.86em}.sg-ok{color:#15803d;font-weight:600}.sg-warn{color:#b45309;font-size:0.86em;font-weight:600}.sg-err{color:#b91c1c;font-weight:600}' +
      '@media(prefers-color-scheme:dark){' +
      '.sg-pill-done,.sg-ok{color:#4ade80}' +
      '.sg-pill-pending,.sg-warn{color:#fbbf24}' +
      '.sg-pill-ready,.sg-pill-dates{color:#93c5fd}' +
      '.sg-err,.sg-btn-ghost.sg-btn-danger:hover:not(:disabled){color:#f87171}' +
      '}' +
      '</style>' +
      '<div class="sg-wrap">' +
        '<div class="sg-head">' +
          '<div>' +
            '<div class="sg-head-title"><h2>StoryGraph Sync</h2><span id="sg-session-pill" class="sg-pill sg-pill-unlinked"></span></div>' +
            '<div id="sg-header-stats" class="sg-muted">Loading...</div>' +
          '</div>' +
          '<div class="sg-row">' +
            '<button type="button" class="sg-btn sg-btn-primary" id="sg-sync-all" title="Sequentially sync all linked books with unsynced progress or journal sessions" disabled>Sync All</button>' +
            '<button type="button" class="sg-btn" id="sg-sync-dates" title="Push device start &amp; finish dates to StoryGraph for linked books" disabled>Sync Dates</button>' +
            '<button type="button" class="sg-btn" id="sg-refresh">Refresh</button>' +
          '</div>' +
        '</div>' +
        '<div id="sg-banner" class="sg-banner sg-muted">Ready.</div>' +
        '<div id="sg-sync-progress" class="sg-sync-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="sg-sync-bar"><div id="sg-sync-fill" class="sg-sync-fill"></div></div><div id="sg-sync-text" class="sg-sync-text"></div></div>' +
        '<div class="sg-drawers">' +
          '<details class="sg-details" id="sg-account-details">' +
            '<summary>Account Settings <span id="sg-cookie-badge" class="sg-muted" style="font-weight:400;margin-left:8px"></span></summary>' +
            '<details class="sg-subdetails" id="sg-cookie-help">' +
              '<summary>How to get cookies? (Desktop &amp; Phone)</summary>' +
              '<div class="sg-help-body">' +
                '<div><a class="sg-journal-link" href="https://app.thestorygraph.com/" target="_blank" rel="noopener noreferrer">Open StoryGraph<span class="sg-ext" aria-hidden="true">↗</span></a> and make sure you are signed in.</div>' +
                '<div><strong>Desktop:</strong> Press <strong>F12</strong> → <strong>Network</strong> → reload (<strong>F5</strong>) → click <code>app.thestorygraph.com</code> → copy the <code>cookie</code> header (or Copy as cURL) and paste below.</div>' +
                '<div><strong>Phone (no PC):</strong> Open StoryGraph in <strong>Firefox</strong> (Android) or <strong>Safari</strong> (iOS) with the <strong>Cookie-Editor</strong> extension → tap <strong>Export → JSON</strong> (or <strong>Header String</strong>) → paste below. <em>(Open this page in the same browser, or Export Settings on desktop and Import Settings on phone.)</em></div>' +
              '</div>' +
            '</details>' +
            '<div class="sg-field">' +
              '<div class="sg-field-head">' +
                '<label for="sg-cookie-input">StoryGraph Cookies (saved in browser only — never on SD)</label>' +
                '<span id="sg-header-meter" class="sg-muted"></span>' +
              '</div>' +
              '<div class="sg-row">' +
                '<input type="password" id="sg-cookie-input" class="sg-input" placeholder="Paste cookie header, Cookie-Editor JSON, or cURL..." />' +
                '<button type="button" class="sg-btn sg-btn-sm" id="sg-cookie-toggle" title="Show or hide cookie header">Show</button>' +
              '</div>' +
              '<div id="sg-cookie-hint" class="sg-muted"></div>' +
            '</div>' +
            '<div class="sg-row">' +
              '<button type="button" class="sg-btn sg-btn-primary" id="sg-verify">Verify Session</button>' +
              '<button type="button" class="sg-btn sg-btn-ghost sg-btn-danger" id="sg-clear-cfg">Clear Cookies</button>' +
            '</div>' +
            '<div class="sg-subblock">' +
              '<label class="sg-muted sg-check" title="Save session duration (e.g. 20m read on CrossPoint) inside StoryGraph reading journal notes"><input type="checkbox" id="sg-journal-notes" /> Include reading duration in StoryGraph journal notes</label>' +
              '<div class="sg-field" style="margin:8px 0 4px 0">' +
                '<label for="sg-device-label">Journal device label (default: CrossPoint)</label>' +
                '<input type="text" id="sg-device-label" class="sg-input" placeholder="CrossPoint" />' +
              '</div>' +
              '<div id="sg-note-preview" class="sg-muted"></div>' +
            '</div>' +
            '<details class="sg-subdetails" id="sg-advanced-details" style="margin-top:10px">' +
              '<summary>Advanced &amp; Backup</summary>' +
              '<div class="sg-field">' +
                '<label for="sg-ua-input">User-Agent (auto-filled; edit only if cookies came from another browser)</label>' +
                '<input type="text" id="sg-ua-input" class="sg-input" />' +
              '</div>' +
              '<div class="sg-row">' +
                '<button type="button" class="sg-btn sg-btn-sm" id="sg-export-cfg" title="Download settings JSON (contains session cookies)">Export Settings</button>' +
                '<button type="button" class="sg-btn sg-btn-sm" id="sg-import-cfg" title="Import a previously exported settings JSON file">Import Settings</button>' +
                '<input type="file" id="sg-settings-file" accept=".json,application/json" style="display:none" />' +
              '</div>' +
              '<div class="sg-muted" style="margin-top:8px">Tip: Use <code>http://crosspoint.local/files</code> so browser localStorage survives router IP changes (and avoid VPN mismatches if Cloudflare challenges requests).</div>' +
            '</details>' +
          '</details>' +
          '<details class="sg-details" id="sg-tools-details">' +
            '<summary>Tools &amp; Preferences <span id="sg-tools-badge" class="sg-muted" style="font-weight:400;margin-left:8px"></span></summary>' +
            '<div class="sg-row" style="margin-top:10px">' +
              '<button type="button" class="sg-btn" id="sg-clean-journals" title="Scan linked StoryGraph Reading Journals and remove bogus 0% or duplicate 100% entries">Clean Journals</button>' +
              '<button type="button" class="sg-btn" id="sg-compact" title="Shrink events.jsonl down to 1 latest snapshot per book (keeps outbox under 4 KB)">Compact Outbox</button>' +
              '<button type="button" class="sg-btn" id="sg-import-history" title="Import per-day sessions from a file or multi-line paste (CrossPoint Sync export, reading-history.json, or events.jsonl)">Import Session History</button>' +
            '</div>' +
            '<div class="sg-row" style="gap:14px;margin-top:10px">' +
              '<label class="sg-muted sg-check" title="Automatically compact events.jsonl after a successful Sync All"><input type="checkbox" id="sg-auto-compact" /> Auto-compact after Sync All</label>' +
              '<label class="sg-muted sg-check" title="During Sync All, overwrite StoryGraph when device progress is 0% or lower without asking"><input type="checkbox" id="sg-overwrite-lower" /> Overwrite lower/0% without asking</label>' +
            '</div>' +
            '<div id="sg-history-import-box" class="sg-import-box">' +
              '<div class="sg-muted">Choose a <code>.json</code> / <code>.jsonl</code> export file or paste multi-line JSON / JSONL below (supports CrossPoint Sync exports, <code>reading-history.json</code>, or <code>events.jsonl</code>):</div>' +
              '<div class="sg-row">' +
                '<input type="file" id="sg-history-file" accept=".json,.jsonl,.ndjson,.txt,application/json,text/plain" />' +
                '<span id="sg-history-file-status" class="sg-muted"></span>' +
              '</div>' +
              '<textarea id="sg-history-textarea" class="sg-textarea" rows="5" placeholder="Paste JSON array/object or multi-line JSONL here..."></textarea>' +
              '<div class="sg-row">' +
                '<button type="button" class="sg-btn sg-btn-primary sg-btn-sm" id="sg-history-import-run">Import</button>' +
                '<button type="button" class="sg-btn sg-btn-sm" id="sg-history-import-cancel">Close</button>' +
              '</div>' +
            '</div>' +
          '</details>' +
          '<details class="sg-details" id="sg-sd-details">' +
            '<summary>Browse SD Library <span id="sg-sd-badge" class="sg-muted" style="font-weight:400;margin-left:8px"></span></summary>' +
            '<div id="sg-sd-browser" style="margin-top:10px"></div>' +
          '</details>' +
        '</div>' +
        '<div id="sg-books-toolbar" class="sg-toolbar">' +
          '<div id="sg-filter-tabs" class="sg-tabs" role="tablist" aria-label="Filter books">' +
            '<button type="button" class="sg-tab sg-tab-active" data-filter="all" role="tab" aria-selected="true">All</button>' +
            '<button type="button" class="sg-tab" data-filter="reading" role="tab" aria-selected="false">Reading</button>' +
            '<button type="button" class="sg-tab" data-filter="needs-sync" role="tab" aria-selected="false">Needs Sync</button>' +
            '<button type="button" class="sg-tab" data-filter="read" role="tab" aria-selected="false">Read</button>' +
            '<button type="button" class="sg-tab" data-filter="unlinked" role="tab" aria-selected="false">Unlinked</button>' +
          '</div>' +
          '<div class="sg-toolbar-controls">' +
            '<input type="search" id="sg-book-search" class="sg-input sg-search-input" placeholder="Search title or author..." aria-label="Filter books by title or author" />' +
            '<select id="sg-book-sort" class="sg-select" aria-label="Sort books">' +
              '<option value="smart">Sort: Smart</option>' +
              '<option value="recent">Sort: Recent</option>' +
              '<option value="progress">Sort: Progress</option>' +
              '<option value="title">Sort: Title</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div id="sg-books-list"></div>' +
      '</div>';

    container.querySelector('#sg-cookie-input').addEventListener('input', (e) => {
      const raw = e && e.target ? String(e.target.value || '') : '';
      const parsed = parseCookieHeader(raw);
      saveCookieMap(parsed);
      if (
        e &&
        e.target &&
        Object.keys(parsed).length > 0 &&
        (/^\s*[\[{]/.test(raw) || raw.includes('\t') || /^(?:request\s+)?cookie\s*:/i.test(raw.trim()) || /^\s*curl\b/i.test(raw) || raw.includes('\n'))
      ) {
        e.target.value = lsGet(LS_COOKIE_KEY, '');
      }
      sessionVerified = false;
      updateCookieBadge();
    });
    container.querySelector('#sg-cookie-toggle').addEventListener('click', (e) => {
      const inp = container.querySelector('#sg-cookie-input');
      if (!inp) return;
      const show = (inp.getAttribute ? inp.getAttribute('type') : inp.type) === 'password' || inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      if (typeof inp.setAttribute === 'function') inp.setAttribute('type', show ? 'text' : 'password');
      if (e && e.target) e.target.textContent = show ? 'Hide' : 'Show';
    });
    container.querySelector('#sg-ua-input').addEventListener('input', (e) => {
      userAgent = e.target.value.trim();
      lsSet(LS_UA_KEY, userAgent);
      updateCookieBadge();
    });
    container.querySelector('#sg-auto-compact').addEventListener('change', (e) => {
      autoCompact = Boolean(e.target.checked);
      lsSet(LS_AUTO_COMPACT_KEY, autoCompact ? '1' : '0');
    });
    container.querySelector('#sg-overwrite-lower').addEventListener('change', (e) => {
      overwriteLowerInBatch = Boolean(e.target.checked);
      lsSet(LS_OVERWRITE_LOWER_KEY, overwriteLowerInBatch ? '1' : '0');
    });
    container.querySelector('#sg-journal-notes').addEventListener('change', (e) => {
      includeJournalNotes = Boolean(e.target.checked);
      lsSet(LS_JOURNAL_NOTES_KEY, includeJournalNotes ? '1' : '0');
      updateJournalNotePreview();
    });
    container.querySelector('#sg-device-label').addEventListener('input', (e) => {
      deviceLabel = String(e.target.value || '').trim() || DEFAULT_DEVICE_LABEL;
      lsSet(LS_DEVICE_LABEL_KEY, deviceLabel);
      updateJournalNotePreview();
    });
    container.querySelector('#sg-clear-cfg').addEventListener('click', async () => {
      if (Object.keys(cookieMap || {}).filter((k) => Boolean(cookieMap[k])).length === 0) {
        setBanner('No stored cookies to clear.', 'muted');
        return;
      }
      if (!(await confirmAction('Clear stored StoryGraph cookies from this browser?'))) return;
      saveCookieMap({});
      container.querySelector('#sg-cookie-input').value = '';
      sessionVerified = false;
      updateCookieBadge();
      setBanner('Cleared stored StoryGraph cookies.', 'muted');
    });
    container.querySelector('#sg-verify').addEventListener('click', verifySession);
    container.querySelector('#sg-export-cfg').addEventListener('click', async () => {
      try {
        await exportSettingsJson();
      } catch (err) {
        setBanner(String(err && err.message ? err.message : err), 'err');
      }
    });
    container.querySelector('#sg-import-cfg').addEventListener('click', importSettingsJson);
    container.querySelector('#sg-settings-file').addEventListener('change', handleSettingsFileSelect);
    container.querySelector('#sg-import-history').addEventListener('click', () => toggleSessionHistoryImportBox());
    container.querySelector('#sg-history-file').addEventListener('change', handleSessionHistoryFileSelect);
    container.querySelector('#sg-history-import-run').addEventListener('click', runSessionHistoryImport);
    container.querySelector('#sg-history-import-cancel').addEventListener('click', () => toggleSessionHistoryImportBox(false));
    container.querySelector('#sg-sync-all').addEventListener('click', syncAllPending);
    container.querySelector('#sg-sync-dates').addEventListener('click', syncAllDates);
    container.querySelector('#sg-clean-journals').addEventListener('click', cleanAllJournals);
    container.querySelector('#sg-compact').addEventListener('click', compactOutbox);
    container.querySelector('#sg-filter-tabs').addEventListener('click', (e) => {
      const btn = e && e.target ? e.target.closest('button[data-filter]') : null;
      if (!btn) return;
      const next = btn.getAttribute('data-filter');
      if (next && next !== activeFilter) {
        activeFilter = next;
        renderBooks();
      }
    });
    container.querySelector('#sg-book-search').addEventListener('input', (e) => {
      bookSearchQuery = e && e.target ? String(e.target.value || '') : '';
      renderBooks();
    });
    container.querySelector('#sg-book-sort').addEventListener('change', (e) => {
      bookSort = (e && e.target && e.target.value) || 'smart';
      renderBooks();
    });
    container.querySelector('#sg-refresh').addEventListener('click', async () => {
      try {
        hideSyncProgress();
        await loadLocalState();
        renderAll();
        setBanner('Refreshed local outbox and mappings.', 'ok');
      } catch (err) {
        setBanner(String(err && err.message ? err.message : err), 'err');
      }
    });

    container.querySelector('#sg-sd-details').addEventListener('toggle', (e) => {
      const target = e && e.target ? e.target : container.querySelector('#sg-sd-details');
      if (target && target.open && !sdBrowserLoaded && !sdBrowserLoading) {
        loadSdFolder(sdBrowserPath);
      }
    });

    container.querySelector('#sg-sd-browser').addEventListener('click', async (e) => {
      const btn = e && e.target ? e.target.closest('button[data-sd-act]') : null;
      if (!btn) return;
      const act = btn.getAttribute('data-sd-act');
      if (act === 'open-dir') {
        await loadSdFolder(btn.getAttribute('data-path') || '/');
      } else if (act === 'reload') {
        await loadSdFolder(sdBrowserPath);
      } else if (act === 'add-book') {
        const sdPath = btn.getAttribute('data-path');
        if (!sdPath) return;
        const meta = extractFilenameMeta(sdPath);
        if (!outboxBooks.has(sdPath) && !findMappingForBook(mapData, {
          sdPath,
          documentHash: '',
          normFilename: meta.normFilename,
          normTitle: meta.normTitle,
          normAuthor: meta.normAuthor
        })) {
          stagedBooks.set(sdPath, {
            sdPath,
            title: meta.title,
            author: meta.author,
            normFilename: meta.normFilename,
            documentHash: ''
          });
        }
        activeLinkKey = sdPath;
        if (activeFilter !== 'all' && activeFilter !== 'unlinked') {
          activeFilter = 'all';
        }
        sectionOpenState.unlinked = true;
        renderBooks();
        renderSdBrowser();
        setBanner(`Ready to link "${meta.title}" — choose an edition below.`, 'muted');
        const linkerInput = Array.from(container.querySelectorAll('input[data-role="search-q"]')).find(
          (el) => el.getAttribute('data-key') === sdPath
        );
        if (linkerInput) {
          if (typeof linkerInput.scrollIntoView === 'function') {
            linkerInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          if (typeof linkerInput.focus === 'function') linkerInput.focus();
        }
      }
    });

    async function handleBookAction(act, key, btn) {
      const row = buildBookRows().find((r) => r.key === key);
      if (!row) return;

      try {
        if (act === 'sync') {
          await syncBook(row);
        } else if (act === 'sync-journal') {
          await syncBookJournalAction(row);
        } else if (act === 'clean-journal') {
          await cleanBookJournalAction(row);
        } else if (act === 'recon-mark' || act === 'recon-retry') {
          await resolveReconciliation(row, btn && btn.getAttribute('data-sid'), act === 'recon-mark');
        } else if (act === 'mark-read') {
          await markBookRead(row);
        } else if (act === 'unlink') {
          if (await confirmAction(`Unlink "${row.title}" from StoryGraph?`)) {
            delete mapData.books[row.sdPath];
            await saveMapData();
            renderBooks();
            renderSdBrowser();
            setBanner(`Unlinked "${row.title}".`, 'muted');
          }
        } else if (act === 'toggle-link') {
          activeLinkKey = activeLinkKey === key ? null : key;
          renderBooks();
        } else if (act === 'remove-staged') {
          stagedBooks.delete(key);
          if (activeLinkKey === key) activeLinkKey = null;
          renderBooks();
          renderSdBrowser();
          setBanner(`Removed "${row.title}" from list.`, 'muted');
        } else if (act === 'pick-cr') {
          const bid = btn && btn.getAttribute('data-bookid');
          const cr = currentReads.find((c) => c.bookId === bid);
          if (cr) await linkBook(row, Object.assign({ status: 'currently-reading' }, cr));
        } else if (act === 'search') {
          const qInput = container.querySelector(`input[data-role="search-q"][data-key="${CSS.escape ? CSS.escape(key) : key}"]`) ||
            Array.from(container.querySelectorAll('input[data-role="search-q"]')).find((el) => el.getAttribute('data-key') === key);
          const audioCb = Array.from(container.querySelectorAll('input[data-role="include-audio"]')).find(
            (el) => el.getAttribute('data-key') === key
          );
          const query = (qInput && qInput.value ? qInput.value : row.title).trim();
          const includeAudio = Boolean(audioCb && audioCb.checked);
          await runExclusive(`Searching StoryGraph for "${query}"...`, async () => {
            const url = `${BASE_URL}/browse?search_term=${encodeURIComponent(query)}`;
            const html = await fetchStoryGraphHtml(url);
            const parsed = parseStoryGraphSearch(html, includeAudio);
            searchResultsByKey[key] = parsed.results || [];
            renderBooks();
            setBanner(`Found ${searchResultsByKey[key].length} edition(s) for "${query}".`, 'ok');
          });
        } else if (act === 'pick-res') {
          const bid = btn && btn.getAttribute('data-bookid');
          const res = (searchResultsByKey[key] || []).find((r) => r.bookId === bid);
          if (res) await linkBook(row, res);
        } else if (act === 'link-direct') {
          const idInput = Array.from(container.querySelectorAll('input[data-role="direct-id"]')).find(
            (el) => el.getAttribute('data-key') === key
          );
          const parsedId = parseBookIdInput(idInput ? idInput.value : '');
          if (!parsedId) {
            setBanner('Enter a valid StoryGraph book ID or https://app.thestorygraph.com/books/<id> URL.', 'err');
            return;
          }
          await linkBook(row, { bookId: parsedId, title: row.title, author: row.author });
        }
      } catch (err) {
        setBanner(String(err && err.message ? err.message : err), 'err');
      }
    }

    container.querySelector('#sg-books-list').addEventListener('keydown', async (e) => {
      if (!e || e.key !== 'Enter') return;
      const inp = e.target;
      const role = inp && typeof inp.getAttribute === 'function' ? inp.getAttribute('data-role') : null;
      if (role !== 'search-q' && role !== 'direct-id') return;
      const key = inp.getAttribute('data-key');
      if (!key || busyLock) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      await handleBookAction(role === 'search-q' ? 'search' : 'link-direct', key, null);
    });

    container.querySelector('#sg-books-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      await handleBookAction(btn.getAttribute('data-act'), btn.getAttribute('data-key'), btn);
    });

    await loadLocalState();
    renderAll();
    if (!cookieMap._storygraph_session) {
      const details = container.querySelector('#sg-account-details');
      if (details) details.open = true;
    }
  });
})();
