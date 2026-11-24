# StoryGraph Sync

Sync reading progress, per-session reading journals, and start/finish dates from your CrossPoint e-reader directly to **The StoryGraph** from the File Manager Web UI (`/files`).

## Highlights

- **Per-session reading diary:** Preserves each individual `reader.session` sitting (even short or same-day sittings with identical progress) with a persistent local synchronization ledger (`sessionId` to StoryGraph `journalEntryId`) and interrupted-sync reconciliation. Books with unposted sessions are flagged **Journal unsynced** and included in **Sync All**, and ambiguous interrupted posts can be resolved in the UI with **Mark Synced** or **Retry**.
- **Progress, status, and dates:** Syncs percentage or page progress, marks finished books as **Read** (including books moved into `/Read/`), and keeps start/finish dates aligned.
- **Clean Journals:** Repairs stray `100%` / `0%` StoryGraph journal artifacts (batch **Clean Journals** under **Tools & Preferences** or per-book **Clean Journal** / **Open Journal ↗** inside **Reading history**) while preserving all ledger-bound and note-bearing sessions, with automatic retry/backoff on transient `/api/fetch` errors and a watermarked verification cache for already-clean Read books.
- **Privacy-first credentials:** Session cookies stay strictly in your browser `localStorage` and are never written to the microSD card. Smart-paste supports DevTools cookie headers, **Cookie-Editor** JSON (great for phone-only setup), Netscape `cookies.txt`, and cURL.

## Compatibility

- Tested on **CrossInk 2.0.0 RC3** (XTEInk X4 Pro).
- Compatible with **CrossPoint 2.0.0 RC / nightly** (`firmware_family: crosspoint`, `plugin_api >= 1`).
- Per-session duration tracking uses `reader.session` events; firmware builds that only emit `reader.exit` still track reading progress checkpoints seamlessly.

## Quick Setup

1. Install from **Plugin Hub** (or copy `storygraph-sync/` into `/.crosspoint/plugins/storygraph-sync/`).
2. Enable **Plugins** in device settings and **reboot once** so firmware registers event subscriptions.
3. Start File Transfer, open `http://crosspoint.local/files`, expand **Account Settings**, paste your StoryGraph cookies (DevTools `cookie` header on desktop, or **Cookie-Editor → Export → JSON / Header String** on phone), and click **Verify Session**.
4. Link books via **Current Reads**, search, or book URL/ID, then click **Sync All**.
