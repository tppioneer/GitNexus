import { getGlobalDir } from '../../storage/repo-manager.js';
import { embedBatch } from './embed.js';
import { openForWrite, closeForWrite, ensureVectorIndex, writeMeta } from './db.js';
import {
  evidenceEmbeddingText,
  type EvidenceUpsertScope,
  type RepoEvidenceDocument,
} from './evidence-types.js';
import { REPO_INDEX_SCHEMA_VERSION, REPO_EVIDENCE_TABLE_NAME } from './schema.js';

const EVIDENCE_EMBED_BATCH_SIZE = 64;

export async function upsertRepoEvidence(
  scope: EvidenceUpsertScope,
  docs: RepoEvidenceDocument[],
): Promise<void> {
  const globalDir = getGlobalDir();
  let handle;

  try {
    handle = await openForWrite(globalDir);
    await deleteScope(handle.conn, scope);

    if (docs.length > 0) {
      const indexedAt = new Date().toISOString();
      for (let offset = 0; offset < docs.length; offset += EVIDENCE_EMBED_BATCH_SIZE) {
        const batch = docs.slice(offset, offset + EVIDENCE_EMBED_BATCH_SIZE);
        const embeddings = await embedBatch(batch.map(evidenceEmbeddingText)).catch(() =>
          batch.map(() => zeroEmbedding()),
        );

        for (let i = 0; i < batch.length; i++) {
          await insertEvidence(handle.conn, batch[i], embeddings[i], indexedAt);
        }
      }
    }

    // Some supported environments do not have LadybugDB VECTOR enabled. The
    // query path already falls back to exact scan, so missing HNSW support must
    // not invalidate the materialized evidence index.
    await ensureVectorIndex(handle).catch(() => {});
    await writeMeta(globalDir, {
      version: REPO_INDEX_SCHEMA_VERSION,
      repoCount: await countRepos(handle.conn),
      updatedAt: new Date().toISOString(),
    });
  } finally {
    if (handle) await closeForWrite(handle).catch(() => {});
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertEvidence(
  conn: any,
  doc: RepoEvidenceDocument,
  embedding: number[],
  indexedAt: string,
): Promise<void> {
  await conn.query(
    `CREATE (n:${REPO_EVIDENCE_TABLE_NAME} {
      id: ${q(doc.id)},
      repoName: ${q(doc.repoName)},
      repoPath: ${q(doc.repoPath)},
      groupName: ${q(doc.groupName ?? '')},
      groupRepoPath: ${q(doc.groupRepoPath ?? '')},
      service: ${q(doc.service ?? '')},
      source: ${q(doc.source)},
      kind: ${q(doc.kind)},
      role: ${q(doc.role ?? '')},
      title: ${q(doc.title)},
      content: ${q(doc.content)},
      sourcePath: ${q(doc.sourcePath ?? '')},
      symbolUid: ${q(doc.symbolUid ?? '')},
      symbolName: ${q(doc.symbolName ?? '')},
      confidence: ${Number(doc.confidence ?? 1)},
      metadata: ${q(JSON.stringify(doc.metadata ?? {}))},
      embedding: ${vectorLiteral(embedding)},
      indexedAt: ${q(indexedAt)}
    })`,
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deleteScope(conn: any, scope: EvidenceUpsertScope): Promise<void> {
  if (scope.repoName) {
    await conn.query(
      `MATCH (n:${REPO_EVIDENCE_TABLE_NAME}) WHERE n.source = ${q(scope.source)} AND n.repoName = ${q(scope.repoName)} DELETE n`,
    );
    return;
  }

  if (scope.groupName) {
    await conn.query(
      `MATCH (n:${REPO_EVIDENCE_TABLE_NAME}) WHERE n.source = ${q(scope.source)} AND n.groupName = ${q(scope.groupName)} DELETE n`,
    );
  }
}

function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

function vectorLiteral(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}

function zeroEmbedding(): number[] {
  return Array.from({ length: 384 }, () => 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function countRepos(conn: any): Promise<number> {
  const result = await conn.query(
    `MATCH (n:${REPO_EVIDENCE_TABLE_NAME}) RETURN COUNT(DISTINCT n.repoName) AS cnt`,
  );
  const rows = await drainQuery(result);
  return Number(rows[0]?.cnt ?? rows[0]?.[0] ?? 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function drainQuery(result: any): Promise<any[]> {
  if (typeof result.getAll === 'function') {
    return await result.getAll();
  }
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
