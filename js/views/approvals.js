Views.Approvals = (() => {

  /* Capitalised label for an action-mode id (e.g. "implementation" → "Implementation"). */
  function _modeLabel(m) {
    const s = String(m || '').replace(/_/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'write';
  }

  /* Human-readable one-liner for a proposal's payload. */
  function _summary(a) {
    const p = a.payload || {};
    switch (a.action_type) {
      case 'add_tasks':    return `Add ${Array.isArray(p.tasks) ? p.tasks.length : 0} task(s)`;
      case 'set_status':   return `Set status → ${p.status}`;
      case 'set_priority': return `Set priority → ${p.priority}`;
      case 'add_link':     return `Add link: ${p.label || p.url || ''}`;
      case 'set_spec':            return `Set project spec (${Array.isArray(p.successCriteria) ? p.successCriteria.length : 0} success criteria)`;
      case 'update_description':  return 'Update project description & summary';
      case 'mark_criterion_done': return `Criterion done: "${(p.criterion || '').slice(0, 60)}"`;
      case 'review_criteria':     return `Review ${Array.isArray(p.criteria) ? p.criteria.length : 0} success criteria`;
      case 'mark_task_done':      return `Mark task done: "${(p.task_text || '').slice(0, 60)}"`;
      case 'authorize_mode':      return `Authorize ${_modeLabel(p.mode)} phase (agent will modify files)`;
      default:                    return a.action_type;
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
    if (a.action_type === 'update_description') {
      return [
        p.summary ? `<p class="approval-detail-note"><strong>Summary:</strong> ${Models.escapeHtml(p.summary)}</p>` : '',
        p.description ? `<div class="approval-detail-note"><strong>Description:</strong><div class="worklog-detail" style="margin-top:4px;">${Models.escapeHtml(p.description)}</div></div>` : ''
      ].filter(Boolean).join('');
    }
    if (a.action_type === 'mark_criterion_done') {
      return [
        p.criterion ? `<p class="approval-detail-note"><strong>Criterion:</strong> ${Models.escapeHtml(p.criterion)}</p>` : '',
        p.evidence  ? `<div class="approval-detail-note"><strong>Evidence:</strong><div class="worklog-detail" style="margin-top:4px;">${Models.escapeHtml(p.evidence)}</div></div>` : ''
      ].filter(Boolean).join('');
    }
    if (a.action_type === 'mark_task_done') {
      return [
        p.task_text ? `<p class="approval-detail-note"><strong>Task:</strong> ${Models.escapeHtml(p.task_text)}</p>` : '',
        p.note      ? `<div class="approval-detail-note"><strong>What was done:</strong><div class="worklog-detail" style="margin-top:4px;">${Models.escapeHtml(p.note)}</div></div>` : ''
      ].filter(Boolean).join('');
    }
    if (a.action_type === 'authorize_mode') {
      return [
        `<p class="approval-detail-note">Approving lets the agent enter the <strong>${_modeLabel(p.mode)}</strong> phase and modify project files. One approval covers the whole write phase (implementation → validation → revision → deployment) until the next plan.</p>`,
        p.plan ? `<div class="approval-detail-note"><strong>Plan:</strong><div class="worklog-detail" style="margin-top:4px;">${Models.escapeHtml(p.plan)}</div></div>` : ''
      ].filter(Boolean).join('');
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

  /* ── Success-criteria review (per-criterion pass/fail + feedback) ── */

  // verdict state per review card: { [approvalId]: { [criterionIdx]: 'pass'|'fail' } }
  const _verdicts = {};

  function _renderCriteriaReview(a) {
    const p = a.payload || {};
    const criteria = Array.isArray(p.criteria) ? p.criteria : [];
    // Seed verdicts once: default every criterion to "pass" (the human flips the
    // ones that actually failed). Met / advanced ones start as pass too.
    if (!_verdicts[a.id]) {
      _verdicts[a.id] = {};
      criteria.forEach((c, i) => { _verdicts[a.id][i] = 'pass'; });
    }
    const v = _verdicts[a.id];

    const rows = criteria.map((c, i) => {
      const verdict = v[i] || 'pass';
      const badge = c.met
        ? `<span class="creview-badge met">previously met</span>`
        : (c.advancedThisRun ? `<span class="creview-badge adv">worked this run</span>` : '');
      return `
        <div class="creview-row" data-crit-idx="${i}">
          <div class="creview-text">${Models.escapeHtml(c.text || '')} ${badge}</div>
          <div class="creview-toggle">
            <button class="btn btn-sm creview-pass${verdict === 'pass' ? ' active' : ''}"
              onclick="Views.Approvals._setVerdict('${a.id}',${i},'pass')">✓ Pass</button>
            <button class="btn btn-sm creview-fail${verdict === 'fail' ? ' active' : ''}"
              onclick="Views.Approvals._setVerdict('${a.id}',${i},'fail')">✗ Fail</button>
          </div>
          <textarea class="creview-feedback${verdict === 'fail' ? '' : ' hidden'}" data-crit-fb="${i}"
            placeholder="What's wrong / what the agent should fix"></textarea>
        </div>`;
    }).join('');

    const report = p.deployReport
      ? `<details class="creview-report"><summary>Deploy report</summary><div class="worklog-detail">${Models.escapeHtml(p.deployReport)}</div></details>`
      : '';
    const visual = p.visualSummary
      ? `<p class="approval-detail-note"><strong>What changed:</strong> ${Models.escapeHtml(p.visualSummary)}</p>`
      : '';

    return `
      <div class="section-card creview-card" data-review-id="${a.id}" style="margin-top:10px;">
        <div class="section-header">
          <span class="section-title">${Models.escapeHtml(_summary(a))}</span>
        </div>
        ${a.rationale ? `<p class="advisor-next">${Models.escapeHtml(a.rationale)}</p>` : ''}
        ${visual}
        <div class="creview-list">${rows}</div>
        ${report}
        <div style="margin-top:12px;">
          <button class="btn btn-success" onclick="Views.Approvals.submitCriteriaReview('${a.id}')">Submit review</button>
        </div>
      </div>`;
  }

  // Flip a criterion's pass/fail and show/hide its feedback box (no full re-render).
  function _setVerdict(approvalId, idx, verdict) {
    _verdicts[approvalId] = _verdicts[approvalId] || {};
    _verdicts[approvalId][idx] = verdict;
    const card = document.querySelector(`.creview-card[data-review-id="${approvalId}"]`);
    if (!card) return;
    const r = card.querySelector(`.creview-row[data-crit-idx="${idx}"]`);
    if (!r) return;
    const pass = r.querySelector('.creview-pass');
    const fail = r.querySelector('.creview-fail');
    const fb   = r.querySelector('.creview-feedback');
    if (pass) pass.classList.toggle('active', verdict === 'pass');
    if (fail) fail.classList.toggle('active', verdict === 'fail');
    if (fb)   fb.classList.toggle('hidden', verdict !== 'fail');
  }

  // Submit the review: tick passes, feed failures back, complete or flag the run,
  // and (on any failure) auto-authorize + fire a revision run for the failures.
  async function submitCriteriaReview(id) {
    const a = Store.getApprovals().find(x => x.id === id);
    if (!a) return;
    const p = a.payload || {};
    const criteria = Array.isArray(p.criteria) ? p.criteria : [];
    const v = _verdicts[id] || {};

    // Collect per-criterion feedback from the textareas in this card.
    const fbByIdx = {};
    const card = document.querySelector(`.creview-card[data-review-id="${id}"]`);
    if (card) card.querySelectorAll('.creview-feedback').forEach(t => {
      fbByIdx[t.getAttribute('data-crit-fb')] = (t.value || '').trim();
    });

    const failed = [];
    let passCount = 0;
    for (let i = 0; i < criteria.length; i++) {
      const c = criteria[i];
      const verdict = v[i] || 'pass';
      if (verdict === 'pass') {
        passCount++;
        if (!c.met) {
          await Sync.addContext({
            project_id: a.project_id, kind: 'success_criteria_met',
            content: c.text + (c.evidence ? `\n\nEvidence: ${c.evidence}` : ''),
            created_by: 'user'
          });
        }
      } else {
        const fb = fbByIdx[String(i)] || '';
        failed.push({ text: c.text, feedback: fb });
        await Sync.addContext({
          project_id: a.project_id, kind: 'success_criteria_feedback',
          content: c.text + `\n\nFeedback: ${fb || '(no detail given)'}`,
          created_by: 'user'
        });
      }
    }

    Sync.addWorklog({
      project_id: a.project_id, kind: 'action', created_by: 'user',
      summary: `Criteria review: ${passCount} passed, ${failed.length} failed`,
      detail: { passed: passCount, failed }
    });

    await Sync.decideApproval(id, 'applied');

    // Update the run state the tracker shows.
    if (p.runId) {
      if (failed.length === 0) {
        await Sync.updateRun(p.runId, { status: 'done', stage: 'complete', percent: 100, ended_at: Date.now() });
      } else {
        await Sync.updateRun(p.runId, { status: 'needs_revision', ended_at: Date.now() });
      }
    }

    // Auto-revision: authorize the revision write phase and fire a run that will
    // work ONLY the failed criteria (it reads the feedback rows from context).
    if (failed.length > 0) {
      await Sync.addWorklog({
        project_id: a.project_id, kind: 'mode_authorized', created_by: 'user',
        summary: 'Authorized Revision phase (criteria review failures)',
        detail: { mode: 'revision', plan: `Fix the ${failed.length} failed criterion/criteria using the user feedback.` }
      });
      Sync.triggerAgent({ force: true, projectId: a.project_id, actionMode: 'revision' });
      Notifications.notifyAgentRun({
        title: '🔧 Revision started',
        body: `Reworking ${failed.length} failed criterion${failed.length === 1 ? '' : 'a'}.`,
        projectId: a.project_id, tag: `rmw-revise-${a.project_id}`
      });
    }

    delete _verdicts[id];
    updateBadge();
    App.refresh();
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
    await autoApplyPending();
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
      const rows = byProject[pid].map(a => {
        // The criteria review is its own interactive card (pass/fail per criterion
        // + one Submit), not a plain approve/reject proposal.
        if (a.action_type === 'review_criteria') return _renderCriteriaReview(a);
        return `
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
        </div>`;
      }).join('');
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
      case 'update_description':
        if (p.description) project.description = p.description;
        if (p.summary)     project.summary     = p.summary;
        break;
      case 'mark_criterion_done': {
        if (!p.criterion) return false;
        Sync.addContext({
          project_id: a.project_id,
          kind: 'success_criteria_met',
          content: p.criterion + (p.evidence ? `\n\nEvidence: ${p.evidence}` : ''),
          created_by: 'agent-approved'
        });
        Sync.addWorklog({
          project_id: a.project_id, kind: 'action', created_by: 'user',
          summary: `Criterion confirmed: "${p.criterion.slice(0, 80)}"`,
          detail: { criterion: p.criterion, evidence: p.evidence }
        });
        return true;   // context rows written directly; no project mutation
      }
      case 'mark_task_done': {
        if (!p.task_text) return false;
        const tasks = project.tasks || [];
        const needle = p.task_text.toLowerCase().slice(0, 50);
        // Match the open task whose text contains the proposed text (fuzzy — the
        // agent may quote a slightly trimmed version of the task).
        const target = tasks.find(t => !t.done && t.text.toLowerCase().includes(needle))
          || tasks.find(t => t.text.toLowerCase().includes(needle));
        if (!target) return false;   // task not found — don't silently swallow
        target.done = true;
        break;
      }
      case 'authorize_mode': {
        if (!p.mode) return false;
        // The token the agent runtime reads (supabase.modeAuthorization): a worklog
        // row of kind 'mode_authorized'. Valid until the next planning run.
        Sync.addWorklog({
          project_id: a.project_id, kind: 'mode_authorized', created_by: 'user',
          summary: `Authorized ${_modeLabel(p.mode)} phase`,
          detail: { mode: p.mode, plan: p.plan || '' }
        });
        return true;   // worklog written directly; no project mutation
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
      if (a.action_type === 'mark_criterion_done') {
        const criterion = (a.payload || {}).criterion || '';
        Sync.addContext({
          project_id: a.project_id,
          kind: 'note',
          content: `[REJECTED] Criterion not yet sufficiently met: "${criterion.slice(0, 200)}". User rejected the completion claim. Gather stronger evidence or complete more work before proposing again.`,
          created_by: 'user'
        });
      }
    }
    await Sync.decideApproval(id, 'rejected');
    updateBadge();
    App.refresh();
  }

  /* Auto-apply approvals that match the user's policy — called after every pull.
   * Returns the number of proposals silently applied. */
  async function autoApplyPending() {
    const settings = Store.getSettings();
    const policies = settings.autoApprove || {};
    const toApply = Store.getApprovals().filter(a => policies[a.action_type]);
    if (!toApply.length) return 0;
    for (const a of toApply) {
      _apply(a);
      Sync.addWorklog({
        project_id: a.project_id, kind: 'action', created_by: 'auto-policy',
        summary: `Auto-approved: ${_summary(a)}`,
        detail: { action_type: a.action_type, payload: a.payload }
      });
      await Sync.decideApproval(a.id, 'applied');
    }
    updateBadge();
    App.refresh();
    return toApply.length;
  }

  /* Fire a browser notification when a mark_criterion_done proposal is pending. */
  function notifyCriterionReview() {
    const settings = Store.getSettings();
    if (!settings.notificationsEnabled || Notification.permission !== 'granted') return;
    const criterionProposals = Store.getApprovals().filter(a => a.action_type === 'mark_criterion_done');
    if (!criterionProposals.length) return;
    const a = criterionProposals[0];
    const project = Store.getProject(a.project_id);
    new Notification('RunMyWork — Criterion ready for review', {
      body: `${project ? project.title : 'A project'}: "${((a.payload || {}).criterion || '').slice(0, 80)}"`,
      tag: 'rmw-criterion'
    });
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

  return { render, approve, reject, updateBadge, autoApplyPending, notifyCriterionReview,
           submitCriteriaReview, _setVerdict, _renderCriteriaReview };
})();
