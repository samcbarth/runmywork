const App = (() => {
  // Bumped on each deploy so you can confirm which build is live (shown in Settings).
  const BUILD = '2026-06-07 · deploy-aware 7-stage tracker';

  let _timerInterval = null;
  let _swRegistration = null;

  /* ── Routing ── */

  function navigate(path) {
    location.hash = path;
  }

  // Re-render whatever view is currently routed (used after an async state change
  // like approving a proposal, so the right view refreshes without knowing which).
  function refresh() {
    _handleRoute();
  }

  function _handleRoute() {
    const hash = location.hash.replace(/^#\/?/, '') || '';
    App.closeModal();

    if (hash === '' || hash === 'dashboard') {
      Views.Dashboard.render();
    } else if (hash === 'approvals') {
      Views.Approvals.render();
    } else if (hash === 'settings') {
      Views.Settings.render();
    } else if (hash.startsWith('project/')) {
      const id = hash.slice('project/'.length);
      Views.ProjectDetail.render(id);
    } else {
      Views.Dashboard.render();
    }
  }

  /* ── Modal ── */

  function openModal(html, title) {
    const overlay = document.getElementById('modal-overlay');
    const container = document.getElementById('modal-container');
    container.innerHTML = `
      <div class="modal-header">
        <span class="modal-title">${Models.escapeHtml(title || '')}</span>
        <button class="modal-close" onclick="App.closeModal()" aria-label="Close">✕</button>
      </div>
      <div class="modal-body" id="modal-body">${html}</div>
    `;
    overlay.classList.remove('hidden');
    container.classList.remove('hidden');
    const firstInput = container.querySelector('input, textarea, select');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
  }

  function openModalFull(html) {
    const overlay = document.getElementById('modal-overlay');
    const container = document.getElementById('modal-container');
    container.innerHTML = html;
    overlay.classList.remove('hidden');
    container.classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal-container').classList.add('hidden');
    if (_timerInterval && !Store.getActiveSession()) {
      clearInterval(_timerInterval);
      _timerInterval = null;
    }
  }

  /* ── Timer management ── */

  function startGlobalTimer(session) {
    clearInterval(_timerInterval);
    _timerInterval = setInterval(() => {
      const elapsed = Date.now() - session.startedAt;
      const mins = Math.floor(elapsed / 60000);
      const secs = Math.floor((elapsed % 60000) / 1000);

      // Update any live timer displays in the dashboard or session modal
      document.querySelectorAll('[data-timer-live]').forEach(el => {
        el.textContent = `⏱ ${_formatElapsed(elapsed)} (running)`;
      });
      const dialEl = document.getElementById('session-timer-display');
      if (dialEl) {
        const hh = Math.floor(elapsed / 3600000);
        const mm = Math.floor((elapsed % 3600000) / 60000);
        const ss = Math.floor((elapsed % 60000) / 1000);
        dialEl.textContent = [
          String(hh).padStart(2, '0'),
          String(mm).padStart(2, '0'),
          String(ss).padStart(2, '0')
        ].join(':');
      }
    }, 1000);
  }

  function stopGlobalTimer() {
    clearInterval(_timerInterval);
    _timerInterval = null;
  }

  function _formatElapsed(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /* ── Service Worker ── */

  async function _registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      _swRegistration = reg;
      await Notifications.tryRegisterPeriodicSync(reg);

      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data?.type === 'OPEN_PROJECT') {
          navigate(`project/${e.data.projectId}`);
        }
      });
    } catch (err) {
      console.warn('SW registration failed:', err);
    }
  }

  /* ── Sync indicator ── */

  function showSyncStatus(state) {
    let el = document.getElementById('sync-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sync-status';
      el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:6px 14px;font-size:0.78rem;color:var(--text-2);z-index:500;box-shadow:0 2px 8px rgba(0,0,0,0.15);transition:opacity 0.3s;pointer-events:none;';
      document.body.appendChild(el);
    }
    const msgs = { syncing: '⟳ Syncing…', ok: '✓ Synced', error: '⚠ Sync failed', pulling: '⟳ Loading…' };
    el.textContent = msgs[state] || state;
    el.style.opacity = '1';
    if (state === 'ok') setTimeout(() => { el.style.opacity = '0'; }, 2000);
  }

  async function syncPush() {
    if (!Sync.isConfigured()) return;
    showSyncStatus('syncing');
    const result = await Sync.push();
    showSyncStatus(result.ok ? 'ok' : 'error');
  }

  // Push only the project that changed — avoids the cross-project clobber of a
  // full whole-document push (see Sync.pushProject). Falls back to silence when
  // sync isn't configured (offline-only mode).
  async function syncPushProject(id) {
    if (!Sync.isConfigured()) return;
    showSyncStatus('syncing');
    const result = await Sync.pushProject(id);
    showSyncStatus(result.ok ? 'ok' : 'error');
  }

  /* ── Force-update from the page (Settings → Check for updates) ── */

  async function checkForUpdate() {
    if (!('serviceWorker' in navigator)) {
      // No SW — a plain reload is the best we can do.
      location.reload(true);
      return;
    }
    try {
      // Wipe every cache so the next fetch pulls fresh files from the network.
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        await reg.unregister();   // drop the controlling SW so the reload is clean
      }
    } catch { /* fall through to reload */ }
    // Cache-busting reload.
    location.replace(location.pathname + '?u=' + Date.now() + location.hash);
  }

  // Format ms → "Xm Ys" / "Ys" for the cooldown readout.
  function _fmtCooldown(ms) {
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  // Bottom pill showing what the agent trigger did on this open.
  function showAgentStatus(result) {
    let el = document.getElementById('agent-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'agent-status';
      el.style.cssText = 'position:fixed;bottom:54px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:6px 14px;font-size:0.78rem;color:var(--text-2);z-index:500;box-shadow:0 2px 8px rgba(0,0,0,0.15);transition:opacity 0.3s;pointer-events:none;max-width:90vw;text-align:center;';
      document.body.appendChild(el);
    }
    if (result && result.triggered) {
      el.textContent = '🤖 Agent run triggered';
      el.style.color = 'var(--c-active)';
    } else if (result && result.remainingMs > 0) {
      el.textContent = `🤖 Agent on cooldown — next run in ${_fmtCooldown(result.remainingMs)}`;
      el.style.color = 'var(--text-2)';
    } else {
      el.textContent = '🤖 Agent trigger unavailable';
      el.style.color = 'var(--c-idle)';
    }
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 5000);
  }

  /* ── Cloud-agent header chip (always-visible cooldown timer) ── */

  let _agentTickTimer = null;
  let _agentRunUntil = 0;   // optimistic "running" window after a trigger this session

  function _fmtClock(ms) {
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function _renderAgentChip() {
    const chip = document.getElementById('agent-chip');
    const txt  = document.getElementById('agent-chip-text');
    if (!chip || !txt) return;
    const remaining = Sync.triggerCooldownRemaining();
    const running = Date.now() < _agentRunUntil;
    chip.classList.toggle('running', running);
    chip.classList.toggle('cooling', remaining > 0 && !running);
    if (running)            txt.textContent = '🤖 Running…';
    else if (remaining > 0) txt.textContent = `🤖 ${_fmtClock(remaining)}`;
    else                    txt.textContent = '🤖 Ready';
  }

  function _startAgentChipTicker() {
    _renderAgentChip();
    if (_agentTickTimer) clearInterval(_agentTickTimer);
    _agentTickTimer = setInterval(_renderAgentChip, 1000);
  }

  // Tapping the chip forces a run, bypassing the cooldown.
  async function runAgentNow() {
    const chip = document.getElementById('agent-chip');
    if (chip) chip.classList.add('running');
    // If we're on a project page, target THAT project so the run actually works it.
    const m = location.hash.match(/project\/([^/?]+)/);
    const projectId = m ? m[1] : null;
    const res = await Sync.triggerAgent({ force: true, projectId });
    if (res.triggered) _agentRunUntil = Date.now() + 120000;
    showAgentStatus(res);
    _renderAgentChip();
  }

  function getBuild() { return BUILD; }

  /* ── Init ── */

  async function init() {
    window.addEventListener('hashchange', _handleRoute);

    const activeSession = Store.getActiveSession();
    if (activeSession) startGlobalTimer(activeSession);

    _registerSW();
    setTimeout(() => Notifications.checkOnOpen(), 1500);

    // Always pull from Supabase — zero-setup, every device stays in sync.
    showSyncStatus('pulling');
    const result = await Sync.pull();
    showSyncStatus(result.ok ? 'ok' : 'error');
    if (result.ok) Store.refreshNotifyCache();   // seed SW cache from synced data
    Views.Approvals.updateBadge();
    Views.Approvals.autoApplyPending();          // silently apply any auto-approve policies
    Views.Approvals.notifyCriterionReview();     // notify if criterion proposals are pending

    // Kick off a GitHub Actions run (20-min cooldown) and keep the header chip ticking.
    Sync.triggerAgent().then(res => {
      if (res.triggered) _agentRunUntil = Date.now() + 120000;
      showAgentStatus(res);
      _renderAgentChip();
    });
    _startAgentChipTicker();

    _handleRoute();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { navigate, refresh, openModal, openModalFull, closeModal, startGlobalTimer, stopGlobalTimer, syncPush, syncPushProject, checkForUpdate, getBuild, showAgentStatus, runAgentNow };
})();
