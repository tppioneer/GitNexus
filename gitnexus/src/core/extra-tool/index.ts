/**
 * Extra MCP Tools
 *
 * Self-contained tool definitions + implementations that are imported and
 * wired into the MCP server with minimal changes to existing code.
 *
 * Each tool lives in its own file; the barrel export below is the single
 * import surface for mcp/tools.ts (schema) and mcp/local/local-backend.ts
 * (implementation).
 */

export { READ_REMOTE_FILE_TOOL, readRemoteFileContent } from './read-remote-file.js';
