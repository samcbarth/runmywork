/*
 * Review tab — a per-project, human-reviewer-focused view.
 * Consolidates everything needed to decide if work is done: the success-criteria
 * checklist (met / failed / open), the live agent tracker, the pending approval
 * controls (incl. the pass/fail criteria card and the keep/duplicate task card),
 * and recent run history. Route: #/review/<projectId> (see js/app.js).
 */
Views.Review = (() => {

  const _norm = (s) => String(s || '').split(/\n\n(?:Evidence|Feedback):/i)[0].trim().toLowerCase();

  // Client mirror of run.js partitionSpec criteria status (recency-aware).
  function _criteriaStatus(entries) {
    const criteria = [];
    const metAt = new Map(), failAt = new Map();
    // entries are newest-first; first seen per key is the latest.
    for (const r of entries) {
      const k = _norm(r.content);
      if (r.kind === 'success_criteria') criteria.push(String(r.content || '').trim());
      else if (r.kind === 'success_criteria_met' && !metAt.has(k)) metAt.set(k, r.created_at || 0);
      else if (r.kind === 'success_criteria_feedback' && !failAt.has(k)) {
        const fb = String(r.content || '').split(/\n\nFeedback:/i)[1];
        failAt.set(k, { at: r.created_at || 0, feedback: (fb || '').trim() });
      }
    }
    const uniq = [...new Set(criteria)];
    return uniq.map(c => {
      const k = _norm(c);
      const m = metAt.has(k) ? metAt.get(k) : -1;
      const f = failAt.has(k) ? failAt.get(k) : null;
      if (f && f.at > m) return { text: c, state: 'failed', feedback: f.feedback };
      if (m >= 0)        return { text: c, state: 'met' };
      return { text: c, state: 'open' };
    });
  }

  async function render(projectId) {
    const root = document.getElementById('view-root');
    const project = Store.getProject(projectId);
    if (!project) {
      root.innerHTML = `<button class="detail-back" onclick="App.navigate('')">← All projects</button>
        <p style="color:var(--text-2);margin-top:16px;">Project not found.</p>`;
      return;
    }

    root.innerHTML = `
      <button class="detail-back" onclick="App.navigate('project/${projectId}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        ${Models.escapeHtml(project.title)}
      </button>
      <h2 class="detail-title" style="margin:8px 0 4px;">🔍 Review</h2>
      <p style="color:var(--text-2);font-size:0.85rem;margin:0 0 16px;">Verify completion, approve or send work back.</p>

      <div class="section-card">
        <div class="section-header"><span class="section-title">✅ Success criteria</span><span id="review-crit-count" class="tracker-badge" style="background:var(--c-done);"></span></div>
        <div id="review-criteria"><p style="color:var(--text-2);font-size:0.85rem;">Loading…</p></div>
      </div>

      <div class="section-card tracker" id="review-tracker"><p style="color:var(--text-2);font-size:0.85rem;">Loading agent progress…</p></div>

      <div class="section-card">
        <div class="section-header"><span class="section-title">📥 Awaiting your approval</span></div>
        <div id="review-approvals"><p style="color:var(--text-2);font-size:0.85rem;">Loading…</p></div>
      </div>

      <div class="section-card">
        <div class="section-header"><span class="section-title">🕘 Run history</span></div>
        <div id="review-history"><p style="color:var(--text-2);font-size:0.85rem;">Loading…</p></div>
      </div>`;

    _loadCriteria(projectId);
    _loadTracker(projectId);
    _loadApprovals(projectId);
    _loadHistory(projectId);
  }

  async function _loadCriteria(projectId) {
    const el = document.getElementById('review-criteria');
    const countEl = document.getElementById('review-crit-count');
    if (!el) return;
    const { ok, entries } = await Sync.pullContext(projectId, 80);
    if (!ok) { el.innerHTML = `<p style="color:var(--c-blocked);font-size:0.85rem;">Could not load criteria.</p>`; return; }
    const status = _criteriaStatus(entries || []);
    if (!status.length) {
      el.innerHTML = `<p style="color:var(--text-2);font-size:0.85rem;">No success criteria yet. The agent proposes them in its planning phase.</p>`;
      if (countEl) countEl.textContent = '0';
      return;
    }
    const met = status.filter(s => s.state === 'met').length;
    if (countEl) countEl.textContent = `${met}/${status.length} met`;
    const icon = { met: '✅', failed: '❌', open: '⬜' };
    el.innerHTML = `<ul class="review-crit-list">${status.map(s => `
      <li class="review-crit review-crit-${s.state}">
        <span class="review-crit-icon">${icon[s.state]}</span>
        <span class="review-crit-text">${Models.escapeHtml(s.text)}${s.state === 'failed' && s.feedback ? `<span class="review-crit-fb">↳ ${Models.escapeHtml(s.feedback)}</span>` : ''}</span>
      </li>`).join('')}</ul>`;
  }

  async function _loadTracker(projectId) {
    const el = document.getElementById('review-tracker');
    if (!el) return;
    const { ok, run } = await Sync.pullLatestRun(projectId);
    if (!ok || !run) {
      el.innerHTML = `<div class="section-header"><span class="section-title">🤖 Agent progress</span></div><p style="color:var(--text-2);font-size:0.85rem;">No recent agent run.</p>`;
      return;
    }
    el.innerHTML = Views.ProjectDetail.trackerHtml(run);
  }

  function _proposalSummary(a) {
    const p = a.payload || {};
    switch (a.action_type) {
      case 'set_status':   return `Set status → ${p.status}`;
      case 'set_priority': return `Set priority → ${p.priority}`;
      case 'add_link':     return `Add link: ${p.label || p.url || ''}`;
      case 'set_spec':     return `Set project spec (${Array.isArray(p.successCriteria) ? p.successCriteria.length : 0} criteria)`;
      case 'update_description': return 'Update description & summary';
      case 'mark_task_done':     return `Mark task done: "${(p.task_text || '').slice(0, 50)}"`;
      case 'authorize_mode':     return `Authorize ${p.mode} phase`;
      default:                   return a.action_type;
    }
  }

  async function _loadApprovals(projectId) {
    const el = document.getElementById('review-approvals');
    if (!el) return;
    await Sync.pullApprovals().catch(() => {});
    Views.Approvals.updateBadge();
    const list = Store.getApprovals().filter(a => a.project_id === projectId);
    if (!list.length) {
      el.innerHTML = `<p style="color:var(--text-2);font-size:0.85rem;">Nothing waiting. ✓</p>`;
      return;
    }
    el.innerHTML = list.map(a => {
      if (a.action_type === 'review_criteria') return Views.Approvals._renderCriteriaReview(a);
      if (a.action_type === 'add_tasks')       return Views.Approvals._renderTaskReview(a);
      return `
        <div class="section-card" style="margin-top:10px;background:var(--surface-2);">
          <div class="section-header"><span class="section-title">${Models.escapeHtml(_proposalSummary(a))}</span></div>
          ${a.rationale ? `<p class="advisor-next">${Models.escapeHtml(a.rationale)}</p>` : ''}
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn btn-sm btn-success" onclick="Views.Approvals.approve('${a.id}')">✓ Approve</button>
            <button class="btn btn-sm btn-danger" onclick="Views.Approvals.reject('${a.id}')">✕ Reject</button>
          </div>
        </div>`;
    }).join('');
  }

  async function _loadHistory(projectId) {
    const el = document.getElementById('review-history');
    if (!el) return;
    const { ok, runs } = await Sync.pullRuns(projectId, 10);
    if (!ok) { el.innerHTML = `<p style="color:var(--c-blocked);font-size:0.85rem;">Could not load history.</p>`; return; }
    if (!runs.length) { el.innerHTML = `<p style="color:var(--text-2);font-size:0.85rem;">No runs yet.</p>`; return; }
    const labels = (Views.ProjectDetail.MODE_LABELS) || {};
    const statusChip = {
      running: ['● Running', 'var(--accent)'], done: ['✓ Complete', 'var(--c-active)'],
      failed: ['⚠ Failed', 'var(--c-blocked)'], awaiting_review: ['⏸ Awaiting review', 'var(--c-idle)'],
      needs_revision: ['↻ Needs revision', 'var(--c-blocked)']
    };
    el.innerHTML = runs.map(r => {
      const [txt, col] = statusChip[r.status] || [r.status, 'var(--c-done)'];
      const mode = r.mode ? (labels[r.mode] || r.mode) : '';
      const when = r.ended_at ? Models.formatDateTime(r.ended_at) : Models.formatDateTime(r.started_at);
      const sum = (r.summary || '').split('\n')[0].slice(0, 120);
      return `
        <div class="history-item">
          <div class="history-content">
            <div class="history-status"><span style="color:${col};font-weight:700;">${txt}</span>${mode ? ` · ${Models.escapeHtml(mode)}` : ''}</div>
            <div class="history-date">${when}${r.percent != null ? ` · ${r.percent}%` : ''}</div>
            ${sum ? `<div class="worklog-detail" style="font-size:0.8rem;">${Models.escapeHtml(sum)}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  return { render };
})();
