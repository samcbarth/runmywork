Views.Settings = (() => {
  function render() {
    const settings  = Store.getSettings();
    const ghConfig  = GithubSync.getConfig();
    const permStatus = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

    const permNote = permStatus === 'denied'
      ? '<p style="color:var(--c-blocked);font-size:0.8rem;margin-top:6px;">Notifications blocked in browser. Click the lock icon in the address bar and reset permissions.</p>'
      : '';

    document.getElementById('view-root').innerHTML = `
      <button class="detail-back" onclick="App.navigate('')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        Back
      </button>
      <h2 style="font-size:1.3rem;font-weight:700;margin-bottom:20px;">Settings</h2>

      <!-- ── Sync ── -->
      <div class="settings-section">
        <div class="settings-section-title">GitHub Sync</div>
        <p style="font-size:0.82rem;color:var(--text-2);margin-bottom:14px;line-height:1.6;">
          Stores your projects in <code>data.json</code> in this repo so every device sees the same data.
          Requires a GitHub Personal Access Token with <strong>Contents: Read &amp; Write</strong> on this repo.
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" style="color:var(--accent);">Create a fine-grained PAT →</a>
        </p>

        <div class="form-group">
          <label class="form-label" for="gh-pat">Personal Access Token</label>
          <input class="form-input" id="gh-pat" type="password"
            placeholder="github_pat_…"
            value="${Models.escapeHtml(ghConfig.pat || '')}"
            autocomplete="off">
          <p class="form-hint">Stored only in this browser — never sent anywhere except api.github.com.</p>
        </div>

        <div class="form-group">
          <label class="form-label" for="gh-repo">Repository</label>
          <input class="form-input" id="gh-repo" type="text"
            placeholder="owner/repo"
            value="${Models.escapeHtml(ghConfig.repo || 'samcbarth/runmywork')}">
        </div>

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-primary" id="sync-save-btn">Save &amp; sync now</button>
          <span id="sync-result" style="font-size:0.82rem;color:var(--text-2);"></span>
        </div>
      </div>

      <!-- ── Notifications ── -->
      <div class="settings-section">
        <div class="settings-section-title">Push Notifications</div>
        <p style="font-size:0.82rem;color:var(--text-2);margin-bottom:14px;line-height:1.6;">
          Daily notifications via <a href="https://ntfy.sh" target="_blank" rel="noopener" style="color:var(--accent);">ntfy.sh</a> — free, no account needed.
          Install the <strong>ntfy app</strong> on your phone, then subscribe to your topic.
          A GitHub Actions cron runs at 9am EST and notifies you about blocked/idle projects.
        </p>

        <div class="form-group">
          <label class="form-label" for="ntfy-topic">ntfy Topic <span class="optional">(keep this private)</span></label>
          <input class="form-input" id="ntfy-topic" type="text"
            placeholder="e.g. runmywork-sam-abc123"
            value="${Models.escapeHtml(settings.ntfyTopic || '')}">
          <p class="form-hint">Use something unguessable. Also add this as a GitHub repo secret named <strong>NTFY_TOPIC</strong> for the cron job: Settings → Secrets → Actions.</p>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn" id="test-ntfy-btn">Send test notification</button>
        </div>
      </div>

      <!-- ── Browser notifications ── -->
      <div class="settings-section">
        <div class="settings-section-title">Browser Notifications</div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Enable on-open alerts</div>
            <div class="setting-desc">Notify when you open the app and a project is blocked or idle.</div>
            ${permNote}
          </div>
          <label class="toggle">
            <input type="checkbox" id="notif-toggle"
              ${settings.notificationsEnabled && permStatus === 'granted' ? 'checked' : ''}
              ${permStatus === 'denied' ? 'disabled' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Alert when blocked for</div>
          </div>
          <div class="number-row">
            <input class="number-input" id="blocked-days" type="number" min="1" max="30" value="${settings.thresholds.blockedDaysWarning}">
            <span style="font-size:0.85rem;color:var(--text-2)">days</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Alert when idle for</div>
          </div>
          <div class="number-row">
            <input class="number-input" id="idle-days" type="number" min="1" max="60" value="${settings.thresholds.idleDaysWarning}">
            <span style="font-size:0.85rem;color:var(--text-2)">days</span>
          </div>
        </div>

        <button class="btn btn-primary" id="save-notif-btn" style="margin-top:8px;">Save notification settings</button>
      </div>

      <!-- ── Data ── -->
      <div class="settings-section">
        <div class="settings-section-title">Data</div>
        <div class="setting-row">
          <div class="setting-info"><div class="setting-label">Export</div><div class="setting-desc">Download all data as JSON.</div></div>
          <button class="btn btn-sm" onclick="Views.Settings.exportData()">Export</button>
        </div>
        <div class="setting-row">
          <div class="setting-info"><div class="setting-label">Import</div><div class="setting-desc">Restore from a JSON backup.</div></div>
          <button class="btn btn-sm" onclick="Views.Settings.importData()">Import</button>
        </div>
        <div class="setting-row">
          <div class="setting-info"><div class="setting-label">Clear all data</div><div class="setting-desc">Cannot be undone.</div></div>
          <button class="btn btn-sm btn-danger" onclick="Views.Settings.clearAll()">Clear all</button>
        </div>
      </div>

      <p style="font-size:0.78rem;color:var(--text-2);text-align:center;margin-top:8px;" id="project-count"></p>
    `;

    const projects = Store.getProjects();
    const countEl = document.getElementById('project-count');
    if (countEl) countEl.textContent = `${projects.length} project${projects.length !== 1 ? 's' : ''} stored locally`;

    // GitHub sync save
    document.getElementById('sync-save-btn').addEventListener('click', _saveGithubConfig);

    // ntfy test
    document.getElementById('test-ntfy-btn').addEventListener('click', _testNtfy);

    // Browser notif toggle
    const toggle = document.getElementById('notif-toggle');
    toggle.addEventListener('change', async () => {
      if (toggle.checked) {
        const perm = await Notifications.requestPermission();
        if (perm !== 'granted') toggle.checked = false;
      } else {
        const s = Store.getSettings();
        s.notificationsEnabled = false;
        Store.saveSettings(s);
      }
    });

    // Save notif settings
    document.getElementById('save-notif-btn').addEventListener('click', _saveNotifSettings);
  }

  async function _saveGithubConfig() {
    const pat    = document.getElementById('gh-pat').value.trim();
    const repo   = document.getElementById('gh-repo').value.trim();
    const topic  = document.getElementById('ntfy-topic').value.trim();
    const result = document.getElementById('sync-result');

    GithubSync.saveConfig(pat, repo);

    // Also save ntfy topic to settings
    const settings = Store.getSettings();
    settings.ntfyTopic = topic;
    Store.saveSettings(settings);

    if (!pat || !repo) {
      result.textContent = 'Enter a PAT and repo to sync.';
      return;
    }

    result.textContent = '⟳ Syncing…';
    const btn = document.getElementById('sync-save-btn');
    btn.disabled = true;

    // Pull first (merge remote → local), then push local → remote
    const pullRes = await GithubSync.pull();
    const pushRes = await GithubSync.push();

    btn.disabled = false;

    if (pushRes.ok) {
      result.style.color = 'var(--c-active)';
      result.textContent = '✓ Synced successfully';
    } else {
      result.style.color = 'var(--c-blocked)';
      result.textContent = `✗ Failed: ${pushRes.reason}`;
    }
  }

  async function _testNtfy() {
    const topic = document.getElementById('ntfy-topic').value.trim();
    if (!topic) { alert('Enter an ntfy topic first.'); return; }

    const btn = document.getElementById('test-ntfy-btn');
    btn.textContent = 'Sending…';
    btn.disabled = true;

    try {
      const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: { 'Title': 'RunMyWork', 'Tags': 'white_check_mark' },
        body: 'Test notification from RunMyWork — notifications are working!'
      });
      btn.textContent = res.ok ? '✓ Sent!' : '✗ Failed';
    } catch {
      btn.textContent = '✗ Network error';
    }

    setTimeout(() => { btn.textContent = 'Send test notification'; btn.disabled = false; }, 3000);
  }

  function _saveNotifSettings() {
    const settings    = Store.getSettings();
    const blockedDays = parseInt(document.getElementById('blocked-days')?.value || '3', 10);
    const idleDays    = parseInt(document.getElementById('idle-days')?.value    || '7', 10);
    const notifOn     = document.getElementById('notif-toggle')?.checked && Notification.permission === 'granted';

    settings.notificationsEnabled            = notifOn;
    settings.thresholds.blockedDaysWarning   = Math.max(1, blockedDays);
    settings.thresholds.idleDaysWarning      = Math.max(1, idleDays);

    Store.saveSettings(settings);

    const btn = document.getElementById('save-notif-btn');
    btn.textContent = 'Saved ✓';
    btn.style.background = 'var(--c-active)';
    setTimeout(() => { btn.textContent = 'Save notification settings'; btn.style.background = ''; }, 2000);
  }

  function exportData() {
    const json = Store.exportData();
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `runmywork-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          Store.importData(reader.result);
          alert('Imported successfully!');
          render();
        } catch (e) {
          alert('Import failed: ' + e.message);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function clearAll() {
    if (!confirm('Delete ALL projects and settings? Cannot be undone.')) return;
    Store.clearAll();
    App.navigate('');
    Views.Dashboard.render();
  }

  return { render, exportData, importData, clearAll };
})();
