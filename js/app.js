const App = (() => {
  let _timerInterval = null;
  let _swRegistration = null;

  /* ── Routing ── */

  function navigate(path) {
    location.hash = path;
  }

  function _handleRoute() {
    const hash = location.hash.replace(/^#\/?/, '') || '';
    App.closeModal();

    if (hash === '' || hash === 'dashboard') {
      Views.Dashboard.render();
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

  /* ── Init ── */

  function init() {
    window.addEventListener('hashchange', _handleRoute);

    // Restore running timer if app was closed during a session
    const activeSession = Store.getActiveSession();
    if (activeSession) {
      startGlobalTimer(activeSession);
    }

    _registerSW();

    // Run notifications check after a brief delay (let page render first)
    setTimeout(() => Notifications.checkOnOpen(), 1500);

    _handleRoute();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { navigate, openModal, openModalFull, closeModal, startGlobalTimer, stopGlobalTimer };
})();
