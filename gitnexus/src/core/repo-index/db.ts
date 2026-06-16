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
import { randomBytes } from 'node:crypto';
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

async function removeLbugFile(basePath: string): Promise<void> {
  const candidates = [basePath, ...SIDECAR_SUFFIXES.map((s) => `${basePath}${s}`)];
  await Promise.allSettled(candidates.map((f) => fs.rm(f, { force: true }).catch(() => {})));
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

  // Remove stale sidecars that could cause database-ID mismatch
  await removeLbugFile(indexPath);

  const { db, conn } = await openLbugConnection(lbug, indexPath);

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

  const { db, conn } = await openLbugConnection(lbug, indexPath);

  // Version gate: stale schema → return null so caller can rebuild
  try {
    const metaRaw = await fs.readFile(getMetaPath(globalDir), 'utf-8');
    const meta = JSON.parse(metaRaw);
    if (meta.version !== REPO_INDEX_SCHEMA_VERSION) return null;
  } catch {
    // meta.json missing or unreadable
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
