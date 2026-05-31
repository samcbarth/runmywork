Views.Settings = (() => {
  function render() {
    const ghConfig   = GithubSync.getConfig();
    const settings   = Store.getSettings();
    const permStatus = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
    const hasPat     = !!ghConfig.pat;

    document.getElementById('view-root').innerHTML = `
      <button class="detail-back" onclick="App.navigate('')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        Back
      </button>
      <h2 style="font-size:1.3rem;font-weight:700;margin-bottom:20px;">Settings</h2>

      <!-- ── Sync ── -->
      <div class="settings-section">
        <div class="settings-section-title">GitHub Sync ${hasPat ? '<span style="color:var(--c-active);font-weight:400;text-transform:none;font-size:0.8rem;">● Connected</span>' : '<span style="color:var(--c-blocked);font-weight:400;text-transform:none;font-size:0.8rem;">● Not connected</span>'}</div>
        <p style="font-size:0.82rem;color:var(--text-2);margin-bottom:14px;line-height:1.6;">
          Syncs your projects to GitHub so every device stays in sync automatically.
          Requires a GitHub Personal Access Token with <strong>Contents: Read &amp; Write</strong> on <code>samcbarth/runmywork</code>.
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" style="color:var(--accent);">Create one →</a>
        </p>
        <div class="form-group">
          <label class="form-label" for="gh-pat">Personal Access Token</label>
          <input class="form-input" id="gh-pat" type="password"
            placeholder="github_pat_…"
            value="${Models.escapeHtml(ghConfig.pat || '')}"
            autocomplete="off">
          <p class="form-hint">Stored in this browser only — enter once per device. Your projects sync automatically after that.</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-primary" id="sync-save-btn">Save &amp; sync</button>
          <span id="sync-result" style="font-size:0.82rem;color:var(--text-2);"></span>
        </div>
      </div>

      <!-- ── Notifications ── -->
      <div class="settings-section">
        <div class="settings-section-title">Notifications</div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Browser alerts</div>
            <div class="setting-desc">Notify when you open the app and something is blocked or idle.</div>
            ${permStatus === 'denied' ? '<p style="color:var(--c-blocked);font-size:0.8rem;margin-top:4px;">Blocked in browser — reset via the lock icon in the address bar.</p>' : ''}
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

        <div style="margin-top:12px;padding:12px;background:var(--surface-2);border-radius:var(--radius-sm);font-size:0.82rem;color:var(--text-2);line-height:1.7;">
          Push notifications (phone + desktop, even when app is closed) come via <strong>ntfy</strong>.<br>
          Install the <a href="https://ntfy.sh" target="_blank" rel="noopener" style="color:var(--accent);">ntfy app</a> and subscribe to topic: <code style="background:var(--border);padding:2px 6px;border-radius:4px;color:var(--text);">rmw-sam-9k2x7p</code>
        </div>

        <button class="btn btn-primary" id="save-notif-btn" style="margin-top:12px;">Save</button>
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

      <p style="font-size:0.75rem;color:var(--text-2);text-align:center;margin-top:8px;" id="project-count"></p>
    `;

    const projects = Store.getProjects();
    const countEl  = document.getElementById('project-count');
    if (countEl) countEl.textContent = `${projects.length} project${projects.length !== 1 ? 's' : ''}`;

    document.getElementById('sync-save-btn').addEventListener('click', _saveGithubConfig);

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

    document.getElementById('save-notif-btn').addEventListener('click', _saveNotifSettings);
  }

  async function _saveGithubConfig() {
    const pat    = document.getElementById('gh-pat').value.trim();
    const result = document.getElementById('sync-result');
    const btn    = document.getElementById('sync-save-btn');

    GithubSync.saveConfig(pat, GithubSync.REPO);

    if (!pat) { result.textContent = 'Enter a PAT to enable sync.'; return; }

    result.style.color = 'var(--text-2)';
    result.textContent = '⟳ Pulling…';
    btn.disabled = true;

    try {
      const pullRes = await GithubSync.pull();
      if (!pullRes.ok && pullRes.reason !== 'not-configured' && pullRes.reason !== 'not-found') {
        btn.disabled = false;
        result.style.color = 'var(--c-blocked)';
        result.textContent = `✗ Pull failed: ${pullRes.reason}`;
        return;
      }

      result.textContent = '⟳ Pushing…';
      const pushRes = await GithubSync.push();

      btn.disabled = false;
      if (pushRes.ok) {
        result.style.color = 'var(--c-active)';
        result.textContent = '✓ Synced — all devices will pick this up automatically';
      } else {
        result.style.color = 'var(--c-blocked)';
        result.textContent = `✗ Push failed: ${pushRes.reason}`;
      }
    } catch (e) {
      btn.disabled = false;
      result.style.color = 'var(--c-blocked)';
      result.textContent = `✗ Error: ${e.message}`;
    }
  }

  function _saveNotifSettings() {
    const settings    = Store.getSettings();
    const blockedDays = parseInt(document.getElementById('blocked-days')?.value || '3', 10);
    const idleDays    = parseInt(document.getElementById('idle-days')?.value    || '7', 10);
    const notifOn     = document.getElementById('notif-toggle')?.checked && Notification.permission === 'granted';

    settings.notificationsEnabled          = notifOn;
    settings.thresholds.blockedDaysWarning = Math.max(1, blockedDays);
    settings.thresholds.idleDaysWarning    = Math.max(1, idleDays);
    Store.saveSettings(settings);

    const btn = document.getElementById('save-notif-btn');
    btn.textContent = 'Saved ✓';
    btn.style.background = 'var(--c-active)';
    setTimeout(() => { btn.textContent = 'Save'; btn.style.background = ''; }, 2000);
  }

  function exportData() {
    const blob = new Blob([Store.exportData()], { type: 'application/json' });
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
        try { Store.importData(reader.result); alert('Imported!'); render(); }
        catch (e) { alert('Import failed: ' + e.message); }
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
