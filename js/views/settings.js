Views.Settings = (() => {
  function render() {
    const settings = Store.getSettings();
    const root = document.getElementById('view-root');
    const permStatus = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
    const permNote = permStatus === 'denied'
      ? '<p style="color:var(--c-blocked);font-size:0.8rem;margin-top:6px;">Notifications are blocked in your browser. To enable, click the lock icon in the address bar and reset permissions.</p>'
      : '';

    root.innerHTML = `
      <button class="detail-back" onclick="App.navigate('')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        Back
      </button>

      <h2 style="font-size:1.3rem;font-weight:700;margin-bottom:20px;">Settings</h2>

      <div class="settings-section">
        <div class="settings-section-title">Notifications</div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Enable notifications</div>
            <div class="setting-desc">Get alerted when projects are blocked or idle too long.</div>
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
            <div class="setting-desc">Days before a blocked project triggers a notification.</div>
          </div>
          <div class="number-row">
            <input class="number-input" id="blocked-days" type="number" min="1" max="30"
              value="${settings.thresholds.blockedDaysWarning}">
            <span style="font-size:0.85rem;color:var(--text-2)">days</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Alert when idle for</div>
            <div class="setting-desc">Days of inactivity before auto-idle detection fires.</div>
          </div>
          <div class="number-row">
            <input class="number-input" id="idle-days" type="number" min="1" max="60"
              value="${settings.thresholds.idleDaysWarning}">
            <span style="font-size:0.85rem;color:var(--text-2)">days</span>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Data</div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Export data</div>
            <div class="setting-desc">Download all projects and settings as JSON.</div>
          </div>
          <button class="btn btn-sm" onclick="Views.Settings.exportData()">Export</button>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Import data</div>
            <div class="setting-desc">Restore from a previously exported JSON file.</div>
          </div>
          <button class="btn btn-sm" onclick="Views.Settings.importData()">Import</button>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Clear all data</div>
            <div class="setting-desc">Delete all projects and reset settings. Cannot be undone.</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="Views.Settings.clearAll()">Clear all</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">About</div>
        <p style="font-size:0.85rem;color:var(--text-2);line-height:1.7;">
          RunMyWork — personal project progress tracker.<br>
          Data stored locally in your browser (localStorage).<br>
          <span id="project-count"></span>
        </p>
      </div>

      <button class="btn btn-primary btn-full" id="save-settings-btn" style="margin-top:8px;">Save settings</button>
    `;

    const projects = Store.getProjects();
    const countEl = document.getElementById('project-count');
    if (countEl) countEl.textContent = `${projects.length} project${projects.length !== 1 ? 's' : ''} in your tracker.`;

    document.getElementById('save-settings-btn').addEventListener('click', _save);

    const toggle = document.getElementById('notif-toggle');
    toggle.addEventListener('change', async () => {
      if (toggle.checked) {
        const perm = await Notifications.requestPermission();
        if (perm !== 'granted') {
          toggle.checked = false;
        }
      } else {
        const s = Store.getSettings();
        s.notificationsEnabled = false;
        Store.saveSettings(s);
      }
    });
  }

  function _save() {
    const settings = Store.getSettings();
    const blockedDays = parseInt(document.getElementById('blocked-days')?.value || '3', 10);
    const idleDays    = parseInt(document.getElementById('idle-days')?.value    || '7', 10);
    const notifOn     = document.getElementById('notif-toggle')?.checked && Notification.permission === 'granted';

    settings.notificationsEnabled = notifOn;
    settings.thresholds.blockedDaysWarning = Math.max(1, blockedDays);
    settings.thresholds.idleDaysWarning    = Math.max(1, idleDays);

    Store.saveSettings(settings);

    const btn = document.getElementById('save-settings-btn');
    if (btn) {
      btn.textContent = 'Saved ✓';
      btn.style.background = 'var(--c-active)';
      setTimeout(() => { btn.textContent = 'Save settings'; btn.style.background = ''; }, 2000);
    }
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
          alert('Data imported successfully!');
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
    if (!confirm('This will delete ALL projects and settings. This cannot be undone.\n\nAre you sure?')) return;
    Store.clearAll();
    App.navigate('');
    Views.Dashboard.render();
  }

  return { render, exportData, importData, clearAll };
})();
