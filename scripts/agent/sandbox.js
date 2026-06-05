'use strict';

/*
 * Path jail. Every file/shell tool resolves user-supplied paths through here so
 * the agent can never read or write outside its per-project work dir — the first
 * line of defence against a prompt-injected "write to C:\..." instruction.
 */

const path = require('path');

// Resolve `rel` against the sandbox root and refuse anything that escapes it.
function safeResolve(root, rel) {
  const target = path.resolve(root, rel || '.');
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new Error(`path "${rel}" escapes the sandbox`);
  }
  return target;
}

module.exports = { safeResolve };
