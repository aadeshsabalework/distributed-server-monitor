// dashboard/app.js
// Client-side logic for the Distributed Server Resource Monitor dashboard.
//
// Features:
//   - Automatic polling every POLL_INTERVAL ms (servers, metrics, alerts)
//   - Manual refresh button with loading spinner and concurrency guard
//   - Keyboard-accessible, clickable server cards with slide-in detail panel
//   - Historical metrics inspection for any selected server
//   - Clickable active alerts with detailed modal dialog
//   - Threshold settings modal with real-time PUT /api/thresholds persistence
//   - Global Escape key and backdrop dismissal for all modals and panels
//   - In-place DOM patching to preserve Chart.js canvas state across polls

"use strict";

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE      = "";          // Same origin — Flask serves static dashboard
const POLL_INTERVAL = 5_000;       // ms between periodic refreshes
const CHART_MAX_PTS = 60;          // maximum points rendered on server sparklines

// Theme colours
const COLOR_CPU  = "#4f8ef7";
const COLOR_MEM  = "#8b5cf6";


// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Record<string, Chart>} Map from server_id → Chart.js instance */
const chartInstances = {};

/** Set of server_ids for which cards are already mounted in DOM */
const knownIds = new Set();

/** Map of server_id → latest server object from /api/servers */
const currentServersMap = new Map();

/** Current active alerts array from /api/alerts */
let currentAlertsList = [];

/** Set of active "server_id:resource" alert keys for O(1) badge lookup */
let activeAlertKeys = new Set();

/**
 * Current alert thresholds. Loaded from /api/thresholds at boot.
 * @type {{ cpu_pct: number, mem_pct: number, offline_seconds: number }}
 */
let thresholds = { cpu_pct: 80, mem_pct: 80, offline_seconds: 20 };

/** Currently selected server_id open in detail panel (null if closed) */
let selectedServerId = null;

/** Guard flag to prevent overlapping manual / automatic refreshes */
let isRefreshing = false;


// ── DOM References ────────────────────────────────────────────────────────────

// Header & Controls
const grid          = document.getElementById("server-grid");
const errorBanner   = document.getElementById("error-banner");
const onlineEl      = document.getElementById("online-count");
const offlineEl     = document.getElementById("offline-count");
const updatedEl     = document.getElementById("last-updated-time");
const alertBadge    = document.getElementById("badge-alert");
const alertCountEl  = document.getElementById("alert-count");
const alertPlural   = document.getElementById("alert-plural");
const btnRefresh    = document.getElementById("btn-refresh");
const refreshIcon   = document.getElementById("refresh-icon");
const btnSettings   = document.getElementById("btn-settings");

// Alerts Panel
const alertsPanel   = document.getElementById("alerts-panel");
const alertsList    = document.getElementById("alerts-list");

// Server Detail Slide-in Panel
const detailBackdrop  = document.getElementById("detail-backdrop");
const detailPanel     = document.getElementById("detail-panel");
const detailTitle     = document.getElementById("detail-title");
const detailBody      = document.getElementById("detail-body");
const btnCloseDetail  = document.getElementById("btn-close-detail");

// Settings Modal
const settingsBackdrop  = document.getElementById("settings-backdrop");
const settingsModal     = document.getElementById("settings-modal");
const btnCloseSettings  = document.getElementById("btn-close-settings");
const btnCancelSettings = document.getElementById("btn-cancel-settings");
const btnSaveSettings   = document.getElementById("btn-save-settings");
const inputCpu          = document.getElementById("input-cpu");
const inputMem          = document.getElementById("input-mem");
const settingsFeedback  = document.getElementById("settings-feedback");

// Alert Detail Modal
const alertDetailBackdrop = document.getElementById("alert-detail-backdrop");
const alertDetailModal    = document.getElementById("alert-detail-modal");
const alertDetailHeading  = document.getElementById("alert-detail-heading");
const alertDetailBody     = document.getElementById("alert-detail-body");
const btnCloseAlertDetail = document.getElementById("btn-close-alert-detail");


// ── Utilities ─────────────────────────────────────────────────────────────────

/** Format a float to `decimals` places, or return "—" for null/undefined. */
function fmt(val, decimals = 1) {
  return val != null ? Number(val).toFixed(decimals) : "—";
}

/** Format a megabyte value as "X MB" or "X.XX GB". */
function fmtMB(mb) {
  if (mb == null) return "—";
  return mb >= 1024
    ? (mb / 1024).toFixed(2) + " GB"
    : mb.toFixed(0) + " MB";
}

/** Return the meter data-level string based on percentage. */
function level(pct) {
  if (pct == null || pct < 60) return "low";
  if (pct < 80)                 return "medium";
  return "high";
}

/** Current local time as HH:MM:SS. */
function nowStr() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/** Format an ISO timestamp string as a short local time (HH:MM:SS). */
function fmtISOTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch (_) { return "—"; }
}

/** Format an ISO timestamp string as full date and time. */
function fmtISODateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch (_) { return "—"; }
}

/** Create a Chart.js gradient fill from a hex colour. */
function makeGradient(ctx, hex, height = 118) {
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, hex + "4a");
  g.addColorStop(1, hex + "00");
  return g;
}


// ── Chart Lifecycle ───────────────────────────────────────────────────────────

/**
 * Create a new Chart.js instance bound to <canvas id="chart-{sid}">.
 * @param {string} sid
 * @returns {Chart|null}
 */
function createChart(sid) {
  const canvas = document.getElementById(`chart-${sid}`);
  if (!canvas) return null;

  const ctx = canvas.getContext("2d");

  return new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label:           "CPU %",
          data:            [],
          borderColor:     COLOR_CPU,
          backgroundColor: makeGradient(ctx, COLOR_CPU),
          borderWidth:     2,
          pointRadius:     0,
          tension:         0.4,
          fill:            true,
          yAxisID:         "y",
        },
        {
          label:           "Mem %",
          data:            [],
          borderColor:     COLOR_MEM,
          backgroundColor: makeGradient(ctx, COLOR_MEM),
          borderWidth:     2,
          pointRadius:     0,
          tension:         0.4,
          fill:            true,
          yAxisID:         "y",
        },
      ],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 350 },
      interaction:         { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(10, 14, 26, 0.95)",
          borderColor:     "rgba(79, 142, 247, 0.25)",
          borderWidth:     1,
          titleColor:      "#94a3b8",
          bodyColor:       "#e2e8f0",
          padding:         8,
          callbacks: {
            title: (items) => items[0].label,
            label: (item)  => ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)}%`,
          },
        },
      },
      scales: {
        x: { display: false },
        y: {
          min:     0,
          max:     100,
          display: true,
          grid: {
            color:       "rgba(255,255,255,0.04)",
            drawBorder:  false,
          },
          ticks: {
            color:         "#475569",
            font:          { size: 9, family: "'JetBrains Mono', monospace" },
            maxTicksLimit: 3,
            callback:      (v) => v + "%",
          },
          border: { display: false },
        },
      },
    },
  });
}

/** Push history data into an existing Chart instance and update without animations. */
function pushHistory(chart, history) {
  if (!chart || !history.length) return;

  chart.data.labels            = history.map(h => h.timestamp.slice(11, 19));
  chart.data.datasets[0].data = history.map(h => h.cpu_pct);
  chart.data.datasets[1].data = history.map(h => h.mem_pct);
  chart.update("none");
}


// ── Card Construction ─────────────────────────────────────────────────────────

/**
 * Return inner HTML markup for a new server card.
 * @param {Object} s
 */
function buildCardHTML(s) {
  const sid  = s.id;
  const cpu  = s.cpu_pct;
  const mem  = s.mem_pct;
  const disk = s.disk_pct;

  const onlineClass = s.online ? "is-online" : "is-offline";
  const onlineLabel = s.online ? "Online"    : "Offline";
  const hasAlert    = activeAlertKeys.has(`${sid}:cpu`) || activeAlertKeys.has(`${sid}:mem`);

  const lastSeenHTML = !s.online && s.last_seen
    ? `<div class="card-last-seen" id="last-seen-${sid}">Last seen ${fmtISOTime(s.last_seen)}</div>`
    : `<div class="card-last-seen" id="last-seen-${sid}"></div>`;

  const alertBadgeHTML = hasAlert
    ? `<span class="alert-badge" id="alert-badge-${sid}">⚠ Alert</span>`
    : `<span class="alert-badge" id="alert-badge-${sid}" hidden></span>`;

  return /* html */`
    <div class="card-header">
      <div class="card-title">
        <div class="server-icon" aria-hidden="true">🖥</div>
        <div>
          <span class="card-hostname" title="${s.hostname}">${s.hostname}</span>
          ${lastSeenHTML}
        </div>
      </div>
      <div class="card-badges">
        ${alertBadgeHTML}
        <span class="status-badge ${onlineClass}" id="badge-${sid}">
          <span class="status-dot" aria-hidden="true"></span>
          ${onlineLabel}
        </span>
      </div>
    </div>

    <div class="card-metrics">

      <!-- CPU -->
      <div class="metric-item">
        <span class="metric-label">CPU</span>
        <span class="metric-value" id="val-cpu-${sid}">
          ${fmt(cpu)}<span class="unit">%</span>
        </span>
        <div class="meter" role="progressbar"
             aria-valuenow="${cpu ?? 0}" aria-valuemin="0" aria-valuemax="100">
          <div class="meter-fill" id="bar-cpu-${sid}"
               data-level="${level(cpu)}"
               style="width:${Math.min(cpu ?? 0, 100)}%"></div>
        </div>
      </div>

      <!-- Memory -->
      <div class="metric-item">
        <span class="metric-label">Memory</span>
        <span class="metric-value" id="val-mem-${sid}">
          ${fmt(mem)}<span class="unit">%</span>
        </span>
        <div class="meter" role="progressbar"
             aria-valuenow="${mem ?? 0}" aria-valuemin="0" aria-valuemax="100">
          <div class="meter-fill" id="bar-mem-${sid}"
               data-level="${level(mem)}"
               style="width:${Math.min(mem ?? 0, 100)}%"></div>
        </div>
      </div>

      <!-- Disk -->
      <div class="metric-item">
        <span class="metric-label">Disk</span>
        <span class="metric-value" id="val-disk-${sid}">
          ${fmt(disk)}<span class="unit">%</span>
        </span>
        <div class="meter" role="progressbar"
             aria-valuenow="${disk ?? 0}" aria-valuemin="0" aria-valuemax="100">
          <div class="meter-fill" id="bar-disk-${sid}"
               data-level="${level(disk)}"
               style="width:${Math.min(disk ?? 0, 100)}%"></div>
        </div>
      </div>

      <!-- RAM Used / Total -->
      <div class="metric-item">
        <span class="metric-label">RAM Used</span>
        <span class="metric-value sm" id="val-ram-${sid}">
          ${fmtMB(s.mem_used_mb)}<span class="unit">/ ${fmtMB(s.mem_total_mb)}</span>
        </span>
      </div>

      <!-- Network I/O -->
      <div class="metric-item span-2">
        <span class="metric-label">Network I/O (interval)</span>
        <span class="metric-value sm" id="val-net-${sid}">
          ↑&nbsp;${fmtMB(s.net_sent_mb)}&nbsp;&nbsp;↓&nbsp;${fmtMB(s.net_recv_mb)}
        </span>
      </div>

    </div>

    <div class="card-chart">
      <p class="chart-title">CPU &amp; Memory — last ${CHART_MAX_PTS} samples</p>
      <div class="chart-wrap">
        <canvas id="chart-${sid}" aria-label="CPU and memory history chart"></canvas>
      </div>
    </div>
  `;
}


// ── Card In-Place Patching ────────────────────────────────────────────────────

/**
 * Patch values of an existing card without touching canvas elements.
 * @param {Object} s
 */
function updateCard(s) {
  const sid  = s.id;
  const cpu  = s.cpu_pct;
  const mem  = s.mem_pct;
  const disk = s.disk_pct;

  const cpuAlert = activeAlertKeys.has(`${sid}:cpu`);
  const memAlert = activeAlertKeys.has(`${sid}:mem`);
  const hasAlert = cpuAlert || memAlert;

  const set = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };

  // Text values
  const cpuClass = cpuAlert ? " is-alert" : "";
  const memClass = memAlert ? " is-alert" : "";
  set(`val-cpu-${sid}`,  `<span class="metric-value${cpuClass}">${fmt(cpu)}<span class="unit">%</span></span>`);
  set(`val-mem-${sid}`,  `<span class="metric-value${memClass}">${fmt(mem)}<span class="unit">%</span></span>`);
  set(`val-disk-${sid}`, `${fmt(disk)}<span class="unit">%</span>`);
  set(`val-ram-${sid}`,
    `${fmtMB(s.mem_used_mb)}<span class="unit">/ ${fmtMB(s.mem_total_mb)}</span>`);
  set(`val-net-${sid}`,
    `↑&nbsp;${fmtMB(s.net_sent_mb)}&nbsp;&nbsp;↓&nbsp;${fmtMB(s.net_recv_mb)}`);

  // Meter bars
  const cpuLevel  = cpuAlert ? "alert" : level(cpu);
  const memLevel  = memAlert ? "alert" : level(mem);
  const diskLevel = level(disk);

  [
    ["cpu", cpu, cpuLevel],
    ["mem", mem, memLevel],
    ["disk", disk, diskLevel],
  ].forEach(([metric, pct, lv]) => {
    const bar = document.getElementById(`bar-${metric}-${sid}`);
    if (bar) {
      bar.style.width   = `${Math.min(pct ?? 0, 100)}%`;
      bar.dataset.level = lv;
      bar.parentElement?.setAttribute("aria-valuenow", pct ?? 0);
    }
  });

  // Status badge
  const badge = document.getElementById(`badge-${sid}`);
  if (badge) {
    const cls   = s.online ? "is-online" : "is-offline";
    const label = s.online ? "Online"    : "Offline";
    badge.className = `status-badge ${cls}`;
    badge.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${label}`;
  }

  // Alert badge
  const ab = document.getElementById(`alert-badge-${sid}`);
  if (ab) {
    ab.hidden = !hasAlert;
  }

  // Last-seen timestamp
  const lsEl = document.getElementById(`last-seen-${sid}`);
  if (lsEl) {
    lsEl.textContent = (!s.online && s.last_seen)
      ? `Last seen ${fmtISOTime(s.last_seen)}`
      : "";
  }

  // Card classes
  const card = document.getElementById(`card-${sid}`);
  if (card) {
    card.classList.toggle("is-offline", !s.online);
    card.classList.toggle("has-alert", hasAlert && s.online);
  }

  // If this server is currently open in the details panel, refresh it too
  if (selectedServerId === sid) {
    renderServerDetail(s);
  }
}


// ── API Fetching ──────────────────────────────────────────────────────────────

async function fetchJSON(url, options = {}) {
  const resp = await fetch(API_BASE + url, options);
  if (!resp.ok) {
    let errorDetail = `HTTP ${resp.status}`;
    try {
      const errBody = await resp.json();
      if (errBody && errBody.description) {
        errorDetail = errBody.description;
      }
    } catch (_) {}
    throw new Error(errorDetail);
  }
  return resp.json();
}

/** Fetch historical metrics for a server. */
async function loadHistory(serverId) {
  try {
    const history = await fetchJSON(`/api/servers/${serverId}/history?limit=${CHART_MAX_PTS}`);
    pushHistory(chartInstances[serverId], history);
    return history;
  } catch (_) {
    return [];
  }
}

/** Fetch active alerts from API and render alerts list. */
async function refreshAlerts() {
  let alerts;
  try {
    alerts = await fetchJSON("/api/alerts");
  } catch (_) {
    return;
  }

  currentAlertsList = alerts;
  activeAlertKeys = new Set(alerts.map(a => `${a.server_id}:${a.resource}`));

  // Header alert badge
  const count = alerts.length;
  alertCountEl.textContent = count;
  alertPlural.textContent  = count === 1 ? "" : "s";
  alertBadge.hidden        = count === 0;

  // Alerts section
  alertsPanel.classList.toggle("hidden", count === 0);
  alertsList.innerHTML = "";

  for (const a of alerts) {
    const resourceLabel = a.resource === "cpu" ? "CPU" : "Memory";
    const startedTime   = fmtISOTime(a.started_at);
    const updatedTime   = fmtISOTime(a.updated_at);

    const li = document.createElement("li");
    li.className = "alert-item";
    li.setAttribute("role", "button");
    li.setAttribute("tabindex", "0");
    li.setAttribute("aria-label", `View alert details for ${a.hostname} ${resourceLabel}`);
    li.innerHTML = `
      <span class="alert-icon" aria-hidden="true">⚠</span>
      <span class="alert-hostname">${a.hostname}</span>
      <span class="alert-resource">${resourceLabel}</span>
      <span class="alert-value">${fmt(a.value)}%</span>
      <span class="alert-threshold">&gt; ${fmt(a.threshold)}%</span>
      <span class="alert-time">since ${startedTime}</span>
    `;

    // Click and keyboard accessibility
    li.addEventListener("click", () => openAlertDetail(a));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openAlertDetail(a);
      }
    });

    alertsList.appendChild(li);
  }
}

/** Load current thresholds from backend. */
async function loadThresholds() {
  try {
    thresholds = await fetchJSON("/api/thresholds");
  } catch (_) {
    // Keep fallback defaults
  }
}


// ── Main Refresh Function ─────────────────────────────────────────────────────

/**
 * Fetch latest servers & alerts, updating cards in-place.
 * @param {boolean} isManual Triggered by the user's click on the Refresh button
 */
async function refreshServers(isManual = false) {
  if (isRefreshing) return;
  isRefreshing = true;

  if (isManual) {
    btnRefresh.disabled = true;
    refreshIcon.classList.add("spinning");
  }

  try {
    await refreshAlerts();

    const servers = await fetchJSON("/api/servers");
    errorBanner.classList.add("hidden");

    // Remove loading placeholder
    const loadingEl = document.getElementById("loading-state");
    if (loadingEl) loadingEl.remove();

    // Cache current servers map
    currentServersMap.clear();
    for (const s of servers) {
      currentServersMap.set(s.id, s);
    }

    // Header counters
    const numOnline  = servers.filter(s => s.online).length;
    const numOffline = servers.length - numOnline;
    onlineEl.textContent  = numOnline;
    offlineEl.textContent = numOffline;
    updatedEl.textContent = nowStr();

    // Render cards
    for (const server of servers) {
      const sid = server.id;

      if (!knownIds.has(sid)) {
        knownIds.add(sid);

        const card    = document.createElement("article");
        card.id        = `card-${sid}`;
        const hasAlert = activeAlertKeys.has(`${sid}:cpu`) || activeAlertKeys.has(`${sid}:mem`);
        card.className = [
          "server-card",
          server.online ? "" : "is-offline",
          hasAlert && server.online ? "has-alert" : "",
        ].filter(Boolean).join(" ");

        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.setAttribute("aria-haspopup", "dialog");
        card.setAttribute("aria-label", `Server ${server.hostname}, click to open details`);
        card.innerHTML = buildCardHTML(server);

        // Click and keyboard handlers to open detail panel
        card.addEventListener("click", (evt) => {
          // Do not navigate or trigger if clicking an internal link
          if (evt.target.closest("button") || evt.target.closest("a")) return;
          openServerDetail(sid);
        });

        card.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter" || evt.key === " ") {
            evt.preventDefault();
            openServerDetail(sid);
          }
        });

        grid.appendChild(card);

        requestAnimationFrame(() => {
          chartInstances[sid] = createChart(sid);
          loadHistory(sid);
        });

      } else {
        updateCard(server);
        loadHistory(sid);
      }
    }

  } catch (err) {
    console.error("Refresh failed:", err);
    errorBanner.classList.remove("hidden");
  } finally {
    isRefreshing = false;
    if (isManual) {
      btnRefresh.disabled = false;
      refreshIcon.classList.remove("spinning");
    }
  }
}


// ── Server Detail Panel Logic ─────────────────────────────────────────────────

/**
 * Open the server details slide-in panel.
 * @param {string} serverId
 */
async function openServerDetail(serverId) {
  selectedServerId = serverId;
  const server = currentServersMap.get(serverId);
  if (!server) return;

  renderServerDetail(server);

  detailBackdrop.classList.remove("hidden");
  detailPanel.classList.remove("hidden");
  btnCloseDetail.focus();

  // Load and render history table
  try {
    const history = await fetchJSON(`/api/servers/${serverId}/history?limit=15`);
    renderDetailHistoryTable(history);
  } catch (_) {
    const historyContainer = document.getElementById("detail-history-container");
    if (historyContainer) {
      historyContainer.innerHTML = `<p class="modal-hint">No history records available.</p>`;
    }
  }
}

/** Render content inside server detail panel body. */
function renderServerDetail(server) {
  const sid = server.id;
  detailTitle.innerHTML = `<span aria-hidden="true">🖥</span> ${server.hostname}`;

  const statusLabel = server.online ? "ONLINE" : "OFFLINE";
  const statusCls   = server.online ? "badge-online" : "badge-offline";
  const hasAlert    = activeAlertKeys.has(`${sid}:cpu`) || activeAlertKeys.has(`${sid}:mem`);

  const alertBadgeStr = hasAlert
    ? `<span class="badge badge-alert" style="margin-left:0.4rem;">⚠ ALERT ACTIVE</span>`
    : "";

  detailBody.innerHTML = `
    <!-- Identity Section -->
    <div class="detail-section">
      <div class="detail-sec-title">Server Identity &amp; Status</div>
      <div class="detail-id-box">
        <span class="detail-id-text" title="Server UUID">${server.id}</span>
      </div>

      <div class="detail-meta-grid">
        <div class="detail-meta-item">
          <div class="detail-meta-label">Status</div>
          <div class="detail-meta-val">
            <span class="badge ${statusCls}">${statusLabel}</span>
            ${alertBadgeStr}
          </div>
        </div>
        <div class="detail-meta-item">
          <div class="detail-meta-label">Last Heartbeat</div>
          <div class="detail-meta-val">${fmtISOTime(server.last_seen)}</div>
        </div>
        <div class="detail-meta-item">
          <div class="detail-meta-label">First Discovered</div>
          <div class="detail-meta-val">${fmtISODateTime(server.first_seen)}</div>
        </div>
        <div class="detail-meta-item">
          <div class="detail-meta-label">Offline Timeout</div>
          <div class="detail-meta-val">${thresholds.offline_seconds}s threshold</div>
        </div>
      </div>
    </div>

    <!-- Live Resource Snapshot -->
    <div class="detail-section">
      <div class="detail-sec-title">Live Resource Snapshot</div>
      <div class="detail-stats-grid">
        <div class="detail-stat-card">
          <div class="detail-stat-label">CPU Usage</div>
          <div class="detail-stat-val" style="color: ${server.cpu_pct > thresholds.cpu_pct ? 'var(--orange)' : 'var(--text-primary)'}">
            ${fmt(server.cpu_pct)}<span class="unit">%</span>
          </div>
        </div>

        <div class="detail-stat-card">
          <div class="detail-stat-label">Memory Usage</div>
          <div class="detail-stat-val" style="color: ${server.mem_pct > thresholds.mem_pct ? 'var(--orange)' : 'var(--text-primary)'}">
            ${fmt(server.mem_pct)}<span class="unit">%</span>
          </div>
        </div>

        <div class="detail-stat-card">
          <div class="detail-stat-label">RAM Allocated</div>
          <div class="detail-stat-val sm">
            ${fmtMB(server.mem_used_mb)} <span class="unit">/ ${fmtMB(server.mem_total_mb)}</span>
          </div>
        </div>

        <div class="detail-stat-card">
          <div class="detail-stat-label">Root Disk</div>
          <div class="detail-stat-val">
            ${fmt(server.disk_pct)}<span class="unit">%</span>
          </div>
        </div>

        <div class="detail-stat-card span-2">
          <div class="detail-stat-label">Network Transfer (per 5s interval)</div>
          <div class="detail-stat-val sm">
            ↑ ${fmtMB(server.net_sent_mb)} &nbsp;&nbsp; ↓ ${fmtMB(server.net_recv_mb)}
          </div>
        </div>
      </div>
    </div>

    <!-- Historical Samples -->
    <div class="detail-section">
      <div class="detail-sec-title">Recent Metric History</div>
      <div class="detail-history-wrap" id="detail-history-container">
        <p class="modal-hint">Loading historical samples&hellip;</p>
      </div>
    </div>
  `;
}

/** Render recent samples table inside history container. */
function renderDetailHistoryTable(history) {
  const container = document.getElementById("detail-history-container");
  if (!container) return;

  if (!history || history.length === 0) {
    container.innerHTML = `<p class="modal-hint" style="padding:0.75rem;">No historical records found for this container.</p>`;
    return;
  }

  // Reverse so newest is at the top of the table
  const rows = [...history].reverse();

  let rowsHTML = "";
  for (const row of rows) {
    rowsHTML += `
      <tr>
        <td>${fmtISOTime(row.timestamp)}</td>
        <td>${fmt(row.cpu_pct)}%</td>
        <td>${fmt(row.mem_pct)}%</td>
        <td>${fmt(row.disk_pct)}%</td>
        <td>↑ ${fmtMB(row.net_sent_mb)}</td>
        <td>↓ ${fmtMB(row.net_recv_mb)}</td>
      </tr>
    `;
  }

  container.innerHTML = `
    <table class="detail-history-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>CPU</th>
          <th>Memory</th>
          <th>Disk</th>
          <th>Sent</th>
          <th>Recv</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHTML}
      </tbody>
    </table>
  `;
}

/** Close server detail panel. */
function closeServerDetail() {
  selectedServerId = null;
  detailPanel.classList.add("hidden");
  detailBackdrop.classList.add("hidden");
}


// ── Alert Detail Modal Logic ──────────────────────────────────────────────────

/**
 * Open alert details modal.
 * @param {Object} alert
 */
function openAlertDetail(alert) {
  const resourceName = alert.resource === "cpu" ? "CPU" : "Memory";
  alertDetailHeading.textContent = `Alert: ${alert.hostname} (${resourceName})`;

  alertDetailBody.innerHTML = `
    <div class="alert-detail-list">
      <div class="alert-detail-row">
        <span class="alert-detail-label">Status</span>
        <span class="badge badge-alert">ACTIVE ALERT</span>
      </div>

      <div class="alert-detail-row">
        <span class="alert-detail-label">Container Hostname</span>
        <span class="alert-detail-val">${alert.hostname}</span>
      </div>

      <div class="alert-detail-row">
        <span class="alert-detail-label">Agent UUID</span>
        <span class="alert-detail-val" style="font-size:0.75rem; word-break:break-all;">${alert.server_id}</span>
      </div>

      <div class="alert-detail-row">
        <span class="alert-detail-label">Resource Type</span>
        <span class="alert-detail-val">${resourceName}</span>
      </div>

      <div class="alert-detail-row">
        <span class="alert-detail-label">Measured Value</span>
        <span class="alert-detail-val alert-val-highlight">${fmt(alert.value)}%</span>
      </div>

      <div class="alert-detail-row">
        <span class="alert-detail-label">Configured Threshold</span>
        <span class="alert-detail-val">${fmt(alert.threshold)}%</span>
      </div>

      <div class="alert-detail-row">
        <span class="alert-detail-label">Alert Triggered</span>
        <span class="alert-detail-val">${fmtISODateTime(alert.started_at)}</span>
      </div>

      <div class="alert-detail-row">
        <span class="alert-detail-label">Last Evaluated</span>
        <span class="alert-detail-val">${fmtISOTime(alert.updated_at)}</span>
      </div>
    </div>

    <p class="modal-hint" style="margin-top:1.2rem; margin-bottom:0;">
      ℹ️ This alert was created automatically when real container usage exceeded the ${fmt(alert.threshold)}% limit.
      It will automatically resolve and disappear when usage drops below the threshold.
    </p>
  `;

  alertDetailBackdrop.classList.remove("hidden");
  alertDetailModal.classList.remove("hidden");
  btnCloseAlertDetail.focus();
}

/** Close alert detail modal. */
function closeAlertDetail() {
  alertDetailModal.classList.add("hidden");
  alertDetailBackdrop.classList.add("hidden");
}


// ── Settings Modal Logic ──────────────────────────────────────────────────────

/** Open settings modal and populate with current values. */
async function openSettings() {
  await loadThresholds();

  inputCpu.value = thresholds.cpu_pct ?? 80;
  inputMem.value = thresholds.mem_pct ?? 80;

  settingsFeedback.className = "settings-feedback";
  settingsFeedback.textContent = "";

  settingsBackdrop.classList.remove("hidden");
  settingsModal.classList.remove("hidden");
  inputCpu.focus();
}

/** Close settings modal. */
function closeSettings() {
  settingsModal.classList.add("hidden");
  settingsBackdrop.classList.add("hidden");
}

/** Validate inputs and save thresholds via PUT /api/thresholds. */
async function saveSettings() {
  const cpuVal = parseFloat(inputCpu.value);
  const memVal = parseFloat(inputMem.value);

  // Client-side validation
  if (isNaN(cpuVal) || cpuVal < 1 || cpuVal > 100) {
    settingsFeedback.className = "settings-feedback error";
    settingsFeedback.textContent = "CPU threshold must be a number between 1 and 100.";
    inputCpu.focus();
    return;
  }

  if (isNaN(memVal) || memVal < 1 || memVal > 100) {
    settingsFeedback.className = "settings-feedback error";
    settingsFeedback.textContent = "Memory threshold must be a number between 1 and 100.";
    inputMem.focus();
    return;
  }

  btnSaveSettings.disabled = true;
  settingsFeedback.className = "settings-feedback";
  settingsFeedback.textContent = "Saving thresholds to server...";

  try {
    const updated = await fetchJSON("/api/thresholds", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cpu_pct: cpuVal, mem_pct: memVal }),
    });

    thresholds.cpu_pct = updated.cpu_pct;
    thresholds.mem_pct = updated.mem_pct;

    settingsFeedback.className = "settings-feedback success";
    settingsFeedback.textContent = `✓ Thresholds updated (CPU: ${updated.cpu_pct}%, Memory: ${updated.mem_pct}%).`;

    // Immediately trigger refresh to re-evaluate active alerts
    await refreshServers();

    setTimeout(() => {
      closeSettings();
      btnSaveSettings.disabled = false;
    }, 700);

  } catch (err) {
    settingsFeedback.className = "settings-feedback error";
    settingsFeedback.textContent = `Error saving settings: ${err.message}`;
    btnSaveSettings.disabled = false;
  }
}


// ── Global Dismissal & Event Listeners ────────────────────────────────────────

/** Close any open modal or panel (Escape key or backdrop click). */
function closeAllModals() {
  closeServerDetail();
  closeAlertDetail();
  closeSettings();
}

function initEventHandlers() {
  // Manual Refresh
  btnRefresh.addEventListener("click", () => refreshServers(true));

  // Settings
  btnSettings.addEventListener("click", openSettings);
  btnCloseSettings.addEventListener("click", closeSettings);
  btnCancelSettings.addEventListener("click", closeSettings);
  btnSaveSettings.addEventListener("click", saveSettings);
  settingsBackdrop.addEventListener("click", closeSettings);

  // Enter key inside settings inputs saves settings
  inputCpu.addEventListener("keydown", (e) => { if (e.key === "Enter") saveSettings(); });
  inputMem.addEventListener("keydown", (e) => { if (e.key === "Enter") saveSettings(); });

  // Server Details Panel
  btnCloseDetail.addEventListener("click", closeServerDetail);
  detailBackdrop.addEventListener("click", closeServerDetail);

  // Alert Details Modal
  btnCloseAlertDetail.addEventListener("click", closeAlertDetail);
  alertDetailBackdrop.addEventListener("click", closeAlertDetail);

  // Global Escape key
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAllModals();
    }
  });
}


// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  initEventHandlers();
  await loadThresholds();
  await refreshServers();
  setInterval(refreshServers, POLL_INTERVAL);
});
