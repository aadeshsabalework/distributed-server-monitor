# api/database.py
# Database helpers for the Distributed Server Resource Monitor API.
# Handles SQLite connection, schema initialization, and query utilities.
#
# Schema version history
# ─────────────────────
# v1 (original): servers, metrics tables
# v2 (upgrade):  alerts table added (safe migration via CREATE TABLE IF NOT EXISTS)

import os
import sqlite3

DB_PATH = os.environ.get("DB_PATH", "/data/monitor.db")

# How many metric rows to retain per server before pruning old ones.
METRIC_HISTORY_LIMIT = 100  # ~8 min of history at 5-second poll interval


# ── Connection ────────────────────────────────────────────────────────────────

def get_connection() -> sqlite3.Connection:
    """Return a new SQLite connection with WAL mode enabled.

    Each call opens a fresh connection.  The caller (wrapped in `with`) is
    responsible for committing / rolling back.  SQLite WAL mode allows one
    writer and many concurrent readers.
    """
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")    # better concurrent read/write
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")  # safe but faster than FULL
    return conn


# ── Schema ────────────────────────────────────────────────────────────────────

def init_db() -> None:
    """Create tables and indexes if they don't already exist.

    Safe to call on every startup (idempotent).
    Existing data is never dropped or altered.
    """
    with get_connection() as conn:
        conn.executescript("""
            -- ── Original tables (v1) ─────────────────────────────────────────

            CREATE TABLE IF NOT EXISTS servers (
                id          TEXT PRIMARY KEY,
                hostname    TEXT NOT NULL,
                first_seen  TEXT NOT NULL
                            DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                last_seen   TEXT NOT NULL
                            DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            );

            CREATE TABLE IF NOT EXISTS metrics (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id    TEXT NOT NULL REFERENCES servers(id),
                timestamp    TEXT NOT NULL
                             DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                cpu_pct      REAL NOT NULL,
                mem_pct      REAL NOT NULL,
                mem_used_mb  REAL NOT NULL,
                mem_total_mb REAL NOT NULL,
                disk_pct     REAL NOT NULL,
                net_sent_mb  REAL NOT NULL,
                net_recv_mb  REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_metrics_server_time
                ON metrics (server_id, id DESC);

            -- ── Alert table (v2 migration) ────────────────────────────────────
            --
            -- One row per (server, resource) pair.
            -- A row is ACTIVE while the resource exceeds the threshold.
            -- It is RESOLVED (and row deleted) when the value drops below the
            -- threshold.  This means no duplicate rows per ongoing alert.

            CREATE TABLE IF NOT EXISTS alerts (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id    TEXT NOT NULL REFERENCES servers(id),
                hostname     TEXT NOT NULL,
                resource     TEXT NOT NULL,   -- 'cpu' or 'mem'
                value        REAL NOT NULL,   -- latest measured value
                threshold    REAL NOT NULL,   -- configured threshold
                started_at   TEXT NOT NULL
                             DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                updated_at   TEXT NOT NULL
                             DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                UNIQUE (server_id, resource)  -- one row per (server, resource)
            );

            -- ── Settings table (v3 migration) ─────────────────────────────────
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)


# ── Write Helpers ─────────────────────────────────────────────────────────────

def upsert_server(server_id: str, hostname: str) -> None:
    """Insert a new server row or refresh its last_seen timestamp."""
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO servers (id, hostname, first_seen, last_seen)
            VALUES (
                ?,
                ?,
                strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            )
            ON CONFLICT(id) DO UPDATE SET
                hostname  = excluded.hostname,
                last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            """,
            (server_id, hostname),
        )


def insert_metric(server_id: str, payload: dict) -> None:
    """Write one metrics row for `server_id`, then prune rows that exceed
    METRIC_HISTORY_LIMIT so the DB stays bounded.
    """
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO metrics
                (server_id, cpu_pct, mem_pct, mem_used_mb, mem_total_mb,
                 disk_pct, net_sent_mb, net_recv_mb)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                server_id,
                payload["cpu_pct"],
                payload["mem_pct"],
                payload["mem_used_mb"],
                payload["mem_total_mb"],
                payload["disk_pct"],
                payload["net_sent_mb"],
                payload["net_recv_mb"],
            ),
        )
        # Prune: delete anything beyond the latest METRIC_HISTORY_LIMIT rows
        conn.execute(
            """
            DELETE FROM metrics
            WHERE server_id = ?
              AND id NOT IN (
                  SELECT id FROM metrics
                  WHERE server_id = ?
                  ORDER BY id DESC
                  LIMIT ?
              )
            """,
            (server_id, server_id, METRIC_HISTORY_LIMIT),
        )


def upsert_alert(server_id: str, hostname: str, resource: str,
                 value: float, threshold: float) -> None:
    """Insert or update an active alert for (server_id, resource).

    If the alert already exists, only `value` and `updated_at` are refreshed
    so `started_at` preserves the original trigger time.
    This prevents duplicate rows on every polling cycle.
    """
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO alerts (server_id, hostname, resource, value, threshold,
                                started_at, updated_at)
            VALUES (?, ?, ?, ?, ?,
                    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            ON CONFLICT(server_id, resource) DO UPDATE SET
                value      = excluded.value,
                hostname   = excluded.hostname,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            """,
            (server_id, hostname, resource, value, threshold),
        )


def resolve_alert(server_id: str, resource: str) -> None:
    """Remove the alert row when the resource returns below its threshold.

    Deleting the row (rather than setting a flag) keeps the alerts table
    small and makes 'active alerts' a simple SELECT * query.
    """
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM alerts WHERE server_id = ? AND resource = ?",
            (server_id, resource),
        )


# ── Read Helpers ──────────────────────────────────────────────────────────────

def get_all_servers() -> list[dict]:
    """Return every server row joined to its single most-recent metric snapshot.

    Servers that have never reported metrics will have NULL metric fields.
    Results are ordered by hostname.
    """
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT
                s.id,
                s.hostname,
                s.first_seen,
                s.last_seen,
                m.cpu_pct,
                m.mem_pct,
                m.mem_used_mb,
                m.mem_total_mb,
                m.disk_pct,
                m.net_sent_mb,
                m.net_recv_mb,
                m.timestamp AS metric_ts
            FROM servers s
            LEFT JOIN metrics m ON m.id = (
                SELECT id FROM metrics
                WHERE server_id = s.id
                ORDER BY id DESC
                LIMIT 1
            )
            ORDER BY s.hostname
            """
        ).fetchall()
        return [dict(r) for r in rows]


def get_server_history(server_id: str, limit: int = 60) -> list[dict]:
    """Return the last `limit` metric rows for a server, ordered oldest-first
    so Chart.js receives data in chronological (left-to-right) order.
    """
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT timestamp, cpu_pct, mem_pct, disk_pct, net_sent_mb, net_recv_mb
            FROM metrics
            WHERE server_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (server_id, limit),
        ).fetchall()
        return [dict(r) for r in reversed(rows)]


def get_active_alerts() -> list[dict]:
    """Return all currently active alert rows, ordered by started_at ascending."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, server_id, hostname, resource, value, threshold,
                   started_at, updated_at
            FROM alerts
            ORDER BY started_at ASC
            """
        ).fetchall()
        return [dict(r) for r in rows]


# ── Threshold Persistence ─────────────────────────────────────────────────────
# Thresholds are stored in a single-row key/value table so that changes made
# via PUT /api/thresholds survive container restarts without needing to edit
# environment variables or compose.yaml.

def _ensure_settings_table(conn: sqlite3.Connection) -> None:
    """Create the settings table if it does not exist (called lazily)."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)


def save_thresholds_to_db(cpu_pct: float, mem_pct: float) -> None:
    """Persist CPU and memory thresholds to the settings table."""
    with get_connection() as conn:
        _ensure_settings_table(conn)
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('cpu_threshold', ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(cpu_pct),),
        )
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('mem_threshold', ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(mem_pct),),
        )


def get_thresholds_from_db() -> dict | None:
    """Return saved thresholds from the settings table, or None if not set."""
    try:
        with get_connection() as conn:
            _ensure_settings_table(conn)
            rows = conn.execute(
                "SELECT key, value FROM settings WHERE key IN ('cpu_threshold', 'mem_threshold')"
            ).fetchall()
            if len(rows) < 2:
                return None
            d = {r["key"]: float(r["value"]) for r in rows}
            return {"cpu_pct": d["cpu_threshold"], "mem_pct": d["mem_threshold"]}
    except Exception:
        return None
