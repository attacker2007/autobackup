const dns = require('dns');
const http = require('http');

class NetworkWatchdog {
  constructor(options = {}) {
    this.checkIntervalMs = options.checkIntervalMs || 20000; // 20s idle interval to prevent socket churn
    this.isOnline = true;
    this.timer = null;
    this.onOfflineCallbacks = [];
    this.onOnlineCallbacks = [];
    this.onStatusChangeCallbacks = [];
  }

  /**
   * Ping reliable endpoints to test real internet connectivity
   */
  async checkConnectivity() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };

      // Fast DNS lookup test first
      dns.lookup('one.one.one.one', { family: 4 }, (err) => {
        if (!err) {
          return done(true);
        }

        // Secondary fallback test via HTTP 204 endpoint
        try {
          const req = http.get('http://clients3.google.com/generate_204', { timeout: 3000 }, (res) => {
            res.resume(); // Consume stream so socket is immediately returned to pool
            done(res.statusCode === 204 || res.statusCode === 200);
          });

          req.on('error', () => done(false));
          req.on('timeout', () => {
            req.destroy();
            done(false);
          });
        } catch (e) {
          done(false);
        }
      });
    });
  }

  onOffline(fn) {
    this.onOfflineCallbacks.push(fn);
  }

  onOnline(fn) {
    this.onOnlineCallbacks.push(fn);
  }

  onStatusChange(fn) {
    this.onStatusChangeCallbacks.push(fn);
  }

  start() {
    if (this.timer) return;
    this.checkNow();
    this.timer = setInterval(() => this.checkNow(), this.checkIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkNow() {
    const connected = await this.checkConnectivity();
    if (connected !== this.isOnline) {
      this.isOnline = connected;
      this.onStatusChangeCallbacks.forEach(cb => {
        try { cb(connected); } catch (e) {}
      });

      if (!connected) {
        console.log('[NetworkWatchdog] ⚠️ Internet connection lost. Triggering auto-pause.');
        this.onOfflineCallbacks.forEach(cb => {
          try { cb(); } catch (e) {}
        });
      } else {
        console.log('[NetworkWatchdog] 🌐 Internet connection restored. Triggering auto-resume.');
        this.onOnlineCallbacks.forEach(cb => {
          try { cb(); } catch (e) {}
        });
      }
    }
    return connected;
  }
}

const defaultWatchdog = new NetworkWatchdog();
module.exports = defaultWatchdog;
