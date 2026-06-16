/**
 * Repo-index LadybugDB lifecycle.
 *
 * Global singleton database at ~/.gitnexus/repo-index.lbug, separate from
 * per-repo knowledge graphs. Uses the bridge-db pattern of native
 * openLbugConnection / closeLbugConnection rather than the pool adapter.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import {
  openLbugConnection,
  closeLbugConnection,
  type LbugConnectionHandle,
} from '../lbug/lbug-config.js';
import {
  REPO_INDEX_SCHEMA_QUERIES,
  REPO_INDEX_SCHEMA_VERSION,
  CREATE_VECTOR_INDEX_QUERY,
} from './schema.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getRepoIndexPath(globalDir: string): string {
  return path.join(globalDir, 'repo-index.lbug');
}

function getMetaPath(globalDir: string): string {
  return path.join(globalDir, 'repo-index-meta.json');
}

// ---------------------------------------------------------------------------
// Sidecar management (mirrors bridge-db)
// ---------------------------------------------------------------------------

const SIDECAR_SUFFIXES = ['.wal', '.shadow'] as const;
const OPEN_RETRY_ATTEMPTS = 5;
const OPEN_RETRY_DELAY_MS = 75;

async function removeLbugSidecars(basePath: string): Promise<void> {
  await Promise.allSettled(
    SIDECAR_SUFFIXES.map((s) => fs.rm(`${basePath}${s}`, { force: true }).catch(() => {})),
  );
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

async function ensureSchema(
  conn: lbug.Connection,
): Promise<void> {
  for (const q of REPO_INDEX_SCHEMA_QUERIES) {
    try {
      await conn.query(q);
    } catch (err: any) {
      if (!err.message?.includes('already exists')) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Write path (analyze-time)
// ---------------------------------------------------------------------------

export interface WriteHandle {
  db: lbug.Database;
  conn: lbug.Connection;
  indexPath: string;
}

export async function openForWrite(globalDir: string): Promise<WriteHandle> {
  const indexPath = getRepoIndexPath(globalDir);

  // Ensure parent directory
  await fs.mkdir(globalDir, { recursive: true });

  // Remove stale sidecars that could cause database-ID mismatch while keeping
  // the materialized global evidence index itself intact across repo updates.
  await removeLbugSidecars(indexPath);

  const { db, conn } = await openWithRetry(indexPath);

  try {
    await ensureSchema(conn);
  } catch (err) {
    await closeLbugConnection({ db, conn }).catch(() => {});
    throw err;
  }

  return { db, conn, indexPath };
}

export async function closeForWrite(handle: WriteHandle): Promise<void> {
  try {
    await handle.conn.query('CHECKPOINT');
  } catch {}
  try {
    await handle.conn.close();
  } catch {}
  try {
    await handle.db.close();
  } catch {}
}

export async function ensureVectorIndex(handle: WriteHandle): Promise<void> {
  try {
    await handle.conn.query(CREATE_VECTOR_INDEX_QUERY);
  } catch (err: any) {
    if (!err.message?.includes('already exists')) throw err;
  }
}

// ---------------------------------------------------------------------------
// Read path (MCP query-time)
// ---------------------------------------------------------------------------

export interface ReadHandle {
  db: lbug.Database;
  conn: lbug.Connection;
}

export async function openForRead(globalDir: string): Promise<ReadHandle | null> {
  const indexPath = getRepoIndexPath(globalDir);

  try {
    await fs.access(indexPath);
  } catch {
    return null; // DB not yet built — no repos have REPO_DESC.md
  }

  const { db, conn } = await openWithRetry(indexPath, { readOnly: true });

  // Version gate: stale schema → return null so caller can rebuild
  try {
    const metaRaw = await fs.readFile(getMetaPath(globalDir), 'utf-8');
    const meta = JSON.parse(metaRaw);
    if (meta.version !== REPO_INDEX_SCHEMA_VERSION) {
      await closeLbugConnection({ db, conn }).catch(() => {});
      return null;
    }
  } catch {
    await closeLbugConnection({ db, conn }).catch(() => {});
    return null;
  }

  return { db, conn };
}

export async function closeForRead(handle: ReadHandle): Promise<void> {
  try {
    await handle.conn.close();
  } catch {}
  try {
    await handle.db.close();
  } catch {}
}

async function openWithRetry(
  indexPath: string,
  options?: { readOnly?: boolean },
): Promise<LbugConnectionHandle> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= OPEN_RETRY_ATTEMPTS; attempt++) {
    try {
      return await openLbugConnection(lbug, indexPath, options);
    } catch (err) {
      lastErr = err;
      if (!isTransientOpenError(err) || attempt === OPEN_RETRY_ATTEMPTS) break;
      await delay(OPEN_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

function isTransientOpenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /lock|busy|Error:\s*33|database is locked/i.test(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Meta management
// ---------------------------------------------------------------------------

export interface RepoIndexMeta {
  version: number;
  repoCount: number;
  updatedAt: string;
}

export async function readMeta(globalDir: string): Promise<RepoIndexMeta | null> {
  try {
    const raw = await fs.readFile(getMetaPath(globalDir), 'utf-8');
    return JSON.parse(raw) as RepoIndexMeta;
  } catch {
    return null;
  }
}

export async function writeMeta(
  globalDir: string,
  meta: RepoIndexMeta,
): Promise<void> {
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(getMetaPath(globalDir), JSON.stringify(meta, null, 2));
}
