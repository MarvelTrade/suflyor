#!/usr/bin/env python3
"""Суфлёр-рекордер: локальный сервер. Только стандартная библиотека + ffmpeg.

С этого Мака (127.0.0.1) доступно всё. Из локальной сети — только страница
пульта и её API, и только с секретным ключом из QR-кода.
"""
import json, os, re, secrets, socket, subprocess, sys, threading, time, shutil, queue
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

HOST = os.environ.get("SUFLYOR_HOST", "0.0.0.0")
PORT = int(os.environ.get("SUFLYOR_PORT", "8917"))
APP_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.expanduser(os.environ.get("SUFLYOR_OUT", "~/Movies/Суфлёр"))
SCRIPTS_DIR = os.path.expanduser(os.environ.get("SUFLYOR_SCRIPTS", os.path.join(OUT_DIR, "Сценарии")))
RAW_DIR = os.path.join(OUT_DIR, "исходники")
LOG_FILE = os.path.join(OUT_DIR, "суфлёр.log")
def _find_ffmpeg():
    for candidate in (
        os.path.join(APP_DIR, "bin", "ffmpeg"),
        os.path.join(os.path.dirname(APP_DIR), "bin", "ffmpeg"),
        shutil.which("ffmpeg"),
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
    ):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "/opt/homebrew/bin/ffmpeg"


FFMPEG = _find_ffmpeg()

os.makedirs(RAW_DIR, exist_ok=True)
_bundled = os.path.join(APP_DIR, "scripts")
if not os.path.isdir(SCRIPTS_DIR) and os.path.isdir(_bundled):
    shutil.copytree(_bundled, SCRIPTS_DIR)
os.makedirs(SCRIPTS_DIR, exist_ok=True)

# ключ пульта живёт в файле, чтобы закладка на телефоне не протухала
_token_file = os.path.join(OUT_DIR, ".remote_key")
try:
    TOKEN = open(_token_file).read().strip()
except OSError:
    TOKEN = ""
if not TOKEN:
    TOKEN = secrets.token_urlsafe(9)
    with open(_token_file, "w") as fh:
        fh.write(TOKEN)

STATE = {"json": b"{}"}          # последнее состояние от окна суфлёра
LISTENERS = []                   # очереди SSE-подписчиков (окно суфлёра)
LISTENERS_LOCK = threading.Lock()
HTTPD = None


def lan_ip():
    # сначала Wi-Fi/Ethernet: маршрут по умолчанию может идти через VPN
    for iface in ("en0", "en1", "en2"):
        try:
            ip = subprocess.run(["ipconfig", "getifaddr", iface], capture_output=True, text=True, timeout=2).stdout.strip()
            if ip:
                return ip
        except Exception:
            pass
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))   # пакеты не отправляются
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def broadcast(obj):
    data = json.dumps(obj, ensure_ascii=False)
    with LISTENERS_LOCK:
        for q in LISTENERS:
            q.put(data)


def log(msg):
    with open(LOG_FILE, "a", encoding="utf-8") as fh:
        fh.write(time.strftime("%H:%M:%S ") + msg + "\n")


def safe_name(name, default="take"):
    name = re.sub(r"[^\w\-. ]+", "_", name or "", flags=re.UNICODE).strip(" ._")
    return name[:80] or default


def encode_vertical(src, dst):
    """Центральный кроп в 9:16, 1080x1920, H.264 (аппаратный на Apple Silicon), AAC."""
    vf = ("crop=trunc(min(iw\\,ih*9/16)/2)*2:trunc(min(ih\\,iw*16/9)/2)*2,"
          "scale=1080:1920:flags=lanczos,setsar=1,fps=30")
    base = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vf", vf]
    tail = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", dst]
    hw = base + ["-c:v", "h264_videotoolbox", "-b:v", "14M", "-profile:v", "high"] + tail
    sw = base + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"] + tail
    r = subprocess.run(hw, capture_output=True, text=True)
    if r.returncode != 0:
        r = subprocess.run(sw, capture_output=True, text=True)
    return r


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(APP_DIR, "web"), **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---------- helpers ----------
    @property
    def is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def _url(self):
        path = self.path
        try:
            path = path.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
        u = urlparse(path)
        return u, parse_qs(u.query)

    def _authed(self, q):
        return self.is_local or secrets.compare_digest(q.get("k", [""])[0], TOKEN)

    def _json(self, obj, code=200):
        data = obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _deny(self):
        self._json({"error": "forbidden"}, 403)

    # ---------- GET ----------
    def do_GET(self):
        u, q = self._url()
        if u.path in ("/remote", "/remote.html"):
            self.path = "/remote.html"
            return super().do_GET()
        if u.path == "/api/state":
            return self._json(STATE["json"]) if self._authed(q) else self._deny()
        if not self.is_local:
            return self._deny()

        if u.path == "/api/scripts":
            items = []
            for f in sorted(os.listdir(SCRIPTS_DIR)):
                if f.lower().endswith((".txt", ".md")):
                    with open(os.path.join(SCRIPTS_DIR, f), encoding="utf-8") as fh:
                        items.append({"file": f, "text": fh.read()})
            return self._json({"scripts": items})
        if u.path == "/api/takes":
            items = []
            try:
                for f in os.listdir(OUT_DIR):
                    if f.lower().endswith((".mp4", ".mov", ".webm")):
                        full = os.path.join(OUT_DIR, f)
                        if os.path.isfile(full):
                            items.append({"file": full, "name": f, "mtime": os.path.getmtime(full)})
                items.sort(key=lambda x: x["mtime"], reverse=True)
            except OSError:
                pass
            return self._json({"takes": items[:10]})
        if u.path == "/api/info":
            return self._json({"out": OUT_DIR, "scripts": SCRIPTS_DIR, "ffmpeg": os.path.isfile(FFMPEG)})
        if u.path == "/api/remote-info":
            return self._json({"url": f"http://{lan_ip()}:{PORT}/remote?k={TOKEN}"})
        if u.path == "/api/events":
            return self._sse()
        return super().do_GET()

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = queue.Queue()
        with LISTENERS_LOCK:
            LISTENERS.append(q)
        try:
            self.wfile.write(b": hello\n\n"); self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f"data: {msg}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with LISTENERS_LOCK:
                LISTENERS.remove(q)

    # ---------- POST ----------
    def do_POST(self):
        u, q = self._url()
        if u.path == "/api/cmd":
            if not self._authed(q):
                return self._deny()
            cmd = json.loads(self._body() or b"{}")
            broadcast(cmd)
            return self._json({"ok": True, "listeners": len(LISTENERS)})
        if not self.is_local:
            return self._deny()

        if u.path == "/api/state":
            STATE["json"] = self._body() or b"{}"
            return self._json({"ok": True})

        if u.path == "/api/log":
            log("[страница] " + self._body().decode("utf-8", "replace")[:2000])
            return self._json({"ok": True})

        if u.path == "/api/shutdown":
            self._json({"ok": True})
            threading.Thread(target=HTTPD.shutdown, daemon=True).start()
            return

        if u.path == "/api/scripts":
            d = json.loads(self._body() or b"{}")
            fname = safe_name(d.get("file") or d.get("name"), "script")
            if not fname.lower().endswith((".txt", ".md")):
                fname += ".txt"
            with open(os.path.join(SCRIPTS_DIR, fname), "w", encoding="utf-8") as fh:
                fh.write(d.get("text", ""))
            return self._json({"ok": True, "file": fname})

        if u.path == "/api/upload":
            ext = "mp4" if q.get("ext", ["webm"])[0] == "mp4" else "webm"
            stem = time.strftime("%Y-%m-%d_%H-%M-%S") + "_" + safe_name(q.get("name", [""])[0])
            raw = os.path.join(RAW_DIR, stem + "." + ext)
            remaining = int(self.headers.get("Content-Length") or 0)
            with open(raw, "wb") as fh:
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    fh.write(chunk)
                    remaining -= len(chunk)
            out = os.path.join(OUT_DIR, stem + "_9x16.mp4")
            r = encode_vertical(raw, out)
            if r.returncode != 0:
                log("ffmpeg: " + r.stderr[-800:])
                return self._json({"ok": False, "raw": raw, "error": r.stderr[-800:]}, 500)
            log("сохранён " + out)
            return self._json({"ok": True, "file": out, "raw": raw})

        if u.path == "/api/delete-script":
            d = json.loads(self._body() or b"{}")
            fname = safe_name(d.get("file") or d.get("name"), "")
            if fname:
                if not fname.lower().endswith((".txt", ".md")):
                    fname += ".txt"
                p = os.path.join(SCRIPTS_DIR, fname)
                if os.path.exists(p):
                    try: os.remove(p)
                    except OSError: pass
            return self._json({"ok": True})

        if u.path in ("/api/reveal", "/api/open", "/api/open-folder", "/api/open-dir"):
            d = json.loads(self._body() or b"{}")
            target = d.get("file") or d.get("path") or OUT_DIR
            path = os.path.realpath(target)
            if not path.startswith(os.path.realpath(OUT_DIR)) and path != os.path.realpath(OUT_DIR):
                path = os.path.realpath(OUT_DIR)
            subprocess.Popen(["open", "-R", path] if (u.path == "/api/reveal" and os.path.isfile(path)) else ["open", path])
            return self._json({"ok": True, "path": path})

        self._json({"error": "not found"}, 404)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    HTTPD = Server((HOST, PORT), Handler)
    log(f"старт: http://127.0.0.1:{PORT}  ·  записи → {OUT_DIR}")
    print(f"Суфлёр: http://127.0.0.1:{PORT}  ·  записи → {OUT_DIR}", flush=True)
    HTTPD.serve_forever()
