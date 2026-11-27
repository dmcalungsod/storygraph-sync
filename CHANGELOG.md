# Changelog

All notable changes to **StoryGraph Sync for CrossPoint** are documented in this file.

## [v1.0.2] - 2026-11-27

### Added
- **Centered floating progress modal (`#sg-sync-progress`):** Matches CrossInk's centered upload modal (`position: fixed` with blurred backdrop), showing live operation labels (`Connecting`, `Searching`, `Linking`, `Uploading`, `Syncing`, `Cleaning`, `Complete`, `Failed`, `Cancelled`), `0–100%` progress, shimmer animation, and `×` / backdrop dismissal across single-book, batch, verification, search, and linking operations.
- **Safe batch Cancel (`#sg-sync-cancel`):** Multi-book batches (**Sync All**, **Sync Dates**, and **Clean Journals**) now include an active **Cancel** button that stops cleanly between books without leaving half-posted StoryGraph entries, preserving completed progress and cleanup watermarks.
- **Ignore / Restore unwanted books:** Added **Ignore** on unlinked outbox cards to hide samples, manuals, or unwanted files in `storygraph-map.json` (`mapData.ignored`, matching by `sdPath`, `documentHash`, and normalized filename) without modifying SD files, plus **Tools & Preferences → Ignored Books** (**Restore** / **Restore All**) and **Browse SD Library** `Ignored` / `Restore` controls.

### Changed
- **Smooth book linking & navigation:** Opening **Link Book** no longer teleports `Unlinked & From SD` above `Currently Reading`, scrolls directly to and focuses the linking UI (and clears active `#sg-book-search` filters on **Add & Link**), adds an inline search spinner and empty-result feedback, and preserves typed search queries and the **Include audiobooks** toggle across searches.
- **Two-tone animated per-book progress bars:** Layered bar styling distinguishes synced StoryGraph progress from unsynced device progress with smooth width transitions.
- **Token-aware build compactor (`scripts/build.mjs`):** Zero-dependency token-level whitespace/newline compaction and safe adjacent string folding with built-in `vm.Script` syntax validation (~227 KB built, reclaiming ~35 KB headroom under CrossInk's 256 KB limit).

## [v1.0.1] - 2026-11-24

### Added
- **Smart-paste cookie parser (`parseCookieHeader`):** Accepts **Cookie-Editor JSON** exports (automatically filtering to StoryGraph domains), **Netscape `cookies.txt`** (including `#HttpOnly_` entries), **Copy as cURL** (`-H 'cookie: ...'`, `-b`, `--cookie`), DevTools `cookie:` prefixes/quotes, and raw header strings or bare tokens, normalizing pasted structured formats automatically.
- **Mobile & Desktop Account Settings guide:** Built-in collapsible **How to get cookies? (Desktop & Phone)** drawer with step-by-step instructions for Desktop DevTools and Phone **Cookie-Editor** (Firefox on Android / Safari on iOS), plus a direct `Open StoryGraph ↗` link.
- **Account Settings usability:** Plain-English summary badge (`Not connected`, `Missing _storygraph_session`, `Cookies saved (N) · click Verify`, `Connected (N cookies)`), inline paste verification hint (`✓ Session cookie detected` / `⚠ Missing _storygraph_session`), **Show/Hide** cookie toggle, live **Headers: X.X / 4.0 KB** meter, live **Journal Note preview**, confirmation dialog before **Clear Cookies**, file-based **Import Settings** (`#sg-settings-file`), and **SD-card preference persistence** (saving `Journal device label`, journal notes toggle, and batch toggles inside `storygraph-map.json` so they survive DHCP IP changes and phone ↔ PC switches while cookies stay strictly in browser `localStorage`).
- **Automated Release Packaging (`.github/workflows/release.yml`):** Publishes `storygraph-sync-v*.zip`, `*.sha256`, and `SHA256SUMS.txt` on `v*` tags alongside the non-draft GitHub Release for Plugin Hub discovery.
- **Reconciliation & per-book journal actions:** Inline **Open Journal ↗**, **Mark Synced**, and **Retry** actions for sessions flagged `needs_reconciliation`, plus per-book **Clean Journal** and **Open Journal ↗** inside every linked book's **Reading history**.
- **Linker ergonomics:** `Enter` key triggers Search or Direct ID linking inside the inline Linker, and **Add & Link** in **Browse SD Library** smoothly scrolls to and focuses the new linker.
- **Zero-dependency build script (`scripts/build.mjs`):** Compacts `src/plugin.js` into `storygraph-sync.crosspoint-plugin/plugin.js` without obfuscation, trimming ~50 KB (~216 KB total) to keep generous headroom under CrossInk's 256 KB `/api/plugin-fs` cap, paired with `.gitattributes` LF line-ending rules.

### Changed
- **Sync detection & progress clarity:** Books with unposted reading sessions (even at the same integer `%`) now show a **Journal unsynced** badge, appear under **Needs Sync**, and are included in **Sync All**; progress direction label now reads `50% synced → 89%`; `syncBookJournalAction` status messages consistently say `session(s)`.
- **Cleaner header & drawer hierarchy:** Moved **Clean Journals**, **Compact Outbox**, **Import Session History**, and batch checkboxes into a collapsible **Tools & Preferences** drawer; tucked **User-Agent** and **Export / Import Settings** under **Account Settings → Advanced & Backup**; added `▸` / `▾` chevrons to **Reading history** summaries and distinguished `logged` vs `total` duration when SD cache time exceeds logged sessions.

---

## [v1.0.0] - 2026-11-22

- Initial public release for CrossPoint Plugin Hub (`manifest.json`, `device.json`, `plugin.js`, `backfill_sd.py`, local mock harness, and `v2` per-session `reading-history.json` diary with synchronization ledger, batch `Sync All`, `Sync Dates`, `Clean Journals`, and `Browse SD Library`).
