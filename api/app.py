# api/app.py
# Flask REST API for the Distributed Server Resource Monitor.
# Receives metrics from agents, stores them in SQLite, and serves the dashboard.
#
# Endpoints:
#   POST /api/metrics              — agent pushes metrics
#   GET  /api/servers              — server list + online flag
#   GET  /api/servers/<id>/history — metric history for charts
#   GET  /api/alerts               — active alert list
#   GET  /api/thresholds           — current threshold config (read)
#   PUT  /api/thresholds           — update thresholds at runtime (write)
#   GET  /health                   — health-check for Docker Compose

import os
import threading
from datetime import datetime, timezone, timedelta

from flask import Flask, abort, jsonify, request, send_from_directory
from flask_cors import CORS

from database import (
    get_active_alerts,
    get_all_servers,
    get_server_history,
    get_thresholds_from_db,
    init_db,
    insert_metric,
    resolve_alert,
    upsert_alert,
    upsert_server,
    save_thresholds_to_db,
)

# ── Configuration ─────────────────────────────────────────────────────────────

# Path to the pre-built dashboard directory.
# In Docker the layout is /app/api/app.py and /app/dashboard/
DASHBOARD_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "dashboard"
)

# Seconds since last heartbeat before a server is marked offline.
OFFLINE_THRESHOLD = int(os.environ.get("OFFLINE_THRESHOLD", 20))

# Resource alert thresholds — loaded from DB at startup (with env-var fallback).
# Use _thresholds_lock for thread-safe mutation by PUT /api/thresholds.
_thresholds_lock = threading.Lock()
_cpu_threshold: float = float(os.environ.get("CPU_ALERT_THRESHOLD", 80.0))
_mem_threshold: float = float(os.environ.get("MEM_ALERT_THRESHOLD", 80.0))


def _get_thresholds() -> tuple[float, float]:
    """Return current (cpu_threshold, mem_threshold) under lock."""
    with _thresholds_lock:
        return _cpu_threshold, _mem_threshold


def _set_thresholds(cpu: float, mem: float) -> None:
    """Update in-memory thresholds and persist to DB under lock."""
    global _cpu_threshold, _mem_threshold
    with _thresholds_lock:
        _cpu_threshold = cpu
        _mem_threshold = mem
    save_thresholds_to_db(cpu, mem)


# ── App Factory ───────────────────────────────────────────────────────────────

app = Flask(__name__, static_folder=None)
CORS(app)  # Allow cross-origin requests

# Initialise the DB schema at import time — safe with gunicorn --preload
init_db()

# Load persisted thresholds from DB (overrides env-var defaults if a saved
# value exists from a previous PUT /api/thresholds call).
_db_thresholds = get_thresholds_from_db()
if _db_thresholds:
    _cpu_threshold = _db_thresholds["cpu_pct"]
    _mem_threshold = _db_thresholds["mem_pct"]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_online(last_seen_iso: str | None) -> bool:
    """Return True if last_seen is within OFFLINE_THRESHOLD seconds of now."""
    if not last_seen_iso:
        return False
    try:
        ts = datetime.fromisoformat(last_seen_iso.replace("Z", "+00:00"))
        age = datetime.now(timezone.utc) - ts
        return age < timedelta(seconds=OFFLINE_THRESHOLD)
    except (ValueError, TypeError):
        return False


def _evaluate_alerts(server_id: str, hostname: str, cpu_pct: float, mem_pct: float) -> None:
    """Compare current metric values against configured thresholds.

    Raises an alert (upserts a row) when a value exceeds the threshold.
    Resolves (deletes the row) when the value returns below the threshold.
    Reads thresholds via _get_thresholds() so runtime changes take effect
    immediately without restarting the container.
    """
    cpu_thresh, mem_thresh = _get_thresholds()

    if cpu_pct > cpu_thresh:
        upsert_alert(server_id, hostname, "cpu", cpu_pct, cpu_thresh)
    else:
        resolve_alert(server_id, "cpu")

    if mem_pct > mem_thresh:
        upsert_alert(server_id, hostname, "mem", mem_pct, mem_thresh)
    else:
        resolve_alert(server_id, "mem")


# ── Health Check ──────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    """Lightweight health-check used by Docker Compose and the agent startup probe."""
    return jsonify({"status": "ok"})


# ── API Routes ────────────────────────────────────────────────────────────────

@app.route("/api/metrics", methods=["POST"])
def post_metrics():
    """Accept a metric payload from an agent and persist it."""
    data = request.get_json(silent=True)
    if not data:
        abort(400, description="Request body must be JSON.")

    required = {
        "server_id", "hostname",
        "cpu_pct", "mem_pct", "mem_used_mb", "mem_total_mb",
        "disk_pct", "net_sent_mb", "net_recv_mb",
    }
    missing = required - data.keys()
    if missing:
        abort(400, description=f"Missing required fields: {sorted(missing)}")

    try:
        cpu_pct = float(data["cpu_pct"])
        mem_pct = float(data["mem_pct"])
    except (TypeError, ValueError):
        abort(400, description="cpu_pct and mem_pct must be numeric.")

    upsert_server(data["server_id"], data["hostname"])
    insert_metric(data["server_id"], data)
    _evaluate_alerts(data["server_id"], data["hostname"], cpu_pct, mem_pct)

    return jsonify({"status": "accepted"}), 201


@app.route("/api/servers")
def list_servers():
    """Return every registered server with its latest metric snapshot,
    an 'online' boolean, and the raw last_seen timestamp.
    """
    servers = get_all_servers()
    for s in servers:
        s["online"] = _is_online(s.get("last_seen"))
    return jsonify(servers)


@app.route("/api/servers/<server_id>/history")
def server_history(server_id: str):
    """Return up to `limit` (default 60, max 100) metric rows oldest-first."""
    try:
        limit = min(int(request.args.get("limit", 60)), 100)
    except ValueError:
        limit = 60
    return jsonify(get_server_history(server_id, limit))


@app.route("/api/alerts")
def list_alerts():
    """Return all currently active resource alerts."""
    return jsonify(get_active_alerts())


@app.route("/api/thresholds", methods=["GET"])
def get_thresholds_route():
    """Return the currently active alert thresholds.

    Response:
      { "cpu_pct": <float>, "mem_pct": <float>, "offline_seconds": <int> }
    """
    cpu, mem = _get_thresholds()
    return jsonify({
        "cpu_pct":         cpu,
        "mem_pct":         mem,
        "offline_seconds": OFFLINE_THRESHOLD,
    })


@app.route("/api/thresholds", methods=["PUT"])
def update_thresholds():
    """Update CPU and memory alert thresholds at runtime.

    Request body:
      { "cpu_pct": <number 1-100>, "mem_pct": <number 1-100> }

    The new thresholds take effect immediately for all subsequent metric
    reports.  They are persisted to SQLite so they survive container restarts.

    Response (success):
      { "cpu_pct": <float>, "mem_pct": <float> }
    """
    data = request.get_json(silent=True)
    if not data:
        abort(400, description="Request body must be JSON.")

    errors = []
    for field in ("cpu_pct", "mem_pct"):
        if field not in data:
            errors.append(f"'{field}' is required.")
            continue
        try:
            v = float(data[field])
        except (TypeError, ValueError):
            errors.append(f"'{field}' must be a number.")
            continue
        if not (1.0 <= v <= 100.0):
            errors.append(f"'{field}' must be between 1 and 100 (got {v}).")

    if errors:
        abort(400, description=" ".join(errors))

    cpu = float(data["cpu_pct"])
    mem = float(data["mem_pct"])
    _set_thresholds(cpu, mem)

    return jsonify({"cpu_pct": cpu, "mem_pct": mem})


# ── Dashboard Static Serving ──────────────────────────────────────────────────

@app.route("/")
def dashboard_root():
    """Serve the dashboard SPA entry point."""
    return send_from_directory(DASHBOARD_DIR, "index.html")


@app.route("/<path:filename>")
def dashboard_static(filename: str):
    """Serve any other static dashboard asset (style.css, app.js, etc.)."""
    return send_from_directory(DASHBOARD_DIR, filename)


# ── Dev Entry Point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
