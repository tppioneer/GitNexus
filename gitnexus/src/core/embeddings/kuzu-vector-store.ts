import {
  type VectorStore,
  type VectorRecord,
  type VectorSearchResult,
  type VectorStoreCachedEmbedding,
} from './vector-store.js';
import {
  EMBEDDING_TABLE_NAME,
  EMBEDDING_INDEX_NAME,
  CREATE_VECTOR_INDEX_QUERY,
  STALE_HASH_SENTINEL,
} from '../lbug/schema.js';
import { loadVectorExtension } from '../lbug/lbug-adapter.js';
import { getExactScanLimit } from '../platform/capabilities.js';
import { rankExactEmbeddingRows, type ExactEmbeddingRow } from './exact-search.js';
import { collectBestChunks } from './types.js';
import type { ExtensionInstallPolicy } from '../lbug/extension-loader.js';
import { logger } from '../logger.js';

export class KuzuVectorStore implements VectorStore {
  private _ready = false;
  private _executeQuery: ((cypher: string) => Promise<any[]>) | null = null;
  private _executeWithReusedStatement: ((cypher: string, paramsList: Array<Record<string, any>>) => Promise<void>) | null = null;

  setExecutors(
    executeQuery: (cypher: string) => Promise<any[]>,
    executeWithReusedStatement: (cypher: string, paramsList: Array<Record<string, any>>) => Promise<void>,
  ): void {
    this._executeQuery = executeQuery;
    this._executeWithReusedStatement = executeWithReusedStatement;
  }

  private get execQuery(): (cypher: string) => Promise<any[]> {
    if (!this._executeQuery) {
      throw new Error('KuzuVectorStore not connected. Call setExecutors first.');
    }
    return this._executeQuery;
  }

  private get execReused(): (cypher: string, paramsList: Array<Record<string, any>>) => Promise<void> {
    if (!this._executeWithReusedStatement) {
      throw new Error('KuzuVectorStore not connected. Call setExecutors first.');
    }
    return this._executeWithReusedStatement;
  }

  async insert(records: VectorRecord[]): Promise<void> {
    const cypher = `CREATE (e:${EMBEDDING_TABLE_NAME} {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, startLine: $startLine, endLine: $endLine, embedding: $embedding, contentHash: $contentHash})`;
    const paramsList = records.map((u) => ({
      id: `${u.nodeId}:${u.chunkIndex}`,
      nodeId: u.nodeId,
      chunkIndex: u.chunkIndex,
      startLine: u.startLine,
      endLine: u.endLine,
      embedding: u.embedding,
      contentHash: u.contentHash ?? STALE_HASH_SENTINEL,
    }));
    await this.execReused(cypher, paramsList);
  }

  async deleteByNodeIds(nodeIds: string[], _repoName?: string): Promise<void> {
    if (nodeIds.length === 0) return;
    try {
      await this.execReused(
        `MATCH (e:${EMBEDDING_TABLE_NAME} {nodeId: $nodeId}) DELETE e`,
        nodeIds.map((nodeId) => ({ nodeId })),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('does not exist')) {
        throw new Error(
          `[embed] Failed to delete stale embedding rows — aborting to prevent vector-index corruption: ${msg}`,
        );
      }
    }
  }

  async createIndex(): Promise<boolean> {
    if (!(await this.ensureVectorExtension())) return false;
    try {
      await this.execQuery(CREATE_VECTOR_INDEX_QUERY);
      return true;
    } catch {
      return false;
    }
  }

  async search(
    queryVector: number[],
    topK: number,
    _repoName?: string,
    maxDistance: number = 0.5,
  ): Promise<VectorSearchResult[]> {
    const queryVecStr = `[${queryVector.join(',')}]`;

    let bestChunks = new Map<
      string,
      { distance: number; chunkIndex: number; startLine: number; endLine: number }
    >();

    if (await loadVectorExtension(undefined, { policy: 'load-only' })) {
      try {
        bestChunks = await collectBestChunks(topK, async (fetchLimit) => {
          const vectorQuery = `
            CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
              CAST(${queryVecStr} AS FLOAT[${queryVector.length}]), ${fetchLimit})
            YIELD node AS emb, distance
            WITH emb, distance
            WHERE distance < ${maxDistance}
            RETURN emb.nodeId AS nodeId, emb.chunkIndex AS chunkIndex,
                   emb.startLine AS startLine, emb.endLine AS endLine, distance
            ORDER BY distance
          `;

          const embResults = await this.execQuery(vectorQuery);
          return embResults.map((row) => ({
            nodeId: row.nodeId ?? row[0],
            chunkIndex: row.chunkIndex ?? row[1] ?? 0,
            startLine: row.startLine ?? row[2] ?? 0,
            endLine: row.endLine ?? row[3] ?? 0,
            distance: row.distance ?? row[4],
          }));
        });
      } catch {
        bestChunks = new Map();
      }
    }

    if (bestChunks.size === 0) {
      const countRows = await this.execQuery(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
      );
      const countRow = countRows[0];
      const embeddingCount = Number(countRow?.cnt ?? countRow?.[0] ?? 0);
      const exactLimit = getExactScanLimit();
      if (embeddingCount > 0 && embeddingCount <= exactLimit) {
        const rows = await this.execQuery(`
          MATCH (e:${EMBEDDING_TABLE_NAME})
          RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex,
                 e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding
        `);
        const exactRows: ExactEmbeddingRow[] = rows.map((row) => ({
          nodeId: row.nodeId ?? row[0],
          chunkIndex: row.chunkIndex ?? row[1] ?? 0,
          startLine: row.startLine ?? row[2] ?? 0,
          endLine: row.endLine ?? row[3] ?? 0,
          embedding: row.embedding ?? row[4] ?? [],
        }));
        bestChunks = new Map(
          rankExactEmbeddingRows(exactRows, queryVector, topK, maxDistance).map((row) => [
            row.nodeId,
            {
              distance: row.distance,
              chunkIndex: row.chunkIndex,
              startLine: row.startLine,
              endLine: row.endLine,
            },
          ]),
        );
      }
    }

    return Array.from(bestChunks.entries()).slice(0, topK).map(([nodeId, chunk]) => ({
      nodeId,
      chunkIndex: chunk.chunkIndex,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      distance: chunk.distance,
    }));
  }

  async count(_repoName?: string): Promise<number> {
    const rows = await this.execQuery(
      `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
    );
    const row = rows[0];
    return Number(row?.cnt ?? row?.[0] ?? 0);
  }

  async getExistingHashes(_repoName?: string): Promise<Map<string, string>> {
    try {
      const rows = await this.execQuery(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.contentHash AS contentHash`,
      );
      if (!rows || rows.length === 0) return new Map();
      const map = new Map<string, string>();
      for (const r of rows) {
        const nodeId = r.nodeId ?? r[0];
        const chunkIndex = r.chunkIndex ?? r[1];
        const startLine = r.startLine ?? r[2];
        const endLine = r.endLine ?? r[3];
        const hash = r.contentHash ?? r[4] ?? STALE_HASH_SENTINEL;
        if (nodeId) {
          const hasChunkMetadata =
            chunkIndex !== undefined &&
            chunkIndex !== null &&
            startLine !== undefined &&
            startLine !== null &&
            endLine !== undefined &&
            endLine !== null;
          map.set(nodeId, hasChunkMetadata && hash ? hash : STALE_HASH_SENTINEL);
        }
      }
      return map;
    } catch {
      return new Map();
    }
  }

  async loadAll(_repoName?: string): Promise<VectorStoreCachedEmbedding[]> {
    const embeddings: VectorStoreCachedEmbedding[] = [];
    try {
      let rows: any;
      let hasContentHash = true;
      try {
        rows = await this.execQuery(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding, e.contentHash AS contentHash`,
        );
      } catch {
        hasContentHash = false;
        rows = await this.execQuery(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding`,
        );
      }
      for (const row of rows) {
        const nodeId = String(row.nodeId ?? row[0] ?? '');
        if (!nodeId) continue;
        const embedding = row.embedding ?? row[4];
        if (embedding) {
          embeddings.push({
            nodeId,
            chunkIndex: Number(row.chunkIndex ?? row[1] ?? 0),
            startLine: Number(row.startLine ?? row[2] ?? 0),
            endLine: Number(row.endLine ?? row[3] ?? 0),
            embedding: Array.isArray(embedding)
              ? embedding.map(Number)
              : Array.from(embedding as any).map(Number),
            contentHash: hasContentHash ? (row.contentHash ?? row[5] ?? undefined) : undefined,
          });
        }
      }
    } catch {
      /* embedding table may not exist */
    }
    return embeddings;
  }

  isReady(): boolean {
    return this._ready;
  }

  async dispose(): Promise<void> {
    this._ready = false;
    this._executeQuery = null;
    this._executeWithReusedStatement = null;
  }

  private async ensureVectorExtension(): Promise<boolean> {
    const raw = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    const policy: ExtensionInstallPolicy =
      raw === 'load-only' || raw === 'never' || raw === 'auto' ? raw : 'auto';
    return loadVectorExtension(undefined, { policy });
  }
}
