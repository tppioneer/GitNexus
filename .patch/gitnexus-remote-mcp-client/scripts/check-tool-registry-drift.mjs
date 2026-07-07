#!/usr/bin/env node
/**
 * Tool-registry drift scanner.
 *
 * Compares the server-side tool list (gitnexus/src/mcp/tools.ts) against the
 * proxy client's hardcoded allowlist
 * (.patch/gitnexus-remote-mcp-client/src/tools.ts) and reports any drift in
 * either direction:
 *
 *   - missing-in-client: tools the server exposes but the client does not
 *     advertise. These will be rejected by the proxy's local allowlist even
 *     though the server can serve them — silent capability loss.
 *   - missing-in-server: tools the client advertises but the server does not
 *     expose. These calls will fail at the HTTP layer with a tool-not-found
 *     error — user-visible breakage.
 *
 * Run from the repo root:
 *   node .patch/gitnexus-remote-mcp-client/scripts/check-tool-registry-drift.mjs
 *
 * Exits non-zero if any drift is detected. Hook this into a PreToolUse gate
 * for `git_commit` (see CLAUDE.md) so the drift can never reach the branch
 * unnoticed.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// .patch/gitnexus-remote-mcp-client/scripts → repo root is up 3 levels
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const CLIENT_TOOLS_FILE = join(
  REPO_ROOT,
  '.patch/gitnexus-remote-mcp-client/src/tools.ts',
);

// The server's tool definitions are not all inline in tools.ts — newer tools
// live in dedicated files and are imported + pushed at module load. Scan each
// known location. When a new tool-definition file is added, append it here.
const SERVER_TOOL_SOURCES = [
  'gitnexus/src/mcp/tools.ts',
  'gitnexus/src/core/repo-index/tool-def.ts',
  'gitnexus/src/core/extra-tool/read-remote-file.ts',
];

/**
 * Extract every `name: '...'` string literal from a TypeScript file.
 * Skips string literals inside comments and import specifiers via a simple
 * per-line scan; sufficient for the well-known shape of these two files.
 */
function extractToolNames(source) {
  const names = new Set();
  const re = /^\s*name:\s*'([^']+)'/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    names.add(m[1]);
  }
  return names;
}

async function main() {
  const clientSrc = await readFile(CLIENT_TOOLS_FILE, 'utf8');
  const clientTools = extractToolNames(clientSrc);

  const serverSources = await Promise.all(
    SERVER_TOOL_SOURCES.map((rel) => readFile(join(REPO_ROOT, rel), 'utf8')),
  );
  const serverTools = new Set(
    serverSources.flatMap((src) => [...extractToolNames(src)]),
  );

  const missingInClient = [...serverTools]
    .filter((t) => !clientTools.has(t))
    .sort();
  const missingInServer = [...clientTools]
    .filter((t) => !serverTools.has(t))
    .sort();

  // Some tools may intentionally be client-only (e.g. proxies of resource
  // handlers); `list_repos` is also routed differently in some flows. List
  // known exceptions here as the design evolves. Today: none.
  const KNOWN_CLIENT_ONLY = new Set();

  const realMissingInServer = missingInServer.filter(
    (t) => !KNOWN_CLIENT_ONLY.has(t),
  );

  process.stdout.write(
    `tool-registry-drift: server=${serverTools.size} client=${clientTools.size}\n`,
  );

  let failed = false;

  if (missingInClient.length > 0) {
    failed = true;
    process.stderr.write(
      `\n❌ Tools exposed by server but NOT in client HARDCODED_TOOLS ` +
        `(${missingInClient.length}):\n`,
    );
    for (const t of missingInClient) process.stderr.write(`   - ${t}\n`);
    process.stderr.write(
      '   The proxy will reject these locally before they reach the server.\n' +
        '   Add the tool definition to .patch/gitnexus-remote-mcp-client/src/tools.ts.\n',
    );
  }

  if (realMissingInServer.length > 0) {
    failed = true;
    process.stderr.write(
      `\n❌ Tools declared by client but NOT exposed by server ` +
        `(${realMissingInServer.length}):\n`,
    );
    for (const t of realMissingInServer) process.stderr.write(`   - ${t}\n`);
    process.stderr.write(
      '   These calls will fail at the HTTP layer. Remove them from the client.\n',
    );
  }

  if (failed) {
    process.exit(1);
  }
  process.stdout.write('✓ no drift\n');
}

main().catch((err) => {
  process.stderr.write(`tool-registry-drift: fatal: ${err.message}\n`);
  process.exit(2);
});
