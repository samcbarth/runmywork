#!/usr/bin/env node
'use strict';

/*
 * Deploy + live-verification driver.
 * ----------------------------------
 * Runs in the workflow AFTER the agent process has exited and the workflow has
 * pushed the agent's commit (plus a version.json stamped with this run's build
 * id) to main. The agent considers a code change "done" only once it is actually
 * LIVE — committing is not the finish line. This script:
 *
 *   1. reads the deploy handoff the agent wrote (scripts/agent/work/deploy-handoff.json)
 *   2. for each tracker run that committed, advances the stage: pushed → deploying
 *   3. polls the live GitHub Pages URL's version.json until it reports this build
 *   4. on match  → live_verified → complete (status done, 100%, enriched report)
 *      on timeout → stage stays "deploying", status "failed", summary notes the
 *                   change is pushed but not yet verified live.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — to patch agent_runs
 *   DEPLOY_BUILD_ID                          — unique build stamp written to version.json
 *   LIVE_URL                                 — base site URL (default: the project's Pages URL)
 *   DEPLOY_TIMEOUT_MS / DEPLOY_POLL_MS       — optional tuning
 */

const { loadConfig } = require('./config');
const { makeSupabase } = require('./supabase');

const LIVE_URL       = (process.env.LIVE_URL || 'https://samcbarth.github.io/runmywork').replace(/\/+$/, '');
const BUILD_ID       = String(process.env.DEPLOY_BUILD_ID || '').trim();
const TIMEOUT_MS     = parseInt(process.env.DEPLOY_TIMEOUT_MS || '', 10) || 12 * 60 * 1000; // 12 min
const POLL_MS        = parseInt(process.env.DEPLOY_POLL_MS || '', 10) || 15 * 1000;          // 15 s
const VERSION_URL    = `${LIVE_URL}/version.json`;

function log(...a) { console.log('[deploy-verify]', ...a); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function readHandoff() {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, 'work', 'deploy-handoff.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

// Fetch the live version.json (cache-busted) and return its build id, or null.
async function fetchLiveBuild() {
  try {
    const res = await fetch(`${VERSION_URL}?cb=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json && json.build ? String(json.build) : null;
  } catch { return null; }
}

// Build the human-readable final report the user reads in the tracker.
function buildReport({ verified, handoff }) {
  const files = (handoff.changedFiles || []).map(f => f.path || f).filter(Boolean);
  const lines = [];
  lines.push(handoff.summary ? handoff.summary.split('\n')[0] : 'Agent run');
  lines.push('');
  lines.push('— DEPLOY REPORT —');
  lines.push(`Files changed: ${files.length ? files.join(', ') : 'none'}`);
  if (handoff.visualSummary) lines.push(`What changed visually: ${handoff.visualSummary}`);
  lines.push(`Commit/push: pushed to main`);
  lines.push(`Deployment: ${verified ? 'deployed' : 'pushed, deploy not confirmed'}`);
  lines.push(`Live URL checked: ${LIVE_URL}`);
  lines.push(`Visible live: ${verified ? 'YES — confirmed live' : 'NOT YET — live site did not reflect this build in time'}`);
  return lines.join('\n').slice(0, 1000);
}

async function main() {
  const handoff = readHandoff();
  if (!handoff || !handoff.committed || !handoff.runs || !handoff.runs.length) {
    log('No committed runs to verify — nothing to do.');
    return;
  }
  if (!BUILD_ID) {
    log('DEPLOY_BUILD_ID not set — cannot verify live build. Skipping verification.');
    return;
  }

  const config = loadConfig();
  const sb = makeSupabase(config);
  const runs = handoff.runs;

  // Stage: pushed → deploying
  for (const id of runs) {
    await sb.updateRun(id, { stage: 'pushed',    percent: Math.round((4 / 7) * 100) });
  }
  log(`Marked ${runs.length} run(s) pushed. Waiting for live deploy of build ${BUILD_ID} at ${VERSION_URL}`);
  for (const id of runs) {
    await sb.updateRun(id, { stage: 'deploying', percent: Math.round((5 / 7) * 100) });
  }

  // Poll the live site until it reports this build (or we time out).
  const deadline = Date.now() + TIMEOUT_MS;
  let verified = false;
  while (Date.now() < deadline) {
    const liveBuild = await fetchLiveBuild();
    if (liveBuild === BUILD_ID) { verified = true; break; }
    log(`live build = ${liveBuild ?? '(unreachable)'} ≠ ${BUILD_ID} — waiting ${POLL_MS / 1000}s…`);
    await sleep(POLL_MS);
  }

  const report = buildReport({ verified, handoff });
  if (verified) {
    log('✓ Live verified — the change is live on the site.');
    for (const id of runs) {
      await sb.updateRun(id, { stage: 'live_verified', percent: Math.round((6 / 7) * 100) });
      await sb.updateRun(id, {
        stage: 'complete', status: 'done', percent: 100,
        summary: report, ended_at: Date.now()
      });
    }
  } else {
    log('✗ Timed out waiting for the live site to reflect this build.');
    for (const id of runs) {
      await sb.updateRun(id, {
        stage: 'deploying', status: 'failed',
        summary: report, ended_at: Date.now()
      });
    }
  }

  // Surface the report in the workflow log too.
  console.log('\n' + report + '\n');
  // Non-zero exit on failed verification so the workflow run is visibly red.
  if (!verified) process.exitCode = 1;
}

main().catch(e => { console.error('[deploy-verify] failed:', e.message); process.exitCode = 1; });
