'use strict';

/*
 * Ollama client for the agent runtime.
 * ------------------------------------
 * Wraps POST /api/chat with native tool-calling. Models like llama3.1 emit a
 * `message.tool_calls` array when they want to use a tool; we hand those to the
 * registry, append the results as role:"tool" messages, and loop. Models that
 * don't support tools just return prose, which the loop treats as a final answer.
 *
 * `chat()` returns the raw assistant message: { content, tool_calls? }.
 */

function makeOllama(config) {
  const HOST = config.ollamaHost.replace(/\/+$/, '');
  const MODEL = config.ollamaModel;

  async function call(path, body, ms) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(`${HOST}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`Ollama ${path} → ${res.status} ${res.statusText}`);
      return res.json();
    } finally {
      clearTimeout(id);
    }
  }

  // One assistant turn. `tools` is the Ollama tool-schema array (or omitted).
  async function chat(messages, tools, opts = {}) {
    const body = {
      model: opts.model || MODEL,
      stream: false,
      messages,
      options: { temperature: opts.temperature ?? 0.3, ...(opts.options || {}) }
    };
    if (tools && tools.length) body.tools = tools;
    if (opts.format) body.format = opts.format;

    const data = await call('/api/chat', body, opts.timeout ?? 180000);
    const msg = (data && data.message) || {};
    return {
      content: typeof msg.content === 'string' ? msg.content : '',
      tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
      raw: msg
    };
  }

  // Plain completion (no tools) — used by summarizers / sub-prompts.
  async function generate(system, user, opts = {}) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    const { content } = await chat(messages, null, opts);
    return content;
  }

  async function tags() {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`${HOST}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(id);
    }
  }

  async function reachable() { return (await tags()) != null; }

  // Installed model names (without :latest suffix noise) for a soft pre-check.
  async function listModels() {
    const data = await tags();
    if (!data || !Array.isArray(data.models)) return [];
    return data.models.map(m => m.name);
  }

  return { chat, generate, reachable, listModels, model: MODEL, host: HOST };
}

module.exports = { makeOllama };
