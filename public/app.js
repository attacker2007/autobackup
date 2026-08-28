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

document.addEventListener('DOMContentLoaded', () => {
  initApp();
  initWebSocket();
  setupEventListeners();
});

async function initApp() {
  await checkPinAuthStatus();
  await Promise.all([
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
function appendConsoleLine(text, type = 'normal') {
  const consoleWin = document.getElementById('console-output');
  if (!consoleWin) return;

  const textStr = String(text || '');
  const lines = textStr.split('\n');
  const fragment = document.createDocumentFragment();

  lines.forEach((lineText, idx) => {
    if (!lineText && idx === lines.length - 1) return;
    const lineEl = document.createElement('div');
    lineEl.className = `console-line ${type}`;
    lineEl.textContent = lineText;
    fragment.appendChild(lineEl);
  });

  consoleWin.appendChild(fragment);
  consoleWin.scrollTop = consoleWin.scrollHeight;

  while (consoleWin.children.length > 500) {
    consoleWin.removeChild(consoleWin.firstChild);
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

  const filteredTasks = remoteFilter === 'all'
    ? currentTasks
    : currentTasks.filter(t => t.target_remote === remoteFilter);

  countBadge.textContent = `${filteredTasks.length} Task(s)`;

  if (filteredTasks.length === 0) {
    container.replaceChildren(emptyState);
    emptyState.classList.remove('hidden');
    return;
  }

  container.innerHTML = '';

  filteredTasks.forEach(task => {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.taskId = task.id;

    const statusClass = `status-${task.last_status || 'idle'}`;
    const statusLabel = task.last_status ? task.last_status.toUpperCase() : 'IDLE';

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

    let actionButtonsHtml = '';
    if (isRunning) {
      actionButtonsHtml = `
        <button class="btn btn-sm btn-outline btn-stop-task" data-id="${task.id}" style="color:#fb7185; border-color:rgba(244,63,94,0.4);" title="Stop Running Backup Task">
          ⏹ Stop
        </button>
      `;
    } else {
      actionButtonsHtml = `
        <button class="btn btn-sm btn-primary btn-run-now" data-id="${task.id}" title="Run Backup Task Now">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          Run
        </button>
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

  document.getElementById('stat-next-run').textContent = 'Scheduled Cron Active';
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
    const raw = src.containerPath.replace(/^(\/|root\/)+/, '').replace(/\/$/, '');
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
          sourceType: isLeaf ? src.source : null
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

    // User-defined source delete button (in dashboard tree)
    if (!isSelectable && node.sourceId && node.sourceType === 'user') {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-tree-action btn-tree-del';
      delBtn.textContent = '✕ Remove';
      delBtn.title = 'Remove this user-defined source folder';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSourceFolder(node.sourceId);
      });
      rowEl.appendChild(delBtn);
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

function renderDashboardTreeExplorer() {
  const dashboardContainer = document.getElementById('dashboard-container-tree');
  if (!dashboardContainer) return;

  if (detectedSources.length === 0) {
    dashboardContainer.innerHTML = '<div class="empty-state"><p>No container volumes detected. Click <strong>Add Source Folder</strong> to add one.</p></div>';
    return;
  }

  const treeData = buildContainerTree(detectedSources);
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
  document.querySelector('.tasks-section')?.scrollIntoView({ behavior: 'smooth' });
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
    const statusClass = `status-${log.status || 'idle'}`;
    const startTimeStr = log.start_time ? new Date(log.start_time).toLocaleString() : '--';
    const durationSec = log.end_time ? ((new Date(log.end_time) - new Date(log.start_time)) / 1000) : null;
    const durationStr = log.end_time ? formatDuration(durationSec) : 'Running...';

    return `
      <tr>
        <td><strong>${escapeHtml(log.task_name)}</strong></td>
        <td><span class="status-pill ${statusClass}">${(log.status || 'IDLE').toUpperCase()}</span></td>
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
  const textContent = `=== AutoBackup Hub Execution Log ===
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
  } else if (type === 'task_finished') {
    removeProgressLine();
    const statusType = data.status === 'success' ? 'system' : 'error';
    appendConsoleLine(`=== Task Finished: ${data.taskName} [${data.status.toUpperCase()}] Transferred: ${data.bytesTransferred} ===\n`, statusType);
    setTaskStatusOptimistic(data.taskId, data.status);
    hideTaskProgressBar(data.taskId);
    removeActiveTransferBanner(data.taskId, data.status, data.bytesTransferred);
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
    pill.className = `status-pill status-${status}`;
    pill.textContent = status.toUpperCase();
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

// ─── Add Source Modal ────────────────────────────────────────────────────────

function openAddSourceModal() {
  const modal = document.getElementById('modal-add-source');
  if (!modal) return;
  modal.classList.add('active');

  const nameInput = document.getElementById('source-name-input');
  const pathInput = document.getElementById('source-host-path-input');
  const preview = document.getElementById('source-container-path-preview');

  if (nameInput) nameInput.value = '';
  if (pathInput) pathInput.value = '';
  if (preview) preview.textContent = '(Enter path above or select subfolders below)';

  folderBrowserState.currentPath = 'default';
  folderBrowserState.history = [];
  folderBrowserState.selectedPaths = new Set();
  updateSourceModalButtonState();
  loadAvailableRoots();
  loadFolderBrowserDir('default');

  // Set up OS File Explorer Picker listener
  const osPickerInput = document.getElementById('input-os-folder-picker');
  if (osPickerInput) {
    osPickerInput.onchange = (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        const firstFile = files[0];
        const relPath = firstFile.webkitRelativePath || '';
        const rootFolder = relPath.split('/')[0] || 'Selected Folder';

        if (nameInput && !nameInput.value) nameInput.value = rootFolder;
        if (pathInput && !pathInput.value) {
          pathInput.value = `C:\\Users\\Dr\\Documents\\${rootFolder}`;
          updateSourceModalButtonState();
        }
      }
    };
  }
}

async function saveSourceFolder() {
  const name = document.getElementById('source-name-input').value.trim();
  const rawInput = document.getElementById('source-host-path-input').value.trim();

  const selectedPaths = folderBrowserState.selectedPaths ? Array.from(folderBrowserState.selectedPaths) : [];
  let sourcesToAdd = [];

  if (selectedPaths.length > 0) {
    sourcesToAdd = selectedPaths.map(containerPath => {
      const winPath = containerPath.replace(/^\/hostfs\/([A-Z])\//, '$1:/').replace(/^\/hostfs\/([A-Z])$/, '$1:/');
      const baseName = name || winPath.split(/[\/\\]/).pop() || 'Folder';
      return { name: baseName, host_path: winPath };
    });
  } else if (rawInput) {
    const rawList = rawInput.split(',').map(s => s.trim()).filter(Boolean);
    sourcesToAdd = rawList.map(hp => ({
      name: name || hp.split(/[\/\\]/).pop() || 'Folder',
      host_path: hp
    }));
  }

  if (sourcesToAdd.length === 0) {
    alert('Please select at least one folder from the browser or enter a Windows path.');
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
      body: JSON.stringify({ sources: sourcesToAdd })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      alert('Error: ' + (data.error || 'Failed to add source'));
      return;
    }
    document.getElementById('modal-add-source').classList.remove('active');
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

  // Delegated clicks for task list
  document.getElementById('tasks-container')?.addEventListener('click', (e) => {
    const runBtn = e.target.closest('.btn-run-now');
    if (runBtn) { runTaskNow(runBtn.dataset.id); return; }

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
  let cron_schedule = document.getElementById('task-schedule-preset').value;

  if (cron_schedule === 'custom') {
    cron_schedule = document.getElementById('task-cron').value.trim();
  }

  if (!name) { alert('Error: Please enter a Task Name.'); return; }
  if (!target_remote) { alert('Error: Please select a Destination Cloud Remote.'); return; }

  const payload = { name, source_path, target_remote, target_path, mode, conflict_mode, cron_schedule, priority, bw_limit, enabled: 1 };

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
  const tabs = ['remotes', 'notifications', 'security', 'backup', 'version'];
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

let appVersionData = { version: '2.8.0', latestVersion: '2.8.0', isLatest: true };

async function fetchAppVersion() {
  try {
    const res = await fetch('/api/version');
    if (!res.ok) return;
    const data = await res.json();
    appVersionData = { ...appVersionData, ...data };
    
    // Update header version pill
    const headerBadge = document.getElementById('header-version-badge');
    if (headerBadge) {
      headerBadge.textContent = `v${data.version || '2.8.0'}`;
    }

    // Update settings modal version display
    const settingsVersionBadge = document.getElementById('settings-current-version');
    if (settingsVersionBadge) {
      settingsVersionBadge.textContent = `v${data.version || '2.8.0'}`;
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
        headerBadge.title = `AutoBackup Hub v${data.currentVersion} • Up to date`;
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
    appendConsoleLine('[System] Preparing AutoBackup Hub export bundle...', 'system');
    const res = await fetch('/api/backup/export');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    const disposition = res.headers.get('content-disposition');
    let filename = 'autobackup-hub-export.json';
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
