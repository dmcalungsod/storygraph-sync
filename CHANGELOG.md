# Changelog

All notable changes to **StoryGraph Sync for CrossPoint** are documented in this file.

## [v1.0.1] - 2026-11-24

### Added
- **Smart-paste cookie parser (`parseCookieHeader`):** Accepts **Cookie-Editor JSON** exports (automatically filtering to StoryGraph domains), **Netscape `cookies.txt`** (including `#HttpOnly_` entries), **Copy as cURL** (`-H 'cookie: ...'`, `-b`, `--cookie`), DevTools `cookie:` prefixes/quotes, and raw header strings or bare tokens, normalizing pasted structured formats automatically.
- **Mobile & Desktop Account Settings guide:** Built-in collapsible **How to get cookies? (Desktop & Phone)** drawer with step-by-step instructions for Desktop DevTools and Phone **Cookie-Editor** (Firefox on Android / Safari on iOS), plus a direct `Open StoryGraph ↗` link.
- **Account Settings usability:** Plain-English summary badge (`Not connected`, `Missing _storygraph_session`, `Cookies saved (N) · click Verify`, `Connected (N cookies)`), inline paste verification hint (`✓ Session cookie detected` / `⚠ Missing _storygraph_session`), **Show/Hide** cookie toggle, live **Headers: X.X / 4.0 KB** meter, live **Journal Note preview**, confirmation dialog before **Clear Cookies**, and file-based **Import Settings** (`#sg-settings-file`).
- **Reconciliation & per-book journal actions:** Inline **Open Journal ↗**, **Mark Synced**, and **Retry** actions for sessions flagged `needs_reconciliation`, plus per-book **Clean Journal** and **Open Journal ↗** inside every linked book's **Reading history**.
- **Linker ergonomics:** `Enter` key triggers Search or Direct ID linking inside the inline Linker, and **Add & Link** in **Browse SD Library** smoothly scrolls to and focuses the new linker.
- **Zero-dependency build script (`scripts/build.mjs`):** Compacts `src/plugin.js` into `storygraph-sync.crosspoint-plugin/plugin.js` without obfuscation, trimming ~50 KB (~216 KB total) to keep generous headroom under CrossInk's 256 KB `/api/plugin-fs` cap, paired with `.gitattributes` LF line-ending rules.

### Changed
- **Sync detection & progress clarity:** Books with unposted reading sessions (even at the same integer `%`) now show a **Journal unsynced** badge, appear under **Needs Sync**, and are included in **Sync All**; progress direction label now reads `50% synced → 89%`; `syncBookJournalAction` status messages consistently say `session(s)`.
- **Cleaner header & drawer hierarchy:** Moved **Clean Journals**, **Compact Outbox**, **Import Session History**, and batch checkboxes into a collapsible **Tools & Preferences** drawer; tucked **User-Agent** and **Export / Import Settings** under **Account Settings → Advanced & Backup**; added `▸` / `▾` chevrons to **Reading history** summaries and distinguished `logged` vs `total` duration when SD cache time exceeds logged sessions.

---

## [v1.0.0] - 2026-11-22

- Initial public release for CrossPoint Plugin Hub (`manifest.json`, `device.json`, `plugin.js`, `backfill_sd.py`, local mock harness, and `v2` per-session `reading-history.json` diary with synchronization ledger, batch `Sync All`, `Sync Dates`, `Clean Journals`, and `Browse SD Library`).
