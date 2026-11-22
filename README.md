# StoryGraph Sync for CrossPoint

A CrossPoint / CrossInk SD-card plugin that syncs reading progress, per-session reading journals, and start/finish dates from your e-reader directly to **The StoryGraph** via the File Manager Web UI (`/files`).

> **Tested Firmware:** **CrossInk 2.0.0 RC3** (XTEInk X4 Pro)  
> **Compatibility:** **CrossPoint 2.0.0 RC / nightly** (`firmware_family: crosspoint`, `plugin_api >= 1`)

## Features

- **Per-session reading diary (`reading-history.json` v2):** Preserves each individual `reader.session` sitting (duration, local time-of-day range, start/end progress, midnight-spanning dates) with a persistent synchronization ledger (`sessionId → journalEntryId → syncStatus`) and single-candidate interrupted-sync reconciliation. Firmware builds that only emit `reader.exit` gracefully record `progress_checkpoint` entries.
- **Progress, status & dates:** Updates StoryGraph progress (pages or percentage), marks finished books as **Read** (including books moved into `/Read/`), and syncs start/finish dates while preserving earlier start dates already on StoryGraph.
- **Clean Journals & resilient fetching:** Repairs stray `100%` / `0%` StoryGraph journal entries while strictly preserving ledger-bound and note-bearing sessions; automatically retries transient `/api/fetch` errors with backoff (never reading stale SD cache on failure) and skips already-verified clean **Read** books via a local activity watermark.
- **Browse SD Library & Session History Import:** Link older or already-finished books directly from your SD card, or import historical sessions from CrossPoint Sync exports, `reading-history.json`, or `events.jsonl`.
- **Privacy-first storage:** StoryGraph session cookies stay strictly in browser `localStorage` and are never written to the microSD card.

## Installation

### Option 1 — CrossPoint Plugin Hub (Recommended)

1. Open **Home → Plugins → Plugin Hub** on your e-reader (or the Plugin Hub WebUI).
2. Find **StoryGraph Sync** under **Community Plugins** and install it.
3. **Reboot once** so firmware registers `reader.exit` and `reader.session` event subscriptions.

### Option 2 — Manual SD Install

1. Copy the contents of [`storygraph-sync.crosspoint-plugin/`](storygraph-sync.crosspoint-plugin/) into `/.crosspoint/plugins/storygraph-sync/` on your microSD card.
2. Enable **Plugins** in device settings and **reboot once**.

See [`storygraph-sync.crosspoint-plugin/README.md`](storygraph-sync.crosspoint-plugin/README.md) for full cookie setup and usage instructions.

## Optional: Historical SD Backfill

If you want to backfill pre-plugin reading progress, durations, and dates from existing on-device EPUB caches (`/.crosspoint/epub_*/`), connect your e-reader in **USB Drive** mode and run:

```bash
python backfill_sd.py --write-sd
```

## Repository Structure

```text
storygraph-sync/
├── storygraph-sync.crosspoint-plugin/   # Installable Plugin Hub payload
│   ├── manifest.json
│   ├── device.json
│   ├── plugin.js
│   ├── README.md
│   └── DETAILS.md
├── backfill_sd.py                       # Optional USB historical cache backfill tool
├── harness/                             # Local mock CrossPoint + StoryGraph test harness
│   ├── server.mjs
│   └── test.mjs
├── docs/
│   └── architecture.md                  # Technical design & firmware plugin API notes
└── LICENSE
```

## Development & Tests

Run the local mock CrossPoint + StoryGraph test suite (Node.js 18+, zero npm dependencies):

```bash
node --check storygraph-sync.crosspoint-plugin/plugin.js
node --check harness/server.mjs
node harness/test.mjs
```

## License

[MIT](LICENSE)
