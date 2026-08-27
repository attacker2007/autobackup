const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { runBackupTask } = require('./rclone');

/**
 * Check if a given date is the last Friday of its month
 */
function isLastFriday(date = new Date()) {
  if (date.getDay() !== 5) return false; // Must be Friday
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return (date.getDate() + 7 > daysInMonth);
}

/**
 * Priority Weights Map: Higher weight tasks run first
 */
const PRIORITY_WEIGHTS = {
  critical: 100, // Backup Day (Last Friday)
  high: 75,      // Monthly
  medium: 50,    // Weekly
  low: 25,       // Daily (laptop wakeup catchup)
  normal: 40
};

/**
 * Normalize preset schedule strings to valid cron expressions
 */
function getActualCronExpression(cronSchedule) {
  if (cronSchedule === 'last_friday' || cronSchedule === '0 2 22-31 * 5') {
    return '0 2 * * 5';
  }
  if (cronSchedule === 'monthly') {
    return '0 3 1 * *';
  }
  if (cronSchedule === 'weekly') {
    return '0 3 * * 0';
  }
  if (cronSchedule === 'daily') {
    return '0 2 * * *';
  }
  return cronSchedule;
}

/**
 * Helper to parse individual cron field expression
 */
function parseCronPart(part) {
  if (!part || part === '*') return null;
  if (part.includes('/')) {
    const [, step] = part.split('/');
    const stepNum = parseInt(step, 10);
    return (val) => val % stepNum === 0;
  }
  if (part.includes(',')) {
    const nums = part.split(',').map(n => parseInt(n, 10));
    return (val) => nums.includes(val);
  }
  if (part.includes('-')) {
    const [start, end] = part.split('-').map(n => parseInt(n, 10));
    return (val) => val >= start && val <= end;
  }
  const num = parseInt(part, 10);
  return (val) => val === num;
}

/**
 * Calculate the exact next run Date (ISO string) for a given cron schedule
 */
function calculateNextRun(cronSchedule, fromDate = new Date()) {
  const start = new Date(fromDate.getTime() + 60000);
  start.setSeconds(0, 0);

  if (cronSchedule === 'last_friday') {
    const d = new Date(start);
    d.setHours(2, 0, 0, 0);
    if (d <= fromDate) d.setDate(d.getDate() + 1);

    for (let i = 0; i < 366 * 2; i++) {
      if (isLastFriday(d) && d > fromDate) {
        return d.toISOString();
      }
      d.setDate(d.getDate() + 1);
      d.setHours(2, 0, 0, 0);
    }
    return null;
  }

  const actualCron = getActualCronExpression(cronSchedule);
  const parts = actualCron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }

  const minCheck = parseCronPart(parts[0]);
  const hourCheck = parseCronPart(parts[1]);
  const domCheck = parseCronPart(parts[2]);
  const monthCheck = parseCronPart(parts[3]);
  const dowCheck = parseCronPart(parts[4]);

  const curr = new Date(start);

  for (let i = 0; i < 525600; i++) {
    const m = curr.getMinutes();
    const h = curr.getHours();
    const dom = curr.getDate();
    const month = curr.getMonth() + 1;
    const dow = curr.getDay();

    if (
      (minCheck === null || minCheck(m)) &&
      (hourCheck === null || hourCheck(h)) &&
      (domCheck === null || domCheck(dom)) &&
      (monthCheck === null || monthCheck(month)) &&
      (dowCheck === null || dowCheck(dow))
    ) {
      if (cronSchedule === '0 2 22-31 * 5') {
        if (isLastFriday(curr)) return curr.toISOString();
      } else {
        return curr.toISOString();
      }
    }

    curr.setMinutes(curr.getMinutes() + 1);
  }

  return null;
}

class TaskScheduler {
  constructor() {
    this.cronJobs = new Map(); // taskId -> cronTask
    this.runningTasks = new Set(); // taskId set
    this.wsBroadcast = null;
    this.checkInterval = null;
  }

  setWebSocketBroadcast(fn) {
    this.wsBroadcast = fn;
  }

  broadcast(type, data) {
    if (this.wsBroadcast) {
      this.wsBroadcast(JSON.stringify({ type, data }));
    }
  }

  /**
   * Initialize scheduler on server startup
   */
  async init() {
    console.log('[Scheduler] Initializing backup task scheduler...');
    try {
      const tasks = await db.all('SELECT * FROM tasks WHERE enabled = 1');
      console.log(`[Scheduler] Loaded ${tasks.length} active task(s) from database.`);
      for (const task of tasks) {
        this.scheduleTask(task);
      }

      // Check for missed / overdue tasks (e.g. after laptop wake up from sleep)
      await this.checkMissedCatchupTasks();

      // Set periodic interval to check for sleep wakeup catchups every 60s
      if (!this.checkInterval) {
        this.checkInterval = setInterval(() => {
          this.checkMissedCatchupTasks();
        }, 60000);
      }

      // Schedule automated monthly Discord summary report (at 9:00 AM on 1st of every month)
      cron.schedule('0 9 1 * *', () => {
        this.sendMonthlyDiscordReport().catch(err => {
          console.error('[Scheduler] Automated monthly Discord report error:', err);
        });
      });
    } catch (err) {
      console.error('[Scheduler] Initialization error:', err);
    }
  }

  /**
   * Laptop Wakeup / Catchup Check: Check if any tasks missed execution during laptop sleep
   */
  async checkMissedCatchupTasks() {
    try {
      const activeTasks = await db.all('SELECT * FROM tasks WHERE enabled = 1');
      const now = new Date();
      const overdueTasks = [];

      for (const task of activeTasks) {
        if (this.runningTasks.has(task.id)) continue;

        let isOverdue = false;
        const lastRun = task.last_run ? new Date(task.last_run) : null;

        if (!lastRun) {
          // Task has never run before
          isOverdue = true;
        } else {
          const sched = task.cron_schedule;
          const hoursSinceLastRun = (now - lastRun) / (1000 * 60 * 60);

          if (sched === 'daily' || sched === '0 2 * * *') {
            // Daily task is overdue if not run today (and past 2:00 AM) or >24 hours ago
            if (hoursSinceLastRun >= 24 || (lastRun.getDate() !== now.getDate() && now.getHours() >= 2)) {
              isOverdue = true;
            }
          } else if (sched === 'weekly' || sched === '0 3 * * 0') {
            // Weekly task is overdue if >7 days ago or if today is Sunday (past 3:00 AM) and hasn't run today
            if (hoursSinceLastRun >= 168 || (now.getDay() === 0 && lastRun.getDate() !== now.getDate() && now.getHours() >= 3)) {
              isOverdue = true;
            }
          } else if (sched === 'monthly' || sched === '0 3 1 * *') {
            // Monthly task is overdue if not run this month
            if (lastRun.getMonth() !== now.getMonth() || lastRun.getFullYear() !== now.getFullYear()) {
              isOverdue = true;
            }
          } else if (sched === 'last_friday') {
            if (isLastFriday(now) && (lastRun.getDate() !== now.getDate() || lastRun.getMonth() !== now.getMonth())) {
              isOverdue = true;
            }
          }
        }

        if (isOverdue) {
          overdueTasks.push(task);
        }
      }

      if (overdueTasks.length > 0) {
        // Sort overdue tasks strictly by Priority Weight (Backup Day > Monthly > Weekly > Daily)
        overdueTasks.sort((a, b) => {
          const wA = PRIORITY_WEIGHTS[a.priority] || PRIORITY_WEIGHTS.normal;
          const wB = PRIORITY_WEIGHTS[b.priority] || PRIORITY_WEIGHTS.normal;
          return wB - wA;
        });

        console.log(`[Scheduler] Laptop wakeup / startup check detected ${overdueTasks.length} overdue task(s). Queueing by priority order...`);

        // Execute top priority overdue task sequentially
        for (const task of overdueTasks) {
          if (!this.runningTasks.has(task.id)) {
            console.log(`[Scheduler] [Priority: ${(task.priority || 'normal').toUpperCase()}] Executing catchup run for "${task.name}"...`);
            this.executeTask(task.id);
            break; // Execute one task at a time to prevent server overload
          }
        }
      }
    } catch (e) {
      console.error('[Scheduler] Catchup check error:', e);
    }
  }

  /**
   * Schedule a single task using node-cron and compute next_run
   */
  scheduleTask(task) {
    this.unscheduleTask(task.id);

    if (!task.enabled) {
      console.log(`[Scheduler] Skipping task "${task.name}" (disabled)`);
      db.run('UPDATE tasks SET next_run = NULL WHERE id = ?', [task.id]);
      return false;
    }

    const actualCron = getActualCronExpression(task.cron_schedule);
    const isBackupDaySpecial = (task.cron_schedule === 'last_friday' || task.cron_schedule === '0 2 22-31 * 5');

    if (!cron.validate(actualCron)) {
      console.log(`[Scheduler] Skipping task "${task.name}" (invalid cron schedule: "${task.cron_schedule}")`);
      db.run('UPDATE tasks SET next_run = NULL WHERE id = ?', [task.id]);
      return false;
    }

    const nextRun = calculateNextRun(task.cron_schedule);
    db.run('UPDATE tasks SET next_run = ? WHERE id = ?', [nextRun, task.id]);

    try {
      const job = cron.schedule(actualCron, () => {
        if (isBackupDaySpecial) {
          const now = new Date();
          if (!isLastFriday(now)) {
            console.log(`[Scheduler] Friday check for "${task.name}": Not the last Friday of the month (${now.toDateString()}). Skipping execution.`);
            return;
          }
        }
        console.log(`[Scheduler] Cron triggered for task "${task.name}" [Priority: ${(task.priority || 'normal').toUpperCase()}] (${task.id})`);
        this.executeTask(task.id);
      });

      this.cronJobs.set(task.id, job);
      console.log(`[Scheduler] Task "${task.name}" scheduled with cron pattern "${task.cron_schedule}" [Priority: ${(task.priority || 'normal').toUpperCase()}] (Next run: ${nextRun})`);
      return true;
    } catch (err) {
      console.error(`[Scheduler] Failed to schedule task "${task.name}":`, err.message);
      return false;
    }
  }

  /**
   * Remove scheduled cron job for a task
   */
  unscheduleTask(taskId) {
    if (this.cronJobs.has(taskId)) {
      const job = this.cronJobs.get(taskId);
      job.stop();
      this.cronJobs.delete(taskId);
      console.log(`[Scheduler] Task ${taskId} unscheduled.`);
    }
    db.run('UPDATE tasks SET next_run = NULL WHERE id = ?', [taskId]);
  }

  /**
   * Execute a task immediately (manual trigger, cron trigger, or dry-run)
   */
  async executeTask(taskId, isDryRun = false) {
    if (this.runningTasks.has(taskId)) {
      console.log(`[Scheduler] Task ${taskId} is already running. Skipping trigger.`);
      this.broadcast('task_skipped', { taskId, reason: 'Already running' });
      return { running: true, message: 'Task is already running' };
    }

    const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) {
      console.error(`[Scheduler] Task ${taskId} not found in database.`);
      return { error: 'Task not found' };
    }

    this.runningTasks.add(taskId);
    const logId = uuidv4();
    const startTime = new Date().toISOString();

    await db.run('UPDATE tasks SET last_status = ?, last_run = ? WHERE id = ?', [
      'running',
      startTime,
      taskId
    ]);

    this.broadcast('task_started', {
      taskId,
      taskName: task.name,
      logId,
      startTime,
      isDryRun
    });

    console.log(`[Scheduler] Starting backup job for "${task.name}" (${task.id})...${isDryRun ? ' [DRY RUN]' : ''}`);

    const result = await runBackupTask(
      task,
      (progressText) => {
        this.broadcast('task_progress', {
          taskId,
          logId,
          progressText
        });
      },
      (logLine) => {
        this.broadcast('task_log', {
          taskId,
          logId,
          logLine
        });
      },
      { isDryRun }
    );

    const endTime = new Date().toISOString();
    const finalStatus = result.success ? (isDryRun ? 'dry_run' : 'success') : 'failed';
    const nextRun = calculateNextRun(task.cron_schedule);

    await db.run(
      `INSERT INTO logs (id, task_id, task_name, start_time, end_time, status, bytes_transferred, files_transferred, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        logId,
        task.id,
        task.name,
        startTime,
        endTime,
        finalStatus,
        result.bytesTransferred || '0 B',
        result.filesTransferred || 0,
        result.output
      ]
    );

    await db.run('UPDATE tasks SET last_status = ?, next_run = ? WHERE id = ?', [finalStatus, nextRun, taskId]);

    this.runningTasks.delete(taskId);

    this.broadcast('task_finished', {
      taskId,
      taskName: task.name,
      logId,
      status: finalStatus,
      bytesTransferred: result.bytesTransferred,
      nextRun,
      endTime,
      isDryRun
    });

    console.log(`[Scheduler] Task "${task.name}" finished with status: ${finalStatus}. Next run: ${nextRun}`);

    // Trigger Phone & App Notifications (Discord, ntfy.sh, Telegram)
    await this.sendPhoneNotifications(task, result, logId, isDryRun);

    return { success: result.success, logId, isDryRun };
  }

  /**
   * Dispatch notifications across Discord, ntfy.sh phone push, and Telegram
   */
  async sendPhoneNotifications(task, result, logId, isDryRun = false) {
    await Promise.all([
      this.sendDiscordNotification(task, result, logId, isDryRun),
      this.sendNtfyNotification(task, result, logId, isDryRun),
      this.sendTelegramNotification(task, result, logId, isDryRun)
    ]);
  }

  /**
   * Send Discord Notification Embed via Webhook URL
   */
  async sendDiscordNotification(task, result, logId, isDryRun = false) {
    try {
      const setting = await db.get('SELECT value FROM settings WHERE key = ?', ['discord_webhook_url']);
      if (!setting || !setting.value || !setting.value.trim().startsWith('http')) {
        return;
      }

      const webhookUrl = setting.value.trim();
      const isSuccess = result.success;
      const statusIcon = isSuccess ? '🟢' : '🔴';
      const statusTitle = isSuccess ? '✅ Backup Succeeded' : '❌ Backup Failed';
      const bytesText = result.bytesTransferred ? ` (${result.bytesTransferred})` : '';
      const dryRunTag = isDryRun ? ' [Dry Run]' : '';
      const remoteTarget = `${task.target_remote}:${task.target_path || ''}`;

      const payload = {
        username: 'AutoBackup Hub',
        avatar_url: 'https://cdn-icons-png.flaticon.com/512/4149/4149678.png',
        content: `${statusIcon} **[${isSuccess ? 'SUCCESS' : 'FAILED'}]** ${task.name}${dryRunTag} ➔ \`${remoteTarget}\`${bytesText}`,
        embeds: [
          {
            title: `${statusTitle}: ${task.name}${dryRunTag}`,
            description: `Backup job execution summary for container volume target **${remoteTarget}**.`,
            color: isSuccess ? 0x22c55e : 0xef4444,
            fields: [
              { name: 'Status', value: isSuccess ? '`SUCCESS`' : '`FAILED`', inline: true },
              { name: 'Transferred', value: `\`${result.bytesTransferred || '0 B'}\``, inline: true },
              { name: 'Priority', value: `\`${(task.priority || 'normal').toUpperCase()}\``, inline: true },
              { name: 'Destination Remote', value: `\`${remoteTarget}\``, inline: true },
              { name: 'Mode', value: `\`${(task.mode || 'copy').toUpperCase()}\``, inline: true },
              { name: 'Bandwidth Limit', value: `\`${task.bw_limit || 'Unlimited'}\``, inline: true }
            ],
            footer: { text: `Log ID: ${logId.slice(0, 8)} • AutoBackup Hub Engine` },
            timestamp: new Date().toISOString()
          }
        ]
      };

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        console.log(`[Scheduler] Discord notification sent for task "${task.name}".`);
      } else {
        console.error(`[Scheduler] Discord webhook status code: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error('[Scheduler] Failed sending Discord notification:', err.message);
    }
  }

  /**
   * Send Direct Mobile Push Notification via ntfy.sh (No account needed)
   */
  async sendNtfyNotification(task, result, logId, isDryRun = false) {
    try {
      const setting = await db.get('SELECT value FROM settings WHERE key = ?', ['ntfy_topic']);
      if (!setting || !setting.value || !setting.value.trim()) return;

      const topic = setting.value.trim().replace(/^https?:\/\/ntfy\.sh\//, '');
      const isSuccess = result.success;
      const title = `${isSuccess ? '✅ Backup Succeeded' : '❌ Backup Failed'}: ${task.name}${isDryRun ? ' (Dry Run)' : ''}`;
      const message = `Target: ${task.target_remote}:${task.target_path || ''}\nTransferred: ${result.bytesTransferred || '0 B'}\nMode: ${(task.mode || 'copy').toUpperCase()} | Priority: ${(task.priority || 'normal').toUpperCase()}`;

      const https = require('https');
      const req = https.request(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: {
          'Title': title,
          'Priority': isSuccess ? 'default' : 'high',
          'Tags': isSuccess ? 'white_check_mark,floppy_disk' : 'x,warning',
          'Content-Type': 'text/plain'
        }
      });
      req.on('error', (e) => console.error('[Scheduler] ntfy.sh error:', e.message));
      req.write(message);
      req.end();
    } catch (e) {
      console.error('[Scheduler] ntfy.sh error:', e.message);
    }
  }

  /**
   * Test sending a sample notification to a specific channel ('discord', 'ntfy', or 'telegram')
   */
  async testNotificationChannel(channelType) {
    const testTask = {
      name: 'Sample Connection Test Task',
      target_remote: 'abdul_pCloud',
      target_path: 'Test/Path',
      mode: 'copy',
      priority: 'normal',
      bw_limit: ''
    };
    const testResult = {
      success: true,
      bytesTransferred: '14.2 MB',
      speed: '5.2 MiB/s'
    };
    const testLogId = 'test-notification-001';

    if (channelType === 'discord') {
      const setting = await db.get('SELECT value FROM settings WHERE key = ?', ['discord_webhook_url']);
      if (!setting || !setting.value || !setting.value.trim().startsWith('http')) {
        return { success: false, error: 'Discord Webhook URL is not configured in settings.' };
      }
      await this.sendDiscordNotification(testTask, testResult, testLogId, false);
      return { success: true, message: 'Test alert card sent to Discord successfully!' };
    }

    if (channelType === 'ntfy') {
      const setting = await db.get('SELECT value FROM settings WHERE key = ?', ['ntfy_topic']);
      if (!setting || !setting.value || !setting.value.trim()) {
        return { success: false, error: 'ntfy.sh topic is not configured in settings.' };
      }
      await this.sendNtfyNotification(testTask, testResult, testLogId, false);
      return { success: true, message: `Test push notification sent to ntfy.sh topic "${setting.value.trim()}"!` };
    }

    if (channelType === 'telegram') {
      const botTokenRow = await db.get('SELECT value FROM settings WHERE key = ?', ['telegram_bot_token']);
      const chatIdRow = await db.get('SELECT value FROM settings WHERE key = ?', ['telegram_chat_id']);
      if (!botTokenRow || !botTokenRow.value || !chatIdRow || !chatIdRow.value) {
        return { success: false, error: 'Telegram Bot Token or Chat ID is missing in settings.' };
      }
      await this.sendTelegramNotification(testTask, testResult, testLogId, false);
      return { success: true, message: 'Test message sent to Telegram bot successfully!' };
    }

    return { success: false, error: 'Unknown notification channel.' };
  }

  /**
   * Send Notification via Telegram Bot
   */
  async sendTelegramNotification(task, result, logId, isDryRun = false) {
    try {
      const botTokenRow = await db.get('SELECT value FROM settings WHERE key = ?', ['telegram_bot_token']);
      const chatIdRow = await db.get('SELECT value FROM settings WHERE key = ?', ['telegram_chat_id']);
      if (!botTokenRow || !botTokenRow.value || !chatIdRow || !chatIdRow.value) return;

      const token = botTokenRow.value.trim();
      const chatId = chatIdRow.value.trim();
      const isSuccess = result.success;

      const text = `*AutoBackup Hub Alert*\n\n` +
        `*Task:* ${task.name}${isDryRun ? ' (Dry Run)' : ''}\n` +
        `*Status:* ${isSuccess ? '✅ SUCCESS' : '❌ FAILED'}\n` +
        `*Transferred:* \`${result.bytesTransferred || '0 B'}\` \n` +
        `*Target:* \`${task.target_remote}:${task.target_path || ''}\` \n` +
        `*Priority:* ${task.priority || 'normal'}`;

      const https = require('https');
      const postData = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
      const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      });
      req.on('error', (e) => console.error('[Scheduler] Telegram error:', e.message));
      req.write(postData);
      req.end();
    } catch (e) {
      console.error('[Scheduler] Telegram error:', e.message);
    }
  }

  /**
   * Send Monthly Executive Summary Report via Discord Webhook
   */
  async sendMonthlyDiscordReport() {
    try {
      const setting = await db.get('SELECT value FROM settings WHERE key = ?', ['discord_webhook_url']);
      if (!setting || !setting.value || !setting.value.trim().startsWith('http')) {
        return { success: false, error: 'Discord Webhook URL is not configured in settings.' };
      }

      const webhookUrl = setting.value.trim();
      const rclone = require('./rclone');

      // Query past 30 days stats from DB
      const logs = await db.all(`
        SELECT * FROM logs 
        WHERE start_time >= datetime('now', '-30 days')
        ORDER BY start_time DESC
      `);

      const totalRuns = logs.length;
      const successRuns = logs.filter(l => l.status === 'success' || l.status === 'dry_run').length;
      const failedRuns = logs.filter(l => l.status === 'failed').length;
      const successRate = totalRuns > 0 ? ((successRuns / totalRuns) * 100).toFixed(1) : '100.0';

      const activeTasksCountRow = await db.get('SELECT COUNT(*) as c FROM tasks WHERE enabled = 1');
      const activeTasksCount = activeTasksCountRow ? activeTasksCountRow.c : 0;
      const remotesList = await rclone.listRemotes();

      // Aggregate storage capacities from cached remote about metrics
      let storageBreakdownText = '';
      for (const remoteName of remotesList) {
        const cached = rclone.getCachedRemoteAbout(remoteName);
        if (cached && cached.data && cached.data.success) {
          const { usedFormatted, totalFormatted, percentage } = cached.data;
          const statusIcon = percentage > 85 ? '⚠️' : '✅';
          storageBreakdownText += `${statusIcon} **${remoteName}**: ${usedFormatted} / ${totalFormatted} (${percentage}% used)\n`;
        } else {
          storageBreakdownText += `☁️ **${remoteName}**: Connected\n`;
        }
      }

      const payload = {
        username: 'AutoBackup Hub Reports',
        avatar_url: 'https://cdn-icons-png.flaticon.com/512/4149/4149678.png',
        content: `📊 **[MONTHLY REPORT]** AutoBackup Hub past 30 days: **${successRate}%** success rate across ${totalRuns} run(s)`,
        embeds: [
          {
            title: '📊 AutoBackup Hub - Monthly Executive Summary',
            description: `Automated 30-day performance report for **AutoBackup Engine**. System running with **${successRate}%** operational reliability.`,
            color: 0x00f2fe,
            fields: [
              { name: 'Total Executions', value: `\`${totalRuns} run(s)\``, inline: true },
              { name: 'Success Rate', value: `\`${successRate}%\``, inline: true },
              { name: 'Active Backup Tasks', value: `\`${activeTasksCount} configured\``, inline: true },
              { name: 'Successful Runs', value: `\`✅ ${successRuns}\``, inline: true },
              { name: 'Failed Runs', value: `\`❌ ${failedRuns}\``, inline: true },
              { name: 'Connected Remotes', value: `\`☁️ ${remotesList.length} cloud(s)\``, inline: true },
              { name: 'Cloud Storage Capacity Overview', value: storageBreakdownText || 'No active remote storage recorded.', inline: false }
            ],
            footer: { text: `AutoBackup Hub • Monthly Automation Report` },
            timestamp: new Date().toISOString()
          }
        ]
      };

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        console.log('[Scheduler] Monthly Discord executive report sent successfully.');
        return { success: true, message: 'Monthly Discord executive report sent successfully!' };
      } else {
        const text = await res.text();
        return { success: false, error: `Discord Webhook returned status ${res.status}: ${text}` };
      }
    } catch (err) {
      console.error('[Scheduler] Error sending monthly Discord report:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Stop/Cancel a currently running task
   */
  async stopTask(taskId) {
    const { cancelBackupTask } = require('./rclone');
    const wasRunning = cancelBackupTask(taskId);
    this.runningTasks.delete(taskId);

    const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
    const nextRun = task ? calculateNextRun(task.cron_schedule) : null;

    await db.run('UPDATE tasks SET last_status = ?, next_run = ? WHERE id = ?', ['stopped', nextRun, taskId]);

    this.broadcast('task_finished', {
      taskId,
      taskName: task ? task.name : `Task ${taskId}`,
      status: 'stopped',
      bytesTransferred: '0 B',
      endTime: new Date().toISOString()
    });

    return { success: true, wasRunning, message: 'Task execution stopped' };
  }
}

module.exports = new TaskScheduler();
module.exports.calculateNextRun = calculateNextRun;

