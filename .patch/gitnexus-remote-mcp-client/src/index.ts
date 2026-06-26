#!/usr/bin/env node

/**
 * GitNexus Remote MCP Client
 *
 * A stdio-to-HTTP proxy that connects a local AI agent (Claude Code, Cursor,
 * etc.) to a remote GitNexus MCP server over Streamable HTTP.
 *
 * Purpose:
 *   When the indexed codebase lives on a remote server (not the AI agent's
 *   machine), this proxy bridges the gap: it speaks MCP stdio to the agent
 *   and forwards every request to the remote GitNexus HTTP endpoint.
 *   Tools are hardcoded in tools.ts (a curated subset of the server-side
 *   GITNEXUS_TOOLS); unknown tools are rejected locally before hitting the
 *   wire.
 *
 * Environment variables:
 *   GITNEXUS_REMOTE_URL — remote GitNexus HTTP server base URL
 *                         (falls back to http://localhost:4747/api/mcp)
 *
 * Usage:
 *   # Direct invocation
 *   gitnexus-remote-mcp-client --url http://192.168.1.100:4747/api/mcp
 *
 *   # Via environment variable
 *   GITNEXUS_REMOTE_URL=http://server:4747/api/mcp gitnexus-remote-mcp-client
 *
 *   # In Claude Code mcp.json
 *   {
 *     "gitnexus-remote": {
 *       "command": "node",
 *       "args": [".patch/gitnexus-remote-mcp-client/dist/index.js",
 *                "--url", "http://10.0.0.5:4747/api/mcp"]
 *     }
 *   }
 */

import { startProxyServer } from './proxy.js';

const DEFAULT_URL = 'http://localhost:4747/api/mcp';

function parseArgs(): { url: string } {
  const args = process.argv.slice(2);
  let url = process.env.GITNEXUS_REMOTE_URL || DEFAULT_URL;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--url' || args[i] === '-u') && i + 1 < args.length) {
      url = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { url };
}

function printHelp(): void {
  process.stderr.write(`gitnexus-remote-mcp-client — MCP stdio-to-HTTP proxy for remote GitNexus

Usage:
  gitnexus-remote-mcp-client [options]

Options:
  -u, --url <url>          Remote GitNexus HTTP server URL
                           (default: http://localhost:4747/api/mcp)
  -h, --help               Show this help message

Environment:
  GITNEXUS_REMOTE_URL      Remote GitNexus HTTP server URL (alternative to --url)

Examples:
  gitnexus-remote-mcp-client
  gitnexus-remote-mcp-client --url http://192.168.1.100:4747/api/mcp
  GITNEXUS_REMOTE_URL=http://server:4747/api/mcp gitnexus-remote-mcp-client
`);
}

async function main(): Promise<void> {
  const { url } = parseArgs();

  process.stderr.write(`gitnexus-remote-mcp-client: connecting to ${url}\n`);

  await startProxyServer({
    remoteUrl: url,
  });
}

main().catch((err) => {
  process.stderr.write(`gitnexus-remote-mcp-client: fatal error: ${err.message}\n`);
  process.exit(1);
});
