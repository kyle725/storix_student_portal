#!/usr/bin/env python3
"""
storix_sync.py
──────────────────────────────────────────────────────────────────────────────
Bidirectional sync between your local storix.db and Cloudflare D1 (via the
Worker API).  Run this script on the admin PC whenever you want to:

  1. Push your current inventory snapshot to D1 so the student portal
     always shows live stock levels.

  2. Pull any pending requests that students submitted while your PC was
     off, and insert them into the local pending_requests table so the
     dashboard can approve/reject them normally.

Usage
──────────────────────────────────────────────────────────────────────────────
  # One-shot (both push and pull):
  python storix_sync.py

  # Push only (update inventory in D1):
  python storix_sync.py --push

  # Pull only (import new student requests):
  python storix_sync.py --pull

  # Watch mode — sync every N seconds (default 60):
  python storix_sync.py --watch
  python storix_sync.py --watch --interval 30

Configuration
──────────────────────────────────────────────────────────────────────────────
  Copy storix_sync.env.example → storix_sync.env and fill in your values,
  OR set the environment variables directly in your shell / a .env file.

Required env vars:
  STORIX_WORKER_URL    e.g. https://storix-worker.your-subdomain.workers.dev
  STORIX_SYNC_SECRET   the same value you set with `wrangler secret put SYNC_SECRET`
  STORIX_DB            path to storix.db (default: ./storix.db)
"""

import os
import sys
import time
import json
import sqlite3
import argparse
import urllib.request
import urllib.error
from datetime import datetime

# ── Config from environment ───────────────────────────────────────────────────

def _env(key, default=None):
    val = os.environ.get(key, default)
    if val is None:
        print(f"[ERROR] Missing required env var: {key}")
        sys.exit(1)
    return val


def load_config():
    # Try loading a .env file from the same directory as this script
    env_file = os.path.join(os.path.dirname(__file__), "storix_sync.env")
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())

    return {
        "worker_url":   _env("STORIX_WORKER_URL").rstrip("/"),
        "sync_secret":  _env("STORIX_SYNC_SECRET"),
        "db_path":      os.environ.get("STORIX_DB", os.path.join(
                            os.path.dirname(os.path.abspath(__file__)), "storix.db")),
    }


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _request(method, url, secret, payload=None):
    """Simple HTTP request without third-party libs."""
    data = json.dumps(payload).encode() if payload is not None else None
    req  = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Content-Type":   "application/json",
            "X-Sync-Secret":  secret,
            "User-Agent":     "StorixSync/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode()
            return json.loads(body)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"[HTTP {e.code}] {url}\n  {body[:200]}")
        return None
    except Exception as exc:
        print(f"[ERROR] {exc}")
        return None


# ── Database helpers ──────────────────────────────────────────────────────────

def open_db(path):
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ── PUSH: local items → D1 ───────────────────────────────────────────────────

def push_items(config):
    print(f"[{_now()}] ▲  Pushing inventory to D1 …")
    conn = open_db(config["db_path"])
    rows = conn.execute(
        """SELECT id, name, sku, category, total_qty, available,
                  low_alert, notes, location, assigned_to, condition
           FROM items ORDER BY id"""
    ).fetchall()
    conn.close()

    items = [dict(r) for r in rows]
    result = _request(
        "POST",
        f"{config['worker_url']}/api/sync/push-items",
        config["sync_secret"],
        {"items": items},
    )
    if result and result.get("ok"):
        print(f"[{_now()}] ✓  Pushed {result['synced']} items to D1.")
    else:
        print(f"[{_now()}] ✗  Push failed: {result}")


# ── PULL: D1 pending requests → local DB ─────────────────────────────────────

def pull_requests(config):
    print(f"[{_now()}] ▼  Pulling new requests from D1 …")
    result = _request(
        "GET",
        f"{config['worker_url']}/api/sync/pull-requests",
        config["sync_secret"],
    )
    if not result or not result.get("ok"):
        print(f"[{_now()}] ✗  Pull failed: {result}")
        return

    requests = result.get("requests", [])
    if not requests:
        print(f"[{_now()}] –  No new requests.")
        return

    conn = open_db(config["db_path"])
    inserted = 0
    for r in requests:
        # Avoid duplicates: check if a pending request with this exact
        # student_name + item_id + created_at already exists locally.
        existing = conn.execute(
            """SELECT id FROM pending_requests
               WHERE student_name = ? AND item_id = ? AND created_at = ?""",
            (r["student_name"], r["item_id"], r["created_at"]),
        ).fetchone()
        if existing:
            continue

        conn.execute(
            """INSERT INTO pending_requests
                 (type, item_id, student_name, student_id, student_email,
                  student_contact, quantity, purpose, due_date, condition,
                  notes, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                r.get("type", "loan"),
                r.get("item_id"),
                r.get("student_name", ""),
                r.get("student_id", ""),
                r.get("student_email", ""),
                r.get("student_contact", ""),
                r.get("quantity", 1),
                r.get("purpose", ""),
                r.get("due_date"),
                r.get("condition"),
                r.get("notes", ""),
                "pending",
                r.get("created_at"),
            ),
        )
        inserted += 1

    conn.commit()
    conn.close()
    print(f"[{_now()}] ✓  Imported {inserted} new request(s) into local DB.")
    if inserted < len(requests):
        print(f"           (skipped {len(requests) - inserted} already-present)")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now():
    return datetime.now().strftime("%H:%M:%S")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Storix D1 sync tool")
    parser.add_argument("--push",     action="store_true", help="Push items only")
    parser.add_argument("--pull",     action="store_true", help="Pull requests only")
    parser.add_argument("--watch",    action="store_true", help="Run continuously")
    parser.add_argument("--interval", type=int, default=60,
                        help="Seconds between syncs in watch mode (default: 60)")
    args = parser.parse_args()

    config = load_config()

    do_push = args.push or (not args.push and not args.pull)
    do_pull = args.pull or (not args.push and not args.pull)

    def run_once():
        if do_push: push_items(config)
        if do_pull: pull_requests(config)

    if args.watch:
        print(f"[{_now()}] 👀 Watch mode — syncing every {args.interval}s. Ctrl+C to stop.")
        while True:
            run_once()
            print(f"[{_now()}] 💤 Next sync in {args.interval}s …\n")
            time.sleep(args.interval)
    else:
        run_once()


if __name__ == "__main__":
    main()