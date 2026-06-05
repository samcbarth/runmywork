Views.ProjectDetail = (() => {
  let _currentId = null;
  let _menuOpen = false;
  let _runPollTimer = null;   // live agent-progress polling (cleared on navigate)

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

      ${_renderTrackerSection(project)}
      ${_renderSessionsSection(project, isTimerRunning)}
      ${_renderAdvisorSection(project)}
      ${_renderContextSection(project)}
      ${_renderTasksSection(project)}
      ${_renderLinksSection(project)}
      ${_renderHistorySection(project)}
      ${_renderWorklogSection(project)}

      <div style="margin-top:20px;text-align:center;">
        <button class="btn btn-ghost btn-sm" onclick="Views.ProjectForm.confirmDelete('${id}')" style="color:var(--c-blocked)">Delete project</button>
      </div>
    `;

    // Close status menu on outside click
    document.addEventListener('click', _closeMenuOnOutside);

    // Live agent-progress tracker (auto-poll while a run is active) + show the
    // project's context inline without needing the Load button.
    _stopRunPoll();
    loadRun(id);
    loadContext(id);
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

  function _renderAdvisorSection(project) {
    const sug = project.aiSuggestion;
    const stale = sug && sug.basedOnUpdatedAt !== project.updatedAt;

    // Pending proposals for THIS project — actionable changes the user gates.
    const proposals = Store.getApprovals().filter(a => a.project_id === project.id);
    const proposalRows = proposals.map(a => `
      <div class="advisor-task" style="flex-direction:column;align-items:stretch;gap:6px;">
        <span><strong>${Models.escapeHtml(_proposalSummary(a))}</strong></span>
        ${_proposalDetail(a)}
        <div style="display:flex;gap:8px;">
          <button class="btn btn-sm btn-success" onclick="Views.ProjectDetail.decideProposal('${a.id}','approve')">✓ Approve</button>
          <button class="btn btn-sm btn-danger" onclick="Views.ProjectDetail.decideProposal('${a.id}','reject')">✕ Reject</button>
        </div>
      </div>`).join('');

    let body;
    if (sug) {
      body = `
        ${sug.nextAction ? `<p class="advisor-next">${Models.escapeHtml(sug.nextAction)}</p>` : ''}
        <div class="advisor-meta">
          ${sug.model ? `via ${Models.escapeHtml(sug.model)} · ` : ''}${Models.formatDays(Date.now() - sug.generatedAt)} ago
          ${stale ? ' · <span style="color:var(--c-idle)">project changed since</span>' : ''}
        </div>`;
    } else if (project.aiRequested) {
      body = `<p class="advisor-pending">⏳ Waiting for the advisor's next run…</p>`;
    } else {
      body = `<p class="advisor-empty" style="color:var(--text-2);font-size:0.85rem;">No suggestion yet. Ask the advisor to read this project and propose a next step.</p>`;
    }

    const btnLabel = project.aiRequested
      ? '⏳ Requested'
      : (sug ? '↻ Ask again' : '✨ Ask the advisor');

    return `
      <div class="section-card" style="border-color:var(--c-active,#6aa6ff);">
        <div class="section-header">
          <span class="section-title">💡 Advisor</span>
          <button class="btn btn-sm" ${project.aiRequested ? 'disabled' : ''}
            onclick="Views.ProjectDetail.requestAdvice('${project.id}')">${btnLabel}</button>
        </div>
        ${body}
        ${proposalRows ? `<div class="advisor-tasks" style="margin-top:10px;"><div style="font-size:0.78rem;color:var(--text-2);margin-bottom:6px;">Proposals awaiting your approval</div>${proposalRows}</div>` : ''}
      </div>`;
  }

  function _proposalSummary(a) {
    const p = a.payload || {};
    switch (a.action_type) {
      case 'add_tasks':    return `Add ${Array.isArray(p.tasks) ? p.tasks.length : 0} task(s)`;
      case 'set_status':   return `Set status → ${p.status}`;
      case 'set_priority': return `Set priority → ${p.priority}`;
      case 'add_link':     return `Add link: ${p.label || p.url || ''}`;
      default:             return a.action_type;
    }
  }

  function _proposalDetail(a) {
    const p = a.payload || {};
    if (a.action_type === 'add_tasks' && Array.isArray(p.tasks) && p.tasks.length) {
      return `<ul class="approval-detail-list" style="margin:0;padding-left:18px;">${p.tasks.map(t => `<li>${Models.escapeHtml(t)}</li>`).join('')}</ul>`;
    }
    if (a.rationale) return `<span style="font-size:0.82rem;color:var(--text-2);">${Models.escapeHtml(a.rationale)}</span>`;
    return '';
  }

  function _renderWorklogSection(project) {
    return `
      <div class="section-card">
        <div class="section-header">
          <span class="section-title">Worklog</span>
          <button class="btn btn-sm" id="worklog-load-${project.id}"
            onclick="Views.ProjectDetail.loadWorklog('${project.id}')">Load</button>
        </div>
        <div class="worklog-list" id="worklog-list-${project.id}">
          <p style="color:var(--text-2);font-size:0.85rem;">The agent's journal for this project — proposals, actions, notes.</p>
        </div>
      </div>`;
  }

  /* ── Agent progress tracker (Domino's-style) ── */

  const _STAGES = [
    ['look', 'Look'], ['think', 'Think'], ['do', 'Do'],
    ['review', 'Review'], ['revise', 'Revise'], ['report', 'Report']
  ];

  // Empty container; loadRun() fills + reveals it only when a run exists.
  function _renderTrackerSection(project) {
    return `<div class="section-card tracker" id="tracker-${project.id}" style="display:none;"></div>`;
  }

  // Build the tracker markup from an agent_runs row.
  function _trackerHtml(run) {
    const curIdx = Math.max(0, _STAGES.findIndex(s => s[0] === run.stage));
    const running = run.status === 'running';
    const failed  = run.status === 'failed';
    const allDone = run.status === 'done';

    const segs = _STAGES.map((s, i) => {
      let cls = 'future';
      if (allDone) cls = 'done';
      else if (i < curIdx) cls = 'done';
      else if (i === curIdx) cls = running ? 'current' : 'done';
      return `<div class="tracker-seg ${cls}">
        <span class="tracker-dot">${cls === 'done' ? '✓' : i + 1}</span>
        <span class="tracker-seg-label">${s[1]}</span>
      </div>`;
    }).join('');

    const pct = Math.max(0, Math.min(100, run.percent || 0));
    const badge = failed
      ? '<span class="tracker-badge failed">Failed</span>'
      : running
        ? '<span class="tracker-badge working">● Working</span>'
        : '<span class="tracker-badge done">✓ Done</span>';

    const logByStage = {};
    (run.log || []).forEach(l => { (logByStage[l.stage] = logByStage[l.stage] || []).push(l); });

    const stageRows = (run.stages || []).map(st => {
      const label = (_STAGES.find(s => s[0] === st.stage) || [, st.stage])[1];
      const logs = logByStage[st.stage] || [];
      const logHtml = logs.length
        ? `<ul class="tracker-log">${logs.map(l => `<li><span class="tracker-log-t">${Models.formatDateTime(l.t)}</span> ${Models.escapeHtml(l.line)}</li>`).join('')}</ul>`
        : '<p class="tracker-log-empty">No tool activity recorded.</p>';
      return `<details class="tracker-stage">
        <summary><strong>${label}</strong> <span class="tracker-stage-time">${Models.formatDateTime(st.enteredAt)}</span>${st.note ? ` — ${Models.escapeHtml(st.note)}` : ''}</summary>
        ${logHtml}
      </details>`;
    }).join('');

    const when = run.ended_at
      ? `finished ${Models.formatDays(Date.now() - run.ended_at)} ago`
      : `started ${Models.formatDays(Date.now() - run.started_at)} ago`;

    return `
      <div class="section-header" style="margin-bottom:10px;">
        <span class="section-title">🤖 Agent progress</span>${badge}
      </div>
      <div class="tracker-bar">${segs}</div>
      <div class="tracker-fill-wrap"><div class="tracker-fill" style="width:${pct}%"></div></div>
      <div class="tracker-meta">Stage ${curIdx + 1} of 6 · ${_STAGES[curIdx][1]} · ${pct}% · ${when}</div>
      ${run.summary ? `<p class="tracker-summary">${Models.escapeHtml(run.summary)}</p>` : ''}
      <div class="tracker-stages">${stageRows}</div>`;
  }

  /* ── Project context / knowledge ── */

  function _renderContextSection(project) {
    const kinds = ['note', 'requirement', 'decision', 'history', 'instruction', 'goal', 'constraint'];
    return `
      <div class="section-card">
        <div class="section-header">
          <span class="section-title">📚 Context / Knowledge</span>
          <button class="btn btn-sm" id="context-load-${project.id}"
            onclick="Views.ProjectDetail.loadContext('${project.id}')">Load</button>
        </div>
        <p style="color:var(--text-2);font-size:0.8rem;margin:0 0 10px;">
          Background the agent reads as memory — requirements, decisions, history, instructions.
          Appended, never overwritten. <strong>No secrets</strong> (this syncs to a shared store).
        </p>
        <div class="context-add">
          <select class="form-input" id="context-kind-${project.id}" style="max-width:170px;">
            ${kinds.map(k => `<option value="${k}">${k}</option>`).join('')}
          </select>
          <textarea class="form-input" id="context-text-${project.id}" rows="4"
            placeholder="Add context, requirements, notes, decisions, constraints…"></textarea>
          <button class="btn btn-sm btn-primary" id="context-save-${project.id}"
            onclick="Views.ProjectDetail.saveContext('${project.id}')">Save update</button>
        </div>
        <div class="context-list" id="context-list-${project.id}"></div>
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

  function requestAdvice(projectId) {
    const project = Store.getProject(projectId);
    if (!project) return;
    project.aiRequested = true;
    Store.saveProject(project);   // syncs to Supabase; the local advisor picks it up on its next run
    render(projectId);
  }

  // Approve/reject a proposal inline — delegates to the shared Approvals logic
  // (apply + worklog + decide), then re-renders this project view.
  async function decideProposal(approvalId, action) {
    if (action === 'approve') await Views.Approvals.approve(approvalId);
    else                      await Views.Approvals.reject(approvalId);
    // Approvals.* calls App.refresh(), which re-renders this view from the hash.
  }

  async function loadWorklog(projectId) {
    const list = document.getElementById(`worklog-list-${projectId}`);
    const btn  = document.getElementById(`worklog-load-${projectId}`);
    if (!list) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

    const { ok, entries } = await Sync.pullWorklog(projectId);
    if (btn) { btn.disabled = false; btn.textContent = '↻ Reload'; }

    if (!ok) { list.innerHTML = '<p style="color:var(--c-blocked);font-size:0.85rem;">Could not load worklog.</p>'; return; }
    if (!entries.length) { list.innerHTML = '<p style="color:var(--text-2);font-size:0.85rem;">No entries yet.</p>'; return; }

    const icon = { proposal: '💡', action: '✓', observation: '👁', note: '•' };
    list.innerHTML = entries.map(e => `
      <div class="history-item">
        <div class="history-content">
          <div class="history-status">${icon[e.kind] || '•'} ${Models.escapeHtml(e.summary || e.kind)}</div>
          <div class="history-date">${Models.formatDateTime(e.created_at)} · ${Models.escapeHtml(e.created_by || '')}</div>
        </div>
      </div>`).join('');
  }

  function _fmtElapsed(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  /* ── Agent progress tracker: load + live poll ── */

  async function loadRun(projectId) {
    const el = document.getElementById(`tracker-${projectId}`);
    if (!el) return;
    const { ok, run } = await Sync.pullLatestRun(projectId);
    if (!ok || !run) { el.style.display = 'none'; return; }
    el.innerHTML = _trackerHtml(run);
    el.style.display = '';
    if (run.status === 'running') _startRunPoll(projectId);
  }

  function _startRunPoll(projectId) {
    _stopRunPoll();
    _runPollTimer = setInterval(async () => {
      // Self-cancel if the user navigated away from this project.
      if (!location.hash.includes('project/' + projectId)) { _stopRunPoll(); return; }
      const el = document.getElementById(`tracker-${projectId}`);
      if (!el) { _stopRunPoll(); return; }
      const { ok, run } = await Sync.pullLatestRun(projectId);
      if (ok && run) {
        el.innerHTML = _trackerHtml(run);
        el.style.display = '';
        if (run.status !== 'running') _stopRunPoll();
      }
    }, 4000);
  }

  function _stopRunPoll() {
    if (_runPollTimer) { clearInterval(_runPollTimer); _runPollTimer = null; }
  }

  /* ── Project context / knowledge: load + save ── */

  async function loadContext(projectId) {
    const list = document.getElementById(`context-list-${projectId}`);
    const btn  = document.getElementById(`context-load-${projectId}`);
    if (!list) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

    let res;
    try { res = await Sync.pullContext(projectId); }
    catch (e) { res = { ok: false, reason: e.message, entries: [] }; }
    if (btn) { btn.disabled = false; btn.textContent = '↻ Reload'; }

    if (!res.ok) { list.innerHTML = `<p style="color:var(--c-blocked);font-size:0.85rem;">Could not load context (${Models.escapeHtml(res.reason || 'error')}).</p>`; return; }
    const entries = res.entries || [];
    if (!entries.length) { list.innerHTML = '<p style="color:var(--text-2);font-size:0.85rem;">No context yet. Add the first note above.</p>'; return; }

    list.innerHTML = entries.map(e => `
      <div class="context-item">
        <div class="context-item-head">
          <span class="context-kind">${Models.escapeHtml(e.kind || 'note')}</span>
          <span class="context-item-time">${Models.formatDateTime(e.created_at)} · ${Models.escapeHtml(e.created_by || 'user')}</span>
        </div>
        <div class="context-content">${Models.escapeHtml(e.content || '')}</div>
      </div>`).join('');
  }

  async function saveContext(projectId) {
    const ta = document.getElementById(`context-text-${projectId}`);
    const kindEl = document.getElementById(`context-kind-${projectId}`);
    const btn = document.getElementById(`context-save-${projectId}`);
    const content = ta ? ta.value.trim() : '';
    if (!content) { ta && ta.focus(); return; }
    const kind = kindEl ? kindEl.value : 'note';

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    let res;
    try { res = await Sync.addContext({ project_id: projectId, kind, content, created_by: 'user' }); }
    catch (e) { res = { ok: false, reason: e.message }; }
    if (btn) { btn.disabled = false; btn.textContent = 'Save update'; }

    if (!res.ok) { alert('Could not save context: ' + (res.reason || 'unknown error')); return; }
    if (ta) ta.value = '';
    loadContext(projectId);
  }

  return {
    render, toggleStatusMenu, changeStatus, deleteSession, addLink, deleteLink,
    addTask, toggleTask, deleteTask, requestAdvice, decideProposal, loadWorklog,
    loadRun, loadContext, saveContext
  };
})();
