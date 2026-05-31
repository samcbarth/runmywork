Views.SessionModal = (() => {
  let _projectId = null;
  let _activeTab = 'timer';

  function open(projectId, tab = 'timer') {
    _projectId = projectId;
    _activeTab = tab;

    const project = Store.getProject(projectId);
    if (!project) return;

    const activeSession = Store.getActiveSession();
    const otherSession = activeSession && activeSession.projectId !== projectId;

    const warningHtml = otherSession ? `
      <div style="background:var(--bg-idle);border:1px solid var(--c-idle);border-radius:var(--radius-sm);padding:12px;margin-bottom:16px;font-size:0.85rem;">
        ⚠️ Timer is running on another project. Stop it first or switch to manual entry.
      </div>` : '';

    const isThisTimerRunning = activeSession && activeSession.projectId === projectId;

    const timerPanel = _buildTimerPanel(project, isThisTimerRunning, otherSession);
    const manualPanel = _buildManualPanel();

    App.openModalFull(`
      <div class="modal-header">
        <span class="modal-title">Log time — ${Models.escapeHtml(project.title)}</span>
        <button class="modal-close" onclick="App.closeModal()">✕</button>
      </div>
      <div class="modal-body">
        ${warningHtml}
        <div class="tab-bar">
          <button class="tab-btn ${_activeTab === 'timer'  ? 'active' : ''}" onclick="Views.SessionModal.switchTab('timer')">⏱ Timer</button>
          <button class="tab-btn ${_activeTab === 'manual' ? 'active' : ''}" onclick="Views.SessionModal.switchTab('manual')">✏️ Manual</button>
        </div>
        <div class="tab-panel ${_activeTab === 'timer' ? 'active' : ''}" id="tab-timer">${timerPanel}</div>
        <div class="tab-panel ${_activeTab === 'manual' ? 'active' : ''}" id="tab-manual">${manualPanel}</div>
      </div>
    `);

    if (isThisTimerRunning) {
      _startDisplayTimer(activeSession.startedAt);
    }
  }

  function _buildTimerPanel(project, isRunning, otherBlocked) {
    if (isRunning) {
      const elapsed = Date.now() - Store.getActiveSession().startedAt;
      return `
        <div class="timer-display">
          <div class="timer-digits" id="session-timer-display">${_fmtTimer(elapsed)}</div>
          <div class="timer-label">Timer running for ${Models.escapeHtml(project.title)}</div>
        </div>
        <div class="form-group" style="margin-top:8px;">
          <label class="form-label" for="timer-note">Note <span class="optional">(what did you do?)</span></label>
          <input class="form-input" id="timer-note" type="text" placeholder="Describe what you worked on...">
        </div>
        <div class="timer-actions">
          <button class="btn btn-danger" onclick="Views.SessionModal.discardTimer()">Discard</button>
          <button class="btn btn-primary" onclick="Views.SessionModal.stopTimer()">■ Stop &amp; save</button>
        </div>`;
    }

    return `
      <div class="timer-display">
        <div class="timer-digits" id="session-timer-display">00:00:00</div>
        <div class="timer-label">Ready to start</div>
      </div>
      <div class="timer-actions">
        <button class="btn" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-success" onclick="Views.SessionModal.startTimer()" ${otherBlocked ? 'disabled style="opacity:0.4"' : ''}>▶ Start timer</button>
      </div>`;
  }

  function _buildManualPanel() {
    const today = new Date().toISOString().slice(0, 10);
    return `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="manual-hours">Hours</label>
          <input class="form-input" id="manual-hours" type="number" min="0" max="24" step="1" value="0" style="text-align:center;">
        </div>
        <div class="form-group">
          <label class="form-label" for="manual-mins">Minutes</label>
          <input class="form-input" id="manual-mins" type="number" min="0" max="59" step="5" value="30" style="text-align:center;">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="manual-date">Date</label>
        <input class="form-input" id="manual-date" type="date" value="${today}" max="${today}">
      </div>
      <div class="form-group">
        <label class="form-label" for="manual-note">Note <span class="optional">(optional)</span></label>
        <input class="form-input" id="manual-note" type="text" placeholder="What did you work on?">
      </div>
      <div class="modal-footer" style="padding:0;border:none;margin-top:8px;">
        <button class="btn" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="Views.SessionModal.saveManual()">Save session</button>
      </div>`;
  }

  function switchTab(tab) {
    _activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase().includes(tab)));
    document.getElementById('tab-timer')?.classList.toggle('active', tab === 'timer');
    document.getElementById('tab-manual')?.classList.toggle('active', tab === 'manual');
  }

  /* ── Timer controls ── */

  let _displayInterval = null;

  function startTimer() {
    const activeSession = Store.getActiveSession();
    if (activeSession) return;

    const project = Store.getProject(_projectId);
    if (!project) return;

    const session = { projectId: _projectId, startedAt: Date.now() };
    Store.saveActiveSession(session);

    if (project.status === 'idle' || project.status === 'blocked') {
      Models.appendStatus(project, 'active', 'Started timer');
      Store.saveProject(project);
    }

    App.startGlobalTimer(session);
    open(_projectId, 'timer');
  }

  function stopTimer() {
    const session = Store.getActiveSession();
    if (!session || session.projectId !== _projectId) {
      // Called from a different context — find the session project
      _stopFromAnywhere();
      return;
    }

    const elapsed = Date.now() - session.startedAt;
    const durationMinutes = Math.round(elapsed / 60000);

    const noteEl = document.getElementById('timer-note');
    const note = noteEl ? noteEl.value.trim() : '';

    if (durationMinutes < 1) {
      Store.clearActiveSession();
      App.stopGlobalTimer();
      App.closeModal();
      _refreshCurrent();
      return;
    }

    const sessionRecord = {
      id: crypto.randomUUID(),
      startedAt: session.startedAt,
      endedAt: Date.now(),
      durationMinutes,
      note,
      manual: false
    };

    Store.addSession(_projectId, sessionRecord);
    Store.clearActiveSession();
    App.stopGlobalTimer();
    App.closeModal();
    _refreshCurrent();
    const _p = Store.getProject(_projectId);
    if (_p) Notifications.ping(_p.title, `${durationMinutes} min logged${note ? ' — ' + note : ''}`, 'default');
  }

  function _stopFromAnywhere() {
    const session = Store.getActiveSession();
    if (!session) { App.closeModal(); return; }

    _projectId = session.projectId;
    const elapsed = Date.now() - session.startedAt;
    const durationMinutes = Math.round(elapsed / 60000);

    if (durationMinutes >= 1) {
      const sessionRecord = {
        id: crypto.randomUUID(),
        startedAt: session.startedAt,
        endedAt: Date.now(),
        durationMinutes,
        note: '',
        manual: false
      };
      Store.addSession(session.projectId, sessionRecord);
      const _p = Store.getProject(session.projectId);
      if (_p) Notifications.ping(_p.title, `${durationMinutes} min logged`, 'default');
    }

    Store.clearActiveSession();
    App.stopGlobalTimer();
    App.closeModal();
    _refreshCurrent();
  }

  function discardTimer() {
    if (!confirm('Discard this timer session? Time will not be saved.')) return;
    Store.clearActiveSession();
    App.stopGlobalTimer();
    App.closeModal();
    _refreshCurrent();
  }

  function saveManual() {
    const hours  = parseInt(document.getElementById('manual-hours')?.value || '0', 10) || 0;
    const mins   = parseInt(document.getElementById('manual-mins')?.value  || '0', 10) || 0;
    const durationMinutes = hours * 60 + mins;

    if (durationMinutes < 1) {
      alert('Please enter at least 1 minute.');
      return;
    }

    const dateStr = document.getElementById('manual-date')?.value;
    const note    = document.getElementById('manual-note')?.value.trim() || '';
    const dateMs  = dateStr ? new Date(dateStr).getTime() : Date.now();

    const sessionRecord = {
      id: crypto.randomUUID(),
      startedAt: dateMs,
      endedAt: dateMs,
      durationMinutes,
      note,
      manual: true
    };

    Store.addSession(_projectId, sessionRecord);
    App.closeModal();
    _refreshCurrent();
    const _p = Store.getProject(_projectId);
    const _mins = durationMinutes;
    if (_p) Notifications.ping(_p.title, `${_mins} min logged${note ? ' — ' + note : ''}`, 'default');
  }

  function _startDisplayTimer(startedAt) {
    clearInterval(_displayInterval);
    _displayInterval = setInterval(() => {
      const el = document.getElementById('session-timer-display');
      if (!el) { clearInterval(_displayInterval); return; }
      el.textContent = _fmtTimer(Date.now() - startedAt);
    }, 1000);
  }

  function _fmtTimer(ms) {
    const hh = Math.floor(ms / 3600000);
    const mm = Math.floor((ms % 3600000) / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    return [hh, mm, ss].map(n => String(n).padStart(2, '0')).join(':');
  }

  function _refreshCurrent() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (hash === '' || hash === 'dashboard') {
      Views.Dashboard.render();
    } else if (hash.startsWith('project/')) {
      Views.ProjectDetail.render(hash.slice('project/'.length));
    }
  }

  return { open, switchTab, startTimer, stopTimer, discardTimer, saveManual };
})();
