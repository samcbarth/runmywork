#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const https = require('https');

const ntfyTopic = process.env.NTFY_TOPIC || 'rmw-sam-9k2x7p';

let raw;
try { raw = JSON.parse(fs.readFileSync('data.json', 'utf8')); }
catch { console.log('data.json not found or invalid — nothing to check.'); process.exit(0); }

const projects  = raw.projects  || [];
const settings  = raw.settings  || {};
const thresholds = settings.thresholds || {};
const blockedMs  = (thresholds.blockedDaysWarning || 1) * 86400000;
const idleMs     = (thresholds.idleDaysWarning    || 1) * 86400000;
const now        = Date.now();

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
