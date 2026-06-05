'use strict';

/* All configuration comes from the environment — no secret ever lives in a file
 * that could be committed. The launcher (run-agent.bat, gitignored) sets these. */

function bool(v) { return v === '1' || v === 'true' || v === 'yes'; }

function loadConfig() {
  const csv = (process.env.AGENT_SHELL_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    ollamaHost: (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    // Base model is the fallback. Planner drives the top loop + board planning
    // (reasoning); worker runs delegated sub-tasks (grunt work). Either unset →
    // base model, so the split is opt-in and back-compatible.
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1',
    plannerModel: process.env.OLLAMA_PLANNER_MODEL || process.env.OLLAMA_MODEL || 'llama3.1',
    workerModel: process.env.OLLAMA_WORKER_MODEL || process.env.OLLAMA_MODEL || 'llama3.1',
    searxngUrl: (process.env.AGENT_SEARXNG_URL || '').replace(/\/+$/, ''),

    budget: parseInt(process.env.AGENT_BUDGET, 10) || 12,
    maxDepth: parseInt(process.env.AGENT_MAX_DEPTH, 10) || 2,
    maxProjects: parseInt(process.env.AGENT_MAX_PROJECTS, 10) || 3,

    allowShell: bool(process.env.AGENT_ALLOW_SHELL),
    shellAllow: csv,
    allowBuildTool: bool(process.env.AGENT_ALLOW_BUILD_TOOL),

    force: bool(process.env.AGENT_FORCE)
  };
}

function validate(config) {
  const missing = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  return missing;
}

module.exports = { loadConfig, validate };
