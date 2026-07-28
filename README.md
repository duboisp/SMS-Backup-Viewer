# SMS Backup Viewer

A fast, privacy-first, offline viewer for **SMS Backup & Restore** XML backup files.
All processing happens locally on your machine — no uploads, no internet required, no waiting.

This personal project was born out of frustration with how slow the official web-based SMS Backup & Restore viewer becomes when handling backups that are GBs large. Built in conjunction with [Claude Code](https://claude.ai/code), the core priorities are speed, local-only processing, and ensuring your private data never leaves your machine.

## Download

Go to the [Releases](https://github.com/McGravyLicious/SMS-Backup-Viewer/releases) page and download the latest `.exe` file.

No installation needed — just download, double-click, and run.

## How to Use

1. **Download** the `.exe` from the [latest release](https://github.com/McGravyLicious/SMS-Backup-Viewer/releases/latest)
2. **Run** the `.exe` — a window opens with the SMS Backup Viewer
3. **Open your backup** — enter the path to your `.xml` or encrypted `.zip` file and click **Open**
4. **Browse your messages** — select a conversation from the sidebar to view messages

### How to build and run localy

1. **Add** your backup files into the folder `user_data`
2. **Run** `docker compose up`
3. **Navigate** to `http://localhost:5000`
4. **Open your backup** — enter the base path `/user_data/` followed by your `.xml` or encrypted `.zip` file and click **Open**
5. **Browse your messages** — select a conversation from the sidebar to view messages

### Supported Files

- `.xml` — SMS Backup & Restore backup files (messages or call logs)
- `.zip` — Password-encrypted backups (AES-256 supported). You'll be prompted for the password.

### Features

- **Messages** — View SMS and MMS in a chat-style bubble layout with sent/received styling
- **Call Logs** — Browse incoming, outgoing, missed, and voicemail calls with duration and timestamps
- **Media Gallery** — View all images, videos, and audio from MMS messages, grouped by month
- **Search** — Search within conversations with match highlighting
- **Media Browsing** — Filter and sort media by type, contact, date, name, or size
- **Export to CSV** — Export all messages or calls to a CSV file, saved to your Downloads folder
- **Export Media ZIP** — Export media files as a ZIP archive, organized by type and contact
- **Light & Dark Mode** — Toggle between themes, or let it follow your system preference
- **Scalable UI** — Zoom the interface from 50% to 200%
- **Large File Support** — Handles backup files up to 10 GB+ via streaming XML parsing, far faster than the web-based viewer

## Privacy & Security

Privacy was a core motivation for building this app locally rather than relying on a web-based tool. Your data never leaves your machine.

- **No internet required** — the app runs entirely offline with no network requests
- **No uploads** — reads files directly from disk via file path
- **No telemetry** — no analytics, tracking, or phone-home behavior
- **No installation** — runs as a standalone portable executable
- **Localhost only** — internal server binds to `127.0.0.1` (loopback only)
- **Secure XML parsing** — uses defusedxml to block XXE and billion laughs attacks
- **Password never stored** — ZIP decryption password is used once and discarded
- **Self-hosted fonts** — no external CDN requests, all fonts bundled in the app
- **Security headers** — CSP, X-Content-Type-Options, X-Frame-Options on every response
- **CSV injection protection** — dangerous characters are sanitized in exports

## Screenshots

<img width="1166" height="814" alt="image" src="https://github.com/user-attachments/assets/73f64e18-cf0d-4e9d-a03c-9e015784ecbf" />

**SMS/MMS Viewer**
<img width="1330" height="875" alt="image" src="https://github.com/user-attachments/assets/d98544d4-bbe3-4a97-b062-4eca9a50b428" />

**Media Gallery**
<img width="1330" height="875" alt="image" src="https://github.com/user-attachments/assets/fe1a7cc4-c36f-4e28-8325-cf911228bb7d" />

**Call Log Viewer**
<img width="1330" height="875" alt="image" src="https://github.com/user-attachments/assets/ef428f20-e20f-4eef-9957-2ac25936fbc4" />

## License

This project is provided as-is for personal use.
