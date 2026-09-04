let socket = null;
let currentTasks = [];
let currentRemotes = [];
let remotesDetails = [];
let detectedSources = [];
let remoteStatusMap = {};
let remoteQuotaMap = {};
let isCustomSourceMode = false;

// Guards to prevent duplicate/concurrent fetches
let isFetchingRemotes = false;
let lastRemotesFetchTime = 0;
const REMOTES_CACHE_TTL_MS = 20 * 1000; // 20 seconds
const remoteQuotaFetchingSet = new Set(); // tracks which remotes have an active quota fetch

// Log pagination state
let logsCurrentPage = 0;
let logsTotalCount = 0;
const LOGS_PAGE_SIZE = 25;
let currentLogs = [];

// Cloud browser state (keyed by browser ID)
const cloudBrowserState = {};

// Folder browser state for source picker
const folderBrowserState = { currentPath: '/hostfs', history: [] };

// Transfer state
let transferSelectedPath = { device: null, cloudSrc: null };

let appBooted = false;
function boot() {
  if (appBooted) return;
  appBooted = true;
  initApp();
  initWebSocket();
  setupEventListeners();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  // DOM already loaded or interactive - boot immediately
  boot();
}

async function initApp() {
  try {
    await checkPinAuthStatus();
  } catch (e) {
    console.warn('PIN check failed, continuing initialization:', e);
  }
  await Promise.allSettled([
    fetchStatus(),
    fetchTasks(),
    fetchRemotes(),
    fetchSources(),
    fetchHistoryLogs(),
    fetchSettings(),
    fetchStorageAlerts(),
    fetchAppVersion()
  ]);
}

// ─── Utility ───────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Debounce helper — returns a function that delays invoking fn until after wait ms.
 */
function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/**
 * Format file size bytes to human readable string
 */
function formatFileSize(bytes) {
  if (!bytes || bytes < 0) return '--';
  if (bytes === 0) return '0 B';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Parse source_path into an array of container paths
 */
function parseSourcePaths(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  const str = String(input).trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const arr = JSON.parse(str);
      if (Array.isArray(arr)) return arr;
    } catch(e) {}
  }
  if (str.includes(',')) {
    return str.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [str];
}

/**
 * Format next run timestamp into human readable relative or date format
 */
function formatNextRun(isoString, cronSchedule) {
  if (!isoString) {
    if (cronSchedule === 'last_friday') return 'Next Last Friday 02:00 AM';
    return 'Scheduled';
  }
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = date - now;
  if (diffMs <= 0) return 'Imminent';

  const diffMins = Math.round(diffMs / (1000 * 60));
  if (diffMins < 60) return `In ${diffMins} min${diffMins === 1 ? '' : 's'}`;

  const diffHours = Math.round(diffMs / (1000 * 60 * 60));
  if (diffHours < 24 && date.getDate() === now.getDate()) {
    return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (diffHours < 48 && (date.getDate() === now.getDate() + 1 || (now.getDate() === 31 && date.getDate() === 1))) {
    return `Tomorrow at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Append a formatted log line to the live execution console window
 */
const consoleQueue = [];
let consoleRafScheduled = false;

function flushConsoleQueue() {
  const consoleWin = document.getElementById('console-output');
  if (!consoleWin || consoleQueue.length === 0) {
    consoleRafScheduled = false;
    return;
  }

  const fragment = document.createDocumentFragment();
  const batch = consoleQueue.splice(0, 100);

  for (const item of batch) {
    const lineEl = document.createElement('div');
    lineEl.className = `console-line ${item.type}`;
    lineEl.textContent = item.lineText;
    fragment.appendChild(lineEl);
  }

  consoleWin.appendChild(fragment);

  // Keep max 300 lines in DOM to keep memory and CPU lean
  while (consoleWin.children.length > 300) {
    consoleWin.removeChild(consoleWin.firstChild);
  }
  consoleWin.scrollTop = consoleWin.scrollHeight;

  if (consoleQueue.length > 0) {
    requestAnimationFrame(flushConsoleQueue);
  } else {
    consoleRafScheduled = false;
  }
}

function appendConsoleLine(text, type = 'normal') {
  const textStr = String(text || '');
  const lines = textStr.split('\n');

  lines.forEach((lineText, idx) => {
    if (!lineText && idx === lines.length - 1) return;
    consoleQueue.push({ lineText, type });
  });

  if (consoleQueue.length > 500) {
    consoleQueue.splice(0, consoleQueue.length - 500);
  }

  if (!consoleRafScheduled) {
    consoleRafScheduled = true;
    requestAnimationFrame(flushConsoleQueue);
  }
}

// ─── Status ────────────────────────────────────────────────────────────────

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    document.getElementById('stat-active-tasks').textContent = data.activeTasksCount || 0;
    document.getElementById('stat-remotes-count').textContent = data.connectedRemotesCount || 0;
    document.getElementById('stat-total-runs').textContent = data.totalLogEntries || 0;

    const nextRunElement = document.getElementById('stat-next-run');
    if (data.nextScheduledRun) {
      nextRunElement.textContent = formatNextRun(data.nextScheduledRun, data.nextScheduledCron);
    } else {
      nextRunElement.textContent = 'No Active Schedule';
    }

    const badge = document.getElementById('system-status-badge');
    if (data.rcloneInstalled) {
      badge.innerHTML = '<span class="pulse-dot"></span> System Ready (Rclone Active)';
    } else {
      badge.innerHTML = '⚠️ Rclone Binary Missing';
      badge.style.borderColor = '#f59e0b';
      badge.style.color = '#f59e0b';
    }

    const persistBadge = document.getElementById('persistence-status-badge');
    if (persistBadge) {
      if (data.hasSeedConfig) {
        persistBadge.textContent = 'Seed Protected';
        persistBadge.className = 'badge badge-success';
      } else {
        persistBadge.textContent = 'Standard';
        persistBadge.className = 'badge badge-secondary';
      }
    }
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

// ─── Tasks ─────────────────────────────────────────────────────────────────

async function fetchTasks() {
  try {
    const res = await fetch('/api/tasks');
    currentTasks = await res.json();
    renderTasks();
  } catch (err) {
    console.error('Failed to fetch tasks:', err);
  }
}

function renderTasks() {
  const container = document.getElementById('tasks-container');
  const emptyState = document.getElementById('tasks-empty');
  const countBadge = document.getElementById('tasks-badge-count');
  const remoteFilter = document.getElementById('tasks-remote-filter')?.value || 'all';

  if (!container) return;

  const filteredTasks = remoteFilter === 'all'
    ? currentTasks
    : currentTasks.filter(t => t.target_remote === remoteFilter);

  if (countBadge) {
    countBadge.textContent = `${filteredTasks.length} Task(s)`;
  }

  if (filteredTasks.length === 0) {
    if (emptyState) {
      container.replaceChildren(emptyState);
      emptyState.classList.remove('hidden');
    } else {
      container.innerHTML = '<div class="empty-state"><p>No backup tasks configured.</p></div>';
    }
    return;
  }

  container.innerHTML = '';

  filteredTasks.forEach(task => {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.taskId = task.id;

    let statusClass = `status-${task.last_status || 'idle'}`;
    let statusLabel = task.last_status ? task.last_status.toUpperCase() : 'IDLE';
    if (task.last_status === 'paused') {
      statusClass = 'status-badge-paused';
      statusLabel = '⏸️ PAUSED';
    } else if (task.last_status === 'paused_network') {
      statusClass = 'status-badge-network-paused';
      statusLabel = '📶 OFFLINE PAUSED';
    } else if (task.last_status === 'partial' || task.failed_files_count > 0) {
      statusClass = 'status-badge-partial';
      statusLabel = `⚠️ PARTIAL (${task.failed_files_count || 1} SKIPPED)`;
    }

    let scheduleDisplay = task.cron_schedule;
    if (task.cron_schedule === 'last_friday') scheduleDisplay = '🏆 Backup Day (Last Friday)';
    else if (task.cron_schedule === 'monthly' || task.cron_schedule === '0 3 1 * *') scheduleDisplay = '📅 Monthly (1st of Month)';
    else if (task.cron_schedule === 'weekly' || task.cron_schedule === '0 3 * * 0') scheduleDisplay = '📅 Weekly (Every Sunday)';
    else if (task.cron_schedule === 'daily' || task.cron_schedule === '0 2 * * *') scheduleDisplay = '📅 Daily (Daily / Laptop Catchup)';

    let priority = task.priority;
    if (!priority || priority === 'normal') {
      if (task.cron_schedule === 'last_friday') priority = 'critical';
      else if (task.cron_schedule === 'monthly') priority = 'high';
      else if (task.cron_schedule === 'weekly') priority = 'medium';
      else if (task.cron_schedule === 'daily') priority = 'low';
      else priority = 'normal';
    }

    let priorityBadgeHtml = '';
    if (priority === 'critical') {
      priorityBadgeHtml = `<span class="badge" style="background:rgba(244,63,94,0.15); color:#fb7185; border:1px solid rgba(244,63,94,0.35); font-size:0.68rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:4px;">🏆 CRITICAL</span>`;
    } else if (priority === 'high') {
      priorityBadgeHtml = `<span class="badge" style="background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.35); font-size:0.68rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:4px;">📅 HIGH</span>`;
    } else if (priority === 'medium') {
      priorityBadgeHtml = `<span class="badge" style="background:rgba(139,92,246,0.15); color:#c4b5fd; border:1px solid rgba(139,92,246,0.35); font-size:0.68rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:4px;">📅 MEDIUM</span>`;
    } else if (priority === 'low') {
      priorityBadgeHtml = `<span class="badge" style="background:rgba(59,130,246,0.15); color:#93c5fd; border:1px solid rgba(59,130,246,0.35); font-size:0.68rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:4px;">📅 LOW</span>`;
    } else {
      priorityBadgeHtml = `<span class="badge" style="font-size:0.68rem; padding:0.1rem 0.45rem; border-radius:4px;">${priority.toUpperCase()}</span>`;
    }

    if (task.realtime_watch) {
      priorityBadgeHtml += ` <span class="badge" style="background:rgba(0,242,254,0.15); color:#00f2fe; border:1px solid rgba(0,242,254,0.35); font-size:0.68rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:4px;" title="Real-time instant sync active">⚡ REALTIME</span>`;
    }
    if (task.encrypt_backup) {
      priorityBadgeHtml += ` <span class="badge" style="background:rgba(139,92,246,0.15); color:#c4b5fd; border:1px solid rgba(139,92,246,0.35); font-size:0.68rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:4px;" title="AES-256 Zero-knowledge client-side encrypted">🔒 ENCRYPTED</span>`;
    }
    if (task.bundle_archive) {
      priorityBadgeHtml += ` <span class="badge" style="background:rgba(234,179,8,0.15); color:#fde047; border:1px solid rgba(234,179,8,0.35); font-size:0.68rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:4px;" title="Archive & Ship fast bundling enabled">📦 BUNDLED</span>`;
    }
    if (task.smart_code_filter !== 0) {
      priorityBadgeHtml += ` <span class="badge" style="background:rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.35); font-size:0.68rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:4px;" title="Smart dependency & build cache exclusions enabled">🧠 FILTERED</span>`;
    }

    const conflictLabel = (task.conflict_mode || 'smart').toUpperCase();
    const sourcePaths = parseSourcePaths(task.source_path);

    let sourcePathDisplay = '';
    if (sourcePaths.length > 1) {
      sourcePathDisplay = `<span class="path-chip" title="${escapeHtml(sourcePaths.join(', '))}">📁 ${sourcePaths.length} Source Folders</span>`;
    } else if (sourcePaths.length === 1) {
      sourcePathDisplay = `<span class="path-chip" title="${escapeHtml(sourcePaths[0])}">${escapeHtml(sourcePaths[0])}</span>`;
    } else {
      sourcePathDisplay = `<span class="path-chip">${escapeHtml(task.source_path)}</span>`;
    }

    const nextRunDisplay = formatNextRun(task.next_run, task.cron_schedule);
    const isRunning = task.last_status === 'running';
    const isPaused = task.last_status === 'paused' || task.last_status === 'paused_network';

    let actionButtonsHtml = '';
    if (isRunning) {
      actionButtonsHtml = `
        <button class="btn btn-sm btn-secondary btn-pause-task" data-id="${task.id}" style="color:#fde047; border-color:rgba(234,179,8,0.4);" title="Pause Running Backup">
          ⏸ Pause
        </button>
        <button class="btn btn-sm btn-outline btn-stop-task" data-id="${task.id}" style="color:#fb7185; border-color:rgba(244,63,94,0.4);" title="Stop Running Backup Task">
          ⏹ Stop
        </button>
      `;
    } else if (isPaused) {
      actionButtonsHtml = `
        <button class="btn btn-sm btn-primary btn-resume-task" data-id="${task.id}" style="background: linear-gradient(135deg, #10b981, #059669); border-color:#10b981;" title="Resume Backup Task">
          ▶ Resume
        </button>
        <button class="btn btn-sm btn-secondary btn-partial-run-task" data-id="${task.id}" title="Run Selected Folders Only">
          📂 Run Partial...
        </button>
        ${(task.failed_files_count > 0 || task.last_status === 'partial') ? `
        <button class="btn btn-sm btn-secondary btn-failed-files" data-id="${task.id}" style="color:#fbbf24; border-color:rgba(245,158,11,0.4); background:rgba(245,158,11,0.08);" title="Check and retry failed/skipped files">
          ⚠️ Failed Files (${task.failed_files_count || 0})
        </button>` : ''}
        <button class="btn btn-sm btn-secondary btn-edit-task" data-id="${task.id}" title="Edit Task">
          <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
        </button>
        <button class="btn btn-sm btn-danger-outline btn-delete-task" data-id="${task.id}" title="Delete Task">
          <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      `;
    } else {
      actionButtonsHtml = `
        <button class="btn btn-sm btn-primary btn-run-now" data-id="${task.id}" title="Run Backup Task Now">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          Run
        </button>
        <button class="btn btn-sm btn-secondary btn-partial-run-task" data-id="${task.id}" title="Run Selected Folders Only">
          📂 Run Partial...
        </button>
        ${(task.failed_files_count > 0 || task.last_status === 'partial') ? `
        <button class="btn btn-sm btn-secondary btn-failed-files" data-id="${task.id}" style="color:#fbbf24; border-color:rgba(245,158,11,0.4); background:rgba(245,158,11,0.08);" title="Check and retry failed/skipped files">
          ⚠️ Failed Files (${task.failed_files_count || 0})
        </button>` : ''}
        <button class="btn btn-sm btn-outline btn-dry-run" data-id="${task.id}" title="Dry Run Simulation">
          🧪 Dry Run
        </button>
        <button class="btn btn-sm btn-secondary btn-edit-task" data-id="${task.id}" title="Edit Task">
          <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
        </button>
        <button class="btn btn-sm btn-danger-outline btn-delete-task" data-id="${task.id}" title="Delete Task">
          <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      `;
    }

    // Progress bar (shown when running)
    const progressBarHtml = isRunning
      ? `<div class="task-progress-bar" id="progress-bar-${task.id}">
           <div class="task-progress-fill task-progress-pulse" style="width:100%"></div>
         </div>`
      : `<div class="task-progress-bar hidden" id="progress-bar-${task.id}">
           <div class="task-progress-fill" style="width:0%"></div>
         </div>`;

    card.innerHTML = `
      <div class="task-card-header">
        <div>
          <div class="task-title">
            <span>${escapeHtml(task.name)}</span>
            <span class="remote-type-badge">${task.mode.toUpperCase()}</span>
            ${priorityBadgeHtml}
            ${task.bw_limit ? `<span class="badge" style="font-size:0.68rem; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); padding:0.1rem 0.4rem; border-radius:4px;">⚡ ${task.bw_limit}</span>` : ''}
          </div>
          <div class="task-path-row" style="margin-top: 0.35rem;">
            ${sourcePathDisplay}
            <span style="color: var(--text-dim);">➔</span>
            <span class="target-remote-chip">☁️ ${escapeHtml(task.target_remote)}:${escapeHtml(task.target_path || '/')}</span>
          </div>
        </div>
        <div class="task-actions-group">
          ${actionButtonsHtml}
        </div>
      </div>

      ${progressBarHtml}

      <div class="task-meta-bar">
        <span>🕒 Schedule: <strong>${escapeHtml(scheduleDisplay)}</strong></span>
        <span>🕒 Last Run: ${task.last_run ? new Date(task.last_run).toLocaleString() : 'Never'}</span>
        <span>⏳ Next Run: <strong>${escapeHtml(nextRunDisplay)}</strong></span>
        <span class="${statusClass}" id="status-pill-${task.id}" style="font-weight:700; font-size:0.72rem;">${statusLabel}</span>
      </div>
    `;

    container.appendChild(card);
  });

  const statNext = document.getElementById('stat-next-run');
  if (statNext) statNext.textContent = 'Scheduled Cron Active';
}

// ─── Sources ───────────────────────────────────────────────────────────────

async function fetchSources() {
  try {
    const res = await fetch('/api/sources');
    detectedSources = await res.json();
    populateSourcesDropdown();
    renderDashboardTreeExplorer();
  } catch (err) {
    console.error('Failed to fetch sources:', err);
  }
}

function populateSourcesDropdown() {
  const select = document.getElementById('task-source-select');
  if (!select) return;
  if (detectedSources.length === 0) {
    select.innerHTML = '<option value="">No mounted volumes detected in docker-compose.yml</option>';
    return;
  }

  select.innerHTML = '<option value="">Select a mounted laptop folder...</option>' +
    detectedSources.map(s => `<option value="${escapeHtml(s.containerPath)}">${escapeHtml(s.label)}</option>`).join('');
}

/**
 * Build hierarchical Tree structure from detectedSources
 */
function buildContainerTree(sourcesList) {
  const root = {
    name: 'root',
    path: 'root',
    isDir: true,
    children: {},
    containerPath: null,
    hostPath: null
  };

  sourcesList.forEach(src => {
    if (!src || !src.containerPath) return;
    const raw = String(src.containerPath).replace(/^(\/|root\/)+/, '').replace(/\/$/, '');
    const parts = raw.split('/').filter(Boolean);

    let curr = root;
    parts.forEach((part, idx) => {
      const isLeaf = (idx === parts.length - 1);
      if (!curr.children[part]) {
        curr.children[part] = {
          name: part,
          path: curr.path + '/' + part,
          isDir: !isLeaf,
          children: {},
          containerPath: isLeaf ? src.containerPath : null,
          hostPath: isLeaf ? src.hostPath : null,
          sourceId: isLeaf ? src.id : null,
          sourceType: isLeaf ? src.source : null,
          tags: isLeaf ? src.tags : null
        };
      }
      curr = curr.children[part];
    });
  });

  return root;
}

/**
 * Render Interactive Tree Component HTML into target container
 */
function renderTreeWidget(treeRoot, targetContainerEl, isSelectable = true, initialSelectedPaths = []) {
  const selectedSet = new Set(initialSelectedPaths);

  function createNodeElement(node) {
    const nodeEl = document.createElement('div');
    nodeEl.className = `tree-node ${node.name === 'root' ? 'tree-node-root' : ''}`;

    const rowEl = document.createElement('div');
    rowEl.className = 'tree-row';

    // Toggle Chevron
    const toggleEl = document.createElement('span');
    toggleEl.className = 'tree-toggle expanded';
    toggleEl.innerHTML = node.isDir && Object.keys(node.children).length > 0 ? '▶' : '';

    // Checkbox (if selectable)
    let checkboxEl = null;
    if (isSelectable) {
      checkboxEl = document.createElement('input');
      checkboxEl.type = 'checkbox';
      checkboxEl.className = 'tree-checkbox';
      if (!node.isDir && selectedSet.has(node.containerPath)) {
        checkboxEl.checked = true;
      }
    }

    // Icon
    const iconEl = document.createElement('span');
    iconEl.className = 'tree-icon';
    if (node.name === 'root') iconEl.textContent = '📁';
    else if (node.isDir) iconEl.textContent = '📂';
    else iconEl.textContent = '📦';

    // Label
    const labelEl = document.createElement('span');
    labelEl.className = 'tree-label';
    labelEl.textContent = node.name === 'root' ? 'root/' : (node.isDir ? `${node.name}/` : node.name);

    rowEl.appendChild(toggleEl);
    if (checkboxEl) rowEl.appendChild(checkboxEl);
    rowEl.appendChild(iconEl);
    rowEl.appendChild(labelEl);

    // Host path pill
    if (node.hostPath) {
      const hostEl = document.createElement('span');
      hostEl.className = 'tree-host-path';
      hostEl.textContent = `Laptop: ${node.hostPath}`;
      rowEl.appendChild(hostEl);
    }

    // Source Tag Badges
    if (node.tags) {
      const tagsArr = String(node.tags).split(',').map(t => t.trim()).filter(Boolean);
      tagsArr.forEach(t => {
        const badge = document.createElement('span');
        badge.className = 'source-tag-badge';
        badge.textContent = `🏷️ ${t}`;
        rowEl.appendChild(badge);
      });
    }

    // User-defined source edit & delete buttons (in dashboard tree)
    if (!isSelectable && node.sourceId && node.sourceType === 'user') {
      const actionGroup = document.createElement('div');
      actionGroup.className = 'tree-actions-group';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn-tree-action btn-tree-edit';
      editBtn.textContent = '✎ Edit';
      editBtn.title = 'Edit this source folder path or drive';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditSourceModal(node.sourceId, node.name, node.hostPath, node.tags);
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-tree-action btn-tree-del';
      delBtn.textContent = '✕ Remove';
      delBtn.title = 'Remove this user-defined source folder';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSourceFolder(node.sourceId);
      });

      actionGroup.appendChild(editBtn);
      actionGroup.appendChild(delBtn);
      rowEl.appendChild(actionGroup);
    }

    nodeEl.appendChild(rowEl);

    // Children block
    let childrenEl = null;
    const childKeys = Object.keys(node.children);
    if (childKeys.length > 0) {
      childrenEl = document.createElement('div');
      childrenEl.className = 'tree-children';

      childKeys.sort().forEach(key => {
        const childNodeEl = createNodeElement(node.children[key]);
        childrenEl.appendChild(childNodeEl);
      });

      nodeEl.appendChild(childrenEl);

      // Toggle click handler
      toggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        childrenEl.classList.toggle('collapsed');
        toggleEl.classList.toggle('expanded');
      });
    }

    // Checkbox cascading handlers
    if (isSelectable && checkboxEl) {
      if (!node.isDir && node.containerPath) {
        checkboxEl.dataset.containerPath = node.containerPath;
      }

      checkboxEl.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        if (node.containerPath) {
          if (isChecked) taskSelectedFoldersSet.add(node.containerPath);
          else taskSelectedFoldersSet.delete(node.containerPath);
        }
        if (childrenEl) {
          childrenEl.querySelectorAll('.tree-checkbox[data-container-path]').forEach(cb => {
            cb.checked = isChecked;
            cb.indeterminate = false;
            if (cb.dataset.containerPath) {
              if (isChecked) taskSelectedFoldersSet.add(cb.dataset.containerPath);
              else taskSelectedFoldersSet.delete(cb.dataset.containerPath);
            }
          });
        }
        updateParentCheckboxStates(targetContainerEl);
        renderTaskSelectedChips();
      });
    }

    return nodeEl;
  }

  targetContainerEl.innerHTML = '';
  const rootEl = createNodeElement(treeRoot);
  targetContainerEl.appendChild(rootEl);

  if (isSelectable) {
    updateParentCheckboxStates(targetContainerEl);
    renderTaskSelectedChips();
  }
}

const taskSelectedFoldersSet = new Set();

function renderTaskSelectedChips() {
  const tray = document.getElementById('task-selected-chips-tray');
  const countBadge = document.getElementById('task-selected-badge-count');
  const modalCount = document.getElementById('modal-selected-count');
  const input = document.getElementById('task-source-input');
  if (!tray) return;

  const folders = Array.from(taskSelectedFoldersSet);
  if (countBadge) countBadge.textContent = folders.length;
  if (modalCount) modalCount.textContent = `${folders.length} folder(s) selected`;
  if (input) input.value = folders.join(', ');

  if (folders.length === 0) {
    tray.innerHTML = '<span class="opacity-60 text-xs" id="task-no-folders-msg">No folders selected yet. Check folders in tree below or use Quick Add.</span>';
    return;
  }

  tray.innerHTML = folders.map(f => {
    const isDrive = f.startsWith('/hostfs/') || /^[A-Z]:/i.test(f);
    const icon = isDrive ? '💾' : '📁';
    return `
      <div class="task-folder-chip" title="${escapeHtml(f)}">
        <span>${icon}</span>
        <span style="max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(f)}</span>
        <button type="button" class="chip-remove-btn" onclick="removeTaskFolder('${escapeHtml(f)}')" title="Remove this folder">&times;</button>
      </div>
    `;
  }).join('');
}

function addTaskFolder(path) {
  if (!path) return;
  const p = path.trim();
  if (!p) return;
  taskSelectedFoldersSet.add(p);
  renderTaskSelectedChips();
  syncTreeFromSelectedFolders();
}

function removeTaskFolder(path) {
  taskSelectedFoldersSet.delete(path);
  renderTaskSelectedChips();
  syncTreeFromSelectedFolders();
}

function clearAllTaskFolders() {
  taskSelectedFoldersSet.clear();
  renderTaskSelectedChips();
  syncTreeFromSelectedFolders();
}

function syncTreeFromSelectedFolders() {
  const container = document.getElementById('modal-container-tree');
  if (!container) return;
  const allCheckboxes = container.querySelectorAll('.tree-checkbox[data-container-path]');
  allCheckboxes.forEach(cb => {
    cb.checked = taskSelectedFoldersSet.has(cb.dataset.containerPath);
  });
  updateParentCheckboxStates(container);
}

function updateParentCheckboxStates(containerEl) {
  if (!containerEl) return;
  const nodeEls = Array.from(containerEl.querySelectorAll('.tree-node'));
  
  // Update from bottom to top
  nodeEls.reverse().forEach(nodeEl => {
    const childrenBlock = nodeEl.querySelector(':scope > .tree-children');
    const parentCheckbox = nodeEl.querySelector(':scope > .tree-row > .tree-checkbox');
    if (childrenBlock && parentCheckbox) {
      const childCheckboxes = Array.from(childrenBlock.querySelectorAll('.tree-checkbox'));
      const checkedCount = childCheckboxes.filter(cb => cb.checked).length;
      if (checkedCount === 0) {
        parentCheckbox.checked = false;
        parentCheckbox.indeterminate = false;
      } else if (checkedCount === childCheckboxes.length) {
        parentCheckbox.checked = true;
        parentCheckbox.indeterminate = false;
      } else {
        parentCheckbox.checked = false;
        parentCheckbox.indeterminate = true;
      }
    }
  });
}

function updateSelectedCount() {
  renderTaskSelectedChips();
}

function getSelectedContainersFromTree() {
  return Array.from(taskSelectedFoldersSet);
}

let activeSourceTagFilter = 'all';
let activeSourceSearchQuery = '';

function renderSourceTagPills() {
  const container = document.getElementById('source-tag-pills');
  if (!container) return;

  const tagSet = new Set();
  detectedSources.forEach(s => {
    if (s.tags) {
      s.tags.split(',').map(t => t.trim()).filter(Boolean).forEach(t => tagSet.add(t));
    }
  });

  const tags = Array.from(tagSet).sort();
  let html = `<span class="tag-pill ${activeSourceTagFilter === 'all' ? 'active' : ''}" onclick="filterSourcesByTag('all')">🏷️ All Folders (${detectedSources.length})</span>`;
  tags.forEach(t => {
    const count = detectedSources.filter(s => s.tags && s.tags.toLowerCase().split(',').map(x => x.trim()).includes(t.toLowerCase())).length;
    html += `<span class="tag-pill ${activeSourceTagFilter.toLowerCase() === t.toLowerCase() ? 'active' : ''}" onclick="filterSourcesByTag('${escapeHtml(t)}')">🏷️ ${escapeHtml(t)} (${count})</span>`;
  });
  container.innerHTML = html;
}

function filterSourcesByTag(tag) {
  activeSourceTagFilter = tag;
  renderSourceTagPills();
  renderDashboardTreeExplorer();
}

function onSourceSearchInput(query) {
  activeSourceSearchQuery = (query || '').toLowerCase().trim();
  renderDashboardTreeExplorer();
}

function renderDashboardTreeExplorer() {
  const dashboardContainer = document.getElementById('dashboard-container-tree');
  if (!dashboardContainer) return;

  renderSourceTagPills();

  if (detectedSources.length === 0) {
    dashboardContainer.innerHTML = '<div class="empty-state"><p>No container volumes detected. Click <strong>Add Source Folder</strong> to add one.</p></div>';
    return;
  }

  let sourcesToRender = detectedSources;

  if (activeSourceTagFilter !== 'all') {
    const targetTag = activeSourceTagFilter.toLowerCase();
    sourcesToRender = sourcesToRender.filter(s => {
      const sourceTags = (s.tags || '').toLowerCase().split(',').map(t => t.trim());
      return sourceTags.includes(targetTag);
    });
  }

  if (activeSourceSearchQuery) {
    sourcesToRender = sourcesToRender.filter(s => {
      const name = (s.name || '').toLowerCase();
      const host = (s.hostPath || '').toLowerCase();
      const container = (s.containerPath || '').toLowerCase();
      const tags = (s.tags || '').toLowerCase();
      return name.includes(activeSourceSearchQuery) || host.includes(activeSourceSearchQuery) || container.includes(activeSourceSearchQuery) || tags.includes(activeSourceSearchQuery);
    });
  }

  if (sourcesToRender.length === 0) {
    dashboardContainer.innerHTML = '<div class="empty-state"><p>No source folders match the current filter/search.</p></div>';
    return;
  }

  const treeData = buildContainerTree(sourcesToRender);
  renderTreeWidget(treeData, dashboardContainer, false);
}

async function deleteSourceFolder(id) {
  if (!confirm('Remove this source folder from the list? (It will no longer appear as a backup source.)')) return;
  try {
    await fetch(`/api/sources/${id}`, { method: 'DELETE' });
    await fetchSources();
  } catch (err) {
    alert('Failed to remove source: ' + err.message);
  }
}

// ─── Remotes ───────────────────────────────────────────────────────────────

async function fetchRemotes(force = false) {
  if (isFetchingRemotes) return;
  if (!force && (Date.now() - lastRemotesFetchTime < REMOTES_CACHE_TTL_MS)) {
    renderRemotesModalList();
    renderRemotesStatusGrid();
    populateRemoteDropdown();
    populateTransferRemoteDropdowns();
    fetchRemoteQuotas();
    return;
  }

  isFetchingRemotes = true;
  try {
    const [remotesRes, detailsRes] = await Promise.all([
      fetch('/api/remotes'),
      fetch('/api/remotes/details')
    ]);

    currentRemotes = await remotesRes.json();
    remotesDetails = await detailsRes.json();

    renderRemotesModalList();
    renderRemotesStatusGrid();
    populateRemoteDropdown();
    populateTransferRemoteDropdowns();
    populateFilterRemoteDropdowns();

    // Async fetch capacity quota info & auto-test connection statuses
    fetchRemoteQuotas();
    testAllRemotes(true);
    lastRemotesFetchTime = Date.now();
  } catch (err) {
    console.error('Failed to fetch remotes:', err);
  } finally {
    isFetchingRemotes = false;
  }
}

function populateFilterRemoteDropdowns() {
  const historyFilter = document.getElementById('history-remote-filter');
  const tasksFilter = document.getElementById('tasks-remote-filter');
  
  if (!currentRemotes || currentRemotes.length === 0) return;

  const currentHistoryVal = historyFilter ? historyFilter.value : 'all';
  const currentTasksVal = tasksFilter ? tasksFilter.value : 'all';

  const optionsHtml = '<option value="all">☁️ All Services</option>' +
    currentRemotes.map(r => {
      const status = remoteStatusMap[r];
      const isRestricted = status && status.success === false;
      const label = isRestricted ? `🚫 ${r} (Read Error)` : `☁️ ${r}`;
      return `<option value="${escapeHtml(r)}">${escapeHtml(label)}</option>`;
    }).join('');

  if (historyFilter) {
    historyFilter.innerHTML = optionsHtml;
    if (Array.from(historyFilter.options).some(o => o.value === currentHistoryVal)) {
      historyFilter.value = currentHistoryVal;
    }
  }
  if (tasksFilter) {
    tasksFilter.innerHTML = optionsHtml;
    if (Array.from(tasksFilter.options).some(o => o.value === currentTasksVal)) {
      tasksFilter.value = currentTasksVal;
    }
  }
}

function filterByRemoteService(remoteName) {
  const tasksFilter = document.getElementById('tasks-remote-filter');
  const historyFilter = document.getElementById('history-remote-filter');
  if (tasksFilter) {
    tasksFilter.value = remoteName;
    renderTasks();
  }
  if (historyFilter) {
    historyFilter.value = remoteName;
    filterAndRenderHistory();
  }
  const targetEl = document.getElementById('tasks-container')?.closest('.section-panel') || document.getElementById('tasks-container');
  if (targetEl) {
    targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function fetchRemoteQuotas() {
  if (!currentRemotes || currentRemotes.length === 0) return;

  currentRemotes.forEach(remoteName => {
    if (!remoteQuotaFetchingSet.has(remoteName)) {
      fetchSingleRemoteQuota(remoteName, 0);
    }
  });
}

async function fetchSingleRemoteQuota(remoteName, attempt) {
  const MAX_ATTEMPTS = 4;
  const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000];

  if (attempt === 0) {
    remoteQuotaFetchingSet.add(remoteName);
    renderRemotesStatusGrid();
  }

  try {
    const res = await fetch(`/api/remotes/${encodeURIComponent(remoteName)}/about`);
    const data = await res.json();

    if (data.success) {
      remoteQuotaMap[remoteName] = data;
      remoteQuotaFetchingSet.delete(remoteName);
      renderRemotesStatusGrid();
    } else if (data.pending && attempt < MAX_ATTEMPTS) {
      setTimeout(() => fetchSingleRemoteQuota(remoteName, attempt + 1), RETRY_DELAYS_MS[attempt]);
    } else {
      remoteQuotaMap[remoteName] = data;
      remoteQuotaFetchingSet.delete(remoteName);
      renderRemotesStatusGrid();
    }
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      setTimeout(() => fetchSingleRemoteQuota(remoteName, attempt + 1), RETRY_DELAYS_MS[attempt]);
    } else {
      remoteQuotaMap[remoteName] = { success: false, error: e.message };
      remoteQuotaFetchingSet.delete(remoteName);
      renderRemotesStatusGrid();
    }
  }
}

function renderRemotesModalList() {
  const container = document.getElementById('remotes-active-list');
  if (currentRemotes.length === 0) {
    container.innerHTML = '<span class="opacity-60 text-sm">No cloud remotes configured yet. Add one below.</span>';
    return;
  }

  container.innerHTML = currentRemotes.map(remote => {
    const detail = remotesDetails.find(d => d.name === remote) || { type: 'drive' };
    return `
      <div class="remote-chip" style="display: flex; align-items: center; gap: 0.5rem;">
        <span>☁️ ${escapeHtml(remote)}</span>
        <button type="button" class="btn btn-sm btn-outline" style="font-size: 0.68rem; padding: 0.1rem 0.35rem; color: #38bdf8; border-color: rgba(0,242,254,0.3);" onclick="openReauthRemoteModal('${escapeHtml(remote)}', '${escapeHtml(detail.type)}')">
          🔄 Re-Auth
        </button>
        <span class="chip-del" onclick="deleteRemote('${escapeHtml(remote)}')" title="Delete Remote">&times;</span>
      </div>
    `;
  }).join('');
}

function renderRemotesStatusGrid() {
  const container = document.getElementById('remotes-status-container');
  if (currentRemotes.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No cloud remotes detected in config. Click "Manage Remotes" or edit rclone.conf to add one.</p></div>';
    return;
  }

  container.innerHTML = currentRemotes.map(remoteName => {
    const detail = remotesDetails.find(d => d.name === remoteName) || { type: 'cloud' };
    const status = remoteStatusMap[remoteName];
    const quota = remoteQuotaMap[remoteName];

    let badgeHtml = '<span class="status-badge-ok" style="background: rgba(255,255,255,0.05); color: #94a3b8; border-color: rgba(255,255,255,0.1);">UNTESTED</span>';
    let detailText = 'Click "Test Connection" to verify authentication and latency.';
    let isAuthError = false;

    if (status) {
      if (status.testing) {
        badgeHtml = '<span class="status-badge-testing">TESTING...</span>';
        detailText = 'Testing API response and storage connectivity...';
      } else if (status.success) {
        badgeHtml = `<span class="status-badge-ok">CONNECTED (${status.latencyMs}ms)</span>`;
        detailText = status.info || 'Connection established successfully.';
      } else {
        isAuthError = true;
        badgeHtml = '<span class="status-badge-err">⛔ TOKEN EXPIRED / ERROR</span>';
        detailText = status.error || 'Authentication error (e.g. invalid OAuth token). Read & transfer from this source is blocked.';
      }
    }

    let quotaHtml = '';
    if (quota && quota.success) {
      const pct = quota.percentage || 0;
      const barColor = pct > 85 ? '#f43f5e' : (pct > 65 ? '#f59e0b' : '#00f2fe');
      quotaHtml = `
        <div style="margin-top: 0.6rem; padding-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.08); font-size: 0.75rem;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem; color: #cbd5e1;">
            <span>Capacity Used: <strong>${quota.usedFormatted} / ${quota.totalFormatted}</strong></span>
            <span>${pct}%</span>
          </div>
          <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
            <div style="width: ${Math.min(100, pct)}%; height: 100%; background: ${barColor}; transition: width 0.3s ease;"></div>
          </div>
        </div>
      `;
    } else if (remoteQuotaFetchingSet.has(remoteName)) {
      quotaHtml = `
        <div style="margin-top: 0.6rem; padding-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.08); font-size: 0.75rem; color: #38bdf8; display: flex; align-items: center; gap: 0.4rem;">
          <span>⏳</span> Fetching capacity metric...
        </div>
      `;
    } else if (quota && quota.success === false) {
      quotaHtml = `
        <div style="margin-top: 0.6rem; padding-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.08); font-size: 0.75rem; color: #94a3b8; display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
          <span style="color: #cbd5e1; font-size: 0.72rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Quota: ${escapeHtml(quota.error || 'Unavailable')}</span>
          <button type="button" class="btn btn-sm btn-outline" style="font-size: 0.68rem; padding: 0.1rem 0.4rem; color: #38bdf8; border-color: rgba(56,189,248,0.3); white-space: nowrap;" onclick="fetchSingleRemoteQuota('${escapeHtml(remoteName)}', 0)">
            🔄 Retry
          </button>
        </div>
      `;
    } else if (status && status.success === false) {
      quotaHtml = `
        <div style="margin-top: 0.6rem; padding-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.08); font-size: 0.75rem; color: #fb7185;">
          ⚠️ Authentication token expired or revoked. Click "Re-Authorize" below to refresh token.
        </div>
      `;
    } else {
      quotaHtml = `
        <div style="margin-top: 0.6rem; padding-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.08); font-size: 0.75rem; color: #94a3b8; display: flex; justify-content: space-between; align-items: center;">
          <span>Capacity: <em>Not queried yet</em></span>
          <button type="button" class="btn btn-sm btn-outline" style="font-size: 0.68rem; padding: 0.1rem 0.4rem; color: #38bdf8; border-color: rgba(56,189,248,0.3);" onclick="fetchSingleRemoteQuota('${escapeHtml(remoteName)}', 0)">
            ⚡ Query Quota
          </button>
        </div>
      `;
    }

    const reauthBtnHtml = isAuthError ? `
      <button class="btn btn-sm btn-primary" onclick="openReauthRemoteModal('${escapeHtml(remoteName)}', '${escapeHtml(detail.type)}')">
        🔄 Re-Authorize
      </button>
    ` : '';

    return `
      <div class="remote-status-card">
        <div class="remote-header">
          <div class="remote-name-tag">
            <span>☁️ ${escapeHtml(remoteName)}</span>
            <span class="remote-type-badge">${escapeHtml(detail.type)}</span>
          </div>
          ${badgeHtml}
        </div>
        <div class="remote-detail-text" style="word-break: break-word;">${escapeHtml(detailText)}</div>
        ${quotaHtml}
        <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap;">
          ${reauthBtnHtml}
          <button class="btn btn-sm btn-outline" onclick="filterByRemoteService('${escapeHtml(remoteName)}')">
            🔍 Filter Jobs
          </button>
          <button class="btn btn-sm btn-outline" onclick="openTransferForRemote('${escapeHtml(remoteName)}')">
            ⬇ Transfer
          </button>
          <button class="btn btn-sm btn-outline" onclick="testSingleRemote('${escapeHtml(remoteName)}')">
            ⚡ Test
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function filterByRemoteService(remoteName) {
  const filterSelect = document.getElementById('tasks-remote-filter');
  if (filterSelect) {
    let found = false;
    for (let i = 0; i < filterSelect.options.length; i++) {
      if (filterSelect.options[i].value === remoteName) {
        filterSelect.selectedIndex = i;
        found = true;
        break;
      }
    }
    if (!found) {
      const opt = document.createElement('option');
      opt.value = remoteName;
      opt.textContent = `☁️ ${remoteName}`;
      filterSelect.appendChild(opt);
      filterSelect.value = remoteName;
    }
  }

  // Re-render tasks filtered by selected remote
  renderTasks();

  // Smoothly auto-scroll down to the tasks matrix section
  const tasksContainer = document.getElementById('tasks-container')?.closest('.section-panel') || document.getElementById('tasks-container');
  if (tasksContainer) {
    tasksContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Wire change event listener for tasks-remote-filter
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tasks-remote-filter')?.addEventListener('change', () => {
    renderTasks();
  });
});

let activeReauthMode = 'standard';

function switchReauthMode(mode) {
  activeReauthMode = mode;
  const standardBtn = document.getElementById('btn-reauth-mode-standard');
  const customBtn = document.getElementById('btn-reauth-mode-custom');
  const cmdEl = document.getElementById('reauth-cmd-code');
  const descTitle = document.getElementById('reauth-mode-desc-title');
  const descSub = document.getElementById('reauth-mode-desc-sub');
  const remoteName = document.getElementById('reauth-remote-name')?.value;
  const remoteType = document.getElementById('reauth-remote-type')?.value || 'drive';

  if (standardBtn && customBtn) {
    standardBtn.classList.toggle('active', mode === 'standard');
    customBtn.classList.toggle('active', mode === 'custom');
  }

  const detail = remotesDetails.find(d => d.name === remoteName) || { type: remoteType, details: {} };
  const clientId = detail.details?.client_id || '';
  const clientSecret = detail.details?.client_secret || '';

  if (mode === 'standard') {
    if (descTitle) descTitle.textContent = '⚡ Standard Authorization (Permanent & Recommended)';
    if (descSub) descSub.textContent = 'Uses rclone\'s built-in permanent OAuth app. Token refresh never expires or fails:';
    let cmd = `rclone authorize "${detail.type || remoteType}"`;
    if ((detail.type || remoteType) === 'pcloud') {
      cmd = `rclone authorize "pcloud" "hostname" "eapi.pcloud.com"`;
    }
    if (cmdEl) cmdEl.textContent = cmd;
  } else {
    if (descTitle) descTitle.textContent = '🔑 Custom Google Cloud Project Credentials';
    if (descSub) descSub.textContent = clientId 
      ? `Using custom client ID "${clientId.slice(0, 20)}...". Generated token will match your custom project:`
      : 'No custom client ID configured for this remote. Enter custom client credentials or use standard mode:';
    
    if (clientId && clientSecret) {
      if (cmdEl) cmdEl.textContent = `rclone authorize "${detail.type || remoteType}" "${clientId}" "${clientSecret}"`;
    } else {
      if (cmdEl) cmdEl.textContent = `rclone authorize "${detail.type || remoteType}"`;
    }
  }
}

function openReauthRemoteModal(remoteName, remoteType = 'drive') {
  const modal = document.getElementById('modal-reauth-remote');
  if (!modal) return;

  const titleEl = document.getElementById('reauth-remote-name-title');
  const nameInput = document.getElementById('reauth-remote-name');
  const typeInput = document.getElementById('reauth-remote-type');
  const tokenInput = document.getElementById('reauth-token-input');

  if (titleEl) titleEl.textContent = remoteName;
  if (nameInput) nameInput.value = remoteName;
  if (typeInput) typeInput.value = remoteType;
  if (tokenInput) tokenInput.value = '';

  switchReauthMode('standard');
  modal.classList.add('active');
}

async function saveReauthorizedToken() {
  const remoteName = document.getElementById('reauth-remote-name')?.value;
  let token = document.getElementById('reauth-token-input')?.value.trim();
  const btn = document.getElementById('btn-save-reauth');

  if (!remoteName || !token) {
    alert('Please paste the new token JSON or token string.');
    return;
  }

  // If user copied entire rclone terminal output, extract just the JSON object
  const jsonMatch = token.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      token = JSON.stringify(JSON.parse(jsonMatch[0]));
    } catch (e) {
      token = jsonMatch[0].trim();
    }
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Updating & Testing Connection...';
  }

  try {
    const stripCustomClient = (activeReauthMode === 'standard');
    const res = await fetch(`/api/remotes/${encodeURIComponent(remoteName)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, stripCustomClient })
    });

    let data;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      const text = await res.text();
      throw new Error(`Server returned HTTP ${res.status}: ${text.slice(0, 120)}`);
    }

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to update remote token.');
    }

    alert(`✅ Remote "${remoteName}" successfully re-authorized and connected!`);
    document.getElementById('modal-reauth-remote')?.classList.remove('active');
    fetchRemotes(true);
    testSingleRemote(remoteName);
  } catch (err) {
    alert('Failed to re-authorize: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Update & Reconnect Remote';
    }
  }
}

async function fetchSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.discord_webhook_url && document.getElementById('discord-webhook-input')) {
      document.getElementById('discord-webhook-input').value = data.discord_webhook_url;
    }
    if (data.ntfy_topic && document.getElementById('ntfy-topic-input')) {
      document.getElementById('ntfy-topic-input').value = data.ntfy_topic;
    }
    if (data.telegram_bot_token && document.getElementById('telegram-bot-token-input')) {
      document.getElementById('telegram-bot-token-input').value = data.telegram_bot_token;
    }
    if (data.telegram_chat_id && document.getElementById('telegram-chat-id-input')) {
      document.getElementById('telegram-chat-id-input').value = data.telegram_chat_id;
    }
    const nodeName = data.device_name || data.device_name_default || 'Default';
    if (document.getElementById('setting-device-name-input')) {
      document.getElementById('setting-device-name-input').value = nodeName;
    }
    const headerBadge = document.getElementById('header-device-badge');
    if (headerBadge) {
      headerBadge.textContent = `💻 Node: ${nodeName}`;
    }

    // Populate Zero-Knowledge Encryption Settings
    if (document.getElementById('setting-encryption-enabled')) {
      document.getElementById('setting-encryption-enabled').checked = (data.encryption_enabled === 'true' || data.encryption_enabled === true);
    }
    if (data.encryption_password && document.getElementById('setting-encryption-password')) {
      document.getElementById('setting-encryption-password').value = data.encryption_password;
    }
    if (data.encryption_salt && document.getElementById('setting-encryption-salt')) {
      document.getElementById('setting-encryption-salt').value = data.encryption_salt;
    }
    const encBadge = document.getElementById('encryption-status-badge');
    if (encBadge) {
      const isEncActive = (data.encryption_enabled === 'true' || data.encryption_enabled === true);
      encBadge.textContent = isEncActive ? 'Active' : 'Optional';
      encBadge.className = isEncActive ? 'badge badge-success' : 'badge badge-secondary';
    }

    // Populate Windows Explorer Context Menu Status
    if (window.desktopApi && typeof window.desktopApi.getContextMenuStatus === 'function') {
      try {
        const isRegistered = await window.desktopApi.getContextMenuStatus();
        const toggle = document.getElementById('setting-context-menu-toggle');
        if (toggle) toggle.checked = !!isRegistered;
        updateContextMenuBadge(isRegistered);
      } catch (err) {
        console.warn('Failed querying context menu status:', err);
      }
    }
  } catch (e) {}
}

async function saveSettingKey(payload, successMsg) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      alert(successMsg);
    } else {
      alert('Error saving settings: ' + data.error);
    }
  } catch (e) {
    alert('Failed to save settings: ' + e.message);
  }
}

async function testSingleRemote(remoteName) {
  remoteStatusMap[remoteName] = { testing: true };
  renderRemotesStatusGrid();

  try {
    const res = await fetch(`/api/remotes/${remoteName}/test`, { method: 'POST' });
    const data = await res.json();
    remoteStatusMap[remoteName] = data;
  } catch (err) {
    remoteStatusMap[remoteName] = { success: false, error: err.message };
  }

  renderRemotesStatusGrid();
}

async function testAllRemotes(silent = false) {
  if (!currentRemotes || currentRemotes.length === 0) return;
  currentRemotes.forEach(r => {
    if (!remoteStatusMap[r]) {
      remoteStatusMap[r] = { testing: true };
    }
  });
  renderRemotesStatusGrid();

  await Promise.all(currentRemotes.map(remoteName => testSingleRemote(remoteName)));
}

function populateRemoteDropdown() {
  const dropdown = document.getElementById('task-remote');
  dropdown.innerHTML = '<option value="">Select a connected remote...</option>' + 
    currentRemotes.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
}

// ─── History Logs (Paginated) ───────────────────────────────────────────────

async function fetchHistoryLogs(page = 0) {
  try {
    logsCurrentPage = page;
    const offset = page * LOGS_PAGE_SIZE;
    const res = await fetch(`/api/logs?limit=${LOGS_PAGE_SIZE}&offset=${offset}`);
    const data = await res.json();
    
    // Support both old (array) and new (object with pagination) response shape
    if (Array.isArray(data)) {
      currentLogs = data;
      logsTotalCount = data.length;
    } else {
      currentLogs = data.logs || [];
      logsTotalCount = data.total || 0;
    }

    filterAndRenderHistory();
    renderPagination();
  } catch (err) {
    console.error('Failed to fetch logs:', err);
  }
}

function renderPagination() {
  const paginationEl = document.getElementById('history-pagination');
  const pageInfo = document.getElementById('history-page-info');
  const prevBtn = document.getElementById('btn-logs-prev');
  const nextBtn = document.getElementById('btn-logs-next');

  const totalPages = Math.max(1, Math.ceil(logsTotalCount / LOGS_PAGE_SIZE));

  if (logsTotalCount <= LOGS_PAGE_SIZE) {
    if (paginationEl) paginationEl.style.display = 'none';
    return;
  }

  if (paginationEl) paginationEl.style.display = 'flex';
  if (pageInfo) pageInfo.textContent = `Page ${logsCurrentPage + 1} of ${totalPages} (${logsTotalCount} entries)`;
  if (prevBtn) prevBtn.disabled = logsCurrentPage === 0;
  if (nextBtn) nextBtn.disabled = logsCurrentPage >= totalPages - 1;
}

function filterAndRenderHistory() {
  const searchTerm = (document.getElementById('history-search-input')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('history-status-filter')?.value || 'all';
  const remoteFilter = document.getElementById('history-remote-filter')?.value || 'all';

  const filtered = currentLogs.filter(log => {
    const nameMatch = !searchTerm || (log.task_name && log.task_name.toLowerCase().includes(searchTerm));
    const statusMatch = (statusFilter === 'all') || (log.status === statusFilter);
    const remoteMatch = (remoteFilter === 'all') ||
      (log.task_name && log.task_name.toLowerCase().includes(remoteFilter.toLowerCase())) ||
      (log.output && log.output.toLowerCase().includes(remoteFilter.toLowerCase()));
    return nameMatch && statusMatch && remoteMatch;
  });

  renderHistoryTable(filtered);
}

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '--';
  const sec = Math.round(seconds);
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (mins < 60) {
    return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

function renderHistoryTable(logs) {
  const tbody = document.getElementById('history-table-body');
  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center opacity-60">No matching execution logs found.</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(log => {
    const statusClass = log.status === 'partial' ? 'status-badge-partial' : `status-${log.status || 'idle'}`;
    const statusLabel = log.status === 'partial' ? '⚠️ PARTIAL' : (log.status || 'IDLE').toUpperCase();
    const startTimeStr = log.start_time ? new Date(log.start_time).toLocaleString() : '--';
    const durationSec = log.end_time ? ((new Date(log.end_time) - new Date(log.start_time)) / 1000) : null;
    const durationStr = log.end_time ? formatDuration(durationSec) : 'Running...';

    return `
      <tr>
        <td><strong>${escapeHtml(log.task_name)}</strong></td>
        <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
        <td><span class="path-code">${escapeHtml(log.bytes_transferred || '0 B')}</span></td>
        <td>${startTimeStr}</td>
        <td>${durationStr}</td>
        <td>
          <button class="btn btn-sm btn-outline" onclick="viewLogDetail('${log.id}')">View Log</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function viewLogDetail(logId) {
  try {
    const res = await fetch(`/api/logs/${logId}`);
    const log = await res.json();

    const modal = document.getElementById('modal-log-detail');
    document.getElementById('log-detail-title').textContent = `Log Detail: ${log.task_name}`;
    document.getElementById('log-detail-meta').textContent = `Status: ${(log.status || '').toUpperCase()} | Transferred: ${log.bytes_transferred || '0 B'} | Start: ${new Date(log.start_time).toLocaleString()}`;
    document.getElementById('log-detail-content').textContent = log.output || 'No text output recorded for this run.';

    const downloadBtn = document.getElementById('btn-download-log-txt');
    downloadBtn.onclick = () => downloadLogAsFile(log);

    modal.classList.add('active');
  } catch (err) {
    alert('Failed to load log detail.');
  }
}

function downloadLogAsFile(log) {
  const sanitizedName = log.task_name.replace(/[^a-z0-9_-]/gi, '_');
  const filename = `backup_log_${sanitizedName}_${log.id.slice(0, 8)}.txt`;
  const textContent = `=== AutoBackup Execution Log ===
Task Name: ${log.task_name}
Log ID: ${log.id}
Status: ${log.status}
Bytes Transferred: ${log.bytes_transferred}
Files Transferred: ${log.files_transferred}
Start Time: ${log.start_time}
End Time: ${log.end_time}

=======================================================
LOG OUTPUT:
=======================================================
${log.output || 'No output recorded.'}
`;

  const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── WebSocket ─────────────────────────────────────────────────────────────

let wsReconnectTimer = null;

function initWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    appendConsoleLine('[System] Live WebSocket log stream connected.', 'system');
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWebSocketMessage(msg);
    } catch (e) {
      appendConsoleLine(event.data);
    }
  };

  socket.onclose = () => {
    if (!wsReconnectTimer) {
      appendConsoleLine('[System] Live stream disconnected. Reconnecting in 2s...', 'error');
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        initWebSocket();
      }, 2000);
    }
  };

  socket.onerror = () => {
    try { socket.close(); } catch (e) {}
  };
}

// Tracks active transfers in top banner
const activeTransfersMap = {};

function addActiveTransferBanner(transferId, taskName) {
  activeTransfersMap[transferId] = { taskName, status: 'running' };

  const container = document.getElementById('active-transfers-container');
  if (!container) return;

  container.classList.remove('hidden');

  let card = document.getElementById(`active-transfer-card-${transferId}`);
  if (!card) {
    card = document.createElement('div');
    card.id = `active-transfer-card-${transferId}`;
    card.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem 1rem; border-radius: 8px; background: rgba(0, 242, 254, 0.08); margin-bottom: 0.5rem;';
    container.appendChild(card);
  }

  card.innerHTML = `
    <div style="display: flex; align-items: center; gap: 0.75rem; flex: 1;">
      <span class="status-pill status-running">TRANSFERRING</span>
      <div>
        <strong style="color: var(--text-main); font-size: 0.92rem;">⚡ ${escapeHtml(taskName)}</strong>
        <div style="font-size: 0.78rem; color: var(--accent-primary);" id="active-transfer-pct-${transferId}">Streaming live output in console...</div>
      </div>
    </div>
    <div style="width: 140px; margin-right: 0.5rem;" class="task-progress-bar">
      <div class="task-progress-fill task-progress-pulse" id="active-transfer-bar-${transferId}" style="width: 100%;"></div>
    </div>
    <button type="button" class="btn btn-sm btn-outline btn-stop-active-transfer" style="color: #fb7185; border-color: rgba(244, 63, 94, 0.4);">
      ⏹ Stop Transfer
    </button>
  `;

  card.querySelector('.btn-stop-active-transfer').onclick = () => stopTransferNow(transferId);
}

function updateActiveTransferProgress(transferId, line) {
  const pctMatch = line.match(/,\s*(\d+)%/);
  if (pctMatch) {
    const pct = pctMatch[1];
    const pctEl = document.getElementById(`active-transfer-pct-${transferId}`);
    const barEl = document.getElementById(`active-transfer-bar-${transferId}`);
    if (pctEl) pctEl.textContent = `Progress: ${pct}% (see live execution log below)`;
    if (barEl) {
      barEl.classList.remove('task-progress-pulse');
      barEl.style.width = `${pct}%`;
    }
  }
}

function removeActiveTransferBanner(transferId, status, bytes) {
  delete activeTransfersMap[transferId];

  const card = document.getElementById(`active-transfer-card-${transferId}`);
  if (card) {
    const isSuccess = status === 'success';
    card.style.background = isSuccess ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)';
    card.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.75rem;">
        <span class="status-pill status-${status}">${status.toUpperCase()}</span>
        <strong style="color: var(--text-main); font-size: 0.92rem;">${status === 'success' ? '✅ Transfer Finished' : '⏹ Transfer Stopped'}: ${escapeHtml(bytes || '')}</strong>
      </div>
    `;
    setTimeout(() => {
      card.remove();
      const container = document.getElementById('active-transfers-container');
      if (container && container.children.length === 0) {
        container.classList.add('hidden');
      }
    }, 2500);
  }
}

async function stopTransferNow(transferId) {
  try {
    appendConsoleLine(`[System] Requesting termination of transfer ${transferId}...`, 'system');
    await fetch(`/api/transfer/${transferId}/stop`, { method: 'POST' });
    removeActiveTransferBanner(transferId, 'stopped', 'Cancelled by user');
  } catch (err) {
    alert('Failed to stop transfer: ' + err.message);
  }
}

function handleWebSocketMessage(msg) {
  const { type, data } = msg;

  if (type === 'task_started') {
    appendConsoleLine(`\n=== 🚀 TASK STARTED: ${data.taskName} ===`, 'system');
    setTaskStatusOptimistic(data.taskId, 'running');
    if (data.taskName.includes('Cloud Transfer') || data.taskName.includes('Download')) {
      addActiveTransferBanner(data.taskId, data.taskName);
    }
    fetchTasks();
  } else if (type === 'task_log') {
    appendConsoleLine(data.logLine);
    parseAndUpdateProgress(data.taskId, data.logLine);
    updateActiveTransferProgress(data.taskId, data.logLine);
  } else if (type === 'task_progress') {
    updateProgressLine(data.progressText);
  } else if (type === 'task_paused') {
    appendConsoleLine(`[Pause] ⏸️ Task paused: ${data.taskName} (Reason: ${data.reason || 'User'})`, 'system');
    setTaskStatusOptimistic(data.taskId, 'paused');
    window.desktopApi?.showNotification?.(`⏸️ Backup Paused: ${data.taskName}`, `Reason: ${data.reason || 'User'}`);
    fetchTasks();
  } else if (type === 'task_resumed') {
    appendConsoleLine(`[Resume] ▶️ Task resumed: ${data.taskName}`, 'system');
    setTaskStatusOptimistic(data.taskId, 'running');
    fetchTasks();
  } else if (type === 'network_status') {
    handleNetworkStatusChange(data.online, data.message);
  } else if (type === 'watcher_event') {
    appendConsoleLine(`[Watcher] 📁 ${data.message}`, 'system');
    if (data.message && data.message.includes('Launching instant backup')) {
      window.desktopApi?.showNotification?.('⚡ Instant Sync Triggered', data.message);
    }
  } else if (type === 'task_slowdown') {
    appendConsoleLine(`[Bandwidth Warning] ⚠️ Task ${data.taskId} severe slowdown detected (${data.speed || 'slow'}). Keeping connection alive and retrying chunks.`, 'error');
  } else if (type === 'task_finished') {
    removeProgressLine();
    const isPartial = data.isPartial || data.status === 'partial';
    let statusType = 'system';
    if (isPartial) statusType = 'warning';
    else if (data.status !== 'success') statusType = 'error';

    if (isPartial) {
      appendConsoleLine(`=== ⚠️ Task Finished with Warnings: ${data.taskName} [PARTIAL] (${data.failedFilesCount || 1} file(s) skipped/locked). Transferred: ${data.bytesTransferred} ===\n`, 'warning');
    } else {
      appendConsoleLine(`=== Task Finished: ${data.taskName} [${data.status.toUpperCase()}] Transferred: ${data.bytesTransferred} ===\n`, statusType);
    }
    setTaskStatusOptimistic(data.taskId, isPartial ? 'partial' : data.status);
    hideTaskProgressBar(data.taskId);
    removeActiveTransferBanner(data.taskId, isPartial ? 'partial' : data.status, data.bytesTransferred);

    if (window.desktopApi && typeof window.desktopApi.showNotification === 'function') {
      if (isPartial) {
        window.desktopApi.showNotification(`⚠️ Backup Partial: ${data.taskName}`, `Transferred: ${data.bytesTransferred}. ${data.failedFilesCount || 1} file(s) skipped due to locks/errors.`);
      } else if (data.status === 'success') {
        window.desktopApi.showNotification(`✅ Backup Complete: ${data.taskName}`, `Transferred: ${data.bytesTransferred}. All files secured.`);
      } else {
        window.desktopApi.showNotification(`❌ Backup Failed: ${data.taskName}`, `Task status: ${data.status.toUpperCase()}`);
      }
    }

    fetchTasks();
    fetchHistoryLogs();
    fetchStatus();
  } else if (type === 'rclone_auth_url') {
    const box = document.getElementById('oauth-status-box');
    if (box) {
      box.innerHTML = `
        <div style="padding: 0.75rem; background: rgba(0, 242, 254, 0.12); border: 1px solid var(--accent-primary); border-radius: 6px; margin-bottom: 0.75rem;">
          <div style="font-weight: 700; color: #00f2fe; margin-bottom: 0.3rem;">🔗 Rclone OAuth Ready! Click below to authorize:</div>
          <a href="${escapeHtml(data.authUrl)}" target="_blank" class="btn btn-sm btn-primary" style="display: inline-flex; align-items: center; gap: 0.4rem; text-decoration: none; margin-top: 0.25rem;">
            👉 Open Authorization Page in Browser
          </a>
          <div style="font-size: 0.75rem; color: #94a3b8; margin-top: 0.4rem;">After approving in browser, the access token JSON will auto-fill below!</div>
        </div>
      `;
    }
  } else if (type === 'rclone_auth_success') {
    const tokenField = document.getElementById('opt-token');
    if (tokenField) tokenField.value = data.token;
    const box = document.getElementById('oauth-status-box');
    if (box) {
      box.innerHTML = `
        <div style="padding: 0.5rem 0.75rem; background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.4); border-radius: 6px; color: #4ade80; font-size: 0.82rem;">
          ✅ OAuth Authorization Successful! Access token auto-filled below. Click "Add & Verify Remote".
        </div>
      `;
    }
  } else if (type === 'rclone_auth_error') {
    const box = document.getElementById('oauth-status-box');
    if (box) {
      box.innerHTML = `
        <div style="padding: 0.75rem; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 6px; color: #fb7185; font-size: 0.83rem;">
          ⚠️ <strong>Port 53682 / Container network blocked:</strong><br>
          Run this in Windows Command Prompt or PowerShell: <br>
          <code style="background: rgba(0,0,0,0.5); padding: 4px 8px; border-radius: 4px; color: #38bdf8; display: inline-block; margin: 0.3rem 0;">rclone authorize "${escapeHtml(document.getElementById('remote-type')?.value || 'provider')}"</code><br>
          Then copy the output JSON token and paste it into the <strong>Access Token JSON</strong> field below.
        </div>
      `;
    }
  }
}

/**
 * Immediately update a task card's status pill without waiting for a full re-render.
 */
function setTaskStatusOptimistic(taskId, status) {
  const pill = document.getElementById(`status-pill-${taskId}`);
  if (pill) {
    if (status === 'partial') {
      pill.className = 'status-pill status-badge-partial';
      pill.textContent = '⚠️ PARTIAL';
    } else {
      pill.className = `status-pill status-${status}`;
      pill.textContent = status.toUpperCase();
    }
  }
  const progressBar = document.getElementById(`progress-bar-${taskId}`);
  if (progressBar) {
    if (status === 'running') {
      progressBar.classList.remove('hidden');
      const fill = progressBar.querySelector('.task-progress-fill');
      if (fill) fill.classList.add('task-progress-pulse');
    }
  }
}

/**
 * Parse rclone stats output and update per-task progress bar.
 */
function parseAndUpdateProgress(taskId, line) {
  // Match rclone "Transferred: X / Y, Z%" pattern
  const pctMatch = line.match(/,\s*(\d+)%/);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1], 10);
    const bar = document.getElementById(`progress-bar-${taskId}`);
    if (bar) {
      const fill = bar.querySelector('.task-progress-fill');
      if (fill) {
        fill.classList.remove('task-progress-pulse');
        fill.style.width = `${Math.min(100, pct)}%`;
      }
    }
  }
}

function hideTaskProgressBar(taskId) {
  const bar = document.getElementById(`progress-bar-${taskId}`);
  if (bar) {
    const fill = bar.querySelector('.task-progress-fill');
    if (fill) {
      fill.style.width = '100%';
      fill.classList.remove('task-progress-pulse');
    }
    setTimeout(() => {
      bar.classList.add('hidden');
      if (fill) fill.style.width = '0%';
    }, 1200);
  }
}

function updateProgressLine(progressText) {
  const consoleWin = document.getElementById('console-output');
  let progEl = document.getElementById('active-progress-line');
  if (!progEl) {
    progEl = document.createElement('div');
    progEl.id = 'active-progress-line';
    progEl.className = 'console-line active-progress';
    if (consoleWin) consoleWin.appendChild(progEl);
  }
  if (progEl) progEl.textContent = progressText;
  if (consoleWin) consoleWin.scrollTop = consoleWin.scrollHeight;
}

function removeProgressLine() {
  const progEl = document.getElementById('active-progress-line');
  if (progEl) progEl.remove();
}

// ─── Cloud Browser (file/folder multi-picker for Transfer modal) ───────────

function initCloudBrowser(browserId, remote, listElId, pathElId, upBtnId, onSelect) {
  cloudBrowserState[browserId] = {
    remote,
    currentPath: '',
    history: [],
    selectedPaths: new Set(),
    itemsCache: []
  };
  loadCloudDir(browserId, '', listElId, pathElId, upBtnId, onSelect);
}

async function loadCloudDir(browserId, dirPath, listElId, pathElId, upBtnId, onSelect) {
  const state = cloudBrowserState[browserId];
  if (!state) return;

  state.currentPath = dirPath;

  const listEl = document.getElementById(listElId);
  const pathEl = document.getElementById(pathElId);
  const upBtn = document.getElementById(upBtnId);

  if (listEl) listEl.innerHTML = '<div class="cloud-browser-loading">Loading...</div>';
  if (pathEl) pathEl.textContent = `${state.remote}:${dirPath || '/'}`;
  if (upBtn) upBtn.disabled = !dirPath;

  try {
    const res = await fetch(`/api/remotes/${encodeURIComponent(state.remote)}/ls?path=${encodeURIComponent(dirPath)}`);
    const data = await res.json();

    if (!data.success) {
      if (listEl) listEl.innerHTML = `<div class="cloud-browser-empty">Error: ${escapeHtml(data.error)}</div>`;
      return;
    }

    if (data.items.length === 0) {
      if (listEl) listEl.innerHTML = '<div class="cloud-browser-empty">This folder is empty.</div>';
      return;
    }

    state.itemsCache = data.items;

    // Sort: dirs first, then files
    const sorted = data.items.slice().sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (listEl) {
      listEl.innerHTML = '';
      sorted.forEach(item => {
        const row = document.createElement('div');
        row.className = `cloud-browser-item ${item.isDir ? 'is-dir' : 'is-file'}`;
        const isChecked = state.selectedPaths.has(item.path);

        row.innerHTML = `
          <input type="checkbox" class="cb-item-checkbox" ${isChecked ? 'checked' : ''} style="cursor:pointer; margin-right:0.35rem;">
          <span class="cb-icon">${item.isDir ? '📂' : '📄'}</span>
          <span class="cb-name">${escapeHtml(item.name)}</span>
          ${!item.isDir ? `<span class="cb-size">${formatFileSize(item.size)}</span>` : '<span class="cb-size">—</span>'}
        `;

        const checkbox = row.querySelector('.cb-item-checkbox');
        checkbox.addEventListener('change', (e) => {
          e.stopPropagation();
          if (e.target.checked) {
            state.selectedPaths.add(item.path);
          } else {
            state.selectedPaths.delete(item.path);
          }
          notifyCloudSelectionChange(browserId, onSelect);
        });

        // Click icon or name: navigate inside if directory, toggle checkbox if file
        row.querySelector('.cb-icon, .cb-name').addEventListener('click', (e) => {
          if (item.isDir) {
            state.history.push(state.currentPath);
            loadCloudDir(browserId, item.path, listElId, pathElId, upBtnId, onSelect);
          } else {
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change'));
          }
        });

        listEl.appendChild(row);
      });
    }
  } catch (err) {
    if (listEl) listEl.innerHTML = `<div class="cloud-browser-empty">Failed to list: ${escapeHtml(err.message)}</div>`;
  }
}

function notifyCloudSelectionChange(browserId, onSelect) {
  const state = cloudBrowserState[browserId];
  if (!state) return;
  const selectedArr = Array.from(state.selectedPaths);
  onSelect && onSelect(selectedArr);
}

function toggleSelectAllCloudDir(browserId, listElId, pathElId, upBtnId, onSelect) {
  const state = cloudBrowserState[browserId];
  if (!state || !state.itemsCache) return;

  const currentItems = state.itemsCache;
  const allCurrentChecked = currentItems.every(item => state.selectedPaths.has(item.path));

  currentItems.forEach(item => {
    if (allCurrentChecked) {
      state.selectedPaths.delete(item.path);
    } else {
      state.selectedPaths.add(item.path);
    }
  });

  const listEl = document.getElementById(listElId);
  if (listEl) {
    listEl.querySelectorAll('.cb-item-checkbox').forEach(cb => {
      cb.checked = !allCurrentChecked;
    });
  }

  notifyCloudSelectionChange(browserId, onSelect);
}

function cloudBrowserGoUp(browserId, listElId, pathElId, upBtnId, onSelect) {
  const state = cloudBrowserState[browserId];
  if (!state || state.history.length === 0) return;
  const prev = state.history.pop();
  loadCloudDir(browserId, prev, listElId, pathElId, upBtnId, onSelect);
}

// ─── Transfer Modal ─────────────────────────────────────────────────────────

function populateTransferRemoteDropdowns() {
  const srcOpts = '<option value="">Select source remote...</option>' + currentRemotes.map(r => {
    const status = remoteStatusMap[r];
    const isRestricted = status && status.success === false;
    if (isRestricted) {
      return `<option value="${escapeHtml(r)}" disabled style="color: #64748b; background: #020617;">🚫 ${escapeHtml(r)} (Read Restricted / Auth Error)</option>`;
    }
    return `<option value="${escapeHtml(r)}">☁️ ${escapeHtml(r)}</option>`;
  }).join('');

  const dstOpts = '<option value="">Select destination remote...</option>' + currentRemotes.map(r => {
    return `<option value="${escapeHtml(r)}">☁️ ${escapeHtml(r)}</option>`;
  }).join('');

  const srcDevice = document.getElementById('transfer-src-remote-device');
  const srcCloud = document.getElementById('transfer-src-remote-cloud');
  const dstCloud = document.getElementById('transfer-dst-remote-cloud');
  const uploadDst = document.getElementById('transfer-upload-dst-remote');

  if (srcDevice) srcDevice.innerHTML = srcOpts;
  if (srcCloud) srcCloud.innerHTML = srcOpts;
  if (dstCloud) dstCloud.innerHTML = dstOpts;
  if (uploadDst) uploadDst.innerHTML = dstOpts;
}

function switchTransferTab(tab) {
  const panelDevice = document.getElementById('transfer-panel-device');
  const panelUpload = document.getElementById('transfer-panel-upload');
  const panelCloud = document.getElementById('transfer-panel-cloud');
  const tabDevice = document.getElementById('tab-cloud-to-device');
  const tabUpload = document.getElementById('tab-device-to-cloud');
  const tabCloud = document.getElementById('tab-cloud-to-cloud');

  if (panelDevice) panelDevice.classList.toggle('hidden', tab !== 'device');
  if (panelUpload) panelUpload.classList.toggle('hidden', tab !== 'upload');
  if (panelCloud) panelCloud.classList.toggle('hidden', tab !== 'cloud');

  if (tabDevice) tabDevice.classList.toggle('active', tab === 'device');
  if (tabUpload) tabUpload.classList.toggle('active', tab === 'upload');
  if (tabCloud) tabCloud.classList.toggle('active', tab === 'cloud');
}

let uploadStagedFiles = [];

function setupUploadDropzone() {
  const dropzone = document.getElementById('upload-dropzone');
  const fileInput = document.getElementById('upload-file-input');
  const folderInput = document.getElementById('upload-folder-input');
  const btnUpload = document.getElementById('btn-do-upload');
  const dstRemoteSelect = document.getElementById('transfer-upload-dst-remote');

  if (dstRemoteSelect && btnUpload) {
    dstRemoteSelect.addEventListener('change', () => {
      btnUpload.disabled = !(dstRemoteSelect.value && uploadStagedFiles.length > 0);
    });
  }

  function handleFilesSelected(files) {
    if (!files || files.length === 0) return;
    uploadStagedFiles = Array.from(files);
    const summary = document.getElementById('upload-selected-summary');
    const totalBytes = uploadStagedFiles.reduce((acc, f) => acc + (f.size || 0), 0);

    if (summary) {
      summary.style.display = 'block';
      summary.innerHTML = `✅ Selected <strong>${uploadStagedFiles.length}</strong> item(s) (${formatFileSize(totalBytes)})`;
    }

    if (btnUpload && dstRemoteSelect) {
      btnUpload.disabled = !(dstRemoteSelect.value && uploadStagedFiles.length > 0);
    }
  }

  if (fileInput) fileInput.addEventListener('change', (e) => handleFilesSelected(e.target.files));
  if (folderInput) folderInput.addEventListener('change', (e) => handleFilesSelected(e.target.files));

  if (dropzone) {
    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files) {
        handleFilesSelected(e.dataTransfer.files);
      }
    });
  }

  if (btnUpload) {
    btnUpload.addEventListener('click', startDeviceToCloudUpload);
  }
}

async function startDeviceToCloudUpload() {
  const remote = document.getElementById('transfer-upload-dst-remote')?.value;
  const targetPath = document.getElementById('transfer-upload-dst-path')?.value.trim() || '';
  const btnUpload = document.getElementById('btn-do-upload');
  const progressContainer = document.getElementById('upload-progress-container');
  const progressBar = document.getElementById('upload-progress-bar');
  const progressStatus = document.getElementById('upload-progress-status');
  const progressPercent = document.getElementById('upload-progress-percent');

  if (!remote) {
    alert('Please select a destination cloud remote.');
    return;
  }
  if (uploadStagedFiles.length === 0) {
    alert('Please select files or a folder to upload.');
    return;
  }

  btnUpload.disabled = true;
  if (progressContainer) progressContainer.classList.remove('hidden');

  try {
    const filePayloads = [];
    let processed = 0;

    if (progressStatus) progressStatus.textContent = 'Reading files from browser...';

    for (const file of uploadStagedFiles) {
      const relPath = file.webkitRelativePath || file.name;
      const base64Data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const res = reader.result;
          const commaIdx = res.indexOf(',');
          resolve(commaIdx !== -1 ? res.substring(commaIdx + 1) : res);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      filePayloads.push({
        path: relPath,
        data: base64Data,
        size: file.size
      });

      processed++;
      const readPct = Math.round((processed / uploadStagedFiles.length) * 40);
      if (progressBar) progressBar.style.width = `${readPct}%`;
      if (progressPercent) progressPercent.textContent = `${readPct}%`;
    }

    if (progressStatus) progressStatus.textContent = 'Transferring to cloud remote...';
    if (progressBar) progressBar.style.width = '60%';
    if (progressPercent) progressPercent.textContent = '60%';

    const res = await fetch('/api/transfer/upload-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remote,
        targetPath,
        files: filePayloads
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Upload failed');
    }

    if (progressBar) progressBar.style.width = '100%';
    if (progressPercent) progressPercent.textContent = '100%';
    if (progressStatus) progressStatus.textContent = '✅ Upload Complete!';

    alert(`✅ Successfully uploaded ${data.filesUploaded} files to ${remote}:${targetPath || '/'}`);
    appendConsoleLine(`[System] ✅ Successfully uploaded ${data.filesUploaded} files to ${remote}:${targetPath || '/'}`, 'system');

    // Reset upload form
    uploadStagedFiles = [];
    const summary = document.getElementById('upload-selected-summary');
    if (summary) summary.style.display = 'none';
  } catch (err) {
    alert('Upload error: ' + err.message);
    appendConsoleLine(`[System] ❌ Upload error: ${err.message}`, 'error');
  } finally {
    btnUpload.disabled = false;
    setTimeout(() => {
      if (progressContainer) progressContainer.classList.add('hidden');
      if (progressBar) progressBar.style.width = '0%';
    }, 2500);
  }
}

function openTransferModal() {
  populateTransferRemoteDropdowns();
  document.getElementById('modal-transfer').classList.add('active');
  switchTransferTab('device');
  setupUploadDropzone();
}

function openTransferForRemote(remoteName) {
  openTransferModal();
  const srcSel = document.getElementById('transfer-src-remote-device');
  if (srcSel) {
    srcSel.value = remoteName;
    srcSel.dispatchEvent(new Event('change'));
  }
}

// ─── Source Folder Browser (for Add Source modal) ───────────────────────────

async function loadAvailableRoots() {
  const container = document.getElementById('folder-roots-pills');
  if (!container) return;
  try {
    const res = await fetch('/api/sources/roots');
    if (!res.ok) return;
    const roots = await res.json();
    const existing = roots.filter(r => r.exists);
    if (existing.length === 0) return;

    let html = '';
    existing.forEach(r => {
      if (r.path === '/hostfs' && r.subDrives && r.subDrives.length > 0) {
        r.subDrives.forEach(d => {
          const driveLetter = d.split('/').pop();
          html += `<button type="button" class="btn btn-sm btn-secondary" style="font-size:0.72rem; padding:0.15rem 0.45rem;" onclick="loadFolderBrowserDir('${escapeHtml(d)}')">💾 ${driveLetter}: Drive</button>`;
        });
      } else {
        html += `<button type="button" class="btn btn-sm btn-secondary" style="font-size:0.72rem; padding:0.15rem 0.45rem;" onclick="loadFolderBrowserDir('${escapeHtml(r.path)}')">${r.icon} ${escapeHtml(r.name.split(' ')[0])}</button>`;
      }
    });
    container.innerHTML = html;
  } catch (e) {
    console.warn('Failed to load available roots:', e);
  }
}

async function loadFolderBrowserDir(dirPath = 'default') {
  const listEl = document.getElementById('folder-browser-list');
  const pathEl = document.getElementById('folder-browser-path');
  const upBtn = document.getElementById('btn-folder-up');
  if (!listEl) return;

  listEl.innerHTML = '<div class="cloud-browser-empty">⏳ Loading directory...</div>';

  try {
    const res = await fetch(`/api/sources/browse?path=${encodeURIComponent(dirPath)}`);
    const data = await res.json();

    if (!res.ok || data.error) {
      listEl.innerHTML = `<div class="cloud-browser-empty" style="color:#fb7185;">⚠️ Error reading directory: ${escapeHtml(data.error || 'Access denied or path not found')}</div>`;
      return;
    }

    if (!data.exists) {
      listEl.innerHTML = `
        <div class="cloud-browser-empty" style="color:var(--text-muted);">
          <div style="margin-bottom:0.4rem;">ℹ️ Path <code>${escapeHtml(data.path)}</code> is not mounted in this container.</div>
          <button type="button" class="btn btn-xs btn-primary" onclick="loadFolderBrowserDir('${escapeHtml(data.fallbackPath || '/')}')">
            Switch to ${escapeHtml(data.fallbackPath || '/')} ➔
          </button>
        </div>
      `;
      if (pathEl) pathEl.textContent = data.path;
      if (upBtn) upBtn.disabled = true;
      renderFolderBreadcrumbs(data.breadcrumbs || [], data.path);
      return;
    }

    folderBrowserState.currentPath = data.path;
    folderBrowserState.parentPath = data.parentPath;
    folderBrowserState.itemsCache = data.items || [];
    if (!folderBrowserState.selectedPaths) folderBrowserState.selectedPaths = new Set();

    if (pathEl) pathEl.textContent = data.path;
    if (upBtn) upBtn.disabled = !data.parentPath;

    renderFolderBreadcrumbs(data.breadcrumbs, data.path);
    renderFolderBrowserList(data.items);
  } catch (err) {
    listEl.innerHTML = `<div class="cloud-browser-empty" style="color:#fb7185;">⚠️ Network error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderFolderBreadcrumbs(breadcrumbs, currentPath) {
  const container = document.getElementById('folder-breadcrumbs-container');
  if (!container) return;

  if (!breadcrumbs || breadcrumbs.length === 0) {
    container.innerHTML = `<span class="folder-browser-path">${escapeHtml(currentPath)}</span>`;
    return;
  }

  container.innerHTML = breadcrumbs.map((crumb, idx) => {
    const isLast = idx === breadcrumbs.length - 1;
    return `
      <button type="button" class="breadcrumb-pill ${isLast ? 'active' : ''}" onclick="loadFolderBrowserDir('${escapeHtml(crumb.path)}')">
        ${escapeHtml(crumb.name)}
      </button>
      ${isLast ? '' : '<span class="breadcrumb-separator">❯</span>'}
    `;
  }).join('');
}

function filterFolderBrowserItems(query) {
  const q = (query || '').toLowerCase().trim();
  const listEl = document.getElementById('folder-browser-list');
  if (!listEl || !folderBrowserState.itemsCache) return;

  const filtered = folderBrowserState.itemsCache.filter(item => item.name.toLowerCase().includes(q));
  renderFolderBrowserList(filtered);
}

function renderFolderBrowserList(items) {
  const listEl = document.getElementById('folder-browser-list');
  if (!listEl) return;

  if (!items || items.length === 0) {
    listEl.innerHTML = `
      <div class="cloud-browser-empty">
        <div>📂 No subfolders found in this directory.</div>
        <div style="font-size:0.74rem; color:var(--text-dim); margin-top:0.3rem;">You can select this folder using the path above or use the available roots bar.</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = '';
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'cloud-browser-item is-dir';
    const isChecked = folderBrowserState.selectedPaths.has(item.path);
    const countBadge = (item.childCount !== null && item.childCount !== undefined)
      ? `<span style="font-size:0.7rem; color:var(--text-dim); margin-left:0.35rem;">(${item.childCount} ${item.childCount === 1 ? 'item' : 'items'})</span>`
      : '';

    row.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0;">
        <input type="checkbox" class="fb-item-checkbox" ${isChecked ? 'checked' : ''} style="cursor:pointer; transform: scale(1.15);">
        <span class="cb-icon" style="cursor: pointer; font-size: 1.1rem;">📁</span>
        <span class="cb-name" style="cursor: pointer; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${escapeHtml(item.name)}${countBadge}
        </span>
      </div>
      <button type="button" class="folder-nav-btn btn-open-subfolder" title="Navigate inside this folder">
        Open ➔
      </button>
    `;

    const checkbox = row.querySelector('.fb-item-checkbox');
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (e.target.checked) {
        folderBrowserState.selectedPaths.add(item.path);
      } else {
        folderBrowserState.selectedPaths.delete(item.path);
      }
      updateSourceModalButtonState();
    });

    // Click on name, icon, or Open button: Navigate deeper into subfolder
    const openAction = (e) => {
      e.stopPropagation();
      if (folderBrowserState.currentPath) {
        folderBrowserState.history.push(folderBrowserState.currentPath);
      }
      loadFolderBrowserDir(item.path);
    };

    row.querySelector('.cb-icon').addEventListener('click', openAction);
    row.querySelector('.cb-name').addEventListener('click', openAction);
    row.querySelector('.btn-open-subfolder').addEventListener('click', openAction);

    listEl.appendChild(row);
  });
}

function toggleSelectAllFolderBrowser() {
  if (!folderBrowserState || !folderBrowserState.itemsCache) return;
  if (!folderBrowserState.selectedPaths) folderBrowserState.selectedPaths = new Set();

  const currentItems = folderBrowserState.itemsCache;
  const allChecked = currentItems.length > 0 && currentItems.every(item => folderBrowserState.selectedPaths.has(item.path));

  currentItems.forEach(item => {
    if (allChecked) {
      folderBrowserState.selectedPaths.delete(item.path);
    } else {
      folderBrowserState.selectedPaths.add(item.path);
    }
  });

  const listEl = document.getElementById('folder-browser-list');
  if (listEl) {
    listEl.querySelectorAll('.fb-item-checkbox').forEach(cb => {
      cb.checked = !allChecked;
    });
  }

  updateSourceModalButtonState();
}

function folderBrowserGoUp() {
  const target = folderBrowserState.parentPath || (folderBrowserState.currentPath ? folderBrowserState.currentPath.replace(/\/[^\/]+$/, '') : null) || '/';
  loadFolderBrowserDir(target);
}

function updateSourceModalButtonState() {
  const saveBtn = document.getElementById('btn-save-source');
  const pathInput = document.getElementById('source-host-path-input');
  const preview = document.getElementById('source-container-path-preview');
  const statusPill = document.getElementById('source-mapping-status-pill');

  if (!folderBrowserState) return;
  if (!folderBrowserState.selectedPaths) folderBrowserState.selectedPaths = new Set();

  const count = folderBrowserState.selectedPaths.size;
  const rawValue = pathInput ? pathInput.value.trim() : '';

  if (count > 0 && pathInput) {
    const selectedArray = Array.from(folderBrowserState.selectedPaths);
    const hostPaths = selectedArray.map(p => {
      const match = p.match(/^\/hostfs\/([A-Za-z])(?:\/(.*))?$/);
      if (match) {
        const drive = match[1].toUpperCase();
        const rest = match[2] ? match[2].replace(/\//g, '\\') : '';
        return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
      }
      return p;
    });

    pathInput.value = hostPaths.join(', ');
    if (preview) {
      preview.textContent = selectedArray.join(', ');
    }
    if (statusPill) {
      statusPill.textContent = `🟢 ${count} Subfolder(s) Selected`;
      statusPill.style.background = 'rgba(16, 185, 129, 0.2)';
      statusPill.style.color = '#34d399';
      statusPill.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    }
  } else if (rawValue) {
    const rawList = rawValue.split(',').map(s => s.trim()).filter(Boolean);
    const previews = rawList.map(item => {
      const normalised = item.replace(/\\/g, '/');
      const driveMatch = normalised.match(/^([A-Za-z]):\/?(.*)$/);
      if (driveMatch) {
        const drive = driveMatch[1].toUpperCase();
        const rest = driveMatch[2].replace(/^\//, '');
        return rest ? `/hostfs/${drive}/${rest}` : `/hostfs/${drive}`;
      }
      return item;
    });
    if (preview) {
      preview.textContent = previews.join(', ');
    }
    if (statusPill) {
      const isHostPath = rawValue.includes(':') || rawValue.includes('\\');
      statusPill.textContent = isHostPath ? '💻 Host Volume Route (/hostfs/...)' : '📦 Direct Container Mount';
      statusPill.style.background = 'rgba(0, 242, 254, 0.15)';
      statusPill.style.color = 'var(--accent-cyan)';
      statusPill.style.borderColor = 'rgba(0, 242, 254, 0.3)';
    }
  } else {
    if (preview) {
      preview.textContent = '(Enter path above or select subfolders below)';
    }
    if (statusPill) {
      statusPill.textContent = 'Waiting for Path';
      statusPill.style.background = 'rgba(255, 255, 255, 0.05)';
      statusPill.style.color = 'var(--text-dim)';
      statusPill.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    }
  }

  if (saveBtn) {
    const hasPath = rawValue.length > 0 || count > 0;
    saveBtn.disabled = !hasPath;
  }
}

// ─── Add & Edit Source Modals ────────────────────────────────────────────────

function isOnlineCloudBuild() {
  const host = window.location.hostname;
  return host !== 'localhost' && host !== '127.0.0.1' && !host.startsWith('192.168.') && !host.startsWith('10.') && !host.endsWith('.local');
}

function handleSourceDriveChange(e) {
  const drive = e.target.value;
  if (drive !== 'custom') {
    localStorage.setItem('last_used_source_drive', drive);
  }
  const pathInput = document.getElementById('source-host-path-input');
  if (!pathInput) return;
  const currentVal = pathInput.value.trim();
  if (currentVal && drive !== 'custom') {
    if (/^[A-Za-z]:[\\\/]/.test(currentVal)) {
      pathInput.value = currentVal.replace(/^[A-Za-z]:/, drive);
    } else {
      pathInput.value = `${drive}\\${currentVal.replace(/^[\\\/]+/, '')}`;
    }
  } else if (!currentVal && drive !== 'custom') {
    pathInput.placeholder = `e.g. ${drive}\\autobackup`;
  }
  updateSourceModalButtonState();
}

async function handleNativeOrBrowserPicker() {
  if (window.desktopApi && typeof window.desktopApi.selectFolder === 'function') {
    try {
      const selected = await window.desktopApi.selectFolder();
      if (selected) {
        const pathInput = document.getElementById('source-host-path-input');
        const nameInput = document.getElementById('source-name-input');
        const driveSelect = document.getElementById('source-drive-select');
        if (pathInput) pathInput.value = selected;
        if (nameInput && !nameInput.value.trim()) {
          nameInput.value = selected.split(/[\\\/]/).filter(Boolean).pop() || 'Folder';
        }
        const driveMatch = selected.match(/^([A-Za-z]):/);
        if (driveMatch && driveSelect) {
          const letter = driveMatch[1].toUpperCase() + ':';
          if (['C:', 'F:', 'D:', 'E:'].includes(letter)) {
            driveSelect.value = letter;
          } else {
            driveSelect.value = 'custom';
          }
        }
        updateSourceModalButtonState();
        return;
      }
    } catch (e) {
      console.error('Error invoking native folder dialog:', e);
    }
  }

  const input = document.getElementById('input-os-folder-picker');
  if (input) input.click();
}

async function handleEditNativePicker() {
  if (window.desktopApi && typeof window.desktopApi.selectFolder === 'function') {
    try {
      const selected = await window.desktopApi.selectFolder();
      if (selected) {
        const pathInput = document.getElementById('edit-source-path');
        const driveSelect = document.getElementById('edit-source-drive-select');
        if (pathInput) {
          pathInput.value = selected;
          pathInput.dispatchEvent(new Event('input'));
        }
        const driveMatch = selected.match(/^([A-Za-z]):/);
        if (driveMatch && driveSelect) {
          const letter = driveMatch[1].toUpperCase() + ':';
          if (['C:', 'F:', 'D:', 'E:'].includes(letter)) {
            driveSelect.value = letter;
          } else {
            driveSelect.value = 'custom';
          }
        }
        return;
      }
    } catch (e) {
      console.error('Error invoking native edit folder dialog:', e);
    }
  }

  const current = document.getElementById('edit-source-path')?.value || '';
  const chosen = prompt('Enter folder path:', current);
  if (chosen) {
    const pathInput = document.getElementById('edit-source-path');
    if (pathInput) {
      pathInput.value = chosen;
      pathInput.dispatchEvent(new Event('input'));
    }
  }
}

function openAddSourceModal(initialPath = null) {
  const modal = document.getElementById('modal-add-source');
  if (!modal) return;
  modal.classList.add('active');

  const nameInput = document.getElementById('source-name-input');
  const pathInput = document.getElementById('source-host-path-input');
  const preview = document.getElementById('source-container-path-preview');
  const driveSelect = document.getElementById('source-drive-select');
  const subfolderGroup = document.getElementById('group-subfolder-selector');
  const filterGroup = document.getElementById('group-filter-subfolders');
  const cloudNotice = document.getElementById('cloud-source-notice');

  if (nameInput) nameInput.value = '';
  if (pathInput) pathInput.value = '';
  if (preview) preview.textContent = '(Enter path above or select subfolders below)';

  const lastDrive = localStorage.getItem('last_used_source_drive') || 'C:';
  if (driveSelect) {
    driveSelect.value = lastDrive;
    driveSelect.onchange = handleSourceDriveChange;
  }

  if (initialPath) {
    if (pathInput) pathInput.value = initialPath;
    const folderName = initialPath.split(/[\\\/]/).filter(Boolean).pop() || 'Source Folder';
    if (nameInput) nameInput.value = folderName;
    const dm = initialPath.match(/^([A-Za-z]):/);
    if (dm && driveSelect) {
      driveSelect.value = dm[1].toUpperCase() + ':';
    }
    updateSourceModalButtonState();
  }

  // Check if running on cloud deployment (Railway) vs local docker/host
  const isOnline = isOnlineCloudBuild();
  if (isOnline) {
    // Online build: hide device tree selector and show cloud notice
    if (subfolderGroup) subfolderGroup.style.display = 'none';
    if (filterGroup) filterGroup.style.display = 'none';
    if (cloudNotice) cloudNotice.classList.remove('hidden');
  } else {
    // Local build: enable local device tree selector
    if (subfolderGroup) subfolderGroup.style.display = '';
    if (filterGroup) filterGroup.style.display = '';
    if (cloudNotice) cloudNotice.classList.add('hidden');
    loadAvailableRoots();
    loadFolderBrowserDir('default');
  }

  folderBrowserState.currentPath = 'default';
  folderBrowserState.history = [];
  folderBrowserState.selectedPaths = new Set();
  updateSourceModalButtonState();

  // Set up OS File Explorer Picker listener
  const osPickerInput = document.getElementById('input-os-folder-picker');
  if (osPickerInput) {
    osPickerInput.onchange = (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        const firstFile = files[0];
        const relPath = firstFile.webkitRelativePath || '';
        const rootFolder = relPath.split('/')[0] || 'Selected Folder';

        const curDrive = driveSelect ? driveSelect.value : 'C:';
        const drivePrefix = curDrive !== 'custom' ? curDrive : 'C:';

        if (nameInput) nameInput.value = rootFolder;
        if (pathInput) {
          if (drivePrefix.toUpperCase() === 'C:') {
            pathInput.value = `C:\\Users\\Dr\\Documents\\${rootFolder}`;
          } else {
            pathInput.value = `${drivePrefix}\\${rootFolder}`;
          }
          updateSourceModalButtonState();
        }
      }
    };
  }
}

async function saveSourceFolder() {
  const name = document.getElementById('source-name-input').value.trim();
  const rawInput = document.getElementById('source-host-path-input').value.trim();
  const tags = document.getElementById('source-tags-input')?.value.trim() || '';

  const selectedPaths = folderBrowserState.selectedPaths ? Array.from(folderBrowserState.selectedPaths) : [];
  let sourcesToAdd = [];

  if (selectedPaths.length > 0) {
    sourcesToAdd = selectedPaths.map(containerPath => {
      const winPath = containerPath.replace(/^\/hostfs\/([A-Z])\//, '$1:/').replace(/^\/hostfs\/([A-Z])$/, '$1:/');
      const baseName = name || winPath.split(/[\/\\]/).pop() || 'Folder';
      return { name: baseName, host_path: winPath, tags };
    });
  } else if (rawInput) {
    const rawList = rawInput.split(',').map(s => s.trim()).filter(Boolean);
    sourcesToAdd = rawList.map(hp => ({
      name: name || hp.split(/[\/\\]/).pop() || 'Folder',
      host_path: hp,
      tags
    }));
  }

  if (sourcesToAdd.length === 0) {
    alert('Please select at least one folder from the browser or enter a device path (e.g. C:\\Users\\Dr\\Documents or F:\\autobackup).');
    return;
  }

  const saveBtn = document.getElementById('btn-save-source');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ Adding...';
  }

  try {
    const res = await fetch('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: sourcesToAdd, tags })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      alert('Error: ' + (data.error || 'Failed to add source'));
      return;
    }
    document.getElementById('modal-add-source').classList.remove('active');
    const tagsInput = document.getElementById('source-tags-input');
    if (tagsInput) tagsInput.value = '';
    await fetchSources();
    appendConsoleLine(`[System] ✅ Added ${data.count} source folder(s) successfully!`, 'system');
  } catch (err) {
    alert('Failed to add source(s): ' + err.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Add Source Folder';
    }
  }
}

function openEditSourceModal(id, name, hostPath, tags) {
  const modal = document.getElementById('modal-edit-source');
  if (!modal) return;
  modal.classList.add('active');

  const idInput = document.getElementById('edit-source-id');
  const nameInput = document.getElementById('edit-source-name');
  const pathInput = document.getElementById('edit-source-path');
  const tagsInput = document.getElementById('edit-source-tags');
  const driveSelect = document.getElementById('edit-source-drive-select');
  const preview = document.getElementById('edit-source-container-preview');

  if (idInput) idInput.value = id;
  if (nameInput) nameInput.value = name || '';
  if (pathInput) pathInput.value = hostPath || '';
  if (tagsInput) tagsInput.value = tags || '';

  // Auto-detect drive letter from hostPath
  const driveMatch = (hostPath || '').match(/^([A-Za-z]):/);
  if (driveMatch && driveSelect) {
    const dLetter = driveMatch[1].toUpperCase() + ':';
    if (['C:', 'D:', 'E:', 'F:'].includes(dLetter)) {
      driveSelect.value = dLetter;
    } else {
      driveSelect.value = 'custom';
    }
  }

  const updatePreview = () => {
    const val = pathInput ? pathInput.value.trim() : '';
    if (!val) {
      if (preview) preview.textContent = '';
      return;
    }
    const norm = val.replace(/\\/g, '/');
    const dm = norm.match(/^([A-Za-z]):\/?(.*)$/);
    if (dm) {
      const d = dm[1].toUpperCase();
      const rest = dm[2].replace(/^\//, '');
      if (preview) preview.textContent = rest ? `/hostfs/${d}/${rest}` : `/hostfs/${d}`;
    } else {
      if (preview) preview.textContent = norm;
    }
  };

  if (pathInput) pathInput.oninput = updatePreview;
  if (driveSelect) {
    driveSelect.onchange = (e) => {
      const d = e.target.value;
      if (d !== 'custom' && pathInput) {
        const cur = pathInput.value.trim();
        if (/^[A-Za-z]:[\\\/]/.test(cur)) {
          pathInput.value = cur.replace(/^[A-Za-z]:/, d);
        } else {
          pathInput.value = `${d}\\${cur.replace(/^[\\\/]+/, '')}`;
        }
        updatePreview();
      }
    };
  }

  updatePreview();
}

async function saveEditedSource(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('edit-source-id')?.value;
  const name = document.getElementById('edit-source-name')?.value.trim();
  const hostPath = document.getElementById('edit-source-path')?.value.trim();
  const tags = document.getElementById('edit-source-tags')?.value.trim() || '';
  const btnSave = document.getElementById('btn-save-edited-source');

  if (!id || !hostPath) {
    alert('Host path is required.');
    return;
  }

  if (btnSave) {
    btnSave.disabled = true;
    btnSave.textContent = 'Saving...';
  }

  try {
    const res = await fetch(`/api/sources/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, host_path: hostPath, tags })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      alert('Error updating source: ' + (data.error || 'Unknown error'));
      return;
    }

    document.getElementById('modal-edit-source')?.classList.remove('active');
    await fetchSources();
    appendConsoleLine(`[System] ✅ Updated source "${name || hostPath}" successfully!`, 'system');
  } catch (err) {
    alert('Failed to update source: ' + err.message);
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.textContent = 'Save Changes';
    }
  }
}

// ─── Event Listeners ────────────────────────────────────────────────────────

function setupEventListeners() {
  document.getElementById('btn-open-new-task')?.addEventListener('click', () => openTaskModal());
  document.getElementById('btn-empty-add-task')?.addEventListener('click', () => openTaskModal());
  document.getElementById('btn-open-remotes')?.addEventListener('click', () => openRemotesModal());
  document.getElementById('btn-test-all-remotes')?.addEventListener('click', testAllRemotes);
  document.getElementById('btn-open-transfer')?.addEventListener('click', openTransferModal);
  document.getElementById('btn-add-source')?.addEventListener('click', openAddSourceModal);
  document.getElementById('btn-save-source')?.addEventListener('click', saveSourceFolder);
  document.getElementById('btn-lock-dashboard')?.addEventListener('click', lockDashboard);
  document.getElementById('btn-save-pin')?.addEventListener('click', saveSecurityPin);
  document.getElementById('btn-trigger-monthly-report')?.addEventListener('click', triggerMonthlyDiscordReport);
  document.getElementById('btn-test-ntfy')?.addEventListener('click', () => sendTestNotificationChannel('ntfy'));
  document.getElementById('btn-test-discord')?.addEventListener('click', () => sendTestNotificationChannel('discord'));
  document.getElementById('btn-test-telegram')?.addEventListener('click', () => sendTestNotificationChannel('telegram'));
  document.getElementById('btn-export-backup-bundle')?.addEventListener('click', exportHubSettings);
  document.getElementById('btn-save-device-name')?.addEventListener('click', saveDeviceName);
  document.getElementById('btn-open-link-device')?.addEventListener('click', openLinkDeviceModal);
  document.getElementById('btn-bulk-remove-sources')?.addEventListener('click', openBulkRemoveModal);
  document.getElementById('btn-publish-discord-release')?.addEventListener('click', publishReleaseToDiscord);

  window.addEventListener('online', () => handleNetworkStatusChange(true, 'Internet connection restored'));
  window.addEventListener('offline', () => handleNetworkStatusChange(false, 'Internet connection disconnected'));

  // Quick Folder Adder in Task Modal
  document.getElementById('btn-task-add-quick-path')?.addEventListener('click', () => {
    const input = document.getElementById('task-quick-add-input');
    if (input && input.value.trim()) {
      addTaskFolder(input.value.trim());
      input.value = '';
    }
  });

  document.getElementById('task-quick-add-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.target.value.trim()) {
        addTaskFolder(e.target.value.trim());
        e.target.value = '';
      }
    }
  });

  document.getElementById('btn-task-clear-all-sources')?.addEventListener('click', clearAllTaskFolders);

  // Initialize Backup Import UI file watcher
  setupBackupImportUI();

  // Delegated clicks for trigger remotes buttons across empty states and UI cards
  document.addEventListener('click', (e) => {
    if (e.target.closest('.btn-trigger-remotes')) {
      openRemotesModal();
    }
  });

  // Close modals on Close button click
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.target.closest('.modal-overlay')?.classList.remove('active');
    });
  });

  // Global ESC Key Listener to close any open popup/modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(modal => {
        modal.classList.remove('active');
      });
    }
  });

  // Toggle Custom vs Tree View Source Selection
  document.getElementById('btn-toggle-custom-source')?.addEventListener('click', () => {
    isCustomSourceMode = !isCustomSourceMode;
    const treeWidget = document.getElementById('task-tree-wrapper');
    const input = document.getElementById('task-source-input');
    const btn = document.getElementById('btn-toggle-custom-source');

    if (isCustomSourceMode) {
      treeWidget?.classList.add('hidden');
      input?.classList.remove('hidden');
      if (btn) btn.textContent = 'Use root/ Tree View...';
    } else {
      treeWidget?.classList.remove('hidden');
      input?.classList.add('hidden');
      if (btn) btn.textContent = 'Manual Text Input...';
    }
  });

  // Modal Tree Toolbar Event Handlers
  document.getElementById('btn-tree-select-all')?.addEventListener('click', () => {
    const modalTree = document.getElementById('modal-container-tree');
    modalTree?.querySelectorAll('.tree-checkbox').forEach(cb => {
      cb.checked = true;
      cb.indeterminate = false;
    });
    updateSelectedCount();
  });

  document.getElementById('btn-tree-deselect-all')?.addEventListener('click', () => {
    const modalTree = document.getElementById('modal-container-tree');
    modalTree?.querySelectorAll('.tree-checkbox').forEach(cb => {
      cb.checked = false;
      cb.indeterminate = false;
    });
    updateSelectedCount();
  });

  document.getElementById('btn-tree-expand-all')?.addEventListener('click', () => {
    const modalTree = document.getElementById('modal-container-tree');
    modalTree?.querySelectorAll('.tree-children').forEach(el => el.classList.remove('collapsed'));
    modalTree?.querySelectorAll('.tree-toggle').forEach(el => el.classList.add('expanded'));
  });

  document.getElementById('btn-tree-collapse-all')?.addEventListener('click', () => {
    const modalTree = document.getElementById('modal-container-tree');
    modalTree?.querySelectorAll('.tree-children').forEach(el => el.classList.add('collapsed'));
    modalTree?.querySelectorAll('.tree-toggle').forEach(el => el.classList.remove('expanded'));
  });

  // Debounced tree search
  document.getElementById('tree-search-input')?.addEventListener('input', debounce((e) => {
    const term = e.target.value.toLowerCase();
    const modalTree = document.getElementById('modal-container-tree');
    const nodes = modalTree?.querySelectorAll('.tree-node') || [];
    nodes.forEach(nodeEl => {
      const text = nodeEl.innerText.toLowerCase();
      nodeEl.style.display = (!term || text.includes(term)) ? '' : 'none';
    });
  }, 150));

  // Dashboard Tree Toolbar Event Handlers
  document.getElementById('btn-dashboard-expand-tree')?.addEventListener('click', () => {
    const dashTree = document.getElementById('dashboard-container-tree');
    dashTree?.querySelectorAll('.tree-children').forEach(el => el.classList.remove('collapsed'));
    dashTree?.querySelectorAll('.tree-toggle').forEach(el => el.classList.add('expanded'));
  });

  document.getElementById('btn-dashboard-collapse-tree')?.addEventListener('click', () => {
    const dashTree = document.getElementById('dashboard-container-tree');
    dashTree?.querySelectorAll('.tree-children').forEach(el => el.classList.add('collapsed'));
    dashTree?.querySelectorAll('.tree-toggle').forEach(el => el.classList.remove('expanded'));
  });

  // Preset Cron change handler & Priority auto-sync
  document.getElementById('task-schedule-preset')?.addEventListener('change', (e) => {
    const customGroup = document.getElementById('group-custom-cron');
    const prioritySelect = document.getElementById('task-priority');
    const val = e.target.value;

    if (val === 'custom') {
      customGroup?.classList.remove('hidden');
    } else {
      customGroup?.classList.add('hidden');
      const taskCron = document.getElementById('task-cron');
      if (taskCron) taskCron.value = val;
    }

    if (prioritySelect) {
      if (val === 'last_friday') prioritySelect.value = 'critical';
      else if (val === 'monthly') prioritySelect.value = 'high';
      else if (val === 'weekly') prioritySelect.value = 'medium';
      else if (val === 'daily') prioritySelect.value = 'low';
      else prioritySelect.value = 'normal';
    }
  });

  // Dynamic remote provider fields
  document.getElementById('remote-type')?.addEventListener('change', (e) => {
    renderRemoteProviderFields(e.target.value);
  });
  renderRemoteProviderFields('drive');

  // Task form submission
  document.getElementById('form-task')?.addEventListener('submit', handleTaskFormSubmit);

  // Remote form submission & Raw block import
  document.getElementById('form-remote')?.addEventListener('submit', handleRemoteFormSubmit);
  document.getElementById('btn-import-raw-remote')?.addEventListener('click', importRawRemoteBlock);

  // Clear console log
  document.getElementById('btn-clear-log')?.addEventListener('click', () => {
    const consoleOut = document.getElementById('console-output');
    if (consoleOut) consoleOut.innerHTML = '<div class="console-line system">[System] Console cleared.</div>';
  });

  // Refresh history logs
  document.getElementById('btn-refresh-logs')?.addEventListener('click', () => fetchHistoryLogs(0));

  // Tasks per-service filter
  document.getElementById('tasks-remote-filter')?.addEventListener('change', renderTasks);

  // Debounced history search and filter
  document.getElementById('history-search-input')?.addEventListener('input', debounce(filterAndRenderHistory, 150));
  document.getElementById('history-status-filter')?.addEventListener('change', filterAndRenderHistory);
  document.getElementById('history-remote-filter')?.addEventListener('change', filterAndRenderHistory);

  // Log pagination
  document.getElementById('btn-logs-prev')?.addEventListener('click', () => fetchHistoryLogs(logsCurrentPage - 1));
  document.getElementById('btn-logs-next')?.addEventListener('click', () => fetchHistoryLogs(logsCurrentPage + 1));

  // Mobile Notification Save Listeners
  document.getElementById('btn-save-ntfy')?.addEventListener('click', () => {
    const topic = document.getElementById('ntfy-topic-input')?.value.trim();
    saveSettingKey({ ntfy_topic: topic }, 'ntfy.sh Mobile Push topic saved successfully!');
  });

  document.getElementById('btn-save-discord')?.addEventListener('click', () => {
    const url = document.getElementById('discord-webhook-input')?.value.trim();
    saveSettingKey({ discord_webhook_url: url }, 'Discord Webhook URL saved successfully!');
  });

  document.getElementById('btn-save-telegram')?.addEventListener('click', () => {
    const token = document.getElementById('telegram-bot-token-input')?.value.trim();
    const chatId = document.getElementById('telegram-chat-id-input')?.value.trim();
    saveSettingKey({ telegram_bot_token: token, telegram_chat_id: chatId }, 'Telegram Bot credentials saved successfully!');
  });

  // Zero-Knowledge Client-Side Cloud Encryption Save Listener
  document.getElementById('btn-save-encryption')?.addEventListener('click', saveEncryptionSettings);

  // Windows Explorer Right-Click Context Menu Toggle
  const contextToggle = document.getElementById('setting-context-menu-toggle');
  if (contextToggle) {
    contextToggle.addEventListener('change', async (e) => {
      const enable = e.target.checked;
      if (window.desktopApi && typeof window.desktopApi.setContextMenuStatus === 'function') {
        try {
          const res = await window.desktopApi.setContextMenuStatus(enable);
          updateContextMenuBadge(res.registered);
          appendConsoleLine(`[Desktop] Windows Explorer right-click integration ${enable ? 'enabled' : 'disabled'}.`, 'system');
        } catch (err) {
          alert('Failed to update context menu integration: ' + err.message);
          e.target.checked = !enable;
        }
      } else {
        alert('Explorer context menu integration is only available in the Electron desktop app.');
        e.target.checked = false;
      }
    });
  }

  // Windows Explorer incoming folder handler
  if (window.desktopApi && typeof window.desktopApi.onAddSourceFromExplorer === 'function') {
    window.desktopApi.onAddSourceFromExplorer((folderPath) => {
      if (folderPath) {
        appendConsoleLine(`[Desktop] Received folder from Windows Explorer: ${folderPath}`, 'system');
        openAddSourceModal(folderPath);
      }
    });
  }

  // Delegated clicks for task list
  document.getElementById('tasks-container')?.addEventListener('click', (e) => {
    const runBtn = e.target.closest('.btn-run-now');
    if (runBtn) { runTaskNow(runBtn.dataset.id); return; }

    const pauseBtn = e.target.closest('.btn-pause-task');
    if (pauseBtn) { pauseTaskNow(pauseBtn.dataset.id); return; }

    const resumeBtn = e.target.closest('.btn-resume-task');
    if (resumeBtn) { resumeTaskNow(resumeBtn.dataset.id); return; }

    const partialBtn = e.target.closest('.btn-partial-run-task');
    if (partialBtn) { openPartialTaskModal(partialBtn.dataset.id); return; }

    const failedBtn = e.target.closest('.btn-failed-files');
    if (failedBtn) { openFailedFilesModal(failedBtn.dataset.id); return; }

    const dryRunBtn = e.target.closest('.btn-dry-run');
    if (dryRunBtn) { runDryRunNow(dryRunBtn.dataset.id); return; }

    const stopBtn = e.target.closest('.btn-stop-task');
    if (stopBtn) { stopTaskNow(stopBtn.dataset.id); return; }

    const editBtn = e.target.closest('.btn-edit-task');
    if (editBtn) {
      const task = currentTasks.find(t => t.id === editBtn.dataset.id);
      if (task) openTaskModal(task);
      return;
    }

    const delBtn = e.target.closest('.btn-delete-task');
    if (delBtn) { deleteTask(delBtn.dataset.id); }
  });

  // Transfer — source remote change triggers browser initialisation (device tab)
  document.getElementById('transfer-src-remote-device')?.addEventListener('change', (e) => {
    const remote = e.target.value;
    if (!remote) return;
    transferSelectedPath.device = [];
    document.getElementById('btn-do-download').disabled = true;
    document.getElementById('transfer-file-info-device').style.display = 'none';

    initCloudBrowser(
      'device', remote,
      'cloud-browser-list-device', 'cloud-browser-path-device', 'btn-cloud-browser-up-device',
      (selectedArr) => {
        transferSelectedPath.device = selectedArr;
        const count = selectedArr.length;
        const infoEl = document.getElementById('transfer-file-info-device');
        const displayEl = document.getElementById('transfer-selected-path-device');
        const dlBtn = document.getElementById('btn-do-download');

        if (count > 0) {
          dlBtn.disabled = false;
          infoEl.style.display = '';
          displayEl.textContent = selectedArr.map(p => p.split('/').pop()).join(', ');
          dlBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Download ${count} Item${count > 1 ? 's (.ZIP)' : ''}`;
        } else {
          dlBtn.disabled = true;
          infoEl.style.display = 'none';
          dlBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Download to Device`;
        }
      }
    );
  });

  // Transfer — Select All button for device browser
  document.getElementById('btn-cloud-select-all-device')?.addEventListener('click', () => {
    toggleSelectAllCloudDir('device', 'cloud-browser-list-device', 'cloud-browser-path-device', 'btn-cloud-browser-up-device',
      (selectedArr) => {
        transferSelectedPath.device = selectedArr;
        const count = selectedArr.length;
        const infoEl = document.getElementById('transfer-file-info-device');
        const displayEl = document.getElementById('transfer-selected-path-device');
        const dlBtn = document.getElementById('btn-do-download');

        if (count > 0) {
          dlBtn.disabled = false;
          infoEl.style.display = '';
          displayEl.textContent = selectedArr.map(p => p.split('/').pop()).join(', ');
          dlBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Download ${count} Item${count > 1 ? 's (.ZIP)' : ''}`;
        } else {
          dlBtn.disabled = true;
          infoEl.style.display = 'none';
        }
      }
    );
  });

  // Transfer — Up button for device cloud browser
  document.getElementById('btn-cloud-browser-up-device')?.addEventListener('click', () => {
    cloudBrowserGoUp('device', 'cloud-browser-list-device', 'cloud-browser-path-device', 'btn-cloud-browser-up-device');
  });

  // Transfer — source remote change (cloud tab)
  document.getElementById('transfer-src-remote-cloud')?.addEventListener('change', (e) => {
    const remote = e.target.value;
    if (!remote) return;
    transferSelectedPath.cloudSrc = [];

    initCloudBrowser(
      'cloud-src', remote,
      'cloud-browser-list-cloud-src', 'cloud-browser-path-cloud-src', 'btn-cloud-browser-up-cloud-src',
      (selectedArr) => {
        transferSelectedPath.cloudSrc = selectedArr;
        const inputEl = document.getElementById('transfer-src-path-cloud');
        if (inputEl) inputEl.value = selectedArr.join(', ');
      }
    );
  });

  // Transfer — Select All button for cloud-to-cloud browser
  document.getElementById('btn-cloud-select-all-cloud-src')?.addEventListener('click', () => {
    toggleSelectAllCloudDir('cloud-src', 'cloud-browser-list-cloud-src', 'cloud-browser-path-cloud-src', 'btn-cloud-browser-up-cloud-src',
      (selectedArr) => {
        transferSelectedPath.cloudSrc = selectedArr;
        const inputEl = document.getElementById('transfer-src-path-cloud');
        if (inputEl) inputEl.value = selectedArr.join(', ');
      }
    );
  });

  document.getElementById('btn-cloud-browser-up-cloud-src')?.addEventListener('click', () => {
    cloudBrowserGoUp('cloud-src', 'cloud-browser-list-cloud-src', 'cloud-browser-path-cloud-src', 'btn-cloud-browser-up-cloud-src');
  });

  // Download button
  document.getElementById('btn-do-download')?.addEventListener('click', doCloudToDeviceDownload);

  // Cloud-to-cloud transfer button
  document.getElementById('btn-do-cloud-transfer')?.addEventListener('click', doCloudToCloudTransfer);

  // Folder browser Select All button
  document.getElementById('btn-folder-select-all')?.addEventListener('click', toggleSelectAllFolderBrowser);

  // Folder browser Up button
  document.getElementById('btn-folder-up')?.addEventListener('click', folderBrowserGoUp);

  // Source path input live preview & validation state
  document.getElementById('source-host-path-input')?.addEventListener('input', () => {
    updateSourceModalButtonState();
  });
}

// ─── Transfer Actions ───────────────────────────────────────────────────────

async function doCloudToDeviceDownload() {
  const remote = document.getElementById('transfer-src-remote-device').value;
  const paths = transferSelectedPath.device;

  if (!remote || !paths || paths.length === 0) {
    alert('Please select a remote and check at least one file or folder to download.');
    return;
  }

  const count = paths.length;
  // Auto-close transfer modal so live console and active transfer banner are visible
  document.getElementById('modal-transfer')?.classList.remove('active');

  appendConsoleLine(`[Transfer] Initiating download of ${count} item(s) from ${remote}...`, 'system');

  try {
    const res = await fetch('/api/transfer/cloud-to-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote, remotePaths: paths })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Download failed');
    }

    const blob = await res.blob();
    const filename = decodeURIComponent(res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || (count > 1 ? `export_${remote}.zip` : paths[0].split('/').pop()));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    appendConsoleLine(`[Transfer] ✅ Download complete: ${filename}`, 'system');
  } catch (err) {
    appendConsoleLine(`[Transfer] ❌ Download failed: ${err.message}`, 'error');
    alert('Download failed: ' + err.message);
  }
}

async function doCloudToCloudTransfer() {
  const srcRemote = document.getElementById('transfer-src-remote-cloud').value;
  const dstRemote = document.getElementById('transfer-dst-remote-cloud').value;
  const dstPath = document.getElementById('transfer-dst-path-cloud').value.trim();
  const mode = document.getElementById('transfer-mode-cloud').value;
  const paths = (transferSelectedPath.cloudSrc && transferSelectedPath.cloudSrc.length > 0)
    ? transferSelectedPath.cloudSrc
    : [document.getElementById('transfer-src-path-cloud').value.trim()];

  if (!srcRemote || !dstRemote) {
    alert('Please select source and destination remotes.');
    return;
  }

  // Auto-close transfer modal so live console and active transfer banner are visible
  document.getElementById('modal-transfer')?.classList.remove('active');

  appendConsoleLine(`[Transfer] Starting cloud-to-cloud (${paths.length} item(s)): ${srcRemote} → ${dstRemote}:${dstPath || '/'} [${mode.toUpperCase()}]`, 'system');

  try {
    const res = await fetch('/api/transfer/cloud-to-cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srcRemote, srcPaths: paths, dstRemote, dstPath, mode })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (data.success) {
      appendConsoleLine(`[Transfer] ✅ Cloud-to-cloud complete. Transferred: ${data.bytesTransferred}`, 'system');
    } else {
      appendConsoleLine(`[Transfer] ❌ Transfer ended with errors. Check log ${data.logId}.`, 'error');
    }
    fetchHistoryLogs();
  } catch (err) {
    appendConsoleLine(`[Transfer] ❌ Failed: ${err.message}`, 'error');
    alert('Transfer failed: ' + err.message);
  }
}

// ─── Task CRUD Modals ───────────────────────────────────────────────────────

async function runDryRunNow(taskId) {
  try {
    appendConsoleLine(`[System] Launching Dry-Run simulation for task ${taskId}...`, 'system');
    const res = await fetch(`/api/tasks/${taskId}/dry-run`, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      alert('Error running dry run: ' + data.error);
    } else {
      fetchTasks();
      fetchHistoryLogs();
    }
  } catch (err) {
    alert('Failed running dry run: ' + err.message);
  }
}

async function stopTaskNow(taskId) {
  if (!confirm('Are you sure you want to stop this running backup task?')) return;
  // Optimistic UI
  setTaskStatusOptimistic(taskId, 'stopped');
  try {
    const res = await fetch(`/api/tasks/${taskId}/stop`, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      alert('Error stopping task: ' + data.error);
    } else {
      appendConsoleLine(`[System] Task ${taskId} execution stopped by user.`, 'error');
      fetchTasks();
      fetchHistoryLogs();
      fetchStatus();
    }
  } catch (err) {
    alert('Failed to stop task: ' + err.message);
  }
}

function openTaskModal(task = null) {
  const modal = document.getElementById('modal-task');
  modal.classList.add('active');
  document.getElementById('form-task').reset();
  taskSelectedFoldersSet.clear();

  if (task) {
    const initialSelected = parseSourcePaths(task.source_path);
    if (Array.isArray(initialSelected)) {
      initialSelected.forEach(p => taskSelectedFoldersSet.add(p));
    } else if (task.source_path) {
      taskSelectedFoldersSet.add(task.source_path);
    }

    document.getElementById('modal-task-title').textContent = 'Edit Backup Task';
    document.getElementById('task-id').value = task.id;
    document.getElementById('task-name').value = task.name;
    document.getElementById('task-source-input').value = Array.isArray(initialSelected) ? initialSelected.join(', ') : task.source_path;
    document.getElementById('task-remote').value = task.target_remote;
    document.getElementById('task-target-path').value = task.target_path;
    document.getElementById('task-mode').value = task.mode;
    document.getElementById('task-conflict').value = task.conflict_mode || 'smart';
    document.getElementById('task-schedule-preset').value = task.cron_schedule;
    document.getElementById('task-priority').value = task.priority || 'normal';
    document.getElementById('task-bw-limit').value = task.bw_limit || '';

    const rtCheck = document.getElementById('task-realtime-watch');
    if (rtCheck) rtCheck.checked = !!(task && (task.realtime_watch === 1 || task.realtime_watch === '1' || task.realtime_watch === true));
    const encCheck = document.getElementById('task-encrypt-backup');
    if (encCheck) encCheck.checked = !!(task && (task.encrypt_backup === 1 || task.encrypt_backup === '1' || task.encrypt_backup === true));
    const bundleCheck = document.getElementById('task-bundle-archive');
    if (bundleCheck) bundleCheck.checked = !!(task && (task.bundle_archive === 1 || task.bundle_archive === '1' || task.bundle_archive === true));
    const smartCheck = document.getElementById('task-smart-filter');
    if (smartCheck) smartCheck.checked = !(task && (task.smart_code_filter === 0 || task.smart_code_filter === '0' || task.smart_code_filter === false));

    if (task.cron_schedule === 'custom' || (!['last_friday', 'monthly', 'weekly', 'daily', '*/15 * * * *', '0 * * * *', '0 */6 * * *'].includes(task.cron_schedule))) {
      document.getElementById('task-schedule-preset').value = 'custom';
      document.getElementById('group-custom-cron').classList.remove('hidden');
      document.getElementById('task-cron').value = task.cron_schedule;
    }
  } else {
    document.getElementById('modal-task-title').textContent = 'Create Backup Task';
    document.getElementById('task-id').value = '';
    document.getElementById('task-conflict').value = 'smart';
    document.getElementById('task-schedule-preset').value = 'last_friday';
    document.getElementById('task-priority').value = 'critical';
    document.getElementById('task-bw-limit').value = '';
    document.getElementById('task-cron').value = 'last_friday';

    const rtCheck = document.getElementById('task-realtime-watch');
    if (rtCheck) rtCheck.checked = false;
    const encCheck = document.getElementById('task-encrypt-backup');
    if (encCheck) encCheck.checked = false;
    const bundleCheck = document.getElementById('task-bundle-archive');
    if (bundleCheck) bundleCheck.checked = false;
    const smartCheck = document.getElementById('task-smart-filter');
    if (smartCheck) smartCheck.checked = true;
  }

  renderTaskSelectedChips();

  const modalTreeContainer = document.getElementById('modal-container-tree');
  modalTreeContainer.innerHTML = '<div class="tree-loading">Loading mounted container paths...</div>';

  fetchSources().then(() => {
    const treeData = buildContainerTree(detectedSources);
    const initialSelected = Array.from(taskSelectedFoldersSet);
    renderTreeWidget(treeData, modalTreeContainer, true, initialSelected);
    renderTaskSelectedChips();
  }).catch(() => {
    modalTreeContainer.innerHTML = '<div class="opacity-60 text-sm">Loaded default container paths.</div>';
  });
}

function openRemotesModal() {
  const modal = document.getElementById('modal-remotes');
  modal.classList.add('active');
  fetchRemotes(true);
  fetchSettings();
}

async function handleTaskFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('task-id').value;
  const name = document.getElementById('task-name').value.trim();
  
  const selectedFolders = Array.from(taskSelectedFoldersSet);
  if (selectedFolders.length === 0) {
    // Fallback: check manual input field if populated
    const manualInput = document.getElementById('task-source-input')?.value.trim();
    if (manualInput) {
      manualInput.split(',').map(s => s.trim()).filter(Boolean).forEach(f => selectedFolders.push(f));
    }
  }

  if (selectedFolders.length === 0) {
    alert('Error: Please select or add at least one source folder to backup.');
    return;
  }

  const source_path = selectedFolders.length === 1 ? selectedFolders[0] : selectedFolders;
  const target_remote = document.getElementById('task-remote').value;
  const target_path = document.getElementById('task-target-path').value.trim();
  const mode = document.getElementById('task-mode').value;
  const conflict_mode = document.getElementById('task-conflict').value;
  const priority = document.getElementById('task-priority').value;
  const bw_limit = document.getElementById('task-bw-limit').value;
  const realtime_watch = document.getElementById('task-realtime-watch')?.checked ? 1 : 0;
  const encrypt_backup = document.getElementById('task-encrypt-backup')?.checked ? 1 : 0;
  const bundle_archive = document.getElementById('task-bundle-archive')?.checked ? 1 : 0;
  const smart_code_filter = document.getElementById('task-smart-filter')?.checked ? 1 : 0;
  let cron_schedule = document.getElementById('task-schedule-preset').value;

  if (cron_schedule === 'custom') {
    cron_schedule = document.getElementById('task-cron').value.trim();
  }

  if (!name) { alert('Error: Please enter a Task Name.'); return; }
  if (!target_remote) { alert('Error: Please select a Destination Cloud Remote.'); return; }

  const payload = { name, source_path, target_remote, target_path, mode, conflict_mode, cron_schedule, priority, bw_limit, realtime_watch, encrypt_backup, bundle_archive, smart_code_filter, enabled: 1 };

  try {
    let res;
    if (id) {
      res = await fetch(`/api/tasks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (data.error) {
      alert('Error saving task: ' + data.error);
    } else {
      document.getElementById('modal-task').classList.remove('active');
      fetchTasks();
      fetchStatus();
    }
  } catch (err) {
    alert('Failed to save task: ' + err.message);
  }
}

async function runTaskNow(taskId) {
  // Optimistic UI
  setTaskStatusOptimistic(taskId, 'running');
  try {
    appendConsoleLine(`[System] Requesting immediate manual execution for task ${taskId}...`, 'system');
    const res = await fetch(`/api/tasks/${taskId}/run`, { method: 'POST' });
    const data = await res.json();
    if (data.message) {
      appendConsoleLine(`[System] ${data.message}`, 'system');
    }
  } catch (err) {
    appendConsoleLine(`[System] Failed to trigger task: ${err.message}`, 'error');
  }
}

async function deleteTask(taskId) {
  if (!confirm('Are you sure you want to delete this backup task?')) return;
  try {
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    fetchTasks();
    fetchStatus();
  } catch (err) {
    alert('Failed to delete task: ' + err.message);
  }
}

function switchSettingsModalTab(tabName) {
  const tabs = ['remotes', 'notifications', 'security', 'encryption', 'backup', 'version'];
  tabs.forEach(t => {
    const btn = document.getElementById(`tab-btn-settings-${t}`);
    const content = document.getElementById(`tab-settings-${t}`);
    if (btn) btn.classList.toggle('active', t === tabName);
    if (content) content.classList.toggle('hidden', t !== tabName);
  });
  if (tabName === 'version') {
    fetchAppVersion();
  }
}

let appVersionData = { version: '2.8.2', latestVersion: '2.8.2', isLatest: true };

async function fetchAppVersion() {
  try {
    const res = await fetch('/api/version');
    if (!res.ok) return;
    const data = await res.json();
    appVersionData = { ...appVersionData, ...data };
    
    // Update header version pill
    const headerBadge = document.getElementById('header-version-badge');
    if (headerBadge) {
      headerBadge.textContent = `v${data.version || '2.8.2'}`;
    }

    // Update settings modal version display
    const settingsVersionBadge = document.getElementById('settings-current-version');
    if (settingsVersionBadge) {
      settingsVersionBadge.textContent = `v${data.version || '2.8.2'}`;
    }
    const settingsNodeUptime = document.getElementById('settings-version-uptime');
    if (settingsNodeUptime && data.uptime !== undefined) {
      const hours = Math.floor(data.uptime / 3600);
      const mins = Math.floor((data.uptime % 3600) / 60);
      settingsNodeUptime.textContent = `${hours}h ${mins}m active`;
    }
  } catch (err) {
    console.warn('Failed to fetch app version:', err);
  }
}

async function checkAppUpdates(isManual = false) {
  const checkStatusEl = document.getElementById('version-check-status');
  const btnCheck = document.getElementById('btn-check-updates');
  if (btnCheck) {
    btnCheck.disabled = true;
    btnCheck.innerHTML = '⏳ Checking...';
  }
  if (checkStatusEl) {
    checkStatusEl.innerHTML = '<span style="color:var(--accent-cyan);">Checking GitHub releases &amp; registry...</span>';
  }

  try {
    const res = await fetch('/api/version/check');
    const data = await res.json();
    appVersionData = { ...appVersionData, ...data };

    if (btnCheck) {
      btnCheck.disabled = false;
      btnCheck.innerHTML = '🔄 Check for Updates';
    }

    if (data.isLatest) {
      if (checkStatusEl) {
        checkStatusEl.innerHTML = `<span style="color:#34d399; font-weight:600;">✅ You are running the latest version (v${escapeHtml(data.currentVersion)})</span>`;
      }
      const headerBadge = document.getElementById('header-version-badge');
      if (headerBadge) {
        headerBadge.className = 'version-pill';
        headerBadge.title = `AutoBackup v${data.currentVersion} • Up to date`;
      }
    } else {
      if (checkStatusEl) {
        checkStatusEl.innerHTML = `
          <div style="background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.4); padding:0.6rem 0.8rem; border-radius:6px; margin-top:0.4rem;">
            <div style="color:#fbbf24; font-weight:700; font-size:0.85rem; margin-bottom:0.25rem;">
              🚀 New Version Available: <strong>v${escapeHtml(data.latestVersion)}</strong>
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:0.4rem;">
              Current: v${escapeHtml(data.currentVersion)} → Latest: v${escapeHtml(data.latestVersion)}
            </div>
            <a href="${escapeHtml(data.releaseUrl || 'https://github.com/attacker2007/autobackup/releases')}" target="_blank" rel="noopener" class="btn btn-sm btn-primary" style="display:inline-flex; align-items:center; gap:0.3rem;">
              View Release on GitHub →
            </a>
          </div>
        `;
      }
      const headerBadge = document.getElementById('header-version-badge');
      if (headerBadge) {
        headerBadge.className = 'version-pill update-available';
        headerBadge.innerHTML = `v${escapeHtml(data.currentVersion)} <span class="update-dot"></span>`;
        headerBadge.title = `New version v${data.latestVersion} available! Click to view.`;
      }
    }
  } catch (err) {
    if (btnCheck) {
      btnCheck.disabled = false;
      btnCheck.innerHTML = '🔄 Check for Updates';
    }
    if (checkStatusEl) {
      checkStatusEl.innerHTML = `<span style="color:#f87171;">Failed to check updates: ${escapeHtml(err.message)}</span>`;
    }
  }
}

async function exportHubSettings() {
  try {
    appendConsoleLine('[System] Preparing AutoBackup export bundle...', 'system');
    const res = await fetch('/api/backup/export');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    const disposition = res.headers.get('content-disposition');
    let filename = 'autobackup-export.json';
    if (disposition && disposition.includes('filename=')) {
      filename = disposition.split('filename=')[1].replace(/["']/g, '').trim();
    }
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
    appendConsoleLine('[System] ✅ Backup Hub configuration exported successfully.', 'system');
  } catch (err) {
    alert('Failed to export configuration: ' + err.message);
    appendConsoleLine(`[System] ❌ Export error: ${err.message}`, 'error');
  }
}

let stagedImportBundle = null;

function setupBackupImportUI() {
  const fileInput = document.getElementById('input-import-backup-file');
  const label = document.getElementById('import-file-name-label');
  const btnExecute = document.getElementById('btn-execute-import-bundle');

  if (fileInput) {
    fileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (label) label.textContent = file.name;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          stagedImportBundle = JSON.parse(event.target.result);
          if (btnExecute) btnExecute.disabled = false;
        } catch (parseErr) {
          alert('Invalid JSON file. Please select a valid AutoBackup export .json bundle.');
          if (btnExecute) btnExecute.disabled = true;
        }
      };
      reader.readAsText(file);
    };
  }

  if (btnExecute) {
    btnExecute.onclick = async () => {
      if (!stagedImportBundle) return;
      if (!confirm('Are you sure you want to restore this configuration? This will import tasks, sources, webhooks, and cloud remotes into this instance.')) return;

      btnExecute.disabled = true;
      btnExecute.textContent = '⏳ Restoring...';
      try {
        const res = await fetch('/api/backup/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(stagedImportBundle)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Import failed');

        alert(`✅ ${data.message}`);
        appendConsoleLine(`[System] ✅ ${data.message}`, 'system');
        await fetchTasks();
        await fetchSources();
        await fetchRemotes(true);
        await fetchSettings();
      } catch (err) {
        alert('Restore failed: ' + err.message);
        appendConsoleLine(`[System] ❌ Restore error: ${err.message}`, 'error');
      } finally {
        btnExecute.disabled = false;
        btnExecute.textContent = 'Restore & Apply Now';
      }
    };
  }
}

async function saveCurrentConfigAsLiveSeed() {
  const btn = document.getElementById('btn-save-as-seed');
  const feedback = document.getElementById('save-seed-feedback');
  const badge = document.getElementById('persistence-status-badge');

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Saving Seed...';
  }
  if (feedback) feedback.textContent = '';

  try {
    const res = await fetch('/api/backup/save-as-seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to save seed');
    }

    if (feedback) {
      feedback.textContent = `✅ Saved ${data.remotesCount || 0} remotes, ${data.tasksCount || 0} tasks, and ${data.sourcesCount || 0} sources as live default!`;
    }
    if (badge) {
      badge.textContent = 'Seed Protected';
      badge.className = 'badge badge-success';
    }
    appendConsoleLine(`[Persistence] ✅ ${data.message}`, 'system');
  } catch (err) {
    if (feedback) {
      feedback.textContent = `❌ Error: ${err.message}`;
    }
    appendConsoleLine(`[Persistence] ❌ Error saving seed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '💾 Store Current Configuration as Live Default';
    }
  }
}

async function saveDeviceName() {
  const input = document.getElementById('setting-device-name-input');
  if (!input) return;
  const name = input.value.trim();
  await saveSettingKey({ device_name: name }, `Device Node Name updated to "${name || 'Default'}"!`);
}

function switchRemoteAddTab(tab) {
  document.getElementById('remote-tab-form')?.classList.toggle('hidden', tab !== 'form');
  document.getElementById('remote-tab-raw')?.classList.toggle('hidden', tab !== 'raw');
  document.getElementById('tab-remote-form-btn')?.classList.toggle('active', tab === 'form');
  document.getElementById('tab-remote-raw-btn')?.classList.toggle('active', tab === 'raw');
}

async function startRcloneOAuthFlow(provider) {
  const box = document.getElementById('oauth-status-box');
  if (box) {
    box.innerHTML = `<div style="padding:0.6rem; background:rgba(0,242,254,0.08); border:1px solid var(--accent-primary); border-radius:6px; color:#38bdf8; font-size:0.83rem;">⏳ Executing <code>rclone authorize "${provider}"</code> to generate authorization URL...</div>`;
  }
  try {
    const res = await fetch('/api/remotes/authorize/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: provider })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (err) {
    if (box) {
      box.innerHTML = `<div style="padding:0.6rem; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.4); border-radius:6px; color:#fb7185; font-size:0.83rem;">❌ OAuth Error: ${escapeHtml(err.message)}</div>`;
    }
  }
}

async function importRawRemoteBlock() {
  const text = document.getElementById('raw-rclone-config-text')?.value.trim();
  if (!text || !text.includes('[')) {
    alert('Please paste a valid rclone.conf section block containing [remote_name].');
    return;
  }

  const btn = document.getElementById('btn-import-raw-remote');
  btn.disabled = true;
  btn.textContent = '⏳ Importing & Verifying...';

  try {
    const res = await fetch('/api/remotes/import-block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configText: text })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    alert(`Successfully imported ${data.importedRemotes.length} remote(s): ${data.importedRemotes.join(', ')}!`);
    document.getElementById('raw-rclone-config-text').value = '';
    fetchRemotes(true);
  } catch (err) {
    alert('Failed to import config block: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Remote Block & Verify';
  }
}

function copyCmdToClipboard(text, btnId) {
  navigator.clipboard.writeText(text);
  const btn = document.getElementById(btnId);
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '✅ Copied to Clipboard!';
  }
}

function updatePCloudAuthCmd(hostname) {
  const codeEl = document.getElementById('auth-cmd-code');
  if (codeEl) {
    if (hostname === 'eapi.pcloud.com') {
      codeEl.textContent = 'rclone authorize "pcloud" "hostname" "eapi.pcloud.com"';
    } else {
      codeEl.textContent = 'rclone authorize "pcloud"';
    }
  }
}

function renderRemoteProviderFields(provider) {
  const container = document.getElementById('remote-dynamic-fields');
  if (!container) return;
  
  if (['drive', 'dropbox', 'box', 'pcloud', 'onedrive'].includes(provider)) {
    const providerName = provider === 'drive' ? 'Google Drive' : (provider === 'dropbox' ? 'Dropbox' : (provider === 'pcloud' ? 'pCloud' : (provider === 'box' ? 'Box.com' : 'OneDrive')));
    const isPCloud = provider === 'pcloud';
    const extraPCloudHtml = isPCloud ? `
      <div class="form-group" style="margin-bottom: 1rem;">
        <label style="color: #38bdf8; font-weight: 700;">🌍 pCloud Account Region / Data Center</label>
        <select id="opt-hostname" onchange="updatePCloudAuthCmd(this.value)">
          <option value="eapi.pcloud.com">🇪🇺 European Union (EU) Server - eapi.pcloud.com (Recommended for EU Accounts)</option>
          <option value="api.pcloud.com">🇺🇸 United States (US) Server - api.pcloud.com</option>
        </select>
        <span class="form-help">If your pCloud account is in Europe, select EU server to avoid 'Invalid access_token (2094)' errors.</span>
      </div>
    ` : '';

    container.innerHTML = `
      <div id="oauth-status-box"></div>
      ${extraPCloudHtml}
      <div style="margin-bottom: 1rem; padding: 0.75rem; background: rgba(30, 41, 59, 0.6); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 8px;">
        <div style="font-size: 0.85rem; font-weight: 700; color: #38bdf8; margin-bottom: 0.4rem;">
          🔑 Rclone OAuth Authorization for ${providerName}
        </div>
        <div style="font-size: 0.78rem; color: #94a3b8; margin-bottom: 0.6rem;">
          Since port 53682 is reserved by Windows Hyper-V, run this command in Windows Command Prompt/PowerShell to authorize:
        </div>
        <div style="display: flex; gap: 0.5rem; align-items: center; background: rgba(0,0,0,0.4); padding: 0.5rem 0.75rem; border-radius: 6px; border: 1px solid rgba(0,242,254,0.3); margin-bottom: 0.6rem;">
          <code id="auth-cmd-code" style="color: #00f2fe; font-family: monospace; font-size: 0.88rem; flex: 1;">rclone authorize "${provider}"${isPCloud ? ' "hostname" "eapi.pcloud.com"' : ''}</code>
          <button type="button" class="btn btn-sm btn-primary" id="btn-copy-auth-cmd" onclick="copyCmdToClipboard(document.getElementById('auth-cmd-code').innerText, 'btn-copy-auth-cmd')">
            📋 Copy Command
          </button>
        </div>
        <div style="font-size: 0.75rem; color: #64748b; display: flex; align-items: center; justify-content: space-between;">
          <span>After running on Windows, paste the returned token JSON into the box below.</span>
          <button type="button" class="btn btn-sm btn-outline" onclick="startRcloneOAuthFlow('${provider}')" style="font-size: 0.72rem; padding: 0.2rem 0.5rem;">
            🌐 In-Container Web OAuth
          </button>
        </div>
      </div>
      <div class="grid-2col">
        <div class="form-group">
          <label>Client ID (Optional)</label>
          <input type="text" id="opt-client_id" placeholder="Optional custom OAuth Client ID">
        </div>
        <div class="form-group">
          <label>Client Secret (Optional)</label>
          <input type="password" id="opt-client_secret" placeholder="Optional custom OAuth Client Secret">
        </div>
      </div>
      <div class="form-group">
        <label>Access Token / Refresh Token JSON (or Raw Token String)</label>
        <textarea id="opt-token" style="background: #090d16; border: 1px solid rgba(255,255,255,0.2); color: #a7f3d0; padding: 0.5rem; border-radius: 4px; width: 100%; font-family: monospace;" rows="3" placeholder='{"access_token":"...","token_type":"bearer"}'></textarea>
        <span class="form-help">Paste token JSON generated from <code>rclone authorize "${provider}"</code> or your raw access token string.</span>
      </div>
    `;
  } else if (provider === 'webdav') {
    container.innerHTML = `
      <div class="form-group">
        <label>WebDAV URL (TeraBox WebDAV Bridge or Nextcloud/Owncloud)</label>
        <input type="text" id="opt-url" placeholder="https://127.0.0.1:8080/webdav or TeraBox WebDAV URL" required>
      </div>
      <div class="grid-2col">
        <div class="form-group">
          <label>Username / Email</label>
          <input type="text" id="opt-user" placeholder="Username">
        </div>
        <div class="form-group">
          <label>Password / App Token</label>
          <input type="password" id="opt-pass" placeholder="Password">
        </div>
      </div>
      <div class="form-group">
        <label>Vendor Preset</label>
        <select id="opt-vendor">
          <option value="other">Generic / TeraBox Bridge</option>
          <option value="nextcloud">Nextcloud</option>
          <option value="owncloud">ownCloud</option>
        </select>
      </div>
    `;
  } else if (provider === 'mega') {
    container.innerHTML = `
      <div class="grid-2col">
        <div class="form-group">
          <label>Mega Email Account</label>
          <input type="text" id="opt-user" placeholder="user@example.com" required>
        </div>
        <div class="form-group">
          <label>Mega Password</label>
          <input type="password" id="opt-pass" placeholder="Password" required>
        </div>
      </div>
    `;
  } else if (provider === 's3') {
    container.innerHTML = `
      <div class="form-group">
        <label>Access Key ID</label>
        <input type="text" id="opt-access_key_id" placeholder="AKIAIOSFODNN7EXAMPLE" required>
      </div>
      <div class="form-group">
        <label>Secret Access Key</label>
        <input type="password" id="opt-secret_access_key" placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" required>
      </div>
      <div class="form-group">
        <label>Region / Endpoint (Optional)</label>
        <input type="text" id="opt-region" placeholder="us-east-1">
      </div>
    `;
  }
}

async function handleRemoteFormSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('remote-name').value.trim();
  const type = document.getElementById('remote-type').value;

  const options = {};
  document.querySelectorAll('#remote-dynamic-fields input, #remote-dynamic-fields select, #remote-dynamic-fields textarea').forEach(input => {
    if (input.value) {
      const key = input.id.replace(/^opt-/, '');
      options[key] = input.value;
    }
  });

  try {
    const res = await fetch('/api/remotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, options })
    });
    const data = await res.json();
    if (data.error) {
      alert('Error creating remote: ' + data.error);
    } else {
      fetchRemotes();
      document.getElementById('remote-name').value = '';
      alert(`Remote "${name}" saved and verified successfully!`);
    }
  } catch (err) {
    alert('Failed to save remote: ' + err.message);
  }
}

async function deleteRemote(name) {
  if (!confirm(`Are you sure you want to remove remote "${name}"?`)) return;
  try {
    await fetch(`/api/remotes/${name}`, { method: 'DELETE' });
    fetchRemotes();
  } catch (err) {
    alert('Failed to delete remote: ' + err.message);
  }
}

// ─── Security PIN & Storage Health Alerts ────────────────────────────────────

let isPinConfigured = false;
let isUnlockedInSession = sessionStorage.getItem('hub_unlocked') === 'true';

async function checkPinAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    isPinConfigured = !!data.pinConfigured;

    const lockBtn = document.getElementById('btn-lock-dashboard');
    const pinStatusText = document.getElementById('pin-status-text');

    if (isPinConfigured) {
      if (lockBtn) lockBtn.classList.remove('hidden');
      if (pinStatusText) pinStatusText.textContent = 'Status: 🔒 PIN Protection Active';

      if (!isUnlockedInSession) {
        document.getElementById('modal-pin-lock')?.classList.add('active');
      }
    } else {
      if (lockBtn) lockBtn.classList.add('hidden');
      if (pinStatusText) pinStatusText.textContent = 'Status: PIN Protection Disabled';
      document.getElementById('modal-pin-lock')?.classList.remove('active');
    }
  } catch (e) {
    console.error('Failed to check PIN auth status:', e);
  }
}

async function handlePinUnlock(e) {
  e.preventDefault();
  const input = document.getElementById('pin-unlock-input');
  const errDiv = document.getElementById('pin-unlock-error');
  const pin = input?.value.trim();

  if (!pin) return;

  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();

    if (data.success) {
      isUnlockedInSession = true;
      sessionStorage.setItem('hub_unlocked', 'true');
      document.getElementById('modal-pin-lock')?.classList.remove('active');
      if (errDiv) errDiv.classList.add('hidden');
      if (input) input.value = '';
    } else {
      if (errDiv) {
        errDiv.textContent = data.error || 'Incorrect Security PIN';
        errDiv.classList.remove('hidden');
      }
    }
  } catch (err) {
    if (errDiv) {
      errDiv.textContent = 'Error: ' + err.message;
      errDiv.classList.remove('hidden');
    }
  }
}

function lockDashboard() {
  isUnlockedInSession = false;
  sessionStorage.removeItem('hub_unlocked');
  document.getElementById('modal-pin-lock')?.classList.add('active');
  const input = document.getElementById('pin-unlock-input');
  if (input) {
    input.value = '';
    input.focus();
  }
}

async function saveSecurityPin() {
  const pinInput = document.getElementById('pin-setup-input');
  const currentPinInput = document.getElementById('pin-current-input');

  const pin = pinInput?.value.trim() || '';
  const current_pin = currentPinInput?.value.trim() || '';

  try {
    const res = await fetch('/api/auth/set-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, current_pin })
    });
    const data = await res.json();

    if (data.error) {
      alert('Security PIN error: ' + data.error);
    } else {
      alert(data.message);
      if (pinInput) pinInput.value = '';
      if (currentPinInput) currentPinInput.value = '';
      checkPinAuthStatus();
    }
  } catch (err) {
    alert('Failed to update Security PIN: ' + err.message);
  }
}

async function triggerMonthlyDiscordReport() {
  const btn = document.getElementById('btn-trigger-monthly-report');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Compiling & Sending Report...';
  }

  try {
    const res = await fetch('/api/reports/monthly/trigger', { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      alert('📊 Monthly Executive Summary Report sent to Discord successfully!');
      appendConsoleLine('[System] ✅ Monthly Executive Summary Report sent to Discord successfully!', 'system');
    } else {
      alert('Failed to send report: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Failed to trigger report: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📊 Send Test Monthly Report Now';
    }
  }
}

async function fetchStorageAlerts() {
  try {
    const res = await fetch('/api/remotes/alerts');
    const data = await res.json();
    const container = document.getElementById('storage-alerts-container');

    if (!container) return;

    if (!data.alerts || data.alerts.length === 0) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    container.innerHTML = data.alerts.map(a => `
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem 1rem; border-radius: 8px; background: ${a.level === 'critical' ? 'rgba(244,63,94,0.12)' : 'rgba(245,158,11,0.12)'}; border: 1px solid ${a.level === 'critical' ? 'rgba(244,63,94,0.4)' : 'rgba(245,158,11,0.4)'}; margin-bottom: 0.5rem;">
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <span style="font-size: 1.2rem;">${a.type === 'capacity' ? '⚠️' : '⛔'}</span>
          <div>
            <strong style="color: ${a.level === 'critical' ? '#fb7185' : '#fbbf24'}; font-size: 0.9rem;">
              ${a.type === 'capacity' ? 'Storage Capacity Warning' : 'Remote Health Alert'}: ${escapeHtml(a.remote)}
            </strong>
            <div style="font-size: 0.78rem; color: #cbd5e1;">${escapeHtml(a.message)}</div>
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-outline btn-trigger-remotes" style="color: #f8fafc; border-color: rgba(255,255,255,0.2);">
          Manage Storage
        </button>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to fetch storage alerts:', err);
  }
}

async function sendTestNotificationChannel(channelType) {
  const btnId = `btn-test-${channelType}`;
  const btn = document.getElementById(btnId);
  const origText = btn ? btn.textContent : '';

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Sending...';
  }

  try {
    const res = await fetch('/api/notifications/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channelType })
    });
    const data = await res.json();

    if (data.success) {
      alert(data.message);
      appendConsoleLine(`[System] ✅ ${data.message}`, 'system');
    } else {
      alert('Test failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Failed to send test notification: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

// ─── Phase 1 & 2 Actions: Pause, Resume, Partial Run, Device Link, Discord Release, Bulk Delete ───

async function pauseTaskNow(taskId) {
  try {
    appendConsoleLine(`[System] Requesting pause for task ${taskId}...`, 'system');
    const res = await fetch(`/api/tasks/${taskId}/pause`, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      alert('Error pausing task: ' + data.error);
    } else {
      appendConsoleLine(`[System] Task ${taskId} paused.`, 'system');
      fetchTasks();
    }
  } catch (err) {
    alert('Failed to pause task: ' + err.message);
  }
}

async function resumeTaskNow(taskId) {
  try {
    appendConsoleLine(`[System] Resuming task ${taskId}...`, 'system');
    const res = await fetch(`/api/tasks/${taskId}/resume`, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      alert('Error resuming task: ' + data.error);
    } else {
      appendConsoleLine(`[System] Task ${taskId} resumed.`, 'system');
      fetchTasks();
    }
  } catch (err) {
    alert('Failed to resume task: ' + err.message);
  }
}

let activePartialTaskId = null;

async function openPartialTaskModal(taskId) {
  const task = currentTasks.find(t => String(t.id) === String(taskId));
  if (!task) return;

  activePartialTaskId = taskId;
  const modal = document.getElementById('modal-partial-task');
  const titleEl = document.getElementById('partial-task-title');
  const idInput = document.getElementById('partial-task-id');
  const listEl = document.getElementById('partial-sources-list');
  const descEl = document.getElementById('partial-task-desc');

  if (titleEl) titleEl.textContent = `📂 Run Partial Backup: ${task.name}`;
  if (idInput) idInput.value = taskId;
  if (!listEl) return;

  listEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.82rem; padding:0.8rem; text-align:center;">⏳ Loading folder structure & sub-items...</div>';
  modal?.classList.add('active');

  try {
    const res = await fetch(`/api/tasks/${taskId}/sources-detail`);
    const detail = await res.json();
    const sources = (detail && Array.isArray(detail.sources)) ? detail.sources : [];

    if (sources.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:0.5rem;">No source paths configured for this task.</div>';
      updatePartialSelectedCount();
      return;
    }

    if (descEl) {
      descEl.textContent = detail.isMultiFolder
        ? 'Select the specific folders or containers to backup. You can also expand any folder to select specific subdirectories or files:'
        : 'Select the entire source folder, or pick specific subdirectories and files to backup in this run:';
    }

    listEl.innerHTML = sources.map((src, idx) => {
      const itemsCount = src.items ? src.items.length : 0;
      const subitemsHtml = itemsCount > 0 ? `
        <div class="partial-subitems-container" id="partial-subitems-${idx}" style="display: ${detail.isMultiFolder ? 'none' : 'flex'};">
          <div style="font-size: 0.7rem; color: var(--accent-cyan); font-weight: 600; margin-bottom: 0.2rem; display: flex; justify-content: space-between;">
            <span>Sub-items in ${escapeHtml(src.name)} (${itemsCount}):</span>
            <span>Uncheck to exclude specific files</span>
          </div>
          ${src.items.map((item, iIdx) => `
            <label class="partial-subitem-row">
              <input type="checkbox" class="partial-item-cb" data-src-idx="${idx}" value="${escapeHtml(item.relPath)}" checked onchange="updatePartialSelectedCount()">
              <span>${item.isDir ? '📁' : '📄'}</span>
              <span style="font-family:var(--font-mono);">${escapeHtml(item.name)}</span>
            </label>
          `).join('')}
        </div>
      ` : '';

      const expandBtnHtml = itemsCount > 0 ? `
        <button type="button" class="btn-toggle-subitems" onclick="togglePartialSubitemsCollapse(${idx})">
          ${detail.isMultiFolder ? `📂 Drill Down (${itemsCount} items)` : `📂 Hide Sub-items`}
        </button>
      ` : '';

      return `
        <div class="partial-source-card" data-src-idx="${idx}">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <label style="display: flex; align-items: center; gap: 0.6rem; cursor: pointer; flex: 1; min-width: 0;">
              <input type="checkbox" class="partial-source-cb" data-src-idx="${idx}" value="${escapeHtml(src.raw)}" checked onchange="handlePartialFolderCheckChange(this, ${idx})">
              <div style="display: flex; flex-direction: column; overflow: hidden;">
                <span style="font-weight: 600; font-size: 0.84rem; color: var(--text-main);">${escapeHtml(src.name)}</span>
                <span style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">${escapeHtml(src.resolved || src.raw)}</span>
              </div>
            </label>
            <div style="display: flex; align-items: center; gap: 0.4rem; margin-left: 0.5rem;">
              ${expandBtnHtml}
            </div>
          </div>
          ${subitemsHtml}
        </div>
      `;
    }).join('');

    updatePartialSelectedCount();
  } catch (err) {
    listEl.innerHTML = `<div style="color:#fb7185; font-size:0.8rem; padding:0.5rem;">⚠️ Failed loading source structure: ${escapeHtml(err.message)}</div>`;
  }
}

function togglePartialSubitemsCollapse(idx) {
  const container = document.getElementById(`partial-subitems-${idx}`);
  if (!container) return;
  const isHidden = (container.style.display === 'none');
  container.style.display = isHidden ? 'flex' : 'none';
}

function handlePartialFolderCheckChange(folderCb, idx) {
  const itemCheckboxes = document.querySelectorAll(`.partial-item-cb[data-src-idx="${idx}"]`);
  itemCheckboxes.forEach(cb => {
    cb.checked = folderCb.checked;
  });
  updatePartialSelectedCount();
}

function updatePartialSelectedCount() {
  const listEl = document.getElementById('partial-sources-list');
  const countEl = document.getElementById('partial-selected-count');
  if (!listEl || !countEl) return;

  const folderCbs = listEl.querySelectorAll('.partial-source-cb');
  const checkedFolders = listEl.querySelectorAll('.partial-source-cb:checked');
  const itemCbs = listEl.querySelectorAll('.partial-item-cb');
  const checkedItems = listEl.querySelectorAll('.partial-item-cb:checked');

  if (itemCbs.length > 0 && folderCbs.length === 1) {
    countEl.textContent = `${checkedItems.length} of ${itemCbs.length} items selected`;
  } else {
    countEl.textContent = `${checkedFolders.length} of ${folderCbs.length} folder(s) selected`;
  }

  const btnRun = document.getElementById('btn-execute-partial-run');
  if (btnRun) {
    const hasAnyChecked = (checkedFolders.length > 0) || (checkedItems.length > 0);
    btnRun.disabled = !hasAnyChecked;
  }
}

function toggleAllPartialSources(checked) {
  const listEl = document.getElementById('partial-sources-list');
  if (!listEl) return;
  listEl.querySelectorAll('.partial-source-cb').forEach(cb => { cb.checked = checked; });
  listEl.querySelectorAll('.partial-item-cb').forEach(cb => { cb.checked = checked; });
  updatePartialSelectedCount();
}

async function executePartialTaskRun() {
  if (!activePartialTaskId) return;
  const listEl = document.getElementById('partial-sources-list');
  const checkedFolders = Array.from(listEl?.querySelectorAll('.partial-source-cb:checked') || []).map(cb => cb.value);

  // Check if any sub-items are selectively chosen (or excluded)
  const allItemCbs = Array.from(listEl?.querySelectorAll('.partial-item-cb') || []);
  const checkedItemCbs = Array.from(listEl?.querySelectorAll('.partial-item-cb:checked') || []);
  
  let subPaths = null;
  // If sub-item selection was shown and user unchecked some items
  if (allItemCbs.length > 0 && checkedItemCbs.length < allItemCbs.length) {
    subPaths = checkedItemCbs.map(cb => cb.value);
  }

  if (checkedFolders.length === 0 && (!subPaths || subPaths.length === 0)) {
    alert('Please select at least one folder or item to run.');
    return;
  }

  const btn = document.getElementById('btn-execute-partial-run');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '🚀 Starting Partial Run...';
  }

  try {
    const payload = { selected_sources: checkedFolders };
    if (subPaths && subPaths.length > 0) {
      payload.sub_paths = subPaths;
    }

    const res = await fetch(`/api/tasks/${activePartialTaskId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    appendConsoleLine(`[System] Partial task execution started (${checkedFolders.length} folder(s)${subPaths ? `, ${subPaths.length} items` : ''}).`, 'system');
    document.getElementById('modal-partial-task')?.classList.remove('active');
    fetchTasks();
  } catch (err) {
    alert('Failed to start partial task run: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🚀 Run Partial Backup';
    }
  }
}

let pairingCountdownTimer = null;
let currentPairingRawCode = '';

function switchPairingModalTab(tab) {
  const tabs = ['code', 'enter', 'qr'];
  tabs.forEach(t => {
    const el = document.getElementById(`pair-tab-${t}`);
    const btn = document.getElementById(`tab-btn-pair-${t}`);
    if (el) el.style.display = (t === tab) ? (t === 'qr' ? 'flex' : 'block') : 'none';
    if (btn) {
      if (t === tab) {
        btn.classList.add('active');
        btn.style.color = 'var(--accent-cyan)';
        btn.style.borderBottomColor = 'var(--accent-cyan)';
      } else {
        btn.classList.remove('active');
        btn.style.color = 'var(--text-muted)';
        btn.style.borderBottomColor = 'transparent';
      }
    }
  });
}

async function fetchPairingCode(forceRefresh = false) {
  const codeDisplay = document.getElementById('pairing-code-display');
  const countdownText = document.getElementById('pairing-countdown-text');
  const urlInput = document.getElementById('pairing-url-input');
  const qrImg = document.getElementById('pairing-qr-image');
  const firewallInput = document.getElementById('firewall-cmd-input');

  if (codeDisplay) codeDisplay.textContent = '... ...';

  try {
    const res = await fetch(`/api/network/pairing-code?refresh=${forceRefresh ? '1' : '0'}`);
    const data = await res.json();

    if (data.success) {
      currentPairingRawCode = data.rawCode;
      if (codeDisplay) codeDisplay.textContent = data.code;
      if (urlInput) urlInput.value = data.pairingUrl || window.location.origin;
      if (firewallInput && data.firewallCommand) firewallInput.value = data.firewallCommand;

      if (qrImg) {
        const qrUrl = data.pairingUrl || window.location.origin;
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=170x170&data=${encodeURIComponent(qrUrl)}`;
      }

      // Start Countdown
      let secondsLeft = data.remainingSeconds || 900;
      if (pairingCountdownTimer) clearInterval(pairingCountdownTimer);
      pairingCountdownTimer = setInterval(() => {
        secondsLeft--;
        if (secondsLeft <= 0) {
          clearInterval(pairingCountdownTimer);
          if (countdownText) countdownText.textContent = '⚠️ Code expired. Click Refresh';
          if (codeDisplay) codeDisplay.textContent = 'EXPIRED';
        } else {
          const mins = Math.floor(secondsLeft / 60);
          const secs = secondsLeft % 60;
          if (countdownText) {
            countdownText.textContent = `⏳ Expires in ${mins}:${secs < 10 ? '0' : ''}${secs}`;
          }
        }
      }, 1000);
    }
  } catch (err) {
    console.warn('[Pairing] Error fetching pairing code:', err);
    if (codeDisplay) codeDisplay.textContent = 'OFFLINE';
  }
}

function copyPairingCode() {
  const code = currentPairingRawCode || document.getElementById('pairing-code-display')?.textContent?.replace(/\s+/g, '');
  if (code) {
    navigator.clipboard.writeText(code);
    const countText = document.getElementById('pairing-countdown-text');
    if (countText) {
      const orig = countText.textContent;
      countText.textContent = '✅ Code Copied to Clipboard!';
      setTimeout(() => { countText.textContent = orig; }, 2000);
    }
  }
}

function copyFirewallCommand() {
  const input = document.getElementById('firewall-cmd-input');
  if (input) {
    navigator.clipboard.writeText(input.value);
    alert('Firewall command copied! Run it in PowerShell (Admin) on your host PC to open port 3000.');
  }
}

async function submitPairingCode() {
  const codeInput = document.getElementById('input-verify-pairing-code');
  const nameInput = document.getElementById('input-verify-device-name');
  const statusDiv = document.getElementById('pair-verify-status');
  const btn = document.getElementById('btn-submit-verify-code');

  const code = codeInput ? codeInput.value.trim() : '';
  if (!code) {
    alert('Please enter the 6-digit code shown on your host computer.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Verifying Code...';
  }

  try {
    const res = await fetch('/api/network/verify-pairing-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        clientDeviceName: nameInput?.value?.trim() || navigator.userAgent.slice(0, 30),
        platform: /iPad|iPhone|Android|Tablet/i.test(navigator.userAgent) ? 'tablet' : 'desktop'
      })
    });

    const data = await res.json();

    if (statusDiv) {
      statusDiv.style.display = 'block';
      if (data.success) {
        statusDiv.style.color = '#34d399';
        statusDiv.innerHTML = `✅ <strong>Successfully Linked!</strong> Connected to host <em>${escapeHtml(data.hostDeviceName || 'AutoBackup')}</em>.`;
        if (data.token) {
          localStorage.setItem('autobackup_linked_token', data.token);
        }
        setTimeout(() => {
          document.getElementById('modal-link-device')?.classList.remove('active');
        }, 2200);
      } else {
        statusDiv.style.color = '#f87171';
        statusDiv.innerHTML = `❌ ${escapeHtml(data.error || 'Failed to verify pairing code')}`;
      }
    }
  } catch (err) {
    if (statusDiv) {
      statusDiv.style.display = 'block';
      statusDiv.style.color = '#f87171';
      statusDiv.textContent = '❌ Network error connecting to host.';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔗 Link This Device Now';
    }
  }
}

async function openLinkDeviceModal() {
  const modal = document.getElementById('modal-link-device');
  modal?.classList.add('active');
  switchPairingModalTab('code');
  await fetchPairingCode(false);

  // Fetch count of linked devices
  try {
    const res = await fetch('/api/network/linked-devices');
    const data = await res.json();
    const countEl = document.getElementById('linked-devices-count-text');
    if (countEl && data.devices) {
      countEl.textContent = `Linked Devices: ${data.devices.length}`;
    }
  } catch (e) {}
}

function copyPairingUrl() {
  const urlInput = document.getElementById('pairing-url-input');
  if (urlInput) {
    navigator.clipboard.writeText(urlInput.value);
    const btn = document.getElementById('btn-copy-pairing-url');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }
  }
}

// ── Auto-Update Engine & Dialog ──
let latestUpdateInfo = null;

async function checkAppUpdates() {
  const modal = document.getElementById('modal-app-update');
  const iconEl = document.getElementById('update-icon-indicator');
  const headingEl = document.getElementById('update-heading-text');
  const descEl = document.getElementById('update-description-text');
  const notesBox = document.getElementById('update-release-notes-box');
  const progressBar = document.getElementById('update-progress-container');
  const actionBtn = document.getElementById('btn-update-action');

  modal?.classList.add('active');
  if (iconEl) iconEl.textContent = '🔄';
  if (headingEl) headingEl.textContent = 'Checking for Updates...';
  if (descEl) descEl.textContent = 'Querying GitHub releases for the latest AutoBackup package...';
  if (notesBox) notesBox.style.display = 'none';
  if (progressBar) progressBar.style.display = 'none';
  if (actionBtn) {
    actionBtn.disabled = true;
    actionBtn.textContent = 'Checking...';
  }

  try {
    // If running in Desktop app with electron-updater
    if (window.desktopApi && typeof window.desktopApi.checkForUpdates === 'function') {
      window.desktopApi.onUpdateStatus((statusData) => {
        handleDesktopUpdateStatus(statusData);
      });
      const checkRes = await window.desktopApi.checkForUpdates();
      if (checkRes && checkRes.devMode) {
        // Fallback to web API in development mode
        await fetchWebVersionCheck();
      }
    } else {
      await fetchWebVersionCheck();
    }
  } catch (err) {
    if (headingEl) headingEl.textContent = 'Update Check Error';
    if (descEl) descEl.textContent = err.message || 'Failed to connect to update server.';
    if (actionBtn) {
      actionBtn.disabled = false;
      actionBtn.textContent = 'Retry';
    }
  }
}

async function fetchWebVersionCheck() {
  const iconEl = document.getElementById('update-icon-indicator');
  const headingEl = document.getElementById('update-heading-text');
  const descEl = document.getElementById('update-description-text');
  const notesBox = document.getElementById('update-release-notes-box');
  const actionBtn = document.getElementById('btn-update-action');

  const res = await fetch('/api/version/check');
  const data = await res.json();
  latestUpdateInfo = data;

  if (data.isLatest) {
    if (iconEl) iconEl.textContent = '✅';
    if (headingEl) headingEl.textContent = `AutoBackup is Up to Date (v${data.currentVersion})`;
    if (descEl) descEl.textContent = 'You are currently running the latest stable release of AutoBackup.';
    if (actionBtn) {
      actionBtn.disabled = false;
      actionBtn.textContent = 'Check Again';
    }
  } else {
    if (iconEl) iconEl.textContent = '🚀';
    if (headingEl) headingEl.textContent = `New Version Available: v${data.latestVersion}`;
    if (descEl) descEl.textContent = `A newer release (v${data.latestVersion}) is available. Current version: v${data.currentVersion}`;
    if (notesBox && data.releaseNotes) {
      notesBox.style.display = 'block';
      notesBox.innerHTML = `<strong>Release Notes:</strong><br><pre style="white-space: pre-wrap; font-family: inherit; margin-top: 0.4rem;">${escapeHtml(data.releaseNotes)}</pre>`;
    }
    if (actionBtn) {
      actionBtn.disabled = false;
      actionBtn.textContent = 'Download Update';
    }
  }
}

function handleDesktopUpdateStatus(data) {
  const iconEl = document.getElementById('update-icon-indicator');
  const headingEl = document.getElementById('update-heading-text');
  const descEl = document.getElementById('update-description-text');
  const progressBar = document.getElementById('update-progress-container');
  const progressInner = document.getElementById('update-progress-bar');
  const percentText = document.getElementById('update-percent-text');
  const actionBtn = document.getElementById('btn-update-action');

  if (data.status === 'checking') {
    if (headingEl) headingEl.textContent = 'Checking for Updates...';
  } else if (data.status === 'available') {
    if (iconEl) iconEl.textContent = '🚀';
    if (headingEl) headingEl.textContent = `New Update v${data.version || ''} Found!`;
    if (descEl) descEl.textContent = 'Click below to download and install automatically.';
    if (actionBtn) {
      actionBtn.disabled = false;
      actionBtn.textContent = '📥 Download Now';
    }
  } else if (data.status === 'not-available') {
    if (iconEl) iconEl.textContent = '✅';
    if (headingEl) headingEl.textContent = 'AutoBackup is Up to Date';
    if (descEl) descEl.textContent = 'You are running the latest version.';
    if (actionBtn) {
      actionBtn.disabled = false;
      actionBtn.textContent = 'Check Again';
    }
  } else if (data.status === 'downloading') {
    if (progressBar) progressBar.style.display = 'block';
    if (progressInner) progressInner.style.width = `${data.percent || 0}%`;
    if (percentText) percentText.textContent = `${data.percent || 0}%`;
    if (descEl) descEl.textContent = `Downloading update... (${data.percent || 0}%)`;
    if (actionBtn) {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Downloading...';
    }
  } else if (data.status === 'downloaded') {
    if (iconEl) iconEl.textContent = '🎉';
    if (headingEl) headingEl.textContent = 'Update Ready to Install!';
    if (descEl) descEl.textContent = 'The new version has been downloaded. Restart AutoBackup to apply.';
    if (progressBar) progressBar.style.display = 'none';
    if (actionBtn) {
      actionBtn.disabled = false;
      actionBtn.textContent = '🔄 Restart & Install Now';
    }
  } else if (data.status === 'error') {
    if (iconEl) iconEl.textContent = '⚠️';
    if (headingEl) headingEl.textContent = 'Update Check Notice';
    if (descEl) descEl.textContent = data.message || 'Could not verify update status.';
    if (actionBtn) {
      actionBtn.disabled = false;
      actionBtn.textContent = 'Retry';
    }
  }
}

function handleUpdateActionClick() {
  const actionBtn = document.getElementById('btn-update-action');
  const btnText = actionBtn ? actionBtn.textContent : '';

  if (btnText.includes('Restart')) {
    if (window.desktopApi && typeof window.desktopApi.installUpdateNow === 'function') {
      window.desktopApi.installUpdateNow();
    }
  } else if (btnText.includes('Download Now')) {
    if (window.desktopApi && typeof window.desktopApi.startDownloadUpdate === 'function') {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Starting Download...';
      window.desktopApi.startDownloadUpdate();
    }
  } else if (btnText.includes('Download Update') && latestUpdateInfo && latestUpdateInfo.releaseUrl) {
    window.open(latestUpdateInfo.releaseUrl, '_blank');
  } else {
    checkAppUpdates();
  }
}

function openBulkRemoveModal() {
  const modal = document.getElementById('modal-bulk-remove-sources');
  const tagSelect = document.getElementById('bulk-remove-tag-select');
  const modeSelect = document.getElementById('bulk-remove-mode');

  if (modeSelect) modeSelect.value = 'all';
  onBulkRemoveModeChange('all');

  // Populate unique tags
  if (tagSelect) {
    const tagSet = new Set();
    detectedSources.forEach(s => {
      if (s.tags) {
        s.tags.split(',').map(t => t.trim()).filter(Boolean).forEach(t => tagSet.add(t));
      }
    });

    if (tagSet.size === 0) {
      tagSelect.innerHTML = '<option value="">No tags defined yet</option>';
    } else {
      tagSelect.innerHTML = Array.from(tagSet).map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    }
  }

  modal?.classList.add('active');
}

function onBulkRemoveModeChange(mode) {
  const tagGroup = document.getElementById('bulk-remove-tag-group');
  if (tagGroup) {
    tagGroup.classList.toggle('hidden', mode !== 'tag');
  }
}

async function executeBulkRemoveSources() {
  const mode = document.getElementById('bulk-remove-mode')?.value || 'all';
  const tag = document.getElementById('bulk-remove-tag-select')?.value;

  let confirmMsg = 'Are you sure you want to remove ALL monitored source folders from AutoBackup?';
  if (mode === 'tag') {
    if (!tag) {
      alert('Please select a tag to remove.');
      return;
    }
    confirmMsg = `Are you sure you want to remove all monitored source folders tagged with "${tag}"?`;
  }

  if (!confirm(confirmMsg)) return;

  const btn = document.getElementById('btn-confirm-bulk-remove');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Removing...';
  }

  try {
    const res = await fetch('/api/sources/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, tag })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    alert(`✅ ${data.message}`);
    document.getElementById('modal-bulk-remove-sources')?.classList.remove('active');
    await fetchSources();
  } catch (err) {
    alert('Failed bulk removal: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Confirm Bulk Removal';
    }
  }
}

async function publishReleaseToDiscord() {
  const btn = document.getElementById('btn-publish-discord-release');
  const statusEl = document.getElementById('discord-publish-status');

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Publishing to Discord...';
  }
  if (statusEl) statusEl.textContent = '';

  try {
    const res = await fetch('/api/settings/publish-discord-release', { method: 'POST' });
    const data = await res.json();

    if (!res.ok || data.error) throw new Error(data.error || 'Failed to publish release');

    if (statusEl) statusEl.textContent = '✅ Published to Discord successfully!';
    appendConsoleLine('[Discord] ✅ Published release card with .EXE download & Docker command to Discord!', 'system');
  } catch (err) {
    alert('Failed to publish to Discord: ' + err.message);
    if (statusEl) statusEl.textContent = '❌ ' + err.message;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📢 Publish Release to Discord Webhook';
    }
  }
}

function handleNetworkStatusChange(isOnline, message) {
  const banner = document.getElementById('network-offline-banner');
  if (banner) {
    banner.classList.toggle('hidden', isOnline);
    if (!isOnline && message) {
      const textEl = banner.querySelector('span:last-child');
      if (textEl) textEl.textContent = message;
    }
  }

  if (isOnline) {
    appendConsoleLine(`[Network] 📶 Connection active: ${message || 'Online'}. Auto-resuming paused backup tasks...`, 'system');
    fetchTasks();
  } else {
    appendConsoleLine(`[Network] ⚠️ Connection dropped: ${message || 'Offline'}. Active tasks auto-paused safely.`, 'error');
    fetchTasks();
  }
}

async function saveEncryptionSettings() {
  const enabled = document.getElementById('setting-encryption-enabled')?.checked;
  const password = document.getElementById('setting-encryption-password')?.value.trim() || '';
  const salt = document.getElementById('setting-encryption-salt')?.value.trim() || '';
  const feedback = document.getElementById('encryption-feedback');

  if (enabled && !password) {
    if (feedback) {
      feedback.style.color = '#fb7185';
      feedback.textContent = '❌ Passphrase is required when encryption is enabled.';
    }
    return;
  }

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        encryption_enabled: enabled ? 'true' : 'false',
        encryption_password: password,
        encryption_salt: salt
      })
    });
    const data = await res.json();
    if (data.success) {
      if (feedback) {
        feedback.style.color = '#34d399';
        feedback.textContent = '✅ Encryption settings saved successfully!';
        setTimeout(() => { feedback.textContent = ''; }, 4000);
      }
      const encBadge = document.getElementById('encryption-status-badge');
      if (encBadge) {
        encBadge.textContent = enabled ? 'Active' : 'Optional';
        encBadge.className = enabled ? 'badge badge-success' : 'badge badge-secondary';
      }
      appendConsoleLine(`[Security] 🔐 Client-side encryption ${enabled ? 'activated' : 'disabled'}.`, 'system');
    } else {
      if (feedback) {
        feedback.style.color = '#fb7185';
        feedback.textContent = '❌ Error saving: ' + (data.error || 'Unknown error');
      }
    }
  } catch (err) {
    if (feedback) {
      feedback.style.color = '#fb7185';
      feedback.textContent = '❌ Failed to save: ' + err.message;
    }
  }
}

function updateContextMenuBadge(isRegistered) {
  const badge = document.getElementById('context-menu-badge');
  if (!badge) return;
  if (isRegistered) {
    badge.textContent = 'Active in Explorer';
    badge.className = 'badge badge-success';
  } else {
    badge.textContent = 'Not Registered';
    badge.className = 'badge badge-secondary';
  }
}

// ─── Failed Files Management Modal ──────────────────────────────────────────

async function openFailedFilesModal(taskId) {
  const modal = document.getElementById('modal-failed-files');
  if (!modal) return;

  const idInput = document.getElementById('failed-files-task-id');
  const titleLabel = document.getElementById('failed-files-task-name-label');
  const countBadge = document.getElementById('failed-files-count-badge');
  const listBody = document.getElementById('failed-files-list-body');
  const retryBtn = document.getElementById('btn-retry-failed-files');
  const copyBtn = document.getElementById('btn-copy-failed-files');

  if (idInput) idInput.value = taskId;

  const task = currentTasks.find(t => String(t.id) === String(taskId));
  const taskName = task ? task.name : `Task #${taskId}`;
  if (titleLabel) titleLabel.textContent = `Task: ${taskName}`;
  if (countBadge) countBadge.textContent = '...';

  if (listBody) {
    listBody.innerHTML = '<tr><td colspan="3" class="text-center" style="padding:1.5rem; color:var(--text-muted);">⏳ Loading failed files list...</td></tr>';
  }

  modal.classList.add('active');

  try {
    const res = await fetch(`/api/tasks/${taskId}/failed-files`);
    const files = await res.json();

    if (!Array.isArray(files) || files.length === 0) {
      if (countBadge) countBadge.textContent = '0';
      if (listBody) {
        listBody.innerHTML = '<tr><td colspan="3" class="text-center" style="padding:1.5rem; color:#34d399;">✅ No pending failed or skipped files found for this task.</td></tr>';
      }
      if (retryBtn) retryBtn.disabled = true;
      if (copyBtn) copyBtn.disabled = true;
      return;
    }

    if (countBadge) countBadge.textContent = files.length;
    if (retryBtn) retryBtn.disabled = false;
    if (copyBtn) copyBtn.disabled = false;

    if (listBody) {
      listBody.innerHTML = files.map(item => `
        <tr id="failed-file-row-${item.id}">
          <td style="padding:0.5rem 0.75rem; font-family:monospace; font-size:0.75rem; word-break:break-all; max-width:280px;" title="${escapeHtml(item.file_path)}">
            ${escapeHtml(item.file_path)}
          </td>
          <td style="padding:0.5rem 0.75rem; color:#fca5a5; font-size:0.75rem;">
            ${escapeHtml(item.error_reason || 'Unknown failure')}
          </td>
          <td style="padding:0.5rem 0.75rem; text-align:right; white-space:nowrap;">
            <button type="button" class="btn btn-sm btn-secondary" onclick="dismissSingleFailedFile('${item.id}', '${taskId}')" title="Dismiss this file record">
              ✕
            </button>
          </td>
        </tr>
      `).join('');
    }
  } catch (err) {
    if (listBody) {
      listBody.innerHTML = `<tr><td colspan="3" class="text-center" style="padding:1.5rem; color:#fb7185;">❌ Failed to load failed files: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

async function retryFailedFilesNow() {
  const taskId = document.getElementById('failed-files-task-id')?.value;
  if (!taskId) return;

  const retryBtn = document.getElementById('btn-retry-failed-files');
  if (retryBtn) {
    retryBtn.disabled = true;
    retryBtn.innerHTML = '⏳ Retrying...';
  }

  try {
    const res = await fetch(`/api/tasks/${taskId}/retry-failed`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      appendConsoleLine(`[Retry] 🔄 Initiated targeted retry of ${data.retriedFilesCount} skipped file(s) for task #${taskId}...`, 'system');
      document.getElementById('modal-failed-files')?.classList.remove('active');
      fetchTasks();
    } else {
      alert('Could not start retry: ' + (data.error || 'Unknown error'));
      if (retryBtn) {
        retryBtn.disabled = false;
        retryBtn.innerHTML = '🔄 Retry Failed Files Now';
      }
    }
  } catch (err) {
    alert('Failed to trigger retry: ' + err.message);
    if (retryBtn) {
      retryBtn.disabled = false;
      retryBtn.innerHTML = '🔄 Retry Failed Files Now';
    }
  }
}

async function dismissAllFailedFiles() {
  const taskId = document.getElementById('failed-files-task-id')?.value;
  if (!taskId) return;

  if (!confirm('Are you sure you want to dismiss all pending failed file records for this task?')) {
    return;
  }

  try {
    const res = await fetch(`/api/tasks/${taskId}/dismiss-failed`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      appendConsoleLine(`[Dismiss] Cleared failed file notifications for task #${taskId}.`, 'system');
      document.getElementById('modal-failed-files')?.classList.remove('active');
      fetchTasks();
    } else {
      alert('Error dismissing: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Failed to dismiss failed files: ' + err.message);
  }
}

async function dismissSingleFailedFile(failedId, taskId) {
  try {
    const res = await fetch(`/api/failed-files/${failedId}/dismiss`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      const row = document.getElementById(`failed-file-row-${failedId}`);
      if (row) row.remove();

      const tbody = document.getElementById('failed-files-list-body');
      const countBadge = document.getElementById('failed-files-count-badge');
      const remainingRows = tbody ? tbody.querySelectorAll('tr').length : 0;
      if (countBadge) countBadge.textContent = remainingRows;

      if (remainingRows === 0) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-center" style="padding:1.5rem; color:#34d399;">✅ All failed files dismissed.</td></tr>';
        document.getElementById('btn-retry-failed-files')?.setAttribute('disabled', 'true');
        document.getElementById('btn-copy-failed-files')?.setAttribute('disabled', 'true');
        fetchTasks();
      }
    }
  } catch (err) {
    alert('Failed to dismiss file: ' + err.message);
  }
}

function copyFailedFilesList() {
  const tbody = document.getElementById('failed-files-list-body');
  if (!tbody) return;

  const rows = tbody.querySelectorAll('tr');
  const paths = [];
  rows.forEach(r => {
    const cell = r.querySelector('td');
    if (cell && cell.textContent.trim()) {
      paths.push(cell.textContent.trim());
    }
  });

  if (paths.length === 0) return;

  navigator.clipboard.writeText(paths.join('\n')).then(() => {
    const btn = document.getElementById('btn-copy-failed-files');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '✅ Copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    }
  }).catch(() => {
    alert('Failed to copy to clipboard.');
  });
}

