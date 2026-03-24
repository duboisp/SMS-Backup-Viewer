"""
MediaBlobStore — Disk-backed storage for MMS media blobs.

Stores decoded binary media in a per-session SQLite database inside a
temporary directory.  Only lightweight metadata stays in RAM; the actual
bytes live on disk and are read on demand.

Security / privacy:
  - Temp directory is user-scoped (%TEMP% on Windows, mode 0o700 on Unix).
  - destroy() removes the entire temp directory (DB + WAL/SHM files).
  - An atexit handler in app.py ensures cleanup on normal exit.
"""

import base64
import os
import shutil
import sqlite3
import tempfile
import threading


class MediaBlobStore:
    """Per-session SQLite store for media binary blobs."""

    def __init__(self):
        self._tmpdir = tempfile.mkdtemp(prefix="sms_viewer_")
        db_path = os.path.join(self._tmpdir, "media.db")
        self._db_path = db_path
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()

        # Performance pragmas for write-heavy parsing phase
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA temp_store=MEMORY")
        self._conn.execute("PRAGMA cache_size=-8192")  # 8 MB page cache

        self._conn.execute(
            "CREATE TABLE blobs ("
            "  media_idx INTEGER PRIMARY KEY,"
            "  data BLOB NOT NULL"
            ")"
        )
        self._conn.commit()

    # ------------------------------------------------------------------
    # Write (used during parsing)
    # ------------------------------------------------------------------

    def store(self, media_idx, data_b64):
        """Decode base64, insert raw bytes, return the decoded byte size."""
        raw = base64.b64decode(data_b64)
        byte_size = len(raw)
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO blobs (media_idx, data) VALUES (?, ?)",
                (media_idx, raw),
            )
            self._conn.commit()
        return byte_size

    # ------------------------------------------------------------------
    # Read (used by /stream, /download, ZIP export)
    # ------------------------------------------------------------------

    def get_blob(self, media_idx):
        """Return raw bytes for the given index, or None if missing."""
        with self._lock:
            cur = self._conn.execute(
                "SELECT data FROM blobs WHERE media_idx = ?", (media_idx,)
            )
            row = cur.fetchone()
        return row[0] if row else None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def destroy(self):
        """Close the database and delete the temp directory."""
        try:
            self._conn.close()
        except Exception:
            pass
        try:
            shutil.rmtree(self._tmpdir, ignore_errors=True)
        except Exception:
            pass
