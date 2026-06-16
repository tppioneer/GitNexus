/**
 * Query-time recommend_repo implementation.
 *
 * Opens the global repo-index.lbug read-only, embeds the user query,
 * runs cosine-similarity vector search, merges segment-level results
 * into repo-level rankings, and returns the top-k.
 */

import { getGlobalDir } from '../../storage/repo-manager.js';
import {
  openForRead,
  closeForRead,
  type ReadHandle,
} from './db.js';
import { embedQuery } from './embed.js';

export interface RepoRecommendation {
  name: string;
  repoPath: string;
  score: number;
}

export async function recommendRepos(
  params: Record<string, unknown>,
): Promise<{ results: RepoRecommendation[] } | { error: string }> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return { error: 'query parameter is required and cannot be empty.' };
  }

  const topK = clampTopK(params.top_k);

  const globalDir = getGlobalDir();

  let handle: ReadHandle | null;
  try {
    handle = await openForRead(globalDir);
  } catch {
    return { results: [] };
  }

  if (!handle) {
    return { results: [] };
  }

  try {
    // 1. Embed the query
    let queryVec: number[];
    try {
      queryVec = await embedQuery(query);
    } catch (err: any) {
      return { error: `Failed to embed query: ${err.message}` };
    }
    const dims = queryVec.length;

    // 2. Try vector index first, fall back to exact scan
    let results: Array<{ name: string; repoPath: string; distance: number }>;

    try {
      results = await queryVectorIndex(handle, queryVec, dims, topK * 3);
    } catch {
      results = await queryExactScan(handle, queryVec, topK * 3);
    }

    // 3. Group by repo name, take best score per repo
    const merged = mergeByRepo(results, topK);

    return {
      results: merged.map((r) => ({
        name: r.name,
        repoPath: r.repoPath,
        score: Math.round((1 - r.distance) * 1000) / 1000,
      })),
    };
  } finally {
    await closeForRead(handle).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Vector index search
// ---------------------------------------------------------------------------

async function queryVectorIndex(
  handle: ReadHandle,
  queryVec: number[],
  dims: number,
  fetchLimit: number,
): Promise<Array<{ name: string; repoPath: string; distance: number }>> {
  const vecStr = `[${queryVec.join(',')}]`;
  const query = `
    CALL QUERY_VECTOR_INDEX('RepoDesc', 'repo_desc_idx',
      CAST(${vecStr} AS FLOAT[${dims}]), ${fetchLimit})
    YIELD node AS emb, distance
    WHERE distance < 0.5
    RETURN emb.name AS name, emb.repoPath AS repoPath, distance
    ORDER BY distance
  `;

  const result = await handle.conn.query(query);
  return await drainRows(result);
}

// ---------------------------------------------------------------------------
// Exact scan fallback
// ---------------------------------------------------------------------------

async function queryExactScan(
  handle: ReadHandle,
  queryVec: number[],
  limit: number,
): Promise<Array<{ name: string; repoPath: string; distance: number }>> {
  const result = await handle.conn.query(
    `MATCH (n:RepoDesc) RETURN n.name AS name, n.repoPath AS repoPath, n.embedding AS embedding`,
  );

  const rows = await drainRows(result);

  // Compute cosine distance in JS, rank, take top
  const scored = rows
    .map((row) => ({
      name: String(row.name ?? ''),
      repoPath: String(row.repoPath ?? ''),
      distance: cosineDistance(queryVec, (row.embedding as number[]) ?? []),
    }))
    .filter((r) => r.distance < 0.5)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);

  return scored;
}

// ---------------------------------------------------------------------------
// Merge segment-level results into repo-level top-k
// ---------------------------------------------------------------------------

function mergeByRepo(
  rows: Array<{ name: string; repoPath: string; distance: number }>,
  topK: number,
): Array<{ name: string; repoPath: string; distance: number }> {
  const best = new Map<string, { name: string; repoPath: string; distance: number }>();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    const existing = best.get(key);
    if (!existing || r.distance < existing.distance) {
      best.set(key, r);
    }
  }
  return Array.from(best.values())
    .sort((a, b) => a.distance - b.distance)
    .slice(0, topK);
}

// ---------------------------------------------------------------------------
// Cosine distance (same formula as core/embeddings/exact-search.ts)
// ---------------------------------------------------------------------------

function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  if (aNorm === 0 || bNorm === 0) return 1;
  return 1 - dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampTopK(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(1, Math.min(20, Math.floor(raw)));
  }
  return 3;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function drainRows(result: any): Promise<any[]> {
  const rows: any[] = [];
  try {
    while (true) {
      const row = await result.next();
      if (row === undefined) break;
      rows.push(row);
    }
  } catch {
    /* exhaustion */
  }
  return rows;
}
