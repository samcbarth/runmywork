'use strict';

/*
 * Self-extension — OFF unless AGENT_ALLOW_BUILD_TOOL=1.
 * ----------------------------------------------------
 * Lets the agent write a NEW tool into ./tools and use it the same run. This is
 * the "build the tools it needs" capability.
 *
 * ⚠️  This grants the agent arbitrary code execution INSIDE the runtime process
 * (a new tool's run() is plain Node with full privileges — it is NOT sandboxed
 * like files/shell). Only enable it on a machine you fully control and trust.
 *
 * Source contract: the provided JS must be a CommonJS module exporting
 *   { name, description, parameters, run(args, ctx) }
 * matching the other files in tools/.
 */

const fs = require('fs');
const path = require('path');
const { TOOLS_DIR } = require('../registry');

const RESERVED = ['done', 'note', 'propose', 'files', 'shell', 'delegate', 'build_tool',
  'web_search', 'fetch_url', 'save_artifact'];

module.exports = {
  name: 'build_tool',
  description: 'Create a new tool you need that does not exist yet, then use it in later steps. Provide the tool name (snake_case) and the full CommonJS source exporting { name, description, parameters, run(args, ctx) }. Returns once the tool is registered.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'snake_case tool name, e.g. "csv_parse".' },
      source: { type: 'string', description: 'Full module source exporting { name, description, parameters, run }.' }
    },
    required: ['name', 'source']
  },
  enabled(config) { return config.allowBuildTool; },

  async run(args, ctx) {
    const name = String(args.name || '').trim();
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) return { error: 'name must be snake_case (a-z, 0-9, _)' };
    if (RESERVED.includes(name)) return { error: `"${name}" is a built-in tool; choose another name` };

    const source = String(args.source || '');
    if (!/module\.exports/.test(source) || !/run\s*[:(]/.test(source)) {
      return { error: 'source must be a CommonJS module exporting an object with a run() function' };
    }

    const file = path.join(TOOLS_DIR, `${name}.js`);
    if (fs.existsSync(file)) return { error: `${name}.js already exists` };

    // sanity-check it loads and shape-checks before we keep it
    fs.writeFileSync(file, source, 'utf8');
    try {
      delete require.cache[require.resolve(file)];
      const mod = require(file);
      if (!mod || mod.name !== name || typeof mod.run !== 'function') {
        fs.unlinkSync(file);
        return { error: 'loaded module must export { name (matching), run() }' };
      }
    } catch (e) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return { error: `new tool failed to load: ${e.message}` };
    }

    if (ctx.reloadTools) ctx.reloadTools();
    if (ctx.project) {
      await ctx.sb.addWorklog({
        project_id: ctx.project.id, kind: 'note', created_by: 'agent',
        summary: `🔧 Built new tool "${name}"`, detail: { tool: name }
      }).catch(() => {});
    }
    return { ok: true, registered: name, note: 'You can call this tool now.' };
  }
};
