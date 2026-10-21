# agent/agent.py
# Monitoring agent for the Distributed Server Resource Monitor.
# Collects real CPU, memory, disk, and network metrics from the container
# using psutil and POSTs them to the central Flask API every POLL_INTERVAL seconds.
#
# Fault tolerance:
#   - Failed HTTP POSTs are logged as warnings and retried on the next cycle.
#   - The agent never crashes on a transient network error.
#   - POLL_INTERVAL defaults to 5 s so the API detects failures quickly.

import logging
import os
import socket
import time
import uuid
from typing import Any, Optional

import psutil
import requests

# ── Configuration ─────────────────────────────────────────────────────────────

API_URL         = os.environ.get("API_URL", "http://api:5000")
# Reporting interval.  Default 5 s: with OFFLINE_THRESHOLD=20 s, the API
# flags an agent offline after 4 consecutive missed reports.
POLL_INTERVAL   = int(os.environ.get("POLL_INTERVAL", 5))
STARTUP_TIMEOUT = int(os.environ.get("STARTUP_TIMEOUT", 60))  # seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Identity ──────────────────────────────────────────────────────────────────
# Deterministic UUID derived from the container hostname.
# Docker Compose gives each replica a unique hostname
# (e.g. distributed-server-monitor-agent-1, -agent-2, …),
# so this ID is stable across restarts but unique across replicas.

HOSTNAME  = socket.gethostname()
SERVER_ID = str(uuid.uuid5(uuid.NAMESPACE_DNS, HOSTNAME))

# ── Network Delta State ───────────────────────────────────────────────────────
# We track the previous net_io snapshot to compute per-interval deltas.
# psutil._common.snetio is a private namedtuple that is not part of the public
# API and is absent on some psutil builds (raises AttributeError at import).
# We use Optional[Any] to stay compatible across all psutil versions while
# preserving full network monitoring behaviour.

_prev_net: Optional[Any] = None   # holds a psutil.net_io_counters() namedtuple
_prev_net_time: Optional[float] = None


# ── Metric Collection ─────────────────────────────────────────────────────────

def collect_metrics() -> dict:
    """Gather system resource metrics via psutil and return a payload dict
    ready to POST to the API.

    CPU measurement uses a 1-second blocking interval for accuracy.
    Network I/O is reported as MB transferred since the previous call.
    """
    global _prev_net, _prev_net_time

    # ── CPU ──────────────────────────────────────────────────────────────────
    # interval=1 blocks for 1 second and returns the percentage of that second.
    cpu_pct = psutil.cpu_percent(interval=1)

    # ── Memory ───────────────────────────────────────────────────────────────
    mem          = psutil.virtual_memory()
    mem_pct      = mem.percent
    mem_used_mb  = round(mem.used  / 1024 / 1024, 2)
    mem_total_mb = round(mem.total / 1024 / 1024, 2)

    # ── Disk (root filesystem) ────────────────────────────────────────────────
    disk     = psutil.disk_usage("/")
    disk_pct = disk.percent

    # ── Network I/O delta ─────────────────────────────────────────────────────
    now = time.monotonic()
    net = psutil.net_io_counters()
    if _prev_net is None:
        # First sample — can't compute a delta yet; report zero.
        net_sent_mb = 0.0
        net_recv_mb = 0.0
    else:
        net_sent_mb = round(max(net.bytes_sent - _prev_net.bytes_sent, 0) / 1024 / 1024, 4)
        net_recv_mb = round(max(net.bytes_recv - _prev_net.bytes_recv, 0) / 1024 / 1024, 4)
    _prev_net      = net
    _prev_net_time = now

    return {
        "server_id":    SERVER_ID,
        "hostname":     HOSTNAME,
        "cpu_pct":      cpu_pct,
        "mem_pct":      mem_pct,
        "mem_used_mb":  mem_used_mb,
        "mem_total_mb": mem_total_mb,
        "disk_pct":     disk_pct,
        "net_sent_mb":  net_sent_mb,
        "net_recv_mb":  net_recv_mb,
    }


# ── API Communication ─────────────────────────────────────────────────────────

def send_metrics(payload: dict) -> bool:
    """POST a metrics payload to the central API.

    Returns True on HTTP 2xx, False on any network or HTTP error.
    Failures are logged as warnings — the agent continues on the next cycle.
    """
    try:
        resp = requests.post(
            f"{API_URL}/api/metrics",
            json=payload,
            timeout=5,
        )
        resp.raise_for_status()
        return True
    except requests.RequestException as exc:
        log.warning("Failed to send metrics: %s", exc)
        return False


def wait_for_api() -> None:
    """Block until the API's /health endpoint responds successfully.

    Uses exponential backoff up to STARTUP_TIMEOUT seconds, then exits.

    This runs *after* depends_on service_healthy, so in normal conditions
    it succeeds on the first or second try. The loop exists as a safety net
    for manual runs or restart scenarios.
    """
    deadline = time.monotonic() + STARTUP_TIMEOUT
    delay = 2
    while time.monotonic() < deadline:
        try:
            resp = requests.get(f"{API_URL}/health", timeout=3)
            if resp.status_code == 200:
                log.info("API reachable at %s", API_URL)
                return
        except requests.RequestException:
            pass
        log.info("API not ready — retrying in %ds…", delay)
        time.sleep(delay)
        delay = min(delay * 2, 15)
    log.error("API did not become reachable within %ds — exiting.", STARTUP_TIMEOUT)
    raise SystemExit(1)


# ── Main Loop ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info("Agent starting  hostname=%s  server_id=%s", HOSTNAME, SERVER_ID)
    wait_for_api()
    log.info("Polling every %ds → %s/api/metrics", POLL_INTERVAL, API_URL)

    consecutive_failures = 0

    while True:
        metrics = collect_metrics()
        ok = send_metrics(metrics)

        if ok:
            consecutive_failures = 0
            log.info(
                "✓ cpu=%.1f%%  mem=%.1f%%  disk=%.1f%%  ↑%.4fMB  ↓%.4fMB",
                metrics["cpu_pct"],
                metrics["mem_pct"],
                metrics["disk_pct"],
                metrics["net_sent_mb"],
                metrics["net_recv_mb"],
            )
        else:
            consecutive_failures += 1
            # Back off log verbosity after repeated failures to avoid log spam.
            # Always logs on the 1st failure; then every 6th (~30 s at 5 s interval).
            if consecutive_failures == 1 or consecutive_failures % 6 == 0:
                log.warning(
                    "API unreachable — %d consecutive failed report(s). "
                    "Will retry next cycle.",
                    consecutive_failures,
                )

        # cpu_percent(interval=1) already consumed ~1 second; subtract that
        # so total loop cadence stays close to POLL_INTERVAL.
        sleep_time = max(POLL_INTERVAL - 1, 1)
        time.sleep(sleep_time)
