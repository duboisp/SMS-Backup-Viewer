#!/usr/bin/env python3
"""
SMS Backup Viewer — Local Python Application
Performance-optimized version with indexed lookups, split rendering,
deduplicated media storage, and non-blocking exports.
"""

import argparse
import atexit
import io
import json
import mimetypes
import os
import re
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from collections import defaultdict
from datetime import datetime, timezone

import defusedxml.ElementTree as ET

from flask import (
    Flask,
    Response,
    jsonify,
    render_template,
    request,
    stream_with_context,
)

from media_store import MediaBlobStore

# Resolve paths for templates and static files (works with PyInstaller too)
if getattr(sys, 'frozen', False):
    _bundle_dir = sys._MEIPASS
else:
    _bundle_dir = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__,
            template_folder=os.path.join(_bundle_dir, 'templates'),
            static_folder=os.path.join(_bundle_dir, 'static'))
# No MAX_CONTENT_LENGTH — large files stream to disk via temp file

# ---------------------------------------------------------------------------
# Security helpers
# ---------------------------------------------------------------------------

# Content types safe to serve inline (everything else → application/octet-stream)
SAFE_STREAM_TYPES = {
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp",
    "video/mp4", "video/3gpp", "video/3gpp2", "video/webm", "video/mpeg",
    "audio/mpeg", "audio/aac", "audio/ogg", "audio/wav", "audio/amr",
    "audio/3gpp", "application/ogg",
}


def sanitize_filename(name):
    """Strip path separators and dangerous characters from a filename."""
    # Take only the basename (strip any path components)
    name = os.path.basename(name)
    # Remove anything that isn't alphanumeric, dot, dash, underscore, space
    name = re.sub(r'[^\w.\- ]', '_', name)
    # Collapse multiple underscores/spaces
    name = re.sub(r'[_ ]{2,}', '_', name).strip('_. ')
    return name or "unnamed"


def sanitize_content_type(ct):
    """Return a safe content-type, or application/octet-stream for unknown types."""
    ct_lower = ct.lower().split(";")[0].strip()
    if ct_lower in SAFE_STREAM_TYPES:
        return ct_lower
    return "application/octet-stream"


def safe_int(val, default=1, minimum=1):
    """Parse an integer from a request parameter, clamping to minimum."""
    try:
        v = int(val)
        return max(minimum, v)
    except (ValueError, TypeError):
        return default


def csv_safe(value):
    """Prevent CSV formula injection by prefixing dangerous first characters."""
    s = str(value)
    if s and s[0] in ('=', '+', '-', '@', '\t', '\r', '\n'):
        return "'" + s
    return s

def _get_downloads_folder():
    """Return the user's Downloads folder path."""
    if sys.platform == "win32":
        # Use Windows known folder API via ctypes
        try:
            import ctypes
            from ctypes import wintypes
            GUID = ctypes.c_char * 16
            _SHGetKnownFolderPath = ctypes.windll.shell32.SHGetKnownFolderPath
            _SHGetKnownFolderPath.argtypes = [ctypes.POINTER(GUID), ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
            _SHGetKnownFolderPath.restype = ctypes.HRESULT
            # FOLDERID_Downloads = {374DE290-123F-4565-9164-39C4925E467B}
            fid = GUID(b'\x90\xe2\x4d\x37\x3f\x12\x65\x45\x91\x64\x39\xc4\x92\x5e\x46\x7b')
            pPath = ctypes.c_wchar_p()
            if _SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(pPath)) == 0:
                path = pPath.value
                ctypes.windll.ole32.CoTaskMemFree(pPath)
                if os.path.isdir(path):
                    return path
        except Exception:
            pass
    # Fallback: ~/Downloads
    dl = os.path.join(os.path.expanduser("~"), "Downloads")
    if os.path.isdir(dl):
        return dl
    # Last resort: home directory
    return os.path.expanduser("~")


sessions = {}
media_stores = {}   # session_id -> MediaBlobStore
parse_jobs = {}
export_jobs = {}
PAGE_SIZE_SERVER = 200


def _cleanup_all_stores():
    """Destroy all media blob stores on interpreter exit."""
    for store in media_stores.values():
        try:
            store.destroy()
        except Exception:
            pass
    media_stores.clear()

atexit.register(_cleanup_all_stores)

# ---------------------------------------------------------------------------
# Cleanup helpers
# ---------------------------------------------------------------------------

def cleanup_old_sessions(keep_id=None):
    """Remove all sessions except keep_id to free memory."""
    for sid in list(sessions.keys()):
        if sid != keep_id:
            del sessions[sid]
            store = media_stores.pop(sid, None)
            if store:
                store.destroy()


def cleanup_stale_jobs():
    """Remove completed/errored parse and export jobs older than their usefulness."""
    for jid in list(parse_jobs.keys()):
        j = parse_jobs[jid]
        if j["status"] in ("done", "error"):
            parse_jobs.pop(jid, None)
    for jid in list(export_jobs.keys()):
        j = export_jobs[jid]
        if j["status"] in ("cancelled", "error"):
            if j.get("filepath"):
                try: os.unlink(j["filepath"])
                except OSError: pass
            export_jobs.pop(jid, None)


# ---------------------------------------------------------------------------
# XML Parsing
# ---------------------------------------------------------------------------

SMS_TYPES = {"1": "received", "2": "sent", "3": "draft", "4": "outbox", "5": "failed", "6": "queued"}
MMS_MSG_BOX = {"1": "received", "2": "sent", "3": "draft", "4": "outbox"}
CALL_TYPES = {"1": "incoming", "2": "outgoing", "3": "missed", "4": "voicemail", "5": "rejected", "6": "refused"}
ADDR_TYPES = {"129": "BCC", "130": "CC", "151": "To", "137": "From"}
MEDIA_PREFIXES = ("image/", "video/", "audio/", "application/ogg")


def ext_for_ct(ct):
    ct = ct.lower().split(";")[0].strip()
    m = {
        "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
        "image/webp": ".webp", "image/bmp": ".bmp",
        "video/mp4": ".mp4", "video/3gpp": ".3gp", "video/3gpp2": ".3g2",
        "video/mpeg": ".mpg", "video/webm": ".webm",
        "audio/mpeg": ".mp3", "audio/amr": ".amr", "audio/aac": ".aac",
        "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/3gpp": ".3gp",
        "application/ogg": ".ogg",
    }
    if ct in m: return m[ct]
    g = mimetypes.guess_extension(ct)
    return g if g else ".bin"


def media_category(ct):
    ct = ct.lower()
    if ct.startswith("image/"): return "image"
    if ct.startswith("video/"): return "video"
    if ct.startswith("audio/") or ct.startswith("application/ogg"): return "audio"
    return "other"


def java_ts_to_datetime(ts_str):
    try:
        ts = int(ts_str)
        return datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc).astimezone()
    except (ValueError, TypeError, OSError):
        return None


def parse_sms_attrib(a):
    dt = java_ts_to_datetime(a.get("date", "0"))
    return {
        "kind": "sms",
        "address": a.get("address", "Unknown"),
        "contact_name": a.get("contact_name", ""),
        "body": a.get("body", ""),
        "date_ts": int(a.get("date", "0")),
        "date_display": dt.strftime("%A, %b %d, %Y %I:%M %p") if dt else "",
        "type": SMS_TYPES.get(a.get("type", ""), a.get("type", "")),
        "read": a.get("read", "0") == "1",
    }


def parse_mms_elem(elem, media_list, blob_store):
    a = elem.attrib
    dt = java_ts_to_datetime(a.get("date", "0"))
    address = a.get("address", "Unknown")
    contact_name = a.get("contact_name", "")
    date_ts = int(a.get("date", "0"))
    date_display = dt.strftime("%A, %b %d, %Y %I:%M %p") if dt else ""

    text_parts = []
    msg_media_indices = []

    for part in elem.iter("part"):
        pa = part.attrib
        ct = pa.get("ct", "")
        text = pa.get("text", "")
        data_b64 = pa.get("data")
        part_name = pa.get("name", "") or pa.get("cl", "")

        if text and ct.lower().startswith("text/"):
            text_parts.append(text)
            continue

        if data_b64 and any(ct.lower().startswith(p) for p in MEDIA_PREFIXES):
            cat = media_category(ct)
            ext = ext_for_ct(ct)
            idx = len(media_list)

            # Store raw bytes on disk, keep only metadata in memory
            byte_size = blob_store.store(idx, data_b64)

            media_entry = {
                "idx": idx,
                "content_type": ct,
                "category": cat,
                "extension": ext,
                "name": sanitize_filename(part_name) if part_name else f"media_{idx}{ext}",
                "size": byte_size,
                "address": address,
                "contact_name": contact_name,
                "date_ts": date_ts,
                "date_display": date_display,
            }

            media_list.append(media_entry)
            msg_media_indices.append(idx)

    return {
        "kind": "mms",
        "address": address,
        "contact_name": contact_name,
        "body": " ".join(text_parts),
        "media_indices": msg_media_indices,  # NO images[] copy — frontend resolves via /stream
        "date_ts": date_ts,
        "date_display": date_display,
        "type": MMS_MSG_BOX.get(a.get("msg_box", ""), a.get("msg_box", "")),
        "read": a.get("read", "0") == "1",
    }


def parse_call_attrib(a):
    dt = java_ts_to_datetime(a.get("date", "0"))
    dur = int(a.get("duration", "0"))
    mins, secs = divmod(dur, 60)
    hrs, mins = divmod(mins, 60)
    dur_str = f"{hrs}h {mins}m {secs}s" if hrs else f"{mins}m {secs}s" if mins else f"{secs}s"
    return {
        "kind": "call",
        "number": a.get("number", "Unknown"),
        "contact_name": a.get("contact_name", ""),
        "duration": dur,
        "duration_display": dur_str,
        "date_ts": int(a.get("date", "0")),
        "date_display": dt.strftime("%A, %b %d, %Y %I:%M %p") if dt else "",
        "type": CALL_TYPES.get(a.get("type", ""), a.get("type", "")),
    }


class _ProgressFileWrapper:
    """Wraps a file to track how many bytes have been read."""
    __slots__ = ('_f', 'bytes_read')
    def __init__(self, f):
        self._f = f
        self.bytes_read = 0
    def read(self, size=-1):
        data = self._f.read(size)
        self.bytes_read += len(data)
        return data
    def close(self):
        self._f.close()


def extract_xml_from_zip(zip_path, password=None, job=None):
    """
    Extract the XML file from an encrypted/unencrypted ZIP, entirely in memory.
    Returns (xml_bytes, xml_filename) or raises an exception.
    The password is used only for decryption and is never stored or logged.
    If job dict is provided, updates job["extract_bytes_read"] and job["extract_total"] for progress.
    """
    pwd_bytes = password.encode("utf-8") if password else None

    def _read_chunked(zf, name, total_size, pwd=None):
        """Read a ZIP entry in chunks, reporting progress to the job dict."""
        chunks = []
        bytes_read = 0
        chunk_size = 256 * 1024  # 256KB chunks
        with zf.open(name, pwd=pwd) as entry:
            while True:
                chunk = entry.read(chunk_size)
                if not chunk:
                    break
                chunks.append(chunk)
                bytes_read += len(chunk)
                if job:
                    job["extract_bytes_read"] = bytes_read
                    job["extract_total"] = total_size
        return b"".join(chunks)

    def _find_xml(zf):
        xml_files = [n for n in zf.namelist() if n.lower().endswith(".xml")]
        if not xml_files:
            raise ValueError("No .xml file found inside the ZIP archive.")
        return xml_files[0]

    def _get_uncompressed_size(zf, name):
        info = zf.getinfo(name)
        return info.file_size if info.file_size > 0 else os.path.getsize(zip_path)

    # Try pyzipper first (supports AES-256, used by SMS Backup & Restore Pro)
    try:
        import pyzipper
        with pyzipper.AESZipFile(zip_path, "r") as zf:
            xml_name = _find_xml(zf)
            total = _get_uncompressed_size(zf, xml_name)
            if job:
                job["extract_total"] = total
            xml_bytes = _read_chunked(zf, xml_name, total, pwd=pwd_bytes)
            return xml_bytes, xml_name
    except ImportError:
        pass  # pyzipper not installed, try stdlib
    except RuntimeError as e:
        if "password" in str(e).lower() or "Bad password" in str(e):
            raise ValueError("Incorrect password.") from e
        raise

    # Fallback to built-in zipfile (supports legacy ZIP encryption only)
    try:
        import zipfile as zf_mod
        with zf_mod.ZipFile(zip_path, "r") as zf:
            xml_name = _find_xml(zf)
            total = _get_uncompressed_size(zf, xml_name)
            if job:
                job["extract_total"] = total
            try:
                xml_bytes = _read_chunked(zf, xml_name, total, pwd=pwd_bytes)
            except RuntimeError as e:
                if "password" in str(e).lower():
                    raise ValueError("Incorrect password.") from e
                if "AES" in str(e) or "compression type" in str(e).lower():
                    raise ValueError(
                        "This ZIP uses AES-256 encryption. "
                        "Install pyzipper to open it: pip install pyzipper"
                    ) from e
                raise
            return xml_bytes, xml_name
    except zf_mod.BadZipFile:
        raise ValueError("The file is not a valid ZIP archive.")


def stream_parse_backup(filepath_or_fileobj, job_id, file_size=None):
    """Parse XML from a file path or a file-like object (for in-memory ZIP extraction)."""
    job = parse_jobs[job_id]

    if isinstance(filepath_or_fileobj, str):
        # File path — open from disk
        file_size = os.path.getsize(filepath_or_fileobj)
        job["file_size"] = file_size
        job["bytes_read"] = 0
        raw_file = open(filepath_or_fileobj, "rb")
    else:
        # File-like object (BytesIO from ZIP extraction)
        job["file_size"] = file_size or 0
        job["bytes_read"] = 0
        raw_file = filepath_or_fileobj

    messages = []
    calls = []
    media_list = []
    blob_store = MediaBlobStore()
    stats = {"sms": 0, "mms": 0, "calls": 0}
    backup_type = None
    count = 0
    last_progress_time = 0

    try:
        pf = _ProgressFileWrapper(raw_file)
        try:
            context = ET.iterparse(pf, events=("start", "end"))
            context = iter(context)
            event, root = next(context)
            root_tag = root.tag.lower()

            if root_tag == "smses":
                backup_type = "messages"
            elif root_tag == "calls":
                backup_type = "calls"
            else:
                job["status"] = "error"
                job["error"] = f"Unrecognized root element: <{root.tag}>."
                pf.close()
                return

            current_mms = None
            mms_depth = 0

            for event, elem in context:
                # Progress update on every iteration — must be before any continue
                now = time.monotonic()
                if now - last_progress_time > 0.3:
                    job["progress"] = count
                    job["bytes_read"] = pf.bytes_read
                    job["stats"] = dict(stats)
                    job["media_count"] = len(media_list)
                    job["status"] = "parsing"
                    last_progress_time = now

                if event == "start":
                    tag = elem.tag.lower()
                    if tag == "mms" and backup_type == "messages":
                        current_mms = elem
                        mms_depth = 1
                    elif current_mms is not None:
                        mms_depth += 1
                    continue

                tag = elem.tag.lower()

                if current_mms is not None:
                    mms_depth -= 1
                    if tag == "mms" and mms_depth <= 0:
                        messages.append(parse_mms_elem(current_mms, media_list, blob_store))
                        stats["mms"] += 1
                        count += 1
                        current_mms.clear()
                        current_mms = None
                        mms_depth = 0
                    continue

                if backup_type == "messages" and tag == "sms":
                    messages.append(parse_sms_attrib(elem.attrib))
                    stats["sms"] += 1
                    count += 1
                    elem.clear()
                elif backup_type == "calls" and tag == "call":
                    calls.append(parse_call_attrib(elem.attrib))
                    stats["calls"] += 1
                    count += 1
                    elem.clear()
                else:
                    elem.clear()

                root.clear()

        finally:
            pf.close()

        # Sort
        job["status"] = "sorting"
        job["progress"] = count
        job["bytes_read"] = file_size
        job["stats"] = dict(stats)
        job["media_count"] = len(media_list)
        if messages:
            messages.sort(key=lambda m: m["date_ts"])
        if calls:
            calls.sort(key=lambda c: c["date_ts"])

        # === BUILD INDEXES ===
        # messages_by_address: {address: [msg, msg, ...]} — sorted by date_ts
        messages_by_address = defaultdict(list)
        for msg in messages:
            messages_by_address[msg["address"]].append(msg)

        # media_by_address: {address: [media_entry, ...]}
        media_by_address = defaultdict(list)
        for m in media_list:
            media_by_address[m["address"]].append(m)

        # Per-conversation media counts
        conv_media_counts = defaultdict(lambda: {"total": 0, "image": 0, "video": 0, "audio": 0})
        for m in media_list:
            addr = m["address"]
            conv_media_counts[addr]["total"] += 1
            conv_media_counts[addr][m["category"]] = conv_media_counts[addr].get(m["category"], 0) + 1

        conv_list = []
        for addr, msgs in messages_by_address.items():
            name = next((m.get("contact_name") for m in msgs[:5] if m.get("contact_name")), "")
            last = msgs[-1]
            conv_list.append({
                "address": addr, "contact_name": name,
                "display_name": name or addr, "count": len(msgs),
                "last_date": last["date_display"], "last_date_ts": last["date_ts"],
                "media_count": conv_media_counts[addr]["total"],
                "media_stats": dict(conv_media_counts[addr]),
            })
        conv_list.sort(key=lambda c: c["last_date_ts"], reverse=True)

        media_stats = {"total": len(media_list), "image": 0, "video": 0, "audio": 0, "other": 0}
        for m in media_list:
            media_stats[m["category"]] = media_stats.get(m["category"], 0) + 1

        # Clean up old sessions before storing new one
        cleanup_old_sessions()
        cleanup_stale_jobs()

        session_id = str(uuid.uuid4())
        sessions[session_id] = {
            "stats": stats, "conversations": conv_list,
            "messages_by_address": dict(messages_by_address),
            "calls": calls,
            "media": media_list, "media_by_address": dict(media_by_address),
            "media_stats": media_stats,
            "backup_type": backup_type, "backup_count": count,
        }
        media_stores[session_id] = blob_store

        job["status"] = "done"
        job["progress"] = count
        job["session_id"] = session_id

    except ET.ParseError as e:
        blob_store.destroy()
        job["status"] = "error"
        job["error"] = f"XML parse error: {e}"
    except Exception as e:
        blob_store.destroy()
        job["status"] = "error"
        job["error"] = f"Unexpected error: {e}"





# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/start_parse", methods=["POST"])
def start_parse():
    data = request.get_json(force=True)
    filepath = data.get("filepath", "").strip()
    password = data.get("password", "").strip() or None

    if not filepath:
        return jsonify({"error": "No file path provided"}), 400
    filepath = os.path.expanduser(filepath)
    if not os.path.isfile(filepath):
        return jsonify({"error": "File not found. Check the path and try again."}), 400

    ext = filepath.lower().rsplit(".", 1)[-1] if "." in filepath else ""
    if ext not in ("xml", "zip"):
        return jsonify({"error": "File must be an .xml or .zip backup file."}), 400

    file_size = os.path.getsize(filepath)
    job_id = str(uuid.uuid4())
    parse_jobs[job_id] = {"status": "starting", "progress": 0, "bytes_read": 0, "error": None, "session_id": None, "file_size": file_size, "extract_bytes_read": 0, "extract_total": 0}

    def run():
        job = parse_jobs[job_id]
        try:
            if ext == "zip":
                # Extract XML from ZIP in memory — never written to disk unencrypted
                job["status"] = "extracting"
                xml_bytes, xml_name = extract_xml_from_zip(filepath, password, job=job)
                xml_size = len(xml_bytes)
                job["file_size"] = xml_size
                # Parse from in-memory bytes
                stream_parse_backup(io.BytesIO(xml_bytes), job_id, file_size=xml_size)
                # Clear the decrypted bytes from memory
                del xml_bytes
            else:
                # Parse XML directly from disk
                stream_parse_backup(filepath, job_id)
        except ValueError as e:
            job["status"] = "error"
            job["error"] = str(e)
        except Exception as e:
            job["status"] = "error"
            job["error"] = f"Failed to process file: {e}"

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"job_id": job_id, "file_size": file_size})


@app.route("/job_status/<job_id>")
def job_status(job_id):
    job = parse_jobs.get(job_id)
    if not job: return jsonify({"error": "Unknown job"}), 404
    return jsonify(job)


@app.route("/session/<session_id>")
def get_session(session_id):
    s = sessions.get(session_id)
    if not s: return jsonify({"error": "Session not found"}), 404
    return jsonify({
        "stats": s["stats"], "conversations": s["conversations"],
        "backup_type": s["backup_type"], "backup_count": s["backup_count"],
        "media_stats": s.get("media_stats", {}),
        "calls_page": s["calls"][:PAGE_SIZE_SERVER] if s["backup_type"] == "calls" else [],
    })


@app.route("/session/<session_id>/messages")
def get_messages(session_id):
    s = sessions.get(session_id)
    if not s: return jsonify({"error": "Session not found"}), 404
    address = request.args.get("address", "")
    page = safe_int(request.args.get("page", 1))
    page_size = min(safe_int(request.args.get("page_size", PAGE_SIZE_SERVER)), 1000)
    sort = request.args.get("sort", "newest")
    search = request.args.get("search", "").lower().strip()

    # O(1) lookup via pre-built index
    msgs = s["messages_by_address"].get(address, [])
    if search:
        msgs = [m for m in msgs if search in (m.get("body") or "").lower()]

    total = len(msgs)

    # Reverse pagination without copying: compute slice from the end
    if sort == "newest":
        # msgs is sorted oldest-first; we want newest-first page
        end = total - (page - 1) * page_size
        start = max(0, end - page_size)
        page_msgs = list(reversed(msgs[start:end]))
    else:
        start = (page - 1) * page_size
        page_msgs = msgs[start:start + page_size]

    return jsonify({"messages": page_msgs, "total": total, "page": page})


@app.route("/session/<session_id>/calls")
def get_calls(session_id):
    s = sessions.get(session_id)
    if not s: return jsonify({"error": "Session not found"}), 404
    page = safe_int(request.args.get("page", 1))
    page_size = min(safe_int(request.args.get("page_size", PAGE_SIZE_SERVER)), 1000)
    sort = request.args.get("sort", "newest")
    call_type = request.args.get("type", "")

    calls = s["calls"]
    if call_type:
        calls = [c for c in calls if c["type"] == call_type]

    total = len(calls)
    if sort == "newest":
        end = total - (page - 1) * page_size
        start = max(0, end - page_size)
        page_calls = list(reversed(calls[start:end]))
    else:
        start = (page - 1) * page_size
        page_calls = calls[start:start + page_size]

    return jsonify({"calls": page_calls, "total": total, "page": page})


@app.route("/session/<session_id>/media")
def get_media(session_id):
    s = sessions.get(session_id)
    if not s: return jsonify({"error": "Session not found"}), 404

    page = safe_int(request.args.get("page", 1))
    page_size = min(safe_int(request.args.get("page_size", 60)), 200)
    sort = request.args.get("sort", "newest")
    category = request.args.get("category", "")
    address = request.args.get("address", "")

    # Select base list (already sorted by date_ts ascending)
    if address:
        base = s.get("media_by_address", {}).get(address, [])
    else:
        base = s.get("media", [])
    if category:
        base = [m for m in base if m["category"] == category]

    total = len(base)

    # For date sorts on unfiltered data, use reverse pagination (no copy)
    if sort == "newest" and not category:
        end = total - (page - 1) * page_size
        start = max(0, end - page_size)
        page_items = list(reversed(base[start:end]))
    elif sort == "oldest" and not category:
        start = (page - 1) * page_size
        page_items = base[start:start + page_size]
    else:
        # For other sorts or filtered data, sort a copy
        # Use a cache key to avoid re-sorting on pagination (Load More)
        cache_key = f"_media_sorted_{sort}_{category}_{address}"
        cached = s.get(cache_key)
        if cached is None or len(cached) != total:
            SORT_KEYS = {
                "newest": (lambda m: m["date_ts"], True),
                "oldest": (lambda m: m["date_ts"], False),
                "name_asc": (lambda m: m.get("name", "").lower(), False),
                "name_desc": (lambda m: m.get("name", "").lower(), True),
                "type_asc": (lambda m: m.get("category", ""), False),
                "size_desc": (lambda m: m.get("size", 0), True),
                "size_asc": (lambda m: m.get("size", 0), False),
                "address_asc": (lambda m: (m.get("contact_name") or m.get("address", "")).lower(), False),
            }
            key_fn, reverse = SORT_KEYS.get(sort, (lambda m: m["date_ts"], True))
            cached = sorted(base, key=key_fn, reverse=reverse)
            s[cache_key] = cached
        start = (page - 1) * page_size
        page_items = cached[start:start + page_size]

    result = list(page_items)
    return jsonify({"items": result, "total": total, "page": page})


@app.route("/session/<session_id>/media/<int:media_idx>/download")
def download_media(session_id, media_idx):
    s = sessions.get(session_id)
    if not s: return jsonify({"error": "Session not found"}), 404
    media = s.get("media", [])
    if media_idx < 0 or media_idx >= len(media):
        return jsonify({"error": "Media not found"}), 404
    store = media_stores.get(session_id)
    if not store: return jsonify({"error": "Media store not found"}), 404
    item = media[media_idx]
    raw = store.get_blob(media_idx)
    if raw is None: return jsonify({"error": "Media data not found"}), 404
    safe_name = sanitize_filename(item.get("name", f"media_{media_idx}{item['extension']}"))
    safe_ct = sanitize_content_type(item["content_type"])
    return Response(raw, mimetype=safe_ct, headers={
        "Content-Disposition": f'attachment; filename="{safe_name}"',
        "Content-Length": str(len(raw)),
    })


@app.route("/session/<session_id>/media/<int:media_idx>/stream")
def stream_media(session_id, media_idx):
    s = sessions.get(session_id)
    if not s: return jsonify({"error": "Session not found"}), 404
    media = s.get("media", [])
    if media_idx < 0 or media_idx >= len(media):
        return jsonify({"error": "Media not found"}), 404
    store = media_stores.get(session_id)
    if not store: return jsonify({"error": "Media store not found"}), 404
    item = media[media_idx]
    raw = store.get_blob(media_idx)
    if raw is None: return jsonify({"error": "Media data not found"}), 404
    safe_name = sanitize_filename(item.get("name", f"media_{media_idx}{item['extension']}"))
    safe_ct = sanitize_content_type(item["content_type"])
    return Response(raw, mimetype=safe_ct, headers={
        "Content-Disposition": f'inline; filename="{safe_name}"',
        "Content-Length": str(len(raw)),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
    })


@app.route("/session/<session_id>/media/<int:media_idx>/info")
def media_info(session_id, media_idx):
    """Return media metadata without the raw binary data."""
    s = sessions.get(session_id)
    if not s: return jsonify({"error": "Session not found"}), 404
    media = s.get("media", [])
    if media_idx < 0 or media_idx >= len(media):
        return jsonify({"error": "Media not found"}), 404
    item = media[media_idx]
    return jsonify(item)


# === EXPORT ROUTES (job-based with cancellation) ===

@app.route("/session/<session_id>/export_media_zip", methods=["POST"])
def start_export_media_zip(session_id):
    s = sessions.get(session_id)
    if not s: return jsonify({"error": "Session not found"}), 404
    data = request.get_json(force=True) if request.is_json else {}
    category = data.get("category", "")
    address = data.get("address", "")

    if address:
        media = s.get("media_by_address", {}).get(address, [])
    else:
        media = s.get("media", [])
    if category:
        media = [m for m in media if m["category"] == category]
    if not media:
        return jsonify({"error": "No media to export"}), 404

    job_id = str(uuid.uuid4())
    export_jobs[job_id] = {"status": "starting", "progress": 0, "total": len(media), "error": None, "filepath": None, "filename": None, "size": 0, "cancelled": False}

    store = media_stores.get(session_id)

    def build_zip():
        job = export_jobs[job_id]
        out_path = None
        try:
            dl_folder = _get_downloads_folder()
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            label = f"media_{category}" if category else ("media_" + (address.replace("+", "") if address else "all"))
            filename = f"{label}_export_{timestamp}.zip"
            out_path = os.path.join(dl_folder, filename)
            with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
                used_names = {}
                for i, m in enumerate(media):
                    if job["cancelled"]: break
                    contact = m.get("contact_name") or m.get("address", "unknown")
                    contact = "".join(c if c.isalnum() or c in " _-" else "_" for c in contact).strip()
                    name = m.get("name", f"media_{m['idx']}{m['extension']}")
                    full_path = f"{m['category']}/{contact}/{name}"
                    if full_path in used_names:
                        used_names[full_path] += 1
                        base, ext = os.path.splitext(name)
                        full_path = f"{m['category']}/{contact}/{base}_{used_names[full_path]}{ext}"
                    else:
                        used_names[full_path] = 0
                    try:
                        raw = store.get_blob(m["idx"]) if store else None
                        if raw:
                            zf.writestr(full_path, raw)
                    except Exception: pass
                    job["progress"] = i + 1
                    job["status"] = "building"
            if job["cancelled"]:
                job["status"] = "cancelled"
                try: os.unlink(out_path)
                except OSError: pass
                return
            job["filepath"] = out_path
            job["filename"] = filename
            job["size"] = os.path.getsize(out_path)
            job["status"] = "done"
        except Exception as e:
            job["status"] = "error"; job["error"] = str(e)
            if out_path:
                try: os.unlink(out_path)
                except OSError: pass

    threading.Thread(target=build_zip, daemon=True).start()
    return jsonify({"job_id": job_id, "total": len(media)})


@app.route("/session/<session_id>/export_csv", methods=["POST"])
def start_export_csv(session_id):
    s = sessions.get(session_id)
    if not s: return jsonify({"error": "Session not found"}), 404

    job_id = str(uuid.uuid4())
    is_messages = s["backup_type"] == "messages"
    # Flatten messages_by_address for CSV export
    all_msgs = []
    if is_messages:
        for addr_msgs in s["messages_by_address"].values():
            all_msgs.extend(addr_msgs)
        all_msgs.sort(key=lambda m: m["date_ts"])
    total = len(all_msgs) if is_messages else len(s["calls"])
    export_jobs[job_id] = {"status": "starting", "progress": 0, "total": total, "error": None, "filepath": None, "filename": None, "size": 0, "cancelled": False}

    def build_csv():
        job = export_jobs[job_id]
        out_path = None
        try:
            dl_folder = _get_downloads_folder()
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"backup_export_{timestamp}.csv"
            out_path = os.path.join(dl_folder, filename)
            with open(out_path, "w", encoding="utf-8", newline="") as f:
                if is_messages:
                    f.write("Type,Address,Contact,Date,Direction,Body\n")
                    for i, m in enumerate(all_msgs):
                        if job["cancelled"]: break
                        body = csv_safe((m.get("body") or "")).replace('"', '""')
                        f.write(f'{csv_safe(m["kind"])},"{csv_safe(m["address"])}","{csv_safe(m.get("contact_name", ""))}","{csv_safe(m["date_display"])}","{csv_safe(m["type"])}","{body}"\n')
                        if i % 500 == 0: job["progress"] = i + 1; job["status"] = "building"
                else:
                    f.write("Number,Contact,Date,Type,Duration\n")
                    for i, c in enumerate(s["calls"]):
                        if job["cancelled"]: break
                        f.write(f'"{csv_safe(c["number"])}","{csv_safe(c.get("contact_name", ""))}","{csv_safe(c["date_display"])}","{csv_safe(c["type"])}","{csv_safe(c["duration_display"])}"\n')
                        if i % 500 == 0: job["progress"] = i + 1; job["status"] = "building"
            if job["cancelled"]:
                job["status"] = "cancelled"
                try: os.unlink(out_path)
                except OSError: pass
                return
            job["progress"] = total
            job["filepath"] = out_path; job["filename"] = filename
            job["size"] = os.path.getsize(out_path); job["status"] = "done"
        except Exception as e:
            job["status"] = "error"; job["error"] = str(e)
            if out_path:
                try: os.unlink(out_path)
                except OSError: pass

    threading.Thread(target=build_csv, daemon=True).start()
    return jsonify({"job_id": job_id, "total": total})


@app.route("/export_job/<job_id>")
def export_job_status(job_id):
    job = export_jobs.get(job_id)
    if not job: return jsonify({"error": "Unknown job"}), 404
    return jsonify({"status": job["status"], "progress": job["progress"], "total": job["total"], "error": job["error"], "filename": job["filename"], "size": job.get("size", 0)})


@app.route("/export_job/<job_id>/cancel", methods=["POST"])
def export_job_cancel(job_id):
    job = export_jobs.get(job_id)
    if not job: return jsonify({"error": "Unknown job"}), 404
    if job["status"] in ("done", "cancelled", "error"):
        return jsonify({"status": job["status"]})
    job["cancelled"] = True
    return jsonify({"status": "cancelling"})


@app.route("/export_job/<job_id>/download")
def export_job_download(job_id):
    job = export_jobs.get(job_id)
    if not job or job["status"] != "done":
        return jsonify({"error": "Export not ready"}), 404
    filepath = job["filepath"]
    filename = job["filename"] or "export"
    def stream_file():
        with open(filepath, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk: break
                yield chunk
        export_jobs.pop(job_id, None)
    mimetype = "application/zip" if filename.endswith(".zip") else "text/csv"
    return Response(stream_with_context(stream_file()), mimetype=mimetype,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"', "Content-Length": str(job.get("size", 0))})


@app.errorhandler(404)
def not_found(e): return jsonify({"error": "Not found"}), 404
@app.errorhandler(500)
def server_error(e): return jsonify({"error": "Internal server error"}), 500


# ---------------------------------------------------------------------------
# Security headers on every response
# ---------------------------------------------------------------------------

@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "0"  # modern browsers: use CSP instead
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    # CSP: allow self, data: URIs for images (thumbnails), block everything else
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self'; "
        "media-src 'self'; "
        "font-src 'self'; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    )
    # Prevent caching of sensitive data
    if "text/html" in response.content_type or "application/json" in response.content_type:
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
        response.headers["Pragma"] = "no-cache"
    return response


def main():
    parser = argparse.ArgumentParser(description="SMS Backup Viewer")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    # Security warning for non-localhost binding
    if args.host != "127.0.0.1":
        print(f"\n{'!'*60}")
        print(f"  WARNING: Binding to {args.host}")
        print(f"  This exposes ALL SMS data, call logs, and media")
        print(f"  to anyone on your network. There is NO authentication.")
        print(f"  Only use this if you understand the risk.")
        print(f"{'!'*60}\n")

    print(f"\n{'='*52}\n  SMS Backup Viewer\n  Open http://{args.host}:{args.port}\n  Press Ctrl+C to quit\n{'='*52}\n")
    app.run(host=args.host, port=args.port, debug=args.debug)

if __name__ == "__main__":
    main()
