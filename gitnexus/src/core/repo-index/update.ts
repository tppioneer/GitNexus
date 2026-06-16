/**
 * Analyze-time hook: update a single repo's description in the global index.
 *
 * Called from run-analyze.ts after runFullAnalysis completes (best-effort).
 * Never throws — failures are logged but never block the analyze pipeline.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getGlobalDir } from '../../storage/repo-manager.js';
import { embedText } from './embed.js';
import { chunkMarkdown } from './chunk.js';
import { openForWrite, closeForWrite, ensureVectorIndex, writeMeta, readMeta } from './db.js';

export async function updateRepoInIndex(
  repoPath: string,
): Promise<void> {
  const descPath = path.join(repoPath, '.gitnexus', 'REPO_DESC.md');

  // Check if this repo has a description file
  let raw: string;
  try {
    raw = await fs.readFile(descPath, 'utf-8');
  } catch {
    return; // No REPO_DESC.md — nothing to index
  }

  if (!raw.trim()) return;

  const segments = chunkMarkdown(raw);
  if (segments.length === 0) return;

  const globalDir = getGlobalDir();

  let handle;
  try {
    handle = await openForWrite(globalDir);

    // Remove old rows for this repo (upsert = DELETE + INSERT)
    const repoName = path.basename(path.resolve(repoPath));
    try {
      await handle.conn.query(
        `MATCH (n:RepoDesc) WHERE n.name = $name DELETE n`,
        { name: repoName },
      );
    } catch {
      // Table may not exist yet — schema bootstrap in openForWrite handles this
    }

    // Insert new segments
    const now = new Date().toISOString();
    for (const seg of segments) {
      const vec = await embedText(seg.content);
      const id = `${repoName}:${seg.index}`;

      await handle.conn.query(
        `CREATE (n:RepoDesc {
          id: $id,
          name: $name,
          repoPath: $repoPath,
          segmentIndex: $segmentIndex,
          segmentTitle: $segmentTitle,
          content: $content,
          embedding: $embedding,
          indexedAt: $indexedAt
        })`,
        {
          id,
          name: repoName,
          repoPath: path.resolve(repoPath),
          segmentIndex: seg.index,
          segmentTitle: seg.title,
          content: seg.content.length > 2000 ? seg.content.slice(0, 2000) + '...' : seg.content,
          embedding: vec,
          indexedAt: now,
        },
      );
    }

    // Ensure vector index exists (idempotent)
    await ensureVectorIndex(handle);

    // Update meta
    const prevMeta = await readMeta(globalDir);
    // Count distinct repos in the index
    const countResult = await handle.conn.query(
      `MATCH (n:RepoDesc) RETURN COUNT(DISTINCT n.name) AS cnt`,
    );
    const rows = await drainQuery(countResult);
    const repoCount = Number(rows[0]?.cnt ?? 0);

    await writeMeta(globalDir, {
      version: 1,
      repoCount,
      updatedAt: now,
    });
  } finally {
    if (handle) await closeForWrite(handle).catch(() => {});
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function drainQuery(result: any): Promise<any[]> {
  const rows: any[] = [];
  try {
    while (true) {
      const row = await result.next();
      if (row === undefined) break;
      rows.push(row);
    }
  } catch {
    /* some drivers throw on exhaustion */
  }
  return rows;
}
