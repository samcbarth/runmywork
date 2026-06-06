Views.Approvals = (() => {

  /* Human-readable one-liner for a proposal's payload. */
  function _summary(a) {
    const p = a.payload || {};
    switch (a.action_type) {
      case 'add_tasks':    return `Add ${Array.isArray(p.tasks) ? p.tasks.length : 0} task(s)`;
      case 'set_status':   return `Set status → ${p.status}`;
      case 'set_priority': return `Set priority → ${p.priority}`;
      case 'add_link':     return `Add link: ${p.label || p.url || ''}`;
      case 'set_spec':     return `Set project spec (${Array.isArray(p.successCriteria) ? p.successCriteria.length : 0} success criteria)`;
      default:             return a.action_type;
    }
  }

  /* Expanded detail (e.g. the actual task list) for a proposal. */
  function _detail(a) {
    const p = a.payload || {};
    if (a.action_type === 'add_tasks' && Array.isArray(p.tasks) && p.tasks.length) {
      return `<ul class="approval-detail-list">${p.tasks.map(t => `<li>${Models.escapeHtml(t)}</li>`).join('')}</ul>`;
    }
    if (a.action_type === 'set_status' && p.note) {
      return `<p class="approval-detail-note">${Models.escapeHtml(p.note)}</p>`;
    }
    if (a.action_type === 'set_spec') {
      const sec = (label, arr, ordered) => {
        if (!Array.isArray(arr) || !arr.length) return '';
        const tag = ordered ? 'ol' : 'ul';
        return `<div class="approval-detail-note"><strong>${label}</strong><${tag} class="approval-detail-list">${arr.map(x => `<li>${Models.escapeHtml(x)}</li>`).join('')}</${tag}></div>`;
      };
      return [
        p.goal ? `<p class="approval-detail-note"><strong>Goal:</strong> ${Models.escapeHtml(p.goal)}</p>` : '',
        sec('Requirements', p.requirements, false),
        sec('Success criteria', p.successCriteria, true),
        sec('Constraints', p.constraints, false)
      ].filter(Boolean).join('');
    }
    return '';
  }

  async function render() {
    const root = document.getElementById('view-root');
    root.innerHTML = `
      <button class="detail-back" onclick="App.navigate('')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        All projects
      </button>
      <h2 class="detail-title" style="margin:8px 0 16px;">Approvals</h2>
      <div id="approvals-list"><p style="color:var(--text-2);font-size:0.85rem;">Loading…</p></div>`;

    // Refresh from the server so the inbox reflects new advisor proposals.
    await Sync.pullApprovals();
    updateBadge();
    _renderList();
  }

  function _renderList() {
    const container = document.getElementById('approvals-list');
    if (!container) return;

    const approvals = Store.getApprovals();
    if (!approvals.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✅</div>
          <p>No proposals waiting. The advisor will add some on its next run.</p>
        </div>`;
      return;
    }

    // Group by project so related proposals sit together.
    const byProject = {};
    approvals.forEach(a => { (byProject[a.project_id] = byProject[a.project_id] || []).push(a); });

    container.innerHTML = Object.keys(byProject).map(pid => {
      const project = Store.getProject(pid);
      const title = project ? project.title : '(unknown project)';
      const rows = byProject[pid].map(a => `
        <div class="section-card" style="margin-top:10px;">
          <div class="section-header">
            <span class="section-title">${Models.escapeHtml(_summary(a))}</span>
          </div>
          ${a.rationale ? `<p class="advisor-next">${Models.escapeHtml(a.rationale)}</p>` : ''}
          ${_detail(a)}
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button class="btn btn-sm btn-success" onclick="Views.Approvals.approve('${a.id}')">✓ Approve</button>
            <button class="btn btn-sm btn-danger" onclick="Views.Approvals.reject('${a.id}')">✕ Reject</button>
          </div>
        </div>`).join('');
      return `
        <div style="margin-bottom:18px;">
          <h3 class="card-title" style="cursor:pointer;" onclick="App.navigate('project/${pid}')">${Models.escapeHtml(title)}</h3>
          ${rows}
        </div>`;
    }).join('');
  }

  /* Apply a proposal's payload to its project via the existing Store mutations. */
  function _apply(a) {
    const project = Store.getProject(a.project_id);
    if (!project) return false;
    const p = a.payload || {};

    switch (a.action_type) {
      case 'add_tasks':
        project.tasks = project.tasks || [];
        (p.tasks || []).forEach(text => {
          if (text && text.trim()) project.tasks.push({ id: crypto.randomUUID(), text: text.trim(), done: false, createdAt: Date.now() });
        });
        break;
      case 'set_status':
        if (!p.status) return false;
        Models.appendStatus(project, p.status, p.note || 'Advisor-applied');
        if (p.status !== 'blocked') project.blockedReason = '';
        break;
      case 'set_priority':
        if (!p.priority) return false;
        project.priority = p.priority;
        break;
      case 'add_link':
        if (!p.url) return false;
        project.links = project.links || [];
        project.links.push({ label: p.label || p.url, url: p.url });
        break;
      case 'set_spec': {
        if (!p.goal) return false;
        // Write the spec as append-only project_context rows (one per field).
        const rows = [{ kind: 'goal', content: p.goal }];
        (p.requirements    || []).forEach(c => rows.push({ kind: 'requirement',      content: c }));
        (p.successCriteria || []).forEach(c => rows.push({ kind: 'success_criteria', content: c }));
        (p.constraints     || []).forEach(c => rows.push({ kind: 'constraint',       content: c }));
        rows.forEach(r => {
          if (r.content && r.content.trim()) {
            Sync.addContext({ project_id: a.project_id, kind: r.kind, content: r.content.trim(), created_by: 'agent-approved' });
          }
        });
        return true;   // context rows are written directly; no project mutation
      }
      default:
        return false;
    }
    Store.saveProject(project);   // persists locally + per-project Supabase push
    return true;
  }

  async function approve(id) {
    const a = Store.getApprovals().find(x => x.id === id);
    if (!a) return;

    if (!_apply(a)) { alert('Could not apply — project may have been deleted.'); }
    else {
      Sync.addWorklog({
        project_id: a.project_id, kind: 'action', created_by: 'user',
        summary: `Approved: ${_summary(a)}`, detail: { action_type: a.action_type, payload: a.payload }
      });
    }
    await Sync.decideApproval(id, 'applied');
    updateBadge();
    App.refresh();
  }

  async function reject(id) {
    const a = Store.getApprovals().find(x => x.id === id);
    if (a) {
      Sync.addWorklog({
        project_id: a.project_id, kind: 'note', created_by: 'user',
        summary: `Rejected: ${_summary(a)}`, detail: { action_type: a.action_type }
      });
    }
    await Sync.decideApproval(id, 'rejected');
    updateBadge();
    App.refresh();
  }

  /* Sync the header badge with the pending count. Safe to call from anywhere. */
  function updateBadge() {
    const badge = document.getElementById('approvals-badge');
    if (!badge) return;
    const n = Store.getApprovals().length;
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  return { render, approve, reject, updateBadge };
})();
