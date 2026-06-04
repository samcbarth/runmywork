#!/usr/bin/env node
'use strict';

/*
 * RunMyWork — home-box notification check
 * ---------------------------------------
 * Replaces the old hourly GitHub Action. Reads projects + settings from
 * Supabase and pushes an ntfy alert for anything that's been blocked or idle
 * past its threshold. Schedule it hourly on the always-on box (cron / Task
 * Scheduler).
 *
 * Requires Node 18+ (global fetch).
 *
 * Config (environment variables):
 *   SUPABASE_URL               (required) e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  (required) service_role key — stays on this box
 *   NTFY_TOPIC                 default "rmw-sam-9k2x7p"
 */

const https = require('https');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ntfyTopic    = process.env.NTFY_TOPIC || 'rmw-sam-9k2x7p';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Aborting.');
  process.exit(1);
}

const REST = `${SUPABASE_URL}/rest/v1`;
function sbHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
}

// Mirrors Sync.rowToProject — only the fields the alert logic needs.
function rowToProject(r) {
  return {
    title: r.title, status: r.status,
    statusHistory: r.status_history || [],
    snoozedUntil: r.snoozed_until ?? null,
    blockedReason: r.blocked_reason || ''
  };
}

function currentEntry(p) {
  return p.statusHistory && p.statusHistory.length
    ? p.statusHistory[p.statusHistory.length - 1]
    : null;
}

function notify(title, body, priority) {
  return new Promise((resolve) => {
    const data = Buffer.from(body, 'utf8');
    const req = https.request({
      hostname: 'ntfy.sh',
      port: 443,
      path: '/' + encodeURIComponent(ntfyTopic),
      method: 'POST',
      headers: {
        'Content-Type':   'text/plain',
        'Content-Length': data.length,
        'Title':          title,
        'Priority':       priority || 'default',
        'Tags':           priority === 'high' ? 'rotating_light' : 'calendar'
      }
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', e => { console.warn('ntfy error:', e.message); resolve(); });
    req.write(data);
    req.end();
  });
}

async function main() {
  const [pRes, sRes] = await Promise.all([
    fetch(`${REST}/projects?select=*`, { headers: sbHeaders() }),
    fetch(`${REST}/settings?id=eq.1&select=*`, { headers: sbHeaders() })
  ]);
  if (!pRes.ok) { console.error(`Supabase GET failed: ${pRes.status}`); process.exit(1); }

  const projects   = (await pRes.json()).map(rowToProject);
  const settings   = sRes.ok ? (await sRes.json())[0] || {} : {};
  const thresholds = settings.thresholds || {};
  const blockedMs  = (thresholds.blockedDaysWarning || 1) * 86400000;
  const idleMs     = (thresholds.idleDaysWarning    || 1) * 86400000;
  const now        = Date.now();

  const alerts = [];
  for (const p of projects) {
    if (p.status === 'done' || p.status === 'archived') continue;
    if (p.snoozedUntil && p.snoozedUntil > now) continue;

    const entry = currentEntry(p);
    if (!entry) continue;
    const timeIn = now - entry.enteredAt;
    const days   = Math.floor(timeIn / 86400000);

    if (p.status === 'blocked' && timeIn >= blockedMs) {
      alerts.push({
        title:    p.title,
        body:     `Blocked for ${days} day${days !== 1 ? 's' : ''}${p.blockedReason ? ' — ' + p.blockedReason : ''}`,
        priority: 'high'
      });
    } else if (p.status === 'idle' && timeIn >= idleMs) {
      alerts.push({
        title:    p.title,
        body:     `Idle for ${days} day${days !== 1 ? 's' : ''} — no recent activity`,
        priority: 'default'
      });
    }
  }

  if (alerts.length === 0) {
    console.log('No projects need attention today.');
    return;
  }

  console.log(`Sending ${alerts.length} notification(s)...`);
  for (const a of alerts) {
    console.log(` → [${a.priority}] ${a.title}: ${a.body}`);
    await notify(a.title, a.body, a.priority);
  }
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
