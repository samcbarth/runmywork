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
const { sendPush } = require('./notify');

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

// Fetch the live version.json (cache-busted). Returns { served, build } —
// served=true means the URL returned 200 (a deploy target exists, even if it's
// still showing an old build); build is the reported build id or null. A target
// with no GitHub Pages at all returns served=false (404 / unreachable).
async function fetchLiveBuild() {
  try {
    const res = await fetch(`${VERSION_URL}?cb=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
    });
    if (!res.ok) return { served: false, build: null };
    const json = await res.json().catch(() => null);
    return { served: true, build: json && json.build ? String(json.build) : null };
  } catch { return { served: false, build: null }; }
}

// Build the human-readable final report the user reads in the tracker.
// outcome: 'verified' (live confirmed) | 'no_pages' (pushed; target has no Pages
// to verify against) | 'stuck' (Pages exists but never showed this build).
function buildReport({ outcome, handoff }) {
  const files = (handoff.changedFiles || []).map(f => f.path || f).filter(Boolean);
  const lines = [];
  lines.push(handoff.summary ? handoff.summary.split('\n')[0] : 'Agent run');
  lines.push('');
  lines.push('— DEPLOY REPORT —');
  lines.push(`Files changed: ${files.length ? files.join(', ') : 'none'}`);
  if (handoff.visualSummary) lines.push(`What changed visually: ${handoff.visualSummary}`);
  lines.push(`Commit/push: pushed to main`);
  const deployLine = outcome === 'verified' ? 'deployed'
    : outcome === 'no_pages' ? 'pushed (no live site configured on this repo — nothing to deploy to)'
    : 'pushed, deploy not confirmed';
  lines.push(`Deployment: ${deployLine}`);
  lines.push(`Live URL checked: ${LIVE_URL}`);
  const visibleLine = outcome === 'verified' ? 'YES — confirmed live'
    : outcome === 'no_pages' ? 'N/A — this repo has no GitHub Pages site, so there is nothing to verify. The change is committed and pushed.'
    : 'NOT YET — live site did not reflect this build in time';
  lines.push(`Visible live: ${visibleLine}`);
  return lines.join('\n').slice(0, 1000);
}

const normCrit = (s) => String(s || '').split(/\n\n(?:Evidence|Feedback):/i)[0].trim().toLowerCase();

// After a change is confirmed LIVE, hand the work to the human for explicit
// per-criterion sign-off. Files ONE `review_criteria` approval listing EVERY
// success criterion with its current status (met / failed / open), which one
// this run claims to have advanced, and the deploy evidence. The app renders
// pass/fail toggles; submitting it ticks the passes and feeds failures back.
//
// Returns { hasCriteria, filed }. hasCriteria=false means the project has no
// success criteria at all, so the caller completes the run outright (nothing to
// review). Idempotent: skips filing if a review is already pending.
async function ensureCriteriaReview(sb, projectId, criteriaAdvanced, deployReport, visualSummary, runId) {
  if (!projectId) return { hasCriteria: false, filed: false };

  let rows = [];
  try { rows = await sb.pullContext(projectId, 80); } catch { /* best effort */ }
  const crits = rows.filter(r => r.kind === 'success_criteria')
    .map(r => String(r.content || '').trim()).filter(Boolean);
  // De-dupe preserving order.
  const seen = new Set();
  const criteria = crits.filter(c => { const k = normCrit(c); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!criteria.length) return { hasCriteria: false, filed: false };

  // A criterion counts as met only if its newest sign-off is at least as recent
  // as its newest failure feedback (so a re-failed criterion shows as not-met).
  const metAt = new Map(), failAt = new Map();
  for (const r of rows) {
    const k = normCrit(r.content);
    if (r.kind === 'success_criteria_met' && !metAt.has(k)) metAt.set(k, r.created_at || 0);
    if (r.kind === 'success_criteria_feedback' && !failAt.has(k)) failAt.set(k, r.created_at || 0);
  }
  const isMet = (c) => { const k = normCrit(c); const m = metAt.has(k) ? metAt.get(k) : -1; const f = failAt.has(k) ? failAt.get(k) : -1; return m >= 0 && m >= f; };
  // Match the agent's free-text "criteria_advanced" to a real criterion row.
  const advNeedle = String(criteriaAdvanced || '').toLowerCase();
  const advancedKey = advNeedle
    ? (criteria.find(c => advNeedle.includes(normCrit(c)) || normCrit(c).includes(advNeedle.slice(0, 40))) || '')
    : '';

  // Already a review waiting? Don't duplicate — the existing one still stands.
  try {
    const pending = await sb.pendingApprovals(projectId);
    if (pending.some(a => a.action_type === 'review_criteria')) {
      log('   criteria review already pending — not duplicating.');
      return { hasCriteria: true, filed: false };
    }
  } catch { /* best effort */ }

  const payloadCriteria = criteria.map(c => ({
    text: c.slice(0, 400),
    met: isMet(c),
    advancedThisRun: advancedKey ? normCrit(c) === normCrit(advancedKey) : false,
    evidence: (advancedKey && normCrit(c) === normCrit(advancedKey)) ? String(deployReport || '').slice(0, 800) : ''
  }));

  await sb.createApproval({
    project_id: projectId,
    action_type: 'review_criteria',
    payload: {
      criteria: payloadCriteria,
      visualSummary: String(visualSummary || '').slice(0, 600),
      deployReport: String(deployReport || '').slice(0, 1000),
      runId: runId || null
    },
    rationale: 'Live-verified change is deployed. Review each success criterion and mark which passed and which failed. Failed ones go back to the agent with your feedback.'
  });
  await sb.addWorklog({
    project_id: projectId, kind: 'proposal', created_by: 'agent',
    summary: `Success criteria ready for your review (${criteria.length})`,
    detail: { action_type: 'review_criteria', criteriaCount: criteria.length, advanced: advancedKey }
  });
  log(`   ✓ filed criteria review (${criteria.length} criteria) for project ${projectId}`);
  return { hasCriteria: true, filed: true };
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
  // Normalise runs to objects: { runId, projectId, criteriaAdvanced }. Tolerate
  // the legacy shape (a bare run-id string) so an in-flight older handoff works.
  const runs = (handoff.runs || [])
    .map(r => (typeof r === 'string' ? { runId: r } : r))
    .filter(r => r && r.runId);
  if (!runs.length) { log('No run ids in handoff — nothing to verify.'); return; }

  // Stage: pushed → deploying
  for (const r of runs) {
    await sb.updateRun(r.runId, { stage: 'pushed',    percent: Math.round((4 / 7) * 100) });
  }
  log(`Marked ${runs.length} run(s) pushed. Waiting for live deploy of build ${BUILD_ID} at ${VERSION_URL}`);
  for (const r of runs) {
    await sb.updateRun(r.runId, { stage: 'deploying', percent: Math.round((5 / 7) * 100) });
  }

  // Poll the live site until it reports this build (or we time out). Track whether
  // the URL ever served a 200: a repo with NO GitHub Pages (e.g. an external
  // target site that was never set up) 404s forever — there is nothing to deploy
  // to, so we must NOT sit here failing for 12 minutes. If we never get a 200
  // within a short grace window, conclude "no live target" and treat the pushed
  // commit as the finish line instead of a failure.
  const NOPAGES_GRACE_MS = parseInt(process.env.DEPLOY_NOPAGES_GRACE_MS || '', 10) || 90 * 1000;
  const startedAt = Date.now();
  const deadline  = startedAt + TIMEOUT_MS;
  let verified = false;
  let everServed = false;
  while (Date.now() < deadline) {
    const { served, build } = await fetchLiveBuild();
    if (served) everServed = true;
    if (build === BUILD_ID) { verified = true; break; }
    // Quick exit when there is plainly no Pages site to verify against.
    if (!everServed && (Date.now() - startedAt) > NOPAGES_GRACE_MS) {
      log(`No live site responded at ${VERSION_URL} after ${Math.round(NOPAGES_GRACE_MS / 1000)}s — treating the push as the finish line (no Pages on this repo).`);
      break;
    }
    log(`live build = ${build ?? (everServed ? '(no build field)' : '(unreachable)')} ≠ ${BUILD_ID} — waiting ${POLL_MS / 1000}s…`);
    await sleep(POLL_MS);
  }

  // verified  → confirmed live.   no_pages → pushed, no live target to verify.
  // stuck     → a Pages site exists but never showed this build (real failure).
  const outcome = verified ? 'verified' : (!everServed ? 'no_pages' : 'stuck');
  const report = buildReport({ outcome, handoff });
  const shipped = outcome !== 'stuck';   // verified live OR pushed with no live target

  if (shipped) {
    log(outcome === 'verified'
      ? '✓ Live verified — the change is live on the site.'
      : '✓ Pushed — no live site to verify on this repo; treating push as shipped.');
    for (const r of runs) {
      await sb.updateRun(r.runId, { stage: 'live_verified', percent: Math.round((6 / 7) * 100) });
      // Shipped, but the run is NOT complete — the human must sign off on the
      // success criteria first. File the review and hold at awaiting_review.
      // Only a project with NO criteria completes outright.
      let review = { hasCriteria: false, filed: false };
      try { review = await ensureCriteriaReview(sb, r.projectId, r.criteriaAdvanced, report, handoff.visualSummary, r.runId); }
      catch (e) { log(`   (criteria review not filed: ${e.message})`); }

      let title = 'A project';
      try { const pr = await sb.pullProject(r.projectId); if (pr) title = pr.title; } catch { /* best effort */ }

      if (review.hasCriteria) {
        await sb.updateRun(r.runId, {
          stage: 'live_verified', status: 'awaiting_review',
          percent: Math.round((6 / 7) * 100),
          summary: report
          // no ended_at — the run waits on the human's criteria review
        });
        log(`   ⏸ run ${r.runId} awaiting your criteria review.`);
        await sendPush({ title: '📋 Review needed — confirm success criteria',
          body: `${title}: ${outcome === 'verified' ? 'the change is live' : 'the change is pushed'}. Mark which criteria passed.`,
          projectId: r.projectId, tag: `rmw-run-${r.runId}` });
      } else {
        await sb.updateRun(r.runId, {
          stage: 'complete', status: 'done', percent: 100,
          summary: report, ended_at: Date.now()
        });
        await sendPush({ title: outcome === 'verified' ? '✅ Change is live' : '✅ Change pushed',
          body: `${title}: ${outcome === 'verified' ? 'deployed and verified.' : 'committed and pushed.'}`,
          projectId: r.projectId, tag: `rmw-run-${r.runId}` });
      }
    }
  } else {
    log('✗ Timed out waiting for the live site to reflect this build.');
    for (const r of runs) {
      await sb.updateRun(r.runId, {
        stage: 'deploying', status: 'failed',
        summary: report, ended_at: Date.now()
      });
      await sendPush({ title: '⚠ Deploy not verified',
        body: 'Change was pushed but the live site did not reflect it in time.',
        projectId: r.projectId, tag: `rmw-run-${r.runId}` });
    }
  }

  // Surface the report in the workflow log too.
  console.log('\n' + report + '\n');
  // Non-zero exit only on a genuine stuck deploy (Pages exists but never updated).
  if (!shipped) process.exitCode = 1;
}

main().catch(e => { console.error('[deploy-verify] failed:', e.message); process.exitCode = 1; });
