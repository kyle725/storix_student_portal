-- ─────────────────────────────────────────────────────────────────────────────
-- Storix D1 Schema
-- Apply with: wrangler d1 execute storix-d1 --file=schema.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Items table (synced FROM your local storix.db via sync.py)
CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    sku         TEXT,
    category    TEXT    NOT NULL DEFAULT 'Other',
    total_qty   INTEGER NOT NULL DEFAULT 0,
    available   INTEGER NOT NULL DEFAULT 0,
    low_alert   INTEGER NOT NULL DEFAULT 5,
    notes       TEXT,
    location    TEXT    NOT NULL DEFAULT 'Sim Man Room',
    assigned_to TEXT,
    condition   TEXT    NOT NULL DEFAULT 'Good'
);

-- Pending requests written by students via the portal
-- pulled_at tracks whether sync.py has already downloaded this row
CREATE TABLE IF NOT EXISTS pending_requests (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    type             TEXT    NOT NULL DEFAULT 'loan',
    item_id          INTEGER,
    student_name     TEXT    NOT NULL,
    student_id       TEXT,
    student_email    TEXT,
    student_contact  TEXT,
    quantity         INTEGER NOT NULL DEFAULT 1,
    purpose          TEXT,
    due_date         TEXT,
    condition        TEXT,
    notes            TEXT,
    status           TEXT    NOT NULL DEFAULT 'pending',
    created_at       TEXT    DEFAULT (datetime('now')),
    pulled_at        TEXT    -- set by worker when sync.py pulls this row
);

CREATE INDEX IF NOT EXISTS idx_pr_pulled   ON pending_requests (pulled_at);
CREATE INDEX IF NOT EXISTS idx_pr_created  ON pending_requests (created_at);
CREATE INDEX IF NOT EXISTS idx_items_name  ON items (name);