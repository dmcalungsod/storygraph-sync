#!/usr/bin/env python3
"""
USB / SD card historical reading progress backfill for StoryGraph Sync (v0.1.0).

Reads CrossInk's on-device caches inside /.crosspoint/epub_*/:
  - progress_percent.bin ("PRPE" whole-book percentage)
  - progress.bin         (<HHHI spineIndex, page, pageCount, offset -> % via EPUB spine sizes)
  - stats_v5.bin         (reading sessions, duration seconds, pages turned, last date YYYY-MM-DD)

Matches caches back to your current EPUBs even after books were reorganized or moved
into /Read/, and exports /.crosspoint/plugins/storygraph-sync/backfill.json.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import shutil
import struct
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
LOCAL_PLUGIN_DIR = SCRIPT_DIR / "plugin"
PLUGIN_REL_DIR = pathlib.Path(".crosspoint") / "plugins" / "storygraph-sync"
PLUGIN_FILES = ["manifest.json", "device.json", "plugin.js", "README.md"]


def fnv1a_64(text: str) -> int:
    h = 0xCBF29CE484222325
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return h


def fnv1a_32(text: str) -> int:
    h = 0x811C9DC5
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def auto_detect_sd_root() -> pathlib.Path | None:
    """Find the first mounted USB drive containing .crosspoint at root."""
    candidates = [f"{ch}:\\" for ch in "EFGHIJKLMNOPQRSTUVWXYZ"] + ["D:\\"]
    for drv in candidates:
        p = pathlib.Path(drv)
        if p.exists() and (p / ".crosspoint").is_dir():
            return p
    return None


def extract_filename_meta(sd_path: str) -> tuple[str, str]:
    name = sd_path.rsplit("/", 1)[-1]
    stem = re.sub(r"\.(epub|txt|xtc|kepub|pdf|md)$", "", name, flags=re.IGNORECASE).strip()
    if " - " in stem:
        idx = stem.rfind(" - ")
        return stem[:idx].strip() or name, stem[idx + 3 :].strip()
    return stem or name, ""


def extract_epub_meta_and_spines(ep_path: pathlib.Path) -> dict:
    title, author = extract_filename_meta(ep_path.name)
    spine_sizes: list[int] = []
    opf_title = ""
    try:
        with zipfile.ZipFile(ep_path, "r") as zf:
            names = zf.namelist()
            by_lower = {n.lower(): n for n in names}

            opf_rel = None
            if "meta-inf/container.xml" in by_lower:
                try:
                    root = ET.fromstring(zf.read(by_lower["meta-inf/container.xml"]))
                    for elem in root.iter():
                        if elem.tag.lower().endswith("rootfile") and elem.attrib.get("full-path"):
                            opf_rel = elem.attrib["full-path"]
                            break
                except Exception:
                    pass
            if not opf_rel:
                opf_candidates = [n for n in names if n.lower().endswith(".opf")]
                if opf_candidates:
                    opf_rel = opf_candidates[0]

            if opf_rel:
                real_opf = by_lower.get(opf_rel.lower(), opf_rel)
                if real_opf in zf.namelist():
                    opf_base = posix_dirname(real_opf)
                    opf_root = ET.fromstring(zf.read(real_opf))
                    manifest_href: dict[str, str] = {}
                    spine_ids: list[str] = []

                    for elem in opf_root.iter():
                        tag = elem.tag.split("}")[-1].lower()
                        if tag == "title" and not opf_title and elem.text:
                            opf_title = elem.text.strip()
                        elif tag == "creator" and not author and elem.text:
                            author = elem.text.strip()
                        elif tag == "item":
                            iid = elem.attrib.get("id")
                            href = elem.attrib.get("href")
                            if iid and href:
                                resolved = posix_join(opf_base, urllib.parse.unquote(href))
                                manifest_href[iid] = resolved
                        elif tag == "itemref":
                            idref = elem.attrib.get("idref")
                            if idref:
                                spine_ids.append(idref)

                    for idref in spine_ids:
                        target = manifest_href.get(idref)
                        if not target:
                            continue
                        real_target = by_lower.get(target.lower(), target)
                        try:
                            info = zf.getinfo(real_target)
                            spine_sizes.append(int(info.file_size))
                        except KeyError:
                            spine_sizes.append(0)

            if not spine_sizes:
                html_files = sorted(
                    n for n in names if n.lower().endswith((".xhtml", ".html", ".htm"))
                )
                spine_sizes = [zf.getinfo(n).file_size for n in html_files]
    except Exception:
        pass

    return {
        "title": title,
        "author": author,
        "opf_title": opf_title,
        "spine_sizes": spine_sizes,
    }


def posix_dirname(path_str: str) -> str:
    if "/" not in path_str:
        return ""
    return path_str.rsplit("/", 1)[0]


def posix_join(base: str, rel: str) -> str:
    parts = [p for p in (f"{base}/{rel}" if base else rel).split("/") if p and p != "."]
    out: list[str] = []
    for p in parts:
        if p == "..":
            if out:
                out.pop()
        else:
            out.append(p)
    return "/".join(out)


def discover_epubs(sd_root: pathlib.Path) -> tuple[list[tuple[pathlib.Path, str]], set[str]]:
    epubs: list[tuple[pathlib.Path, str]] = []
    book_folders: set[str] = {"/", "/Books", "/Read"}
    for dirpath, dirnames, filenames in os.walk(sd_root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        cur_path = pathlib.Path(dirpath)
        rel_dir = cur_path.relative_to(sd_root).as_posix()
        norm_dir = "/" if rel_dir == "." else "/" + rel_dir.strip("/")
        if norm_dir == "/Books" or norm_dir.startswith("/Books/"):
            book_folders.add(norm_dir)
        for fn in filenames:
            if fn.startswith(".") or not fn.lower().endswith(".epub"):
                continue
            ep = cur_path / fn
            rel_file = ep.relative_to(sd_root).as_posix()
            epubs.append((ep, "/" + rel_file.lstrip("/")))
    return sorted(epubs, key=lambda x: x[1].lower()), book_folders


def build_hash_table(
    epubs: list[tuple[pathlib.Path, str]],
    book_folders: set[str],
    meta_by_sd: dict[str, dict],
) -> dict[str, list[tuple[str, str]]]:
    table: dict[str, list[tuple[str, str]]] = {}

    def register(candidate_path: str, current_sd_path: str) -> None:
        for h in (fnv1a_64(candidate_path), fnv1a_32(candidate_path)):
            key = f"epub_{h}"
            lst = table.setdefault(key, [])
            item = (current_sd_path, candidate_path)
            if item not in lst:
                lst.append(item)

    folder_list = sorted(book_folders)
    for ep_path, current_sd in epubs:
        fname = ep_path.name
        stem_title = extract_filename_meta(fname)[0]
        opf_title = (meta_by_sd[current_sd].get("opf_title") or "").strip()

        filenames = {fname, f"{stem_title}.epub"}
        if opf_title:
            filenames.add(f"{opf_title}.epub")

        local_folders = set(folder_list)
        if ep_path.parent != ep_path.anchor:
            local_folders.add(f"/Books/{ep_path.parent.name}")
            local_folders.add(f"/{ep_path.parent.name}")

        register(current_sd, current_sd)
        for folder in local_folders:
            prefix = "" if folder == "/" else folder.rstrip("/")
            for fn in filenames:
                register(f"{prefix}/{fn}", current_sd)

    return table


def match_by_dictionary_history(
    cache_dir: pathlib.Path,
    spine_idx: int,
    epubs: list[tuple[pathlib.Path, str]],
    meta_by_sd: dict[str, dict],
) -> str | None:
    dh = cache_dir / "dictionary_history.txt"
    if not dh.is_file():
        return None
    words: list[str] = []
    seen: set[str] = set()
    for line in dh.read_text("utf-8", errors="ignore").splitlines():
        if "|" not in line:
            continue
        w = line.split("|", 1)[0].strip().lower()
        if len(w) >= 3 and w not in seen:
            seen.add(w)
            words.append(w)
        if len(words) >= 10:
            break
    if not words:
        return None

    scored: list[tuple[int, str]] = []
    for ep_path, current_sd in epubs:
        spine_count = len(meta_by_sd[current_sd].get("spine_sizes") or [])
        if spine_idx >= 0 and spine_count > 0 and spine_count <= spine_idx:
            continue
        try:
            with zipfile.ZipFile(ep_path, "r") as zf:
                chunks = []
                for n in zf.namelist():
                    if n.lower().endswith((".xhtml", ".html", ".htm")):
                        chunks.append(zf.read(n).decode("utf-8", errors="ignore").lower())
                full_text = "\n".join(chunks)
            hits = sum(1 for w in words if w in full_text)
            if hits == len(words) or (len(words) >= 2 and hits >= max(2, len(words) - 1)):
                scored.append((hits, current_sd))
        except Exception:
            continue

    if not scored:
        return None
    scored.sort(reverse=True)
    top_hits = scored[0][0]
    winners = [sd for hits, sd in scored if hits == top_hits]
    if len(winners) == 1:
        return winners[0]
    return None


def parse_ymd(buf: bytes, offset: int) -> tuple[str, int | None]:
    if len(buf) < offset + 4:
        return "", None
    yr = int.from_bytes(buf[offset : offset + 2], "little")
    mo = buf[offset + 2]
    dy = buf[offset + 3]
    if 2020 <= yr <= 2100 and 1 <= mo <= 12 and 1 <= dy <= 31:
        try:
            d = dt.datetime(yr, mo, dy, 12, 0, 0, tzinfo=dt.timezone.utc)
            return d.strftime("%Y-%m-%d"), int(d.timestamp())
        except ValueError:
            return "", None
    return "", None


def decode_cache_dir(
    cache_dir: pathlib.Path,
    ep_path: pathlib.Path,
    epub_meta: dict,
) -> dict:
    pp_file = cache_dir / "progress_percent.bin"
    pp_val = None
    has_progress_percent = False
    if pp_file.is_file():
        raw = pp_file.read_bytes()
        if len(raw) >= 7 and raw[:4] == b"PRPE":
            _, _, bp = struct.unpack("<4sBH", raw[:7])
            if 0 <= bp <= 10000:
                pp_val = max(1, round(bp / 100)) if bp > 0 else 0
                has_progress_percent = True
        elif len(raw) >= 5 and raw[:4] == b"PRPE" and 0 <= raw[4] <= 100:
            pp_val = int(raw[4])
            has_progress_percent = True

    p_file = cache_dir / "progress.bin"
    if not p_file.is_file():
        p_file = cache_dir / "progress.bin.bak"
    spine_idx = -1
    page = 0
    page_count = 0
    offset = 0
    if p_file.is_file():
        raw = p_file.read_bytes()
        if len(raw) >= 10:
            spine_idx, page, page_count, offset = struct.unpack("<HHHI", raw[:10])

    raw_percent = 0
    if pp_val is not None:
        raw_percent = pp_val
    elif spine_idx >= 0:
        spine_sizes: list[int] = epub_meta.get("spine_sizes") or []
        if spine_idx == 0 and page == 0 and offset == 0:
            raw_percent = 0
        elif spine_sizes and sum(spine_sizes) > 0:
            idx = min(spine_idx, len(spine_sizes) - 1)
            before = sum(spine_sizes[:idx])
            cur = spine_sizes[idx]
            total = sum(spine_sizes)
            frac = min(1.0, (page + 0.5) / max(1, page_count))
            raw_percent = max(1, min(100, round(((before + frac * cur) / total) * 100)))

    stat_candidates = []
    for p in list(cache_dir.glob("stats_v7*.bin*")) + list(cache_dir.glob("stats_v5*.bin*")):
        if not p.is_file():
            continue
        sb = p.read_bytes()
        if len(sb) >= 25 and sb[0] in (5, 7):
            s_sess = int.from_bytes(sb[1:3], "little")
            s_sec = int.from_bytes(sb[3:7], "little")
            s_pg = int.from_bytes(sb[7:11], "little")
            s_fin = 1 if sb[11] == 1 else 0
            s_start, s_start_ts = parse_ymd(sb, 17)
            s_end, s_end_ts = parse_ymd(sb, 21)
            is_bak = 1 if p.name.endswith(".bak") else 0
            rank = (sb[0], 0 if is_bak else 1, s_sec, s_pg, s_sess)
            stat_candidates.append(
                (rank, p, s_sess, s_sec, s_pg, s_fin, s_start, s_start_ts, s_end, s_end_ts)
            )

    sessions = 0
    total_sec = 0
    pages_turned = 0
    finished_flag = 0
    start_date = ""
    start_ts: int | None = None
    last_date = ""
    last_read_ts: int | None = None
    explicit_stats_date = False
    stats_file_used = None

    if stat_candidates:
        stat_candidates.sort(key=lambda t: t[0], reverse=True)
        (
            _,
            stats_file_used,
            sessions,
            total_sec,
            pages_turned,
            finished_flag,
            start_date,
            start_ts,
            end_date,
            end_ts,
        ) = stat_candidates[0]
        if end_date:
            last_date = end_date
            last_read_ts = end_ts
            explicit_stats_date = True
        elif start_date:
            mt_list = [
                c.stat().st_mtime
                for c in (stats_file_used, pp_file, p_file)
                if c and c.exists()
            ]
            if mt_list:
                best_mt = max(mt_list)
                d = dt.datetime.fromtimestamp(best_mt, tz=dt.timezone.utc)
                if 2020 <= d.year <= 2100 and (start_ts is None or int(best_mt) >= start_ts - 86400):
                    last_date = d.strftime("%Y-%m-%d")
                    last_read_ts = int(best_mt)
                    explicit_stats_date = True
            if not last_date:
                last_date = start_date
                last_read_ts = start_ts
                explicit_stats_date = True

    if not last_date:
        mtimes = []
        for candidate in (
            stats_file_used,
            cache_dir / "stats_v5.bin",
            cache_dir / "progress_percent.bin",
            cache_dir / "progress.bin",
            cache_dir / "progress.bin.bak",
            ep_path,
        ):
            if candidate and candidate.exists():
                mtimes.append(candidate.stat().st_mtime)
        if mtimes:
            best_mt = max(mtimes)
            d = dt.datetime.fromtimestamp(best_mt, tz=dt.timezone.utc)
            if 2020 <= d.year <= 2100:
                last_date = d.strftime("%Y-%m-%d")
                last_read_ts = int(best_mt)

    return {
        "cacheDir": cache_dir.name,
        "spine": spine_idx,
        "page": page,
        "pageCount": page_count,
        "hasProgressPercent": has_progress_percent,
        "rawPercent": raw_percent,
        "sessions": sessions,
        "durationSeconds": total_sec,
        "pagesTurned": pages_turned,
        "finishedFlag": finished_flag,
        "startDate": start_date,
        "lastDate": last_date,
        "lastReadTs": last_read_ts,
        "explicitStatsDate": explicit_stats_date,
    }


def fallback_file_date(ep_path: pathlib.Path) -> tuple[str, int | None]:
    mt = ep_path.stat().st_mtime
    d = dt.datetime.fromtimestamp(mt, tz=dt.timezone.utc)
    if 2020 <= d.year <= 2100:
        return d.strftime("%Y-%m-%d"), int(mt)
    return "", None


def scan_sd_root(sd_root: pathlib.Path) -> tuple[dict, list[str]]:
    cp_dir = sd_root / ".crosspoint"
    if not cp_dir.is_dir():
        raise FileNotFoundError(f"Missing .crosspoint directory under {sd_root}")

    epubs, book_folders = discover_epubs(sd_root)
    meta_by_sd: dict[str, dict] = {}
    ep_by_sd: dict[str, pathlib.Path] = {}
    for ep_path, rel_sd in epubs:
        ep_by_sd[rel_sd] = ep_path
        meta_by_sd[rel_sd] = extract_epub_meta_and_spines(ep_path)

    hash_table = build_hash_table(epubs, book_folders, meta_by_sd)

    matched_records: dict[str, list[dict]] = {}
    unmatched_caches: list[str] = []

    for cache_dir in sorted(cp_dir.glob("epub_*")):
        if not cache_dir.is_dir():
            continue
        entries = hash_table.get(cache_dir.name)
        target_sd = None
        matched_hint = ""
        if entries:
            target_sd, matched_hint = entries[0]
        else:
            p_file = cache_dir / "progress.bin"
            spine_idx = -1
            if p_file.is_file() and len(p_file.read_bytes()) >= 2:
                spine_idx = struct.unpack("<H", p_file.read_bytes()[:2])[0]
            target_sd = match_by_dictionary_history(cache_dir, spine_idx, epubs, meta_by_sd)
            if target_sd:
                matched_hint = "(dictionary_history match)"

        if not target_sd:
            has_data = any(
                (cache_dir / f).is_file()
                for f in ("progress.bin", "stats_v5.bin", "progress_percent.bin")
            ) or any(cache_dir.glob("stats_v*.bin"))
            if has_data:
                unmatched_caches.append(cache_dir.name)
            continue

        decoded = decode_cache_dir(cache_dir, ep_by_sd[target_sd], meta_by_sd[target_sd])
        decoded["matchedPath"] = matched_hint
        matched_records.setdefault(target_sd, []).append(decoded)

    books_out: dict[str, dict] = {}
    for ep_path, rel_sd in epubs:
        meta = meta_by_sd[rel_sd]
        is_read_dir = rel_sd.lower().startswith("/read/")
        recs = matched_records.get(rel_sd, [])

        best = None
        start_date = ""
        duration = 0
        pages_turned = 0
        sessions = 0
        if recs:
            recs.sort(
                key=lambda r: (
                    1 if r["hasProgressPercent"] else 0,
                    r["rawPercent"],
                    r["durationSeconds"],
                    r["pagesTurned"],
                    1 if r["explicitStatsDate"] else 0,
                ),
                reverse=True,
            )
            best = recs[0]
            start_dates = [r["startDate"] for r in recs if r["startDate"]]
            start_date = min(start_dates) if start_dates else ""
            duration = max(r["durationSeconds"] for r in recs)
            pages_turned = max(r["pagesTurned"] for r in recs)
            sessions = max(r["sessions"] for r in recs)

        finished = is_read_dir or any(r["finishedFlag"] == 1 for r in recs)
        raw_percent = best["rawPercent"] if best else 0
        last_date = best["lastDate"] if best else ""
        last_ts = best["lastReadTs"] if best else None
        source_cache = best["cacheDir"] if best else ""

        if finished and not last_date:
            last_date, last_ts = fallback_file_date(ep_path)

        has_activity = raw_percent > 0 or duration > 0 or pages_turned > 0
        if not finished and not has_activity:
            continue

        books_out[rel_sd] = {
            "sdPath": rel_sd,
            "title": meta["title"],
            "author": meta["author"],
            "percent": 100 if finished else raw_percent,
            "rawPercent": raw_percent,
            "finished": finished,
            "durationSeconds": duration,
            "pagesTurned": pages_turned,
            "sessions": sessions,
            "startDate": start_date,
            "lastDate": last_date,
            "lastReadTs": last_ts,
            "sourceCache": source_cache,
        }

    payload = {
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "books": books_out,
    }
    return payload, unmatched_caches


def clean_stale_read_zero_events(events_path: pathlib.Path) -> tuple[int, int]:
    if not events_path.is_file():
        return 0, 0
    raw = events_path.read_text("utf-8", errors="ignore")
    kept: list[str] = []
    removed = 0
    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
            v = ev.get("vars") if isinstance(ev.get("vars"), dict) else ev
            book = str((v or {}).get("book") or "")
            pct = str((v or {}).get("percent") if (v or {}).get("percent") is not None else "")
            if book.lower().startswith("/read/") and pct == "0":
                removed += 1
                continue
        except Exception:
            pass
        kept.append(line)

    if removed > 0:
        events_path.write_text(("\n".join(kept) + "\n") if kept else "\n", encoding="utf-8")
    return removed, len(kept)


def upload_wifi_file(base_url: str, remote_path: str, data: bytes) -> None:
    boundary = "----StoryGraphSyncBackfill7MA4YWxkTrZu0gW"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="data"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("ascii") + data + f"\r\n--{boundary}--\r\n".encode("ascii")

    query = urllib.parse.urlencode({"plugin": "storygraph-sync", "path": remote_path})
    url = f"{base_url.rstrip('/')}/api/plugin-fs?{query}"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        if resp.status < 200 or resp.status >= 300:
            raise RuntimeError(f"HTTP {resp.status}: {resp.read().decode('utf-8', 'replace')}")


def print_summary(payload: dict, unmatched: list[str]) -> None:
    books = list(payload["books"].values())
    print(f"Found {len(books)} book(s) with historical progress / Read status:\n")
    for b in sorted(books, key=lambda x: (not x["finished"], -(x["rawPercent"] or 0), x["sdPath"])):
        mins = round(b["durationSeconds"] / 60)
        dur_str = f"{mins}m" if mins > 0 else f"{b['durationSeconds']}s"
        status_str = f"READ (cache {b['rawPercent']}%)" if b["finished"] else f"{b['percent']}%"
        sd = b.get("startDate") or ""
        ld = b.get("lastDate") or ""
        if sd and ld and sd != ld:
            date_str = f"{sd} -> {ld}"
        else:
            date_str = ld or sd or "unknown date"
        print(
            f"  - {b['title']} | {status_str} | {dur_str}, {b['pagesTurned']} pp, "
            f"{b['sessions']} sessions | {date_str} | {b['sourceCache'] or 'folder'} | {b['sdPath']}"
        )
    if unmatched:
        print(f"\nUnmatched non-empty cache folders ({len(unmatched)}): {', '.join(unmatched)}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill StoryGraph Sync from X4 Pro USB/SD caches.")
    parser.add_argument("--sd-root", help="Path to mounted X4 Pro SD card (e.g. E:\\). Auto-detected if omitted.")
    parser.add_argument("--write-sd", action="store_true", help="Write backfill.json & updated plugin files onto --sd-root.")
    parser.add_argument("--out", help="Write backfill JSON to a local file.")
    parser.add_argument(
        "--push-wifi",
        nargs="?",
        const="http://crosspoint.local",
        default=None,
        help="Upload backfill.json over Wi-Fi File Transfer to the X4 Pro.",
    )
    args = parser.parse_args()

    sd_root = pathlib.Path(args.sd_root) if args.sd_root else auto_detect_sd_root()
    if not sd_root or not sd_root.exists():
        print("No mounted XTEInk SD card (.crosspoint directory) found. Pass --sd-root E:\\ after connecting via USB.", file=sys.stderr)
        return 1

    payload, unmatched = scan_sd_root(sd_root)
    print_summary(payload, unmatched)

    json_bytes = (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

    if args.out:
        out_path = pathlib.Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(json_bytes)
        print(f"\nWrote {len(json_bytes)} bytes -> {out_path}")

    if args.write_sd:
        plugin_target = sd_root / PLUGIN_REL_DIR
        plugin_target.mkdir(parents=True, exist_ok=True)
        for fname in PLUGIN_FILES:
            src = LOCAL_PLUGIN_DIR / fname
            if src.is_file():
                shutil.copy2(src, plugin_target / fname)
        (plugin_target / "backfill.json").write_bytes(json_bytes)
        removed, kept = clean_stale_read_zero_events(plugin_target / "events.jsonl")
        print(f"\nUpdated plugin + wrote backfill.json ({len(json_bytes)} bytes) to {plugin_target}")
        if removed:
            print(f"Cleaned {removed} stale /Read/ 0% line(s) from events.jsonl ({kept} kept).")

    if args.push_wifi:
        upload_wifi_file(args.push_wifi, "/.crosspoint/plugins/storygraph-sync/backfill.json", json_bytes)
        print(f"\nUploaded backfill.json ({len(json_bytes)} bytes) over Wi-Fi to {args.push_wifi}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
