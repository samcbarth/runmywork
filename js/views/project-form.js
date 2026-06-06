Views.ProjectForm = (() => {
  function open(existingId) {
    const project = existingId ? Store.getProject(existingId) : null;
    const isEdit = !!project;

    const html = `
      <div class="form-group">
        <label class="form-label" for="pf-title">Project name <span style="color:var(--c-blocked)">*</span></label>
        <input class="form-input" id="pf-title" type="text" placeholder="What are you working on?"
          value="${Models.escapeHtml(project ? project.title : '')}" maxlength="120" autocomplete="off">
      </div>

      <div class="form-group">
        <label class="form-label" for="pf-summary">Short summary <span class="optional">(1-2 sentences, shown on cards)</span></label>
        <input class="form-input" id="pf-summary" type="text" maxlength="200"
          placeholder="e.g. Automates weekly reports so the team spends less time on admin"
          value="${Models.escapeHtml(project ? (project.summary || '') : '')}">
      </div>

      <div class="form-group">
        <label class="form-label" for="pf-desc">Full description <span class="optional">(optional)</span></label>
        <textarea class="form-textarea" id="pf-desc" placeholder="Background, context, and details…">${Models.escapeHtml(project ? project.description : '')}</textarea>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="pf-status">Status</label>
          <select class="form-select" id="pf-status">
            <option value="active"  ${(!project || project.status === 'active')  ? 'selected' : ''}>Active</option>
            <option value="blocked" ${project && project.status === 'blocked' ? 'selected' : ''}>Blocked</option>
            <option value="idle"    ${project && project.status === 'idle'    ? 'selected' : ''}>Idle</option>
            <option value="done"    ${project && project.status === 'done'    ? 'selected' : ''}>Done</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="pf-priority">Priority</label>
          <select class="form-select" id="pf-priority">
            <option value="high"   ${project && project.priority === 'high'   ? 'selected' : ''}>High</option>
            <option value="medium" ${(!project || project.priority === 'medium') ? 'selected' : ''}>Medium</option>
            <option value="low"    ${project && project.priority === 'low'    ? 'selected' : ''}>Low</option>
          </select>
        </div>
      </div>

      <div class="form-group blocked-reason-group" id="pf-blocked-group">
        <label class="form-label" for="pf-blocked-reason">Blocked by <span class="optional">(optional)</span></label>
        <input class="form-input" id="pf-blocked-reason" type="text"
          placeholder="What's blocking this?"
          value="${Models.escapeHtml(project ? project.blockedReason : '')}">
      </div>

      <div class="form-group">
        <label class="form-label" for="pf-tags">Tags <span class="optional">(comma-separated)</span></label>
        <input class="form-input" id="pf-tags" type="text"
          placeholder="e.g. backend, v2, personal"
          value="${project && project.tags ? project.tags.join(', ') : ''}">
      </div>

      <div class="form-group">
        <label class="form-label" for="pf-note">Note <span class="optional">(reason for this status)</span></label>
        <input class="form-input" id="pf-note" type="text" placeholder="Optional context...">
      </div>

      <div class="modal-footer" style="padding: 0; border: none; margin-top: 8px;">
        ${isEdit ? `<button class="btn btn-danger btn-ghost" onclick="Views.ProjectForm.confirmDelete('${project.id}')">Delete</button>` : ''}
        <div style="flex:1"></div>
        <button class="btn" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary" id="pf-save">
          ${isEdit ? 'Save changes' : 'Add project'}
        </button>
      </div>
    `;

    App.openModal(html, isEdit ? 'Edit project' : 'New project');

    // Show/hide blocked reason
    const statusSel = document.getElementById('pf-status');
    const blockedGroup = document.getElementById('pf-blocked-group');
    function toggleBlocked() {
      blockedGroup.classList.toggle('visible', statusSel.value === 'blocked');
    }
    toggleBlocked();
    statusSel.addEventListener('change', toggleBlocked);

    document.getElementById('pf-save').addEventListener('click', () => _save(project));

    // Submit on Enter in title field
    document.getElementById('pf-title').addEventListener('keydown', e => {
      if (e.key === 'Enter') _save(project);
    });
  }

  function _save(existing) {
    const title = document.getElementById('pf-title').value.trim();
    if (!title) {
      document.getElementById('pf-title').focus();
      document.getElementById('pf-title').style.borderColor = 'var(--c-blocked)';
      return;
    }

    const status   = document.getElementById('pf-status').value;
    const priority = document.getElementById('pf-priority').value;
    const summary  = document.getElementById('pf-summary').value.trim();
    const desc     = document.getElementById('pf-desc').value.trim();
    const tagStr   = document.getElementById('pf-tags').value;
    const note     = document.getElementById('pf-note').value.trim();
    const blocked  = document.getElementById('pf-blocked-reason').value.trim();

    const tags = tagStr.split(',').map(t => t.trim()).filter(Boolean);

    if (existing) {
      const prevStatus = existing.status;
      existing.title       = title;
      existing.summary     = summary;
      existing.description = desc;
      existing.priority    = priority;
      existing.tags        = tags;
      existing.blockedReason = status === 'blocked' ? blocked : '';

      if (status !== prevStatus) {
        Models.appendStatus(existing, status, note);
        if (status === 'blocked') existing.blockedReason = blocked;
      }

      Store.saveProject(existing);
      if (status === 'blocked' && status !== prevStatus) {
        Notifications.ping(title, blocked ? `Blocked — ${blocked}` : 'Marked as blocked', 'high');
      }
    } else {
      const project = Models.createProject({ title, summary, description: desc, status, priority, tags, note, blockedReason: blocked });
      Store.saveProject(project);
      if (status === 'blocked') {
        Notifications.ping(title, blocked ? `Blocked — ${blocked}` : 'Marked as blocked', 'high');
      }
    }

    App.closeModal();
    _refresh();
  }

  function markBlocked(id) {
    const project = Store.getProject(id);
    if (!project) return;

    const html = `
      <p style="margin-bottom:16px;color:var(--text-2)">What's blocking <strong>${Models.escapeHtml(project.title)}</strong>?</p>
      <div class="form-group">
        <label class="form-label" for="block-reason">Blocked by <span class="optional">(optional)</span></label>
        <input class="form-input" id="block-reason" type="text" placeholder="Person, dependency, system...">
      </div>
      <div class="form-group">
        <label class="form-label" for="block-note">Note <span class="optional">(optional)</span></label>
        <input class="form-input" id="block-note" type="text" placeholder="More context...">
      </div>
      <div class="modal-footer" style="padding:0;border:none;margin-top:8px;">
        <button class="btn" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-danger" id="block-save">Mark as blocked</button>
      </div>
    `;

    App.openModal(html, 'Mark as blocked');

    document.getElementById('block-save').addEventListener('click', () => {
      const reason = document.getElementById('block-reason').value.trim();
      const note   = document.getElementById('block-note').value.trim();
      Models.appendStatus(project, 'blocked', note);
      project.blockedReason = reason;
      project.snoozedUntil = null;
      Store.saveProject(project);
      Notifications.ping(project.title, reason ? `Blocked — ${reason}` : 'Marked as blocked', 'high');
      App.closeModal();
      _refresh();
    });

    document.getElementById('block-reason').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('block-save').click();
    });
  }

  function confirmDelete(id) {
    const project = Store.getProject(id);
    if (!project) return;
    if (confirm(`Delete "${project.title}"? This cannot be undone.`)) {
      Store.deleteProject(id);
      App.closeModal();
      App.navigate('');
    }
  }

  function _refresh() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (hash === '' || hash === 'dashboard') {
      Views.Dashboard.render();
    } else if (hash.startsWith('project/')) {
      const id = hash.slice('project/'.length);
      Views.ProjectDetail.render(id);
    }
  }

  return { open, markBlocked, confirmDelete };
})();
