'use strict';

/*
 * Push notifier for the agent runtime.
 * ------------------------------------
 * Best-effort fire-and-forget: POSTs an event to the `send-push` edge function,
 * which signs it with VAPID and fans it out to every stored push subscription —
 * so the user's installed PWA buzzes even when the app is closed. Never throws
 * and never blocks the loop; if push isn't set up yet it just no-ops.
 *
 * The anon key is public-by-design (same one committed in js/store.js); the edge
 * function does the privileged work with the service role key on its side.
 */

const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRtcWZmcHJmaGF2emJheWN2eGVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NDE1MTQsImV4cCI6MjA5NjExNzUxNH0.rtcPzaPwo2qMYJdm_sdpOvjEuEuK0O0I6r-pPrqCma4';

async function sendPush({ title, body, projectId, tag }) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base) return;
  const url = `${base}/functions/v1/send-push`;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: String(title || 'RunMyWork').slice(0, 120),
        body: String(body || '').slice(0, 240),
        projectId: projectId || null,
        tag: tag || 'rmw'
      }),
      signal: ctrl.signal
    });
  } catch { /* push is best-effort — never block or fail the run */ }
  finally { clearTimeout(id); }
}

module.exports = { sendPush };
