#!/usr/bin/env python3
"""Visitor counters for murmurconnect.com, served on the site's own origin.

The page calls POST /api/hit on load and every minute while it stays visible, and
GET /api/stats to draw the footer counters. Nothing is stored about a person: each
hit is reduced to a visitor id, sha256(day salt + IP + User-Agent), with a random salt
per day, so ids cannot be joined across days. No cookies, no third-party scripts.

Counters: visitor-days for today, the last 7 days, the last 30 days and all time
(one visitor counted once per day), plus visitors seen in the last 5 minutes.
"""
import hashlib, json, os, re, secrets, sqlite3, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("STATS_PORT", "8791"))
DB = os.environ.get("STATS_DB", "/var/lib/murmurconnect-stats/stats.db")
ONLINE_SEC = 300
BOT = re.compile(r"bot|crawl|spider|slurp|fetch|preview|headless|python|curl|wget|httpclient|monitor|scan|lighthouse|pagespeed|facebookexternalhit|whatsapp|telegram|discord|skype|slack|go-http", re.I)
LOCK = threading.Lock()

def db():
    c = sqlite3.connect(DB, timeout=10, isolation_level=None)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE IF NOT EXISTS hits (ts INTEGER NOT NULL, day TEXT NOT NULL, vid TEXT NOT NULL, page TEXT NOT NULL)")
    c.execute("CREATE INDEX IF NOT EXISTS hits_day_vid ON hits (day, vid)")
    c.execute("CREATE INDEX IF NOT EXISTS hits_ts ON hits (ts)")
    c.execute("CREATE TABLE IF NOT EXISTS salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL)")
    c.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
    c.execute("INSERT OR IGNORE INTO meta VALUES ('since', ?)", (time.strftime("%Y-%m-%d", time.gmtime()),))
    return c

def salt_for(c, day):
    row = c.execute("SELECT salt FROM salts WHERE day=?", (day,)).fetchone()
    if row: return row[0]
    s = secrets.token_hex(16)
    c.execute("INSERT OR IGNORE INTO salts VALUES (?,?)", (day, s))
    return c.execute("SELECT salt FROM salts WHERE day=?", (day,)).fetchone()[0]

def stats(c):
    now = int(time.time()); today = time.strftime("%Y-%m-%d", time.gmtime(now))
    def days_ago(n): return time.strftime("%Y-%m-%d", time.gmtime(now - n * 86400))
    q = lambda sql, *a: c.execute(sql, a).fetchone()[0]
    return {
        "today": q("SELECT COUNT(DISTINCT vid) FROM hits WHERE day=?", today),
        "week": q("SELECT COUNT(*) FROM (SELECT DISTINCT day, vid FROM hits WHERE day>=?)", days_ago(6)),
        "month": q("SELECT COUNT(*) FROM (SELECT DISTINCT day, vid FROM hits WHERE day>=?)", days_ago(29)),
        "all": q("SELECT COUNT(*) FROM (SELECT DISTINCT day, vid FROM hits)"),
        "online": q("SELECT COUNT(DISTINCT vid) FROM hits WHERE ts>=?", now - ONLINE_SEC),
        "since": q("SELECT v FROM meta WHERE k='since'"),
    }

class H(BaseHTTPRequestHandler):
    server_version = "murmurconnect-stats/1"
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _send(self, code, body=b"", ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body: self.wfile.write(body)
    def do_GET(self):
        if self.path.split("?")[0] != "/api/stats": return self._send(404, b'{"error":"not found"}')
        with LOCK:
            c = db()
            try: out = stats(c)
            finally: c.close()
        self._send(200, json.dumps(out).encode())
    def do_POST(self):
        if self.path.split("?")[0] != "/api/hit": return self._send(404, b'{"error":"not found"}')
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(min(length, 2048)) if length else b""
        page = "/"
        try:
            p = json.loads(raw or b"{}").get("p", "/")
            if isinstance(p, str) and p.startswith("/") and len(p) <= 120: page = p
        except Exception: pass
        ua = self.headers.get("User-Agent", "")
        ip = self.headers.get("X-Real-IP") or self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0]
        if not ua or BOT.search(ua): return self._send(204)
        now = int(time.time()); day = time.strftime("%Y-%m-%d", time.gmtime(now))
        with LOCK:
            c = db()
            try:
                vid = hashlib.sha256(f"{salt_for(c, day)}|{ip}|{ua}".encode()).hexdigest()[:20]
                c.execute("INSERT INTO hits VALUES (?,?,?,?)", (now, day, vid, page))
                # Old hits are only needed as (day, vid) pairs: keep 400 days of detail.
                if now % 97 == 0: c.execute("DELETE FROM hits WHERE ts < ?", (now - 400 * 86400,))
            finally: c.close()
        self._send(204)

if __name__ == "__main__":
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    db().close()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"murmurconnect-stats listening on 127.0.0.1:{PORT}, db {DB}", flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: sys.exit(0)
