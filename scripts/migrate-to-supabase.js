#!/usr/bin/env node
'use strict';

/*
 * RunMyWork — one-time migration from data.json to Supabase
 * --------------------------------------------------------
 * Reads the legacy data.json (the old GitHub-synced datastore) and upserts its
 * projects + settings into Supabase. Run once on the box after creating the
 * tables (see the SQL in the Phase 0 plan / scripts/ADVISOR.md).
 *
 * Requires Node 18+ (global fetch).
 *
 * Usage:
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/migrate-to-supabase.js [path/to/data.json]
 *
 * After verifying the rows in the Supabase table editor, delete data.json.
 */

const fs = require('fs');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const FILE         = process.argv[2] || 'data.json';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Aborting.');
  process.exit(1);
}

const REST = `${SUPABASE_URL}/rest/v1`;
function sbHeaders(extra) {
  return {
    apikey:         SERVICE_KEY,
    Authorization:  `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

// Mirrors Sync.projectToRow in js/store.js.
function projectToRow(p) {
  return {
    id: p.id, title: p.title, description: p.description,
    status: p.status, priority: p.priority, tags: p.tags || [],
    created_at: p.createdAt, updated_at: p.updatedAt,
    status_history: p.statusHistory || [],
    sessions: p.sessions || [], total_minutes: p.totalMinutes || 0,
    blocked_reason: p.blockedReason || '', snoozed_until: p.snoozedUntil ?? null,
    links: p.links || [], tasks: p.tasks || [],
    ai_suggestion: p.aiSuggestion ?? null, ai_requested: !!p.aiRequested
  };
}

async function upsert(path, body) {
  const res = await fetch(`${REST}/${path}?on_conflict=id`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`upsert ${path} failed: ${res.status} ${err.slice(0, 200)}`);
  }
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const projects = (raw.projects || []).map(projectToRow);

  if (projects.length) {
    await upsert('projects', projects);
    console.log(`Migrated ${projects.length} project(s).`);
  } else {
    console.log('No projects to migrate.');
  }

  await upsert('settings', [{
    id: 1,
    ntfy_topic: raw.settings?.ntfyTopic || 'rmw-sam-9k2x7p',
    thresholds: raw.settings?.thresholds || {}
  }]);
  console.log('Migrated settings.');
  console.log('Done. Verify rows in Supabase, then delete data.json.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
