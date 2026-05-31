const Views = window.Views || {};

Views.Dashboard = (() => {
  let _filter = 'all';

  function render() {
    const { projects, newlyIdle } = Store.runAutoIdleDetection();
    newlyIdle.forEach(p => Notifications.ping(p.title, 'Auto-detected idle — no recent activity', 'default'));
    const root = document.getElementById('view-root');

    const counts = {
      active:  projects.filter(p => p.status === 'active').length,
      blocked: projects.filter(p => p.status === 'blocked').length,
      idle:    projects.filter(p => p.status === 'idle').length,
      done:    projects.filter(p => p.status === 'done').length
    };

    root.innerHTML = `
      <div class="summary-row">
        <button class="s-chip chip-all ${_filter === 'all' ? 'active' : ''}" data-filter="all">
          All <span class="chip-count">${projects.filter(p => p.status !== 'archived').length}</span>
        </button>
        <button class="s-chip chip-active ${_filter === 'active' ? 'active' : ''}" data-filter="active">
          Active <span class="chip-count">${counts.active}</span>
        </button>
        <button class="s-chip chip-blocked ${_filter === 'blocked' ? 'active' : ''}" data-filter="blocked">
          Blocked <span class="chip-count">${counts.blocked}</span>
        </button>
        <button class="s-chip chip-idle ${_filter === 'idle' ? 'active' : ''}" data-filter="idle">
          Idle <span class="chip-count">${counts.idle}</span>
        </button>
        <button class="s-chip chip-done ${_filter === 'done' ? 'active' : ''}" data-filter="done">
          Done <span class="chip-count">${counts.done}</span>
        </button>
      </div>

      <div class="project-list" id="project-list">
        ${_renderList(projects)}
      </div>
    `;

    _attachEvents();
  }

  function _renderList(all) {
    let list = all.filter(p => p.status !== 'archived');

    if (_filter !== 'all') list = list.filter(p => p.status === _filter);

    const order = { blocked: 0, idle: 1, active: 2, done: 3 };
    list.sort((a, b) => {
      const diff = (order[a.status] ?? 4) - (order[b.status] ?? 4);
      if (diff !== 0) return diff;
      return Models.timeInCurrentStatus(b) - Models.timeInCurrentStatus(a);
    });

    if (list.length === 0 && all.filter(p => p.status !== 'archived').length === 0) {
      return `
        <div class="empty-state">
          <div class="empty-icon">🚀</div>
          <p>No projects yet. Add one to get started.</p>
          <button class="btn btn-primary" onclick="Views.ProjectForm.open()">+ New Project</button>
        </div>`;
    }

    if (list.length === 0) {
      return '<p class="no-results">No projects in this category.</p>';
    }

    return list.map(_renderCard).join('');
  }

  function _renderCard(project) {
    const activeSession = Store.getActiveSession();
    const isTimerRunning = activeSession && activeSession.projectId === project.id;
    const timeIn = Models.timeInCurrentStatus(project);
    const invested = Models.formatDuration(project.totalMinutes);

    const statusLabels = { active: 'Active', blocked: 'Blocked', idle: 'Idle', done: 'Done' };
    const statusLabel = statusLabels[project.status] || project.status;

    let detail = '';
    if (project.status === 'blocked' && project.blockedReason) {
      detail = `<p class="card-detail warning">⛔ ${Models.escapeHtml(project.blockedReason)}</p>`;
    } else if (project.status === 'idle') {
      detail = `<p class="card-detail">No activity for ${Models.formatDays(timeIn)}</p>`;
    } else if (isTimerRunning) {
      const elapsed = Date.now() - activeSession.startedAt;
      detail = `<p class="card-detail timer-live" data-timer-live data-project="${project.id}">⏱ ${_fmtElapsed(elapsed)} (running)</p>`;
    }

    const tags = project.tags && project.tags.length
      ? `<div class="card-tags">${project.tags.map(t => `<span class="tag">${Models.escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    const priorityBadge = project.priority === 'high'
      ? `<span class="priority-badge">HIGH</span>` : '';

    return `
      <div class="project-card status-${project.status}" data-id="${project.id}">
        <div class="card-top">
          <div>
            <span class="status-pill status-${project.status}">
              <span class="status-dot"></span>${statusLabel}
            </span>
            <span class="status-time">${Models.formatDays(timeIn)}</span>
          </div>
          ${priorityBadge}
        </div>
        <h3 class="card-title" onclick="App.navigate('project/${project.id}')">${Models.escapeHtml(project.title)}</h3>
        ${detail}
        ${tags}
        <div class="card-footer">
          <span class="time-invested">⏱ ${invested}</span>
          ${(() => { const tasks = project.tasks || []; const rem = tasks.filter(t => !t.done).length; return rem > 0 ? `<span class="task-badge">${rem} task${rem !== 1 ? 's' : ''} left</span>` : ''; })()}
          <div class="card-actions">${_renderCardActions(project, isTimerRunning)}</div>
        </div>
      </div>
    `;
  }

  function _renderCardActions(project, isTimerRunning) {
    const id = project.id;
    const parts = [`<button class="btn btn-sm" onclick="App.navigate('project/${id}')">View</button>`];

    if (project.status === 'active') {
      if (isTimerRunning) {
        parts.push(`<button class="btn btn-sm btn-warning" onclick="Views.SessionModal.stopTimer()">■ Stop</button>`);
      } else {
        parts.push(`<button class="btn btn-sm btn-success" onclick="Views.SessionModal.open('${id}', 'timer')">▶ Start</button>`);
      }
      parts.push(`<button class="btn btn-sm btn-danger" onclick="Views.ProjectForm.markBlocked('${id}')">Block</button>`);
    } else if (project.status === 'blocked') {
      parts.push(`<button class="btn btn-sm btn-success" onclick="Views.Dashboard.unblock('${id}')">Unblock</button>`);
      parts.push(`<button class="btn btn-sm" onclick="Views.Dashboard.snooze('${id}')">Snooze 3d</button>`);
    } else if (project.status === 'idle') {
      parts.push(`<button class="btn btn-sm btn-success" onclick="Views.SessionModal.open('${id}', 'timer')">▶ Resume</button>`);
      parts.push(`<button class="btn btn-sm" onclick="Views.SessionModal.open('${id}', 'manual')">+ Log Time</button>`);
    } else if (project.status === 'done') {
      parts.push(`<button class="btn btn-sm" onclick="Views.Dashboard.reopen('${id}')">Reopen</button>`);
    }

    return parts.join('');
  }

  function _fmtElapsed(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function _attachEvents() {
    document.querySelectorAll('[data-filter]').forEach(el => {
      el.addEventListener('click', () => {
        _filter = el.dataset.filter;
        render();
      });
    });
  }

  /* ── Inline card actions ── */

  function unblock(id) {
    const project = Store.getProject(id);
    if (!project) return;
    Models.appendStatus(project, 'active', 'Unblocked');
    project.blockedReason = '';
    Store.saveProject(project);
    render();
  }

  function snooze(id) {
    const project = Store.getProject(id);
    if (!project) return;
    project.snoozedUntil = Date.now() + 3 * 86400000;
    Store.saveProject(project);
    render();
  }

  function reopen(id) {
    const project = Store.getProject(id);
    if (!project) return;
    Models.appendStatus(project, 'active', 'Reopened');
    Store.saveProject(project);
    render();
  }

  return { render, unblock, snooze, reopen };
})();
