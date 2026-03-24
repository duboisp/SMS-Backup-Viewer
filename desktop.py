#!/usr/bin/env python3
"""
SMS Backup Viewer — Desktop Application
Runs the Flask backend in a background thread and opens a native window
using pywebview (EdgeWebView2 on Windows, WebKit on macOS/Linux).

The native window provides a file browser dialog that returns real file paths
directly to the frontend — no upload, no copy, no temp files.

Usage:
    python desktop.py [--port PORT]

Build standalone exe:
    build.bat (Windows)
"""

import argparse
import os
import socket
import sys
import threading
import time

# When frozen by PyInstaller, app.py is bundled via --add-data into a temp dir.
# We need to add that directory to sys.path so "from app import app" works.
if getattr(sys, 'frozen', False):
    bundle_dir = sys._MEIPASS
    if bundle_dir not in sys.path:
        sys.path.insert(0, bundle_dir)


def find_free_port(start=5000):
    """Find a free port starting from the given number."""
    for port in range(start, start + 100):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue
    return start


def start_server(app, port):
    """Start Flask in a background thread on localhost only."""
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)

    app.run(
        host="127.0.0.1",
        port=port,
        debug=False,
        use_reloader=False,
        threaded=True,
    )


def wait_for_server(port, timeout=10):
    """Wait until the Flask server is accepting connections."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                s.connect(("127.0.0.1", port))
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.1)
    return False


class Api:
    """
    Python API exposed to JavaScript via pywebview.
    Calls are made from the frontend as: await window.pywebview.api.method_name()
    """

    def __init__(self, window):
        self._window = window

    def browse_file(self):
        """
        Open the native OS file dialog and return the selected file path.
        Returns the full path string, or empty string if cancelled.
        No file data is read or copied — only the path is returned.
        """
        file_types = ('Backup Files (*.xml;*.zip)', 'XML Files (*.xml)', 'ZIP Files (*.zip)', 'All Files (*.*)')
        result = self._window.create_file_dialog(
            dialog_type=webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=file_types,
        )
        if result and len(result) > 0:
            return result[0]
        return ""

    def is_desktop(self):
        """Let the frontend know it's running in desktop mode."""
        return True


def main():
    parser = argparse.ArgumentParser(description="SMS Backup Viewer — Desktop")
    parser.add_argument("--port", type=int, default=0, help="Port (0 = auto-find free port)")
    args = parser.parse_args()

    from app import app

    port = args.port if args.port > 0 else find_free_port()

    server_thread = threading.Thread(
        target=start_server,
        args=(app, port),
        daemon=True,
    )
    server_thread.start()

    if not wait_for_server(port):
        print("ERROR: Server failed to start within 10 seconds.")
        sys.exit(1)

    try:
        global webview
        import webview
    except ImportError:
        print("ERROR: pywebview is not installed.")
        print("  Install it with: pip install pywebview")
        print()
        print(f"  In the meantime, open http://127.0.0.1:{port} in your browser.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        sys.exit(1)

    window = webview.create_window(
        title="SMS Backup Viewer",
        url=f"http://127.0.0.1:{port}",
        width=1200,
        height=800,
        min_size=(800, 500),
        resizable=True,
        text_select=True,
    )

    # Attach the API after window creation
    api = Api(window)
    window.expose(api.browse_file, api.is_desktop)

    webview.start(
        gui=None,
        debug=False,
    )


if __name__ == "__main__":
    main()
