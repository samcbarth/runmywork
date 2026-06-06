'use strict';

/*
 * find_in_file — locate exact text in a project file.
 * -----------------------------------------------------
 * Solves the #1 cause of write_file patch failures: the agent generating an
 * old_string from memory that doesn't exactly match the file.
 *
 * Workflow the agent MUST follow for code edits:
 *   1. read_file op:read  → see the file
 *   2. find_in_file       → get the EXACT text block to replace
 *   3. write_file op:patch old_string=(result from step 2)
 *
 * Returns the exact matching text plus surrounding context lines so the agent
 * can construct a precise, unambiguous old_string.
 */

const fs   = require('fs');
const path = require('path');

function safeResolve(root, rel) {
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path "${rel}" escapes the project root.`);
  }
  return resolved;
}

module.exports = {
  name: 'find_in_file',
  description: 'Find the exact text of a code section you want to edit. Give a search string (partial text, function name, id, etc.) and get back the exact matching lines with context. Use the returned "exact_match" as the old_string in write_file op:patch — do not retype it from memory.',
  parameters: {
    type: 'object',
    properties: {
      path:    { type: 'string', description: 'File path relative to project root.' },
      search:  { type: 'string', description: 'Text to search for (partial, case-insensitive). Can be a function name, HTML id, unique string, etc.' },
      context: { type: 'number', description: 'Lines of context around each match (default 3).' }
    },
    required: ['path', 'search']
  },
  enabled: (config) => Boolean(config.projectRoot),
  async run(args, ctx) {
    const root = ctx.config.projectRoot;
    if (!root) return { error: 'AGENT_PROJECT_ROOT not configured.' };

    let target;
    try { target = safeResolve(root, args.path || ''); }
    catch (e) { return { error: e.message }; }

    if (!fs.existsSync(target)) {
      return { error: `File not found: "${args.path}". Use read_file op:list to find the correct path.` };
    }

    const content = fs.readFileSync(target, 'utf8');
    const lines   = content.split('\n');
    const search  = String(args.search || '').toLowerCase();
    const ctx_n   = Math.min(Number(args.context) || 3, 10);

    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(search)) {
        const start = Math.max(0, i - ctx_n);
        const end   = Math.min(lines.length - 1, i + ctx_n);
        const block = lines.slice(start, end + 1).join('\n');
        matches.push({
          line:        i + 1,
          exact_match: block,
          preview:     lines[i].trim()
        });
      }
    }

    if (!matches.length) {
      return {
        error:      `"${args.search}" not found in ${args.path}.`,
        suggestion: 'Try a shorter or different search term. Use read_file op:read to see the file contents.'
      };
    }

    return {
      file:    args.path,
      matches: matches.slice(0, 5),   // cap at 5 to avoid token bloat
      instruction: 'Use exact_match from the best match as old_string in write_file op:patch. Do not retype it — copy it exactly.'
    };
  }
};
