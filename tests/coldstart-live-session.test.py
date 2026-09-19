#!/usr/bin/env python3
# #123 — the cold-start watcher must stand down while an interactive Codex session is
# alive. Two signals, either one is enough: a reachable app-server socket, or a fresh
# non-coldstart row in session_presence for the same agent.
from __future__ import annotations

import importlib.util
import os
import socket
import sqlite3
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


watch = load("coldstart_watch", ROOT / "scripts" / "codex-murmur-coldstart-watch.py")


def lease_db_with_presence(path: str, rows):
    conn = sqlite3.connect(path)
    conn.executescript(watch.LEASE_DDL_FALLBACK)
    for row in rows:
        conn.execute(
            "INSERT INTO session_presence (session_id, agent_id, thread_id, pid, mode, heartbeat_at, started_at) VALUES (?, ?, NULL, 1, ?, ?, ?)",
            (row["session_id"], row["agent_id"], row["mode"], row["heartbeat_at"], row["heartbeat_at"]),
        )
    conn.commit()
    conn.close()


NOW = 1_000_000_000_000


def test_nothing_alive():
    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, "lease.db")
        lease_db_with_presence(db, [])
        assert watch.detect_live_session(db, "agent-codex", None, 60_000, now_ms=NOW) is None


def test_fresh_interactive_presence_wins():
    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, "lease.db")
        lease_db_with_presence(db, [
            {"session_id": "tui-1", "agent_id": "agent-codex", "mode": "foreground", "heartbeat_at": NOW - 5_000},
        ])
        reason = watch.detect_live_session(db, "agent-codex", None, 60_000, now_ms=NOW)
        assert reason == "presence:foreground:tui-1", reason


def test_stale_presence_and_coldstart_rows_are_ignored():
    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, "lease.db")
        lease_db_with_presence(db, [
            {"session_id": "tui-old", "agent_id": "agent-codex", "mode": "foreground", "heartbeat_at": NOW - 120_000},
            {"session_id": "cold-1", "agent_id": "agent-codex", "mode": "coldstart", "heartbeat_at": NOW},
            {"session_id": "tui-other", "agent_id": "agent-other", "mode": "foreground", "heartbeat_at": NOW},
        ])
        assert watch.detect_live_session(db, "agent-codex", None, 60_000, now_ms=NOW) is None


def test_missing_lease_db_is_not_an_error():
    with tempfile.TemporaryDirectory() as tmp:
        assert watch.detect_live_session(os.path.join(tmp, "absent.db"), "agent-codex", None, 60_000, now_ms=NOW) is None


def test_reachable_app_server_socket_wins():
    with tempfile.TemporaryDirectory() as tmp:
        sock_path = os.path.join(tmp, "codex.sock")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(sock_path)
        server.listen(1)
        accepted = []

        def accept_once():
            try:
                conn, _ = server.accept()
                accepted.append(conn)
                conn.close()
            except OSError:
                pass

        thread = threading.Thread(target=accept_once, daemon=True)
        thread.start()
        try:
            reason = watch.detect_live_session(None, "agent-codex", sock_path, 60_000, now_ms=NOW)
            assert reason == f"app-server-socket:{sock_path}", reason
        finally:
            server.close()
            thread.join(timeout=1)


def test_dead_socket_file_does_not_count():
    with tempfile.TemporaryDirectory() as tmp:
        sock_path = os.path.join(tmp, "codex.sock")
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(sock_path)
        stale.close()  # the file stays, nobody listens
        assert os.path.exists(sock_path)
        assert watch.detect_live_session(None, "agent-codex", sock_path, 60_000, now_ms=NOW) is None


def test_process_batch_skips_when_live(monkeypatch=None):
    class Args:
        db = None
        settle_seconds = 0
        dry_run = False
        lease_db = None
        agent_id = "agent-codex"
        app_server_socket = None
        presence_ttl_ms = 60_000
        ignore_live_session = False

    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, "murmur.db")
        conn = watch.connect_rw(db)
        conn.execute(
            "CREATE TABLE local_messages (id TEXT PRIMARY KEY, conversation_id TEXT, msg_id TEXT, direction TEXT, sender TEXT, text TEXT, created_at TEXT, transport TEXT)"
        )
        watch.ensure_processed_table(conn)
        conn.commit()
        conn.close()
        lease = os.path.join(tmp, "lease.db")
        lease_db_with_presence(lease, [
            {"session_id": "tui-1", "agent_id": "agent-codex", "mode": "foreground", "heartbeat_at": watch.lease_now_ms()},
        ])
        args = Args()
        args.db = db
        args.lease_db = lease
        rows = [{"rowid": 1, "msg_id": "m-1", "conversation_id": "dm:a:b", "text": "hi", "sender": "agent-a", "created_at": "2026-09-12T12:00:00Z"}]
        result = watch.process_batch(args, rows)
        assert result["event"] == "skip_live_session", result
        assert result["reason"] == "presence:foreground:tui-1", result


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok - {name}")
    print("coldstart-live-session: all tests passed")
