'use strict';

/*
 * Groq provider — drop-in replacement for makeOllama().
 * -------------------------------------------------------
 * Groq uses the OpenAI chat/completions API. This module normalises the
 * request/response shape so the rest of the agent (loop.js, run.js) sees the
 * same interface as the Ollama provider:
 *
 *   chat(messages, toolSchemas, opts) → { content, tool_calls }
 *
 * Key format differences handled here:
 *   • Outbound: assistant tool_calls need type:"function" + string arguments.
 *   • Outbound: tool results need tool_call_id (matched by function name order).
 *   • Inbound:  tool_calls.function.arguments arrives as a JSON string → parsed.
 *   • Model:    opts.model or config.groqModel (default llama-3.3-70b-versatile).
 */

const BASE = 'https://api.groq.com/openai/v1';

// Map internal (Ollama-style) messages → OpenAI format Groq expects.
function toOpenAI(messages) {
  const out = [];
  let lastCallIds = {};   // function-name → id, from last assistant tool_calls

  for (const m of messages) {
    if (m.role === 'system' || (m.role === 'user' && !m.tool_name)) {
      out.push({ role: m.role, content: m.content || '' });

    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.tool_calls && m.tool_calls.length) {
        lastCallIds = {};
        msg.tool_calls = m.tool_calls.map((tc, i) => {
          const fn = tc.function || tc;
          const id = tc.id || `call_${fn.name}_${i}`;
          lastCallIds[fn.name] = id;
          return {
            id,
            type: 'function',
            function: {
              name: fn.name,
              arguments: typeof fn.arguments === 'string'
                ? fn.arguments
                : JSON.stringify(fn.arguments || {})
            }
          };
        });
      }
      out.push(msg);

    } else if (m.role === 'tool') {
      // Groq requires tool_call_id. Match by the tool_name we stored.
      const id = lastCallIds[m.tool_name] || `call_${m.tool_name}`;
      out.push({ role: 'tool', tool_call_id: id, content: String(m.content || '') });

    } else {
      out.push({ role: m.role, content: m.content || '' });
    }
  }
  return out;
}

// Groq's parser is strict — sanitize each tool schema before sending.
// Removes undefined values (via JSON round-trip), ensures parameters has
// type:object, and strips any keys that aren't in the OpenAI spec.
function sanitizeTools(tools) {
  return (tools || []).map(t => {
    const fn = t.function || {};
    const params = fn.parameters || { type: 'object', properties: {} };
    // round-trip to drop undefined values
    const cleanParams = JSON.parse(JSON.stringify({
      type: 'object',
      properties: params.properties || {},
      required: params.required || []
    }));
    return {
      type: 'function',
      function: {
        name: fn.name,
        description: (fn.description || '').slice(0, 1024),
        parameters: cleanParams
      }
    };
  });
}

function makeGroq(config) {
  const KEY   = config.groqKey;
  const MODEL = config.groqModel || 'llama-3.3-70b-versatile';

  async function _post(path, body, ms = 180000) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText);
        throw new Error(`Groq ${path} → ${res.status} ${txt}`);
      }
      return res.json();
    } finally {
      clearTimeout(tid);
    }
  }

  async function chat(messages, tools, opts = {}) {
    const model = opts.model || MODEL;
    const body = {
      model,
      messages: toOpenAI(messages),
      stream: false,
      temperature: 0.1,
    };
    if (tools && tools.length) {
      body.tools = sanitizeTools(tools);
      body.tool_choice = 'auto';
      body.parallel_tool_calls = false;  // one tool at a time — keeps loop simpler
    }

    // Note: qwen3 thinking mode disabled via <think> stripping in response normalisation above.
    // Groq does not support enable_thinking param.

    // Retry once on rate-limit (429) after waiting the suggested delay.
    let data;
    try {
      data = await _post('/chat/completions', body, opts.timeout ?? 180000);
    } catch (e) {
      const m = e.message.match(/try again in ([\d.]+)s/i);
      if (m) {
        const wait = Math.min(Math.ceil(parseFloat(m[1])) * 1000 + 1000, 60000);
        await new Promise(r => setTimeout(r, wait));
        data = await _post('/chat/completions', body, opts.timeout ?? 180000);
      } else { throw e; }
    }
    const msg  = data.choices?.[0]?.message;
    if (!msg) throw new Error('Groq returned no message in choices[0]');

    // Qwen3 emits <think>...</think> reasoning blocks before responding.
    // Strip them so they don't pollute the message history or confuse the loop.
    if (msg.content) {
      msg.content = msg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }

    // Normalise tool_calls → Ollama shape (arguments as parsed object, id preserved)
    const tool_calls = (msg.tool_calls || []).map(tc => ({
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: (() => {
          if (typeof tc.function.arguments === 'object') return tc.function.arguments;
          try { return JSON.parse(tc.function.arguments); } catch { return {}; }
        })()
      }
    }));

    return { content: msg.content || '', tool_calls };
  }

  async function reachable() {
    try {
      const res = await fetch(`${BASE}/models`, {
        headers: { Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(6000)
      });
      return res.ok;
    } catch { return false; }
  }

  async function listModels() {
    try {
      const res = await fetch(`${BASE}/models`, {
        headers: { Authorization: `Bearer ${KEY}` }
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data || []).map(m => m.id);
    } catch { return []; }
  }

  return { chat, reachable, listModels, host: 'groq.com', model: MODEL };
}

// OpenRouter — same OpenAI-compatible API, different base URL + headers.
// Best free models: meta-llama/llama-3.3-70b-instruct:free, qwen/qwen3-235b-a22b:free
function makeOpenRouter(config) {
  const KEY   = config.openRouterKey;
  const MODEL = config.openRouterModel || 'meta-llama/llama-3.3-70b-instruct:free';
  const OR_BASE = 'https://openrouter.ai/api/v1';

  async function _post(path, body, ms = 180000) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(`${OR_BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer':  'https://samcbarth.github.io/runmywork',
          'X-Title':       'RunMyWork Agent'
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText);
        throw new Error(`OpenRouter ${path} → ${res.status} ${txt}`);
      }
      return res.json();
    } finally {
      clearTimeout(tid);
    }
  }

  async function chat(messages, tools, opts = {}) {
    const model = opts.model || MODEL;
    const body = {
      model,
      messages: toOpenAI(messages),
      stream: false,
      temperature: 0.1,
    };
    if (tools && tools.length) {
      body.tools = sanitizeTools(tools);
      body.tool_choice = 'auto';
      body.parallel_tool_calls = false;
    }

    let data;
    try {
      data = await _post('/chat/completions', body, opts.timeout ?? 180000);
    } catch (e) {
      const m = e.message.match(/try again in ([\d.]+)s/i);
      if (m) {
        const wait = Math.min(Math.ceil(parseFloat(m[1])) * 1000 + 1000, 60000);
        await new Promise(r => setTimeout(r, wait));
        data = await _post('/chat/completions', body, opts.timeout ?? 180000);
      } else { throw e; }
    }

    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('OpenRouter returned no message in choices[0]');

    if (msg.content) {
      msg.content = msg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }

    const tool_calls = (msg.tool_calls || []).map(tc => ({
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: (() => {
          if (typeof tc.function.arguments === 'object') return tc.function.arguments;
          try { return JSON.parse(tc.function.arguments); } catch { return {}; }
        })()
      }
    }));

    return { content: msg.content || '', tool_calls };
  }

  async function reachable() {
    try {
      const res = await fetch(`${OR_BASE}/models`, {
        headers: { Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(6000)
      });
      return res.ok;
    } catch { return false; }
  }

  async function listModels() {
    try {
      const res = await fetch(`${OR_BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data || []).map(m => m.id);
    } catch { return []; }
  }

  return { chat, reachable, listModels, host: 'openrouter.ai', model: MODEL };
}

// OpenAI — same OpenAI-compat format, api.openai.com
function makeOpenAI(config) {
  const KEY   = config.openAIKey;
  const MODEL = config.openAIModel || 'gpt-4o-mini';
  const OA_BASE = 'https://api.openai.com/v1';

  async function _post(path, body, ms = 180000) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(`${OA_BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText);
        throw new Error(`OpenAI ${path} → ${res.status} ${txt}`);
      }
      return res.json();
    } finally { clearTimeout(tid); }
  }

  async function chat(messages, tools, opts = {}) {
    const model = opts.model || MODEL;
    const body = { model, messages: toOpenAI(messages), stream: false, temperature: 0.1 };
    if (tools && tools.length) {
      body.tools = sanitizeTools(tools);
      body.tool_choice = 'auto';
      body.parallel_tool_calls = false;
    }
    let data;
    try { data = await _post('/chat/completions', body, opts.timeout ?? 180000); }
    catch (e) {
      const m = e.message.match(/try again in ([\d.]+)s/i);
      if (m) {
        await new Promise(r => setTimeout(r, Math.min(Math.ceil(parseFloat(m[1])) * 1000 + 1000, 60000)));
        data = await _post('/chat/completions', body, opts.timeout ?? 180000);
      } else { throw e; }
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('OpenAI returned no message in choices[0]');
    const tool_calls = (msg.tool_calls || []).map(tc => ({
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: (() => {
          if (typeof tc.function.arguments === 'object') return tc.function.arguments;
          try { return JSON.parse(tc.function.arguments); } catch { return {}; }
        })()
      }
    }));
    return { content: msg.content || '', tool_calls };
  }

  async function reachable() {
    try {
      const res = await fetch(`${OA_BASE}/models`, {
        headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(6000)
      });
      return res.ok;
    } catch { return false; }
  }

  async function listModels() { return [MODEL]; }

  return { chat, reachable, listModels, host: 'api.openai.com', model: MODEL };
}

/*
 * Chained provider — tries each provider in order, falls over on failure.
 * ----------------------------------------------------------------------
 * providers: [{ label, impl }]  (impl = makeGroq/makeOpenRouter/makeOpenAI/makeOllama result)
 *
 * On chat():
 *   • Try the first non-dead provider.
 *   • On a DAILY rate limit / auth / quota error → mark that provider DEAD for the
 *     rest of the process (don't waste calls retrying it every step).
 *   • On any other error → try the next provider this call, but keep it alive.
 *   • This makes fallover work MID-RUN: if Groq dies on step 8, step 9 uses the next.
 *
 * Each impl uses ITS OWN default model — we strip opts.model so a Groq model name
 * is never sent to OpenAI etc.
 */
function makeChainedProvider(providers, log) {
  const dead = new Set();
  let activeIdx = -1;
  const announce = (i) => {
    if (i !== activeIdx) {
      activeIdx = i;
      if (log) log(`   ↻ provider → ${providers[i].label}`);
    }
  };

  // Mark a provider dead for the rest of this process run when it won't recover
  // in time to matter: daily limits, auth/quota failures, AND any 429 (a rate
  // limit won't clear within a short agent run, so stop wasting a call on it
  // every step — fall straight to the next provider).
  const isFatal = (msg) =>
    /\b429\b|rate limit|per day|TPD|tokens per day|insufficient_quota|invalid_api_key|incorrect api key|401|403/i.test(msg);

  async function chat(messages, tools, opts = {}) {
    const cleanOpts = { ...opts };
    delete cleanOpts.model;   // let each impl use its own default model
    let lastErr;
    for (let i = 0; i < providers.length; i++) {
      if (dead.has(i)) continue;
      try {
        const r = await providers[i].impl.chat(messages, tools, cleanOpts);
        announce(i);
        return r;
      } catch (e) {
        lastErr = e;
        if (isFatal(e.message)) {
          dead.add(i);
          if (log) log(`   ✗ ${providers[i].label} exhausted (${e.message.slice(0, 70)})`);
        } else if (log) {
          log(`   ⚠ ${providers[i].label} error, trying next (${e.message.slice(0, 70)})`);
        }
        // fall through to next provider
      }
    }
    throw lastErr || new Error('all providers failed');
  }

  async function reachable() {
    for (let i = 0; i < providers.length; i++) {
      if (dead.has(i)) continue;
      try { if (await providers[i].impl.reachable()) return true; } catch { /* next */ }
    }
    return false;
  }

  async function listModels() { return []; }   // suppress the Ollama "model not found" warning path

  return {
    chat, reachable, listModels,
    host: providers.map(p => p.label).join('→'),
    model: providers[0] ? providers[0].impl.model : ''
  };
}

module.exports = { makeGroq, makeOpenRouter, makeOpenAI, makeChainedProvider };
