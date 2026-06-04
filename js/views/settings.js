Views.Settings = (() => {
  function render() {
    const settings   = Store.getSettings();
    const permStatus = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

    document.getElementById('view-root').innerHTML = `
      <button class="detail-back" onclick="App.navigate('')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        Back
      </button>
      <h2 style="font-size:1.3rem;font-weight:700;margin-bottom:20px;">Settings</h2>

      <!-- ── Sync ── -->
      <div class="settings-section">
        <div class="settings-section-title">Sync <span style="color:var(--c-active);font-weight:400;text-transform:none;font-size:0.8rem;">● Automatic</span></div>
        <p style="font-size:0.82rem;color:var(--text-2);line-height:1.6;">
          Your projects sync across every device automatically through Supabase — no setup, nothing to configure.
        </p>
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

      <!-- ── App version ── -->
      <div class="settings-section">
        <div class="settings-section-title">App version</div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Current build</div>
            <div class="setting-desc">Last code update this app loaded: <strong>${App.getBuild()}</strong></div>
          </div>
          <button class="btn btn-sm" id="update-btn">Check for updates</button>
        </div>
        <p style="font-size:0.78rem;color:var(--text-2);margin-top:4px;line-height:1.6;">
          Clears the cached app code and reloads with the latest version from the server.
        </p>
      </div>

      <p style="font-size:0.75rem;color:var(--text-2);text-align:center;margin-top:8px;" id="project-count"></p>
    `;

    const projects = Store.getProjects();
    const countEl  = document.getElementById('project-count');
    if (countEl) countEl.textContent = `${projects.length} project${projects.length !== 1 ? 's' : ''}`;

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

    const updateBtn = document.getElementById('update-btn');
    if (updateBtn) updateBtn.addEventListener('click', () => {
      updateBtn.textContent = '⟳ Updating…';
      updateBtn.disabled = true;
      App.checkForUpdate();
    });
  }

  function _saveNotifSettings() {
    const settings = Store.getSettings();
    const notifOn  = document.getElementById('notif-toggle')?.checked && Notification.permission === 'granted';

    settings.notificationsEnabled = notifOn;
    Store.saveSettings(settings);
    setTimeout(() => App.syncPush(), 0);

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
