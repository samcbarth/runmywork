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

module.exports = { makeGroq };
