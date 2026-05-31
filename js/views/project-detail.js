Views.ProjectDetail = (() => {
  let _currentId = null;
  let _menuOpen = false;

  function render(id) {
    _currentId = id;
    const project = Store.getProject(id);
    const root = document.getElementById('view-root');

    if (!project) {
      root.innerHTML = `
        <button class="detail-back" onclick="App.navigate('')">← Back</button>
        <p style="color:var(--text-2)">Project not found.</p>`;
      return;
    }

    const timeIn       = Models.timeInCurrentStatus(project);
    const timeBlocked  = Models.timeBlockedTotal(project);
    const timeIdle     = Models.timeIdleTotal(project);
    const activeSession = Store.getActiveSession();
    const isTimerRunning = activeSession && activeSession.projectId === id;

    const statusLabels = { active: 'Active', blocked: 'Blocked', idle: 'Idle', done: 'Done', archived: 'Archived' };
    const tags = project.tags && project.tags.length
      ? `<div class="card-tags" style="margin-top:10px;">${project.tags.map(t => `<span class="tag">${Models.escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    const blockedNote = project.status === 'blocked' && project.blockedReason
      ? `<p class="card-detail warning" style="margin-top:8px;">⛔ Blocked by: ${Models.escapeHtml(project.blockedReason)}</p>` : '';

    const timerBanner = isTimerRunning ? `
      <div style="background:var(--bg-active);border:1px solid var(--c-active);border-radius:var(--radius-sm);padding:12px 16px;margin-top:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <span class="card-detail timer-live" data-timer-live style="margin:0;">⏱ ${_fmtElapsed(Date.now() - activeSession.startedAt)} (timer running)</span>
        <button class="btn btn-sm btn-warning" onclick="Views.SessionModal.stopTimer()">■ Stop</button>
      </div>` : '';

    root.innerHTML = `
      <button class="detail-back" onclick="App.navigate('')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        All projects
      </button>

      <div class="detail-hero">
        <div class="detail-hero-top">
          <div>
            <span class="status-pill status-${project.status}">
              <span class="status-dot"></span>${statusLabels[project.status] || project.status}
            </span>
            <span class="status-time">${Models.formatDays(timeIn)}</span>
          </div>
          <div class="detail-actions">
            <button class="btn btn-sm" onclick="Views.ProjectForm.open('${id}')">Edit</button>
            <div class="status-menu" id="status-menu">
              <button class="btn btn-sm" onclick="Views.ProjectDetail.toggleStatusMenu()">Change status ▾</button>
              <div class="status-menu-dropdown" id="status-menu-dropdown">
                ${_statusMenuItems(project.status)}
              </div>
            </div>
          </div>
        </div>

        <h2 class="detail-title">${Models.escapeHtml(project.title)}</h2>
        ${blockedNote}
        ${project.description ? `<p class="detail-desc">${Models.escapeHtml(project.description)}</p>` : ''}
        ${tags}
        ${timerBanner}

        <div class="detail-meta" style="margin-top:14px;">
          <span class="meta-item">📅 Created ${Models.formatDate(project.createdAt)}</span>
          ${project.priority !== 'medium' ? `<span class="meta-item">• ${project.priority === 'high' ? '🔴' : '🟢'} ${project.priority} priority</span>` : ''}
          <span class="meta-item">• Updated ${Models.formatDate(project.updatedAt)}</span>
        </div>
      </div>

      <div class="stats-row">
        <div class="stat-box">
          <div class="stat-value">${Models.formatDuration(project.totalMinutes)}</div>
          <div class="stat-label">Time invested</div>
        </div>
        <div class="stat-box">
          <div class="stat-value" style="color:var(--c-blocked)">${Models.formatDays(timeBlocked) === '—' ? '—' : Models.formatDays(timeBlocked)}</div>
          <div class="stat-label">Time blocked</div>
        </div>
        <div class="stat-box">
          <div class="stat-value" style="color:var(--c-idle)">${timeIdle > 60000 ? Models.formatDays(timeIdle) : '—'}</div>
          <div class="stat-label">Time idle</div>
        </div>
      </div>

      ${_renderSessionsSection(project, isTimerRunning)}
      ${_renderTasksSection(project)}
      ${_renderLinksSection(project)}
      ${_renderHistorySection(project)}

      <div style="margin-top:20px;text-align:center;">
        <button class="btn btn-ghost btn-sm" onclick="Views.ProjectForm.confirmDelete('${id}')" style="color:var(--c-blocked)">Delete project</button>
      </div>
    `;

    // Close status menu on outside click
    document.addEventListener('click', _closeMenuOnOutside);
  }

  function _statusMenuItems(currentStatus) {
    const all = [
      { value: 'active',  label: 'Active',  dot: 'dot-active'  },
      { value: 'blocked', label: 'Blocked', dot: 'dot-blocked' },
      { value: 'idle',    label: 'Idle',    dot: 'dot-idle'    },
      { value: 'done',    label: 'Done',    dot: 'dot-done'    }
    ];
    return all.filter(s => s.value !== currentStatus).map(s =>
      `<button class="status-menu-item" onclick="Views.ProjectDetail.changeStatus('${s.value}')">
        <span class="dot ${s.dot}"></span>${s.label}
      </button>`
    ).join('');
  }

  function _renderSessionsSection(project, isTimerRunning) {
    const sessions = [...(project.sessions || [])].reverse();
    const sessionRows = sessions.map(s => `
      <div class="session-item">
        <div>
          <div class="session-duration">${Models.formatDuration(s.durationMinutes)}${s.manual ? ' <span style="font-size:0.7rem;color:var(--text-2)">(manual)</span>' : ''}</div>
          <div class="session-date">${Models.formatDate(s.startedAt)}</div>
          ${s.note ? `<div class="session-note">"${Models.escapeHtml(s.note)}"</div>` : ''}
        </div>
        <button class="session-delete" onclick="Views.ProjectDetail.deleteSession('${project.id}','${s.id}')">✕</button>
      </div>
    `).join('') || '<p style="color:var(--text-2);font-size:0.85rem;">No sessions logged yet.</p>';

    const canStart = project.status !== 'done' && project.status !== 'archived';

    return `
      <div class="section-card">
        <div class="section-header">
          <span class="section-title">Sessions</span>
          ${canStart ? `
            <div style="display:flex;gap:8px;">
              ${!isTimerRunning
                ? `<button class="btn btn-sm btn-success" onclick="Views.SessionModal.open('${project.id}','timer')">▶ Start timer</button>`
                : ''}
              <button class="btn btn-sm" onclick="Views.SessionModal.open('${project.id}','manual')">+ Log time</button>
            </div>` : ''}
        </div>
        <div class="sessions-list">${sessionRows}</div>
      </div>`;
  }

  function _renderLinksSection(project) {
    const links = project.links || [];
    const rows = links.map((l, i) => `
      <div class="link-item">
        <a class="link-label" href="${Models.escapeHtml(l.url)}" target="_blank" rel="noopener">${Models.escapeHtml(l.label || l.url)}</a>
        <button class="link-delete" onclick="Views.ProjectDetail.deleteLink('${project.id}',${i})">✕</button>
      </div>
    `).join('') || '';

    return `
      <div class="section-card">
        <div class="section-header">
          <span class="section-title">Links</span>
          <button class="btn btn-sm" onclick="Views.ProjectDetail.addLink('${project.id}')">+ Add link</button>
        </div>
        <div class="links-list">
          ${rows || '<p style="color:var(--text-2);font-size:0.85rem;">No links yet.</p>'}
        </div>
      </div>`;
  }

  function _renderTasksSection(project) {
    return `
      <div class="section-card">
        <div class="section-header">
          <span class="section-title">Tasks <span id="task-count-${project.id}" style="font-weight:400;color:var(--text-2);font-size:0.82rem;">${_taskCountText(project)}</span></span>
        </div>
        <div class="task-list" id="task-list-${project.id}">${_taskRows(project)}</div>
        <div class="task-add-row">
          <input class="task-add-input" id="task-input-${project.id}" type="text"
            placeholder="Add a task…"
            onkeydown="if(event.key==='Enter')Views.ProjectDetail.addTask('${project.id}')">
          <button class="btn btn-sm" onclick="Views.ProjectDetail.addTask('${project.id}')">Add</button>
        </div>
      </div>`;
  }

  function _taskRows(project) {
    return (project.tasks || []).map(t => `
      <div class="task-item${t.done ? ' task-done' : ''}" data-task-id="${t.id}">
        <button class="task-check${t.done ? ' checked' : ''}"
          onclick="Views.ProjectDetail.toggleTask('${project.id}','${t.id}')">
          ${t.done ? '✓' : ''}
        </button>
        <span class="task-text">${Models.escapeHtml(t.text)}</span>
        <button class="task-delete" onclick="Views.ProjectDetail.deleteTask('${project.id}','${t.id}')">✕</button>
      </div>`).join('');
  }

  function _taskCountText(project) {
    const tasks = project.tasks || [];
    if (!tasks.length) return '';
    const done = tasks.filter(t => t.done).length;
    return `${done}/${tasks.length}`;
  }

  function _updateTaskUI(projectId, project) {
    const list = document.getElementById(`task-list-${projectId}`);
    if (list) list.innerHTML = _taskRows(project);
    const count = document.getElementById(`task-count-${projectId}`);
    if (count) count.textContent = _taskCountText(project);
  }

  function _renderHistorySection(project) {
    const history = [...project.statusHistory].reverse();
    const rows = history.map((h, i) => {
      const isLast = i === history.length - 1;
      const next = i > 0 ? history[i - 1] : null;
      const duration = next ? next.enteredAt - h.enteredAt : Date.now() - h.enteredAt;
      return `
        <div class="history-item">
          <div class="history-dot status-${h.status}"></div>
          <div class="history-content">
            <div class="history-status">${h.status}</div>
            <div class="history-date">${Models.formatDateTime(h.enteredAt)} · ${Models.formatDays(duration)}</div>
            ${h.note ? `<div class="history-note">${Models.escapeHtml(h.note)}</div>` : ''}
          </div>
        </div>`;
    }).join('');

    return `
      <div class="section-card">
        <div class="section-header"><span class="section-title">Status history</span></div>
        <div class="history-list">${rows}</div>
      </div>`;
  }

  /* ── Actions ── */

  function toggleStatusMenu() {
    _menuOpen = !_menuOpen;
    document.getElementById('status-menu-dropdown')?.classList.toggle('open', _menuOpen);
  }

  function _closeMenuOnOutside(e) {
    if (!document.getElementById('status-menu')?.contains(e.target)) {
      _menuOpen = false;
      document.getElementById('status-menu-dropdown')?.classList.remove('open');
    }
  }

  function changeStatus(newStatus) {
    _menuOpen = false;
    document.getElementById('status-menu-dropdown')?.classList.remove('open');

    const project = Store.getProject(_currentId);
    if (!project) return;

    if (newStatus === 'blocked') {
      Views.ProjectForm.markBlocked(_currentId);
      return;
    }

    Models.appendStatus(project, newStatus, '');
    if (newStatus !== 'blocked') project.blockedReason = '';
    Store.saveProject(project);
    render(_currentId);
  }

  function deleteSession(projectId, sessionId) {
    if (!confirm('Remove this session?')) return;
    Store.deleteSession(projectId, sessionId);
    render(projectId);
  }

  function addLink(projectId) {
    const project = Store.getProject(projectId);
    if (!project) return;

    const html = `
      <div class="form-group">
        <label class="form-label" for="link-label">Label</label>
        <input class="form-input" id="link-label" type="text" placeholder="e.g. GitHub PR, Design doc">
      </div>
      <div class="form-group">
        <label class="form-label" for="link-url">URL</label>
        <input class="form-input" id="link-url" type="url" placeholder="https://...">
      </div>
      <div class="modal-footer" style="padding:0;border:none;margin-top:8px;">
        <button class="btn" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary" id="link-save">Add link</button>
      </div>
    `;
    App.openModal(html, 'Add link');

    document.getElementById('link-save').addEventListener('click', () => {
      const label = document.getElementById('link-label').value.trim();
      const url   = document.getElementById('link-url').value.trim();
      if (!url) return;
      project.links = project.links || [];
      project.links.push({ label: label || url, url });
      Store.saveProject(project);
      App.closeModal();
      render(projectId);
    });
  }

  function deleteLink(projectId, index) {
    const project = Store.getProject(projectId);
    if (!project) return;
    project.links.splice(index, 1);
    Store.saveProject(project);
    render(projectId);
  }

  function addTask(projectId) {
    const input = document.getElementById(`task-input-${projectId}`);
    const text = input?.value.trim();
    if (!text) { input?.focus(); return; }
    const project = Store.getProject(projectId);
    if (!project) return;
    project.tasks = project.tasks || [];
    project.tasks.push({ id: crypto.randomUUID(), text, done: false, createdAt: Date.now() });
    Store.saveProject(project);
    input.value = '';
    _updateTaskUI(projectId, project);
    input.focus();
  }

  function toggleTask(projectId, taskId) {
    const project = Store.getProject(projectId);
    if (!project) return;
    const task = (project.tasks || []).find(t => t.id === taskId);
    if (!task) return;
    task.done = !task.done;
    Store.saveProject(project);
    _updateTaskUI(projectId, project);
  }

  function deleteTask(projectId, taskId) {
    const project = Store.getProject(projectId);
    if (!project) return;
    project.tasks = (project.tasks || []).filter(t => t.id !== taskId);
    Store.saveProject(project);
    _updateTaskUI(projectId, project);
  }

  function _fmtElapsed(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  return { render, toggleStatusMenu, changeStatus, deleteSession, addLink, deleteLink, addTask, toggleTask, deleteTask };
})();
