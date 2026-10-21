# Distributed Server Resource Monitor

Real-time resource monitoring across multiple Docker containers — CPU, memory, disk, and network — with a live Chart.js dashboard, fault detection, threshold-based alerts, offline detection, and SQLite persistence.

---

## What's New (Upgrade)

| Feature | Details |
|---|---|
| **Fault / failure detection** | Agents report every 5 s; API marks them offline after 20 s of missed reports (configurable). `last_seen` timestamp is visible on offline cards. |
| **CPU & memory alerts** | Configurable thresholds (default 80 %). Active alerts appear in a dedicated panel above the server grid. Alert badges appear on individual cards. No duplicate rows — one alert row per (server, resource) pair. |
| **Scalable agent identity** | `container_name` and `deploy.replicas` removed from the agent service so `--scale` works correctly. Each replica gets a unique UUID from its Docker hostname. |
| **New API endpoints** | `GET /api/alerts` — active alerts list. `GET /api/thresholds` — current threshold config. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Browser                            │
│                  localhost:5000                          │
└──────────────────────┬──────────────────────────────────┘
                       │  HTTP (GET /api/servers, /api/alerts, /api/thresholds)
                       ▼
┌─────────────────────────────────────────────────────────┐
│   api  container  (Flask + gunicorn)                    │
│   • POST /api/metrics        ← receives agent reports   │
│   • GET  /api/servers        ← server list + online flag│
│   • GET  /api/servers/<id>/history                      │
│   • GET  /api/alerts         ← active alert list        │
│   • GET  /api/thresholds     ← current threshold config │
│   • GET  /health                                        │
│   • Serves dashboard/ static files                      │
│   • Persists /data/monitor.db (SQLite, WAL mode)        │
└───────────────────┬─────────────────────────────────────┘
                    │  POST /api/metrics  (every 5 s)
        ┌───────────┼───────────┐
        ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ agent-1 │ │ agent-2 │ │ agent-3 │  ← scale to 5 with --scale agent=5
   │ psutil  │ │ psutil  │ │ psutil  │
   └─────────┘ └─────────┘ └─────────┘
```

Each agent monitors **its own container** (CPU, memory, disk, network) and reports to the central API every **5 seconds**. If no report arrives within **20 seconds**, the server is marked **Offline**. If CPU or memory exceeds **80 %**, an alert is raised and shown in the dashboard.

---

## Prerequisites

| Tool              | Minimum version | Check                        |
|-------------------|-----------------|------------------------------|
| Docker Desktop    | 4.x             | `docker --version`           |
| Docker Compose v2 | 2.20            | `docker compose version`     |

> **Windows users**: use `docker compose` (space), not the legacy `docker-compose`.

---

## Quick Start

```powershell
# 1. Navigate to the project
cd C:\Users\Aadesh\.gemini\antigravity\scratch\distributed-server-monitor

# 2. Build images and start with 3 agents
docker compose up --build -d --scale agent=3

# 3. Wait ~20 seconds, then check container health
docker compose ps

# 4. Open the dashboard
Start-Process http://localhost:5000
```

---

## Scaling Agents — Tested PowerShell Commands

### 1. Start the application

```powershell
cd C:\Users\Aadesh\.gemini\antigravity\scratch\distributed-server-monitor
docker compose up --build -d --scale agent=3
```

### 2. Check running containers

```powershell
docker compose ps
```

Compose names agent replicas automatically: `distributed-server-monitor-agent-1`, `-agent-2`, `-agent-3`, etc. Do not guess names — always use `docker compose ps` to discover them.

### 3. Scale to three agents (already running, no-op)

```powershell
docker compose up --scale agent=3 -d
```

### 4. Scale to five agents

```powershell
docker compose up --scale agent=5 -d
```

Two new cards appear in the dashboard within ~5 seconds.

### 5. View application logs

```powershell
# All services
docker compose logs -f

# API only
docker compose logs -f api

# Agents only
docker compose logs -f agent
```

### 6. Stop one agent to demonstrate failure detection

```powershell
# First, find the actual container name
docker compose ps

# Then stop one agent by its name (example — use the real name from ps)
docker stop distributed-server-monitor-agent-3-1
```

After ~20 seconds, the stopped agent's card will dim and show **Offline** with a last-seen timestamp. The remaining agents keep reporting normally.

### 7. Restart an agent and observe recovery

```powershell
docker start distributed-server-monitor-agent-3-1
```

The card returns to **Online** within one polling cycle (~5 seconds).

### 8. Return to three agents

```powershell
docker compose up --scale agent=3 -d
```

### 9. Stop the application safely

```powershell
# Stop and remove containers; data volume preserved
docker compose down

# Full teardown including the SQLite database
docker compose down
Remove-Item data\monitor.db -ErrorAction SilentlyContinue
```

---

## Environment Variables

### API service

| Variable              | Default | Description |
|-----------------------|---------|-------------|
| `OFFLINE_THRESHOLD`   | `20`    | Seconds since last heartbeat before server is offline |
| `CPU_ALERT_THRESHOLD` | `80`    | CPU % above which an alert is raised |
| `MEM_ALERT_THRESHOLD` | `80`    | Memory % above which an alert is raised |
| `DB_PATH`             | `/data/monitor.db` | SQLite file path inside the container |

### Agent service

| Variable          | Default           | Description |
|-------------------|-------------------|-------------|
| `API_URL`         | `http://api:5000` | Base URL of the central API |
| `POLL_INTERVAL`   | `5`               | Seconds between metric reports |
| `STARTUP_TIMEOUT` | `60`              | Max seconds to wait for API at startup |

---

## REST API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Health check — `{"status":"ok"}` |
| `POST` | `/api/metrics` | Agent pushes a metric payload |
| `GET`  | `/api/servers` | All servers + latest snapshot + `online` flag |
| `GET`  | `/api/servers/<id>/history?limit=60` | Last N rows oldest-first |
| `GET`  | `/api/alerts` | All currently active resource alerts |
| `GET`  | `/api/thresholds` | Current threshold configuration |
| `PUT`  | `/api/thresholds` | Update thresholds at runtime with validation |
| `GET`  | `/` | Serves the dashboard |

---

## Interactive Dashboard Features

1. **Manual Refresh**
   - Click the **Refresh** button in the header (or press `Enter` on it) to fetch the latest servers and alerts immediately.
   - Shows an animated spinning indicator during fetch and disables the button to prevent duplicate concurrent requests.
   - Preserves continuous automatic 5-second polling in the background.

2. **Interactive Server Cards & Deep Inspection**
   - Each server card is fully keyboard-accessible (`Tab`, `Enter`, `Space`) and clickable.
   - Clicking a card slides open the **Server Details Panel** showing:
     - Full Server UUID and Docker container hostname
     - Heartbeat timestamps (Last seen, First discovered)
     - Live resource metrics (CPU %, Memory %, Disk %, Network I/O)
     - Historical metric table of recent samples
     - Real-time live updating while the panel remains open
   - Close via the `✕` button, clicking the backdrop, or pressing the `Escape` key.

3. **Active Alert Details Dialog**
   - Clicking any active alert chip in the alert banner opens a dedicated **Alert Details Modal**.
   - Displays measured value, target threshold, trigger timestamp, and explanation of the auto-resolution behavior.
   - Dismissible via `✕`, backdrop click, or `Escape`.

4. **Dynamic Threshold Settings**
   - Click the **Settings** button in the header to open the threshold configuration dialog.
   - View and edit current CPU % and Memory % alert thresholds.
   - Validates user input (numeric, between 1 and 100 %).
   - Saves to the backend via `PUT /api/thresholds` and persists in SQLite (`settings` table) across container restarts.
   - Re-evaluates all server alerts immediately upon saving.

---

## Fault Detection & Alert Behavior

### Offline detection

- Agents report every `POLL_INTERVAL` seconds (default 5 s).
- The API records `last_seen` on every successful `POST /api/metrics`.
- `GET /api/servers` computes `online = (now - last_seen) < OFFLINE_THRESHOLD`.
- Default `OFFLINE_THRESHOLD = 20 s` = 4 missed reports.
- Offline cards dim to 50 % opacity and show the last-seen time.
- Recovery is automatic: the card goes back online on the next successful report.

### CPU / memory alerts

- Every incoming metric is compared against `CPU_ALERT_THRESHOLD` and `MEM_ALERT_THRESHOLD`.
- When a value exceeds the threshold, `upsert_alert()` inserts or updates a single row in the `alerts` table (`UNIQUE(server_id, resource)` prevents duplicates).
- When the value returns below the threshold, `resolve_alert()` deletes the row.
- `GET /api/alerts` returns active rows with agent name, value, threshold, start time, and last-updated time.
- The dashboard renders an amber alerts panel and an `⚠ Alert` badge on the affected card.
- Alert state clears automatically when the value recovers.

---

## Database Schema

```sql
-- Original tables (unchanged)
servers (id, hostname, first_seen, last_seen)
metrics (id, server_id, timestamp, cpu_pct, mem_pct, mem_used_mb, mem_total_mb,
         disk_pct, net_sent_mb, net_recv_mb)

-- Added in upgrade (safe migration — CREATE TABLE IF NOT EXISTS)
alerts   (id, server_id, hostname, resource, value, threshold,
          started_at, updated_at,
          UNIQUE(server_id, resource))
settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)
```

Existing data is never dropped. The `alerts` table is created if it does not exist; otherwise it is left untouched.

---

## Troubleshooting

### Agents show as Offline immediately

```powershell
docker compose logs agent
# Expect: "API reachable at http://api:5000" within 20 s
```

### Scaling with --scale produces no new containers

Verify the agent service in `compose.yaml` has **no** `container_name` and **no** `deploy.replicas`. Both prevent Docker Compose from starting multiple replicas.

### Dashboard shows no alerts despite high CPU

Check that `CPU_ALERT_THRESHOLD` in `compose.yaml` matches your expectations. You can lower it temporarily to test:

```powershell
# Temporarily lower threshold to 5 % to verify alert flow
$env:CPU_ALERT_THRESHOLD = "5"
docker compose up --build -d
```

### Port 5000 already in use

```powershell
netstat -ano | findstr :5000
```

Kill the process or change the host port in `compose.yaml` from `"5000:5000"` to e.g. `"5001:5000"`.

---

## Project Structure

```
distributed-server-monitor/
├── api/
│   ├── app.py          Flask REST API (metrics, servers, alerts, thresholds)
│   ├── database.py     SQLite schema, upsert, alert helpers
│   ├── requirements.txt
│   └── Dockerfile      Build context = project root (bundles dashboard/)
├── agent/
│   ├── agent.py        psutil collector + HTTP reporter + failure backoff
│   ├── requirements.txt
│   └── Dockerfile
├── dashboard/
│   ├── index.html      SPA shell — alerts panel + server grid
│   ├── style.css       Dark glassmorphism + alert styles
│   └── app.js          Polling, card create/update, alert rendering, Chart.js
├── data/               SQLite bind-mount (monitor.db created at runtime)
├── compose.yaml        Orchestration — scalable agent, alert thresholds
└── README.md
```
