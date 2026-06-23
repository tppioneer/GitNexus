/**
 * read_remote_file Tool
 *
 * Definition and implementation for the GitNexus MCP tool that reads source
 * files from an indexed repository on the server side. This bridges the gap
 * between graph exploration (query / context / trace) and reading actual
 * implementation code — especially critical in remote-deployment mode where
 * source files are not available on the client machine.
 *
 * Tool schema lives here (not in mcp/tools.ts) so that every new extra tool
 * is self-contained in one directory. mcp/tools.ts imports and pushes the
 * definition; mcp/local/local-backend.ts imports the implementation function.
 */

import fs from 'fs/promises';
import path from 'path';

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../core/logger.js';
import type { ToolDefinition } from '../../mcp/tools.js';

// ─── Annotations ────────────────────────────────────────────────────────

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// ─── Constants ──────────────────────────────────────────────────────────

/** Max candidates for suffix-based fallback search. Beyond this we stop
 *  scanning and return the ambiguous list rather than burning I/O on a
 *  very common suffix. */
const FALLBACK_MAX_CANDIDATES = 20;

/** Max file size in bytes (1 MiB). Larger files are rejected with a hint
 *  to use start_line / end_line. */
const MAX_FILE_SIZE = 1_048_576;

/** Max files visited during suffix-based fallback search. Prevents
 *  unbounded tree walks on misspelled filenames in very large repos. */
const MAX_VISITED_FILES = 50_000;

/** Directories skipped during suffix-based file search.
 *  All entries are lowercase for case-insensitive comparison. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '__pycache__',
  'target',          // Rust
  'vendor',          // PHP / Go
  '.terraform',
  '.cache',
  '.idea',
  '.vscode',
  'coverage',
  '.nyc_output',
  'out',
  'bin',
  'obj',
  'venv',
  '.venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'bazel-bin',
  'bazel-out',
  'bazel-testlogs',
  '.gradle',
  '.mvn',
]);

// ─── Tool Schema ────────────────────────────────────────────────────────

export const READ_REMOTE_FILE_TOOL: ToolDefinition = {
  name: 'read_remote_file',
  description: `Read a source file from the indexed repository on the remote server.

WHEN TO USE: The last step in the exploration workflow — after query() / context() / trace() identified relevant source files via the knowledge graph, use this tool to read their implementation details. The graph tells you WHERE the code is; read_remote_file lets you read WHAT it says.

Returns the file content as a Markdown code block with line numbers. Use start_line / end_line to limit output for large files.

AFTER THIS: Use context() to dive deeper into symbols found in the file, or impact() to assess the blast radius of planned changes.`,
  annotations: READ_ONLY,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Relative file path within the repository (e.g., "src/payments/processor.ts"). Must point to a file inside the indexed repo.',
      },
      repo: {
        type: 'string',
        description:
          'Repository name or path. Omit when only one repo is indexed.',
      },
      start_line: {
        type: 'integer',
        minimum: 1,
        description:
          'First line to return (1-based, inclusive). Omit to start from line 1.',
      },
      end_line: {
        type: 'integer',
        minimum: 1,
        description:
          'Last line to return (1-based, inclusive). Omit to read to end of file.',
      },
    },
    required: ['file_path'],
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Recursively walk `root` and collect files whose path ends with `suffix`.
 *
 * Stops early once `maxCandidates + 1` hits are found (the +1 lets us detect
 * ambiguity without scanning the entire tree). Also stops after visiting
 * `maxVisited` files to prevent unbounded walks on very large repos.
 */
async function findFilesBySuffix(
  root: string,
  suffix: string,
  maxCandidates: number,
  maxVisited: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const results: string[] = [];
  let visited = 0;
  let hitCandidateLimit = false;
  let permissionErrors = 0;
  const normalizedSuffix = suffix.replace(/\\/g, '/');

  async function walk(dir: string): Promise<void> {
    // Guard: stop scanning when we already have enough candidates to detect
    // ambiguity, or when the visit budget is exhausted.
    if (results.length > maxCandidates) {
      hitCandidateLimit = true;
      return;
    }
    if (visited >= maxVisited) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length > maxCandidates) {
          hitCandidateLimit = true;
          return;
        }
        if (visited >= maxVisited) return;

        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
          await walk(path.join(dir, entry.name));
          continue;
        }

        if (!entry.isFile()) continue;

        visited++;
        const fullPath = path.join(dir, entry.name);
        const normalized = fullPath.replace(/\\/g, '/');
        if (normalized.endsWith(normalizedSuffix)) {
          results.push(fullPath);
        }
      }
    } catch {
      // Permission errors, broken symlinks, etc. — skip silently but track
      // for the summary log.
      permissionErrors++;
      return;
    }
  }

  await walk(root);

  const truncated = visited >= maxVisited;
  logger.debug(
    {
      suffix: normalizedSuffix,
      candidates: results.length,
      visited,
      hitCandidateLimit,
      truncated,
      permissionErrors,
    },
    'findFilesBySuffix: walk complete',
  );

  return { files: results, truncated };
}

/**
 * Render file content as a Markdown code block with line numbers.
 */
function formatFileContent(
  displayPath: string,
  content: string,
  startLine?: number,
  endLine?: number,
): string {
  const lang = path.extname(displayPath).replace(/^\./, '') || 'text';
  // Split and strip trailing empty line so that files ending with \n
  // report the correct total line count.
  const rawLines = content.split('\n');
  const trailingEmpty =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === '';
  const totalLines = trailingEmpty ? rawLines.length - 1 : rawLines.length;

  const startIdx = (startLine ?? 1) - 1;
  const endIdx = endLine ?? totalLines;
  // Guard: when start_line exceeds the actual file length, return empty
  // slice rather than letting Array.slice clamp silently.
  const sliced =
    startIdx < totalLines ? rawLines.slice(startIdx, endIdx) : [];

  if (startIdx >= totalLines && (startLine != null || endLine != null)) {
    logger.debug(
      { displayPath, startLine, endLine, totalLines },
      'formatFileContent: requested line range is past end of file',
    );
  }

  const lineStart = startLine ?? 1;
  const numbered = sliced
    .map((line, i) => `${String(lineStart + i).padStart(4, ' ')}| ${line}`)
    .join('\n');

  const shownLines = sliced.length;
  const rangeNote =
    startLine || endLine
      ? ` (lines ${lineStart}–${lineStart + shownLines - 1} of ${totalLines})`
      : ` (${totalLines} lines total)`;

  return [
    `## \`${displayPath}\`${rangeNote}`,
    '',
    '```' + lang,
    numbered,
    '```',
  ].join('\n');
}

/**
 * Validate, resolve, and read a file at `absPath` within `repoPath`.
 *
 * Performs:
 * 1. Stat + size check (rejects files > maxBytes)
 * 2. Realpath resolution + path-traversal guard (symlink-safe)
 * 3. Binary detection (rejects files with null bytes)
 * 4. UTF-8 read
 *
 * Returns the decoded content and its byte length.
 */
async function readFileSafe(
  absPath: string,
  repoPath: string,
  maxBytes: number,
): Promise<{ content: string; byteLength: number }> {
  // 1. Stat and size check.
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    logger.warn(
      { absPath, statMode: stat.mode },
      'readFileSafe: path is not a regular file',
    );
    throw new Error(`Not a regular file: "${absPath}"`);
  }
  if (stat.size > maxBytes) {
    logger.warn(
      { absPath, fileSize: stat.size, maxBytes },
      'readFileSafe: file exceeds size limit',
    );
    throw new Error(
      `File too large (${(stat.size / 1_048_576).toFixed(1)} MiB). ` +
        `Use start_line and end_line to read a portion of the file.`,
    );
  }

  // 2. Resolve symlinks and re-verify the real path is still inside the
  //    repo tree.  `path.resolve` alone does NOT resolve symlinks, so a
  //    symlink pointing outside the repo would pass the initial string-
  //    prefix check in `readRemoteFileContent`.
  let realPath: string;
  try {
    realPath = await fs.realpath(absPath);
  } catch (err: any) {
    // Preserve ENOENT so the exact-lookup catch block in
    // readRemoteFileContent can fall through to suffix search.
    if (err.code === 'ENOENT') {
      logger.debug(
        { absPath },
        'readFileSafe: file vanished between stat and realpath (ENOENT), propagating for fallback',
      );
      throw err;
    }
    logger.warn(
      { absPath, errCode: err.code, errMessage: err.message },
      'readFileSafe: realpath resolution failed',
    );
    throw new Error(
      `Cannot resolve real path for "${absPath}": ${err.message || err}`,
    );
  }

  const normalizedRepo = path.resolve(repoPath) + path.sep;
  if (!realPath.startsWith(normalizedRepo)) {
    logger.warn(
      { requested: absPath, resolved: realPath, repoRoot: normalizedRepo },
      'read_remote_file: symlink escapes repo root',
    );
    throw new Error(
      `Access denied: "${absPath}" resolves outside the repository root via symlink`,
    );
  }

  // 3. Read as buffer for binary detection.
  let buf: Buffer;
  try {
    buf = await fs.readFile(realPath);
  } catch (err: any) {
    logger.warn(
      { realPath, errCode: err.code, errMessage: err.message },
      'readFileSafe: readFile failed',
    );
    throw err;
  }
  if (buf.includes(0)) {
    logger.warn(
      { realPath, fileSize: buf.length },
      'readFileSafe: binary file detected (contains null bytes)',
    );
    throw new Error(
      `File appears to be binary (contains null bytes). ` +
        `read_remote_file only supports text files.`,
    );
  }

  // 4. Decode.
  const content = buf.toString('utf-8');
  const byteLength = buf.length;
  return { content, byteLength };
}

// ─── Main Export ────────────────────────────────────────────────────────

/**
 * Read a source file from the indexed repository root.
 *
 * When the exact `repoPath + file_path` doesn't exist, performs a
 * suffix-based fallback search inside the repo tree (skipping
 * `node_modules`, `.git`, build output dirs, etc.).  Behaviour:
 * - 1 match  → return the file content (with resolved display path).
 * - 2+ matches → return a candidate list so the AI can pick one.
 * - 0 matches → throw "file not found".
 *
 * @param repoPath  Absolute path to the repository root (already resolved by
 *                  `LocalBackend.resolveRepo()`).
 * @param params    Tool call arguments: `file_path` plus optional line range.
 * @returns         Markdown-formatted file content with line numbers,
 *                  or a candidate-selection message.
 */
export async function readRemoteFileContent(
  repoPath: string,
  params: { file_path: string; start_line?: number; end_line?: number },
): Promise<string> {
  logger.info(
    {
      file_path: params.file_path,
      start_line: params.start_line,
      end_line: params.end_line,
    },
    'read_remote_file request',
  );

  // 0. Validate line range.
  if (
    params.start_line != null &&
    params.end_line != null &&
    params.start_line > params.end_line
  ) {
    logger.warn(
      { start_line: params.start_line, end_line: params.end_line },
      'read_remote_file: start_line exceeds end_line, rejecting',
    );
    throw new Error(
      `start_line (${params.start_line}) must be <= end_line (${params.end_line})`,
    );
  }

  // 1. Resolve absolute path and validate it stays inside the repo tree
  //    (string-level check — the definitive symlink-safe check is inside
  //    `readFileSafe`).
  const normalizedRepo = path.resolve(repoPath) + path.sep;
  const absPath = path.resolve(repoPath, params.file_path);

  if (!absPath.startsWith(normalizedRepo)) {
    logger.warn(
      { file_path: params.file_path, resolved: absPath, repoRoot: normalizedRepo },
      'read_remote_file: path escapes repo root',
    );
    throw new Error(
      `Access denied: "${params.file_path}" resolves outside the repository root`,
    );
  }

  logger.debug({ absPath }, 'read_remote_file: attempting exact lookup');

  // 2. Try exact path first.
  try {
    const { content, byteLength } = await readFileSafe(
      absPath,
      repoPath,
      MAX_FILE_SIZE,
    );
    logger.info({ absPath, bytes: byteLength }, 'read_remote_file: exact hit');
    return formatFileContent(
      params.file_path,
      content,
      params.start_line,
      params.end_line,
    );
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      // Not a missing-file error — surface to the caller.
      throw err;
    }
    logger.debug(
      { file_path: params.file_path, absPath },
      'read_remote_file: exact path not found (ENOENT), falling back to suffix search',
    );
  }

  // 3. Fallback: suffix-based search inside the repo tree.
  logger.info(
    { file_path: params.file_path },
    'read_remote_file: exact miss, starting suffix fallback search',
  );
  const suffix = params.file_path.replace(/\\/g, '/');
  const { files: candidates, truncated } = await findFilesBySuffix(
    repoPath,
    suffix,
    FALLBACK_MAX_CANDIDATES,
    MAX_VISITED_FILES,
  );

  logger.info(
    { candidateCount: candidates.length, truncated },
    'read_remote_file: fallback search complete',
  );

  if (candidates.length === 0) {
    const truncatedNote = truncated
      ? ` (search truncated after ${MAX_VISITED_FILES} files — try a more specific path)`
      : '';
    logger.warn(
      { file_path: params.file_path },
      'read_remote_file: no matches in exact or fallback search',
    );
    throw new Error(
      `File not found: "${params.file_path}" (exact path and suffix search both failed)${truncatedNote}`,
    );
  }

  // Relative paths so the AI sees the path structure within the repo.
  const relativeCandidates = candidates.map((c) =>
    path.relative(repoPath, c).replace(/\\/g, '/'),
  );

  if (candidates.length > 1) {
    logger.info(
      {
        candidateCount: candidates.length,
        candidates: relativeCandidates,
        truncated,
        shownCount: Math.min(candidates.length, FALLBACK_MAX_CANDIDATES),
      },
      'read_remote_file: ambiguous fallback, returning candidate list',
    );
    // Slice to FALLBACK_MAX_CANDIDATES so the overflow message matches reality.
    const shown = relativeCandidates.slice(0, FALLBACK_MAX_CANDIDATES);
    const list = shown.map((c, i) => `  ${i + 1}. \`${c}\``).join('\n');
    const overflowNote =
      candidates.length > FALLBACK_MAX_CANDIDATES
        ? `\n（结果已截断，仅显示前 ${FALLBACK_MAX_CANDIDATES} 个，共 ${candidates.length} 个候选）`
        : '';
    const truncatedNote = truncated
      ? `\n（目录遍历已截断，结果可能不完整）`
      : '';
    return [
      `## 多个文件匹配 \`${params.file_path}\`（${candidates.length} 个候选）${overflowNote}${truncatedNote}`,
      '',
      `精确路径 \`${params.file_path}\` 不存在，但找到了以下同名文件。请用完整路径重新调用：`,
      '',
      list,
    ].join('\n');
  }

  // 4. Unique match — read and return.
  const resolvedPath = candidates[0];
  const displayPath = relativeCandidates[0];
  logger.info(
    { resolvedPath, displayPath },
    'read_remote_file: fallback unique match',
  );
  const { content, byteLength } = await readFileSafe(
    resolvedPath,
    repoPath,
    MAX_FILE_SIZE,
  );
  logger.info(
    { displayPath, bytes: byteLength },
    'read_remote_file: fallback hit',
  );
  return formatFileContent(
    displayPath,
    content,
    params.start_line,
    params.end_line,
  );
}
