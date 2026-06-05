'use strict';

/*
 * Tool registry.
 * --------------
 * Loads every module in ./tools, each of which exports:
 *   {
 *     name:        'web_search',
 *     description: 'one line the model reads to decide when to use it',
 *     parameters:  { type:'object', properties:{...}, required:[...] },  // JSON schema
 *     enabled?:    (config) => boolean,   // gate dangerous tools behind env flags
 *     run:         async (args, ctx) => any   // result is serialized into a tool message
 *   }
 *
 * This is the extension point. "The agent can build tools it needs" = the
 * build_tool tool writes a new file here and calls reload(); next loop sees it.
 */

const fs = require('fs');
const path = require('path');

const TOOLS_DIR = path.join(__dirname, 'tools');

function loadTools(config, allowList) {
  const tools = new Map();
  if (!fs.existsSync(TOOLS_DIR)) return tools;

  for (const file of fs.readdirSync(TOOLS_DIR)) {
    if (!file.endsWith('.js')) continue;
    const full = path.join(TOOLS_DIR, file);
    let mod;
    try {
      delete require.cache[require.resolve(full)];   // allow hot reload
      mod = require(full);
    } catch (e) {
      console.warn(`[registry] failed to load ${file}: ${e.message}`);
      continue;
    }
    if (!mod || !mod.name || typeof mod.run !== 'function') continue;
    if (typeof mod.enabled === 'function' && !mod.enabled(config)) continue;
    if (allowList && !allowList.includes(mod.name)) continue;
    tools.set(mod.name, mod);
  }
  return tools;
}

// Ollama tool-schema array from a loaded tool map.
function toSchemas(tools) {
  return [...tools.values()].map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} }
    }
  }));
}

// Run one tool call. Always resolves to a string (the tool message content),
// turning thrown errors into a structured error the model can react to.
async function dispatch(tools, name, args, ctx) {
  const tool = tools.get(name);
  if (!tool) return JSON.stringify({ error: `Unknown tool "${name}". Available: ${[...tools.keys()].join(', ')}` });
  try {
    const result = await tool.run(args || {}, ctx);
    if (result == null) return JSON.stringify({ ok: true });
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
}

module.exports = { loadTools, toSchemas, dispatch, TOOLS_DIR };
