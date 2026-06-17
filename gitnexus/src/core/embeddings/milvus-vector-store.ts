import {
  type VectorStore,
  type VectorRecord,
  type VectorSearchResult,
  type VectorStoreCachedEmbedding,
} from './vector-store.js';
import type { MilvusConfig } from './vector-store-config.js';
import { sanitizeCollectionName } from './vector-store-config.js';
import { logger } from '../logger.js';

/** Escape double-quotes in a string for use in Milvus filter expressions. */
const escapeExpr = (s: string): string => s.replace(/"/g, '\\"');

interface MilvusClient {
  hasCollection: (params: { collection_name: string }) => Promise<{ value: boolean }>;
  createCollection: (params: {
    collection_name: string;
    fields: Array<{
      name: string;
      data_type: string;
      is_primary_key?: boolean;
      autoID?: boolean;
      dim?: number;
      max_length?: number;
    }>;
  }) => Promise<any>;
  createIndex: (params: {
    collection_name: string;
    field_name: string;
    index_name: string;
    params: Record<string, unknown>;
  }) => Promise<any>;
  loadCollectionSync: (params: { collection_name: string }) => Promise<any>;
  insert: (params: { collection_name: string; data: Record<string, unknown>[] }) => Promise<any>;
  delete: (params: { collection_name: string; filter: string }) => Promise<any>;
  search: (params: {
    collection_name: string;
    vector: number[];
    limit: number;
    output_fields: string[];
    params: Record<string, unknown>;
  }) => Promise<{ results: Array<Record<string, unknown> & { score?: number }> }>;
  query: (params: {
    collection_name: string;
    output_fields: string[];
    limit?: number;
  }) => Promise<{ data: Record<string, unknown>[] }>;
  count: (params: { collection_name: string }) => Promise<{ data: number }>;
  flushSync: (params: { collection_names: string[] }) => Promise<any>;
  close: () => Promise<void>;
  dropCollection: (params: { collection_name: string }) => Promise<any>;
}

/** Derive a per-repo collection name from the base prefix and repo name. */
const repoCollectionName = (baseName: string, repoName: string): string =>
  `${baseName}${sanitizeCollectionName(repoName, baseName.length)}`;

export class MilvusVectorStore implements VectorStore {
  private client: MilvusClient | null = null;
  private config: MilvusConfig;
  private _ready = false;
  /** Track which per-repo collections have already been created+indexed+loaded. */
  private _ensuredCollections = new Set<string>();

  constructor(config: MilvusConfig) {
    this.config = config;
  }

  private async getClient(): Promise<MilvusClient> {
    if (this.client) return this.client;
    const { MilvusClient: MC } = await importMilvusSdk();
    const cfg: Record<string, unknown> = { address: this.config.address };
    if (this.config.token) cfg.token = this.config.token;
    if (this.config.username) cfg.username = this.config.username;
    if (this.config.password) cfg.password = this.config.password;
    this.client = new MC(cfg) as unknown as MilvusClient;
    return this.client;
  }

  /** Require that the operation supplies a repoName — fail early otherwise. */
  private requireRepoName(repoName: string | undefined): string {
    if (!repoName) {
      throw new Error(
        'MilvusVectorStore: repoName is required for per-repo collection isolation. ' +
          'Pass a repo name to search/insert/delete/count.',
      );
    }
    return repoName;
  }

  /**
   * Ensure a per-repo collection exists with schema + HNSW index + loaded.
   * Each repo gets its own collection: `{baseName}_{repoName}`.
   */
  private async ensureCollection(repoName: string): Promise<string> {
    const colName = repoCollectionName(this.config.collectionName, repoName);
    if (this._ensuredCollections.has(colName)) return colName;

    const client = await this.getClient();
    const exists = await client.hasCollection({ collection_name: colName });
    if (!exists.value) {
      await client.createCollection({
        collection_name: colName,
        fields: [
          { name: 'id', data_type: 'VarChar', is_primary_key: true, max_length: 256 },
          { name: 'nodeId', data_type: 'VarChar', max_length: 512 },
          { name: 'chunkIndex', data_type: 'Int32' },
          { name: 'startLine', data_type: 'Int64' },
          { name: 'endLine', data_type: 'Int64' },
          { name: 'contentHash', data_type: 'VarChar', max_length: 64 },
          { name: 'embedding', data_type: 'FloatVector', dim: this.config.dims },
        ],
      });
      await client.createIndex({
        collection_name: colName,
        field_name: 'embedding',
        index_name: 'embedding_idx',
        params: { metric_type: 'COSINE', index_type: 'HNSW', M: 16, efConstruction: 200 },
      });
      await client.loadCollectionSync({ collection_name: colName });
    }
    this._ensuredCollections.add(colName);
    return colName;
  }

  async insert(records: VectorRecord[]): Promise<void> {
    // Use repoName from the first record to determine the target collection
    const repoName = records[0]?.repoName;
    const rn = this.requireRepoName(repoName);
    const colName = await this.ensureCollection(rn);
    const client = await this.getClient();
    await client.insert({
      collection_name: colName,
      data: records.map((r) => ({
        id: `${r.nodeId}:${r.chunkIndex}`,
        nodeId: r.nodeId,
        chunkIndex: r.chunkIndex,
        startLine: r.startLine,
        endLine: r.endLine,
        contentHash: r.contentHash ?? '',
        embedding: r.embedding,
      })),
    });
    await client.flushSync({ collection_names: [colName] });
  }

  async deleteByNodeIds(nodeIds: string[], repoName?: string): Promise<void> {
    if (nodeIds.length === 0) return;
    const rn = this.requireRepoName(repoName);
    const colName = repoCollectionName(this.config.collectionName, rn);
    const client = await this.getClient();
    const ids = nodeIds.map((id) => `"${escapeExpr(id)}"`).join(', ');
    const filter = `nodeId in [${ids}]`;
    // Milvus SDK v3 uses `filter` (not `expr`) in the delete method
    await client.delete({ collection_name: colName, filter });
    await client.flushSync({ collection_names: [colName] });
  }

  async createIndex(): Promise<boolean> {
    // Index is created per-collection in ensureCollection().
    // This method is a no-op at the global level for Milvus since
    // each repo collection manages its own index.
    return true;
  }

  async search(
    queryVector: number[],
    topK: number,
    repoName?: string,
    maxDistance: number = 0.5,
  ): Promise<VectorSearchResult[]> {
    const rn = this.requireRepoName(repoName);
    const colName = await this.ensureCollection(rn);
    const client = await this.getClient();
    const result = await client.search({
      collection_name: colName,
      vector: queryVector,
      limit: topK,
      output_fields: ['nodeId', 'chunkIndex', 'startLine', 'endLine'],
      params: { metric_type: 'COSINE', ef: 64 },
    });
    return (result.results ?? [])
      .filter((r) => (r.score ?? 0) >= 1 - maxDistance)
      .map((r) => ({
        nodeId: r.nodeId as string,
        chunkIndex: Number(r.chunkIndex ?? 0),
        startLine: Number(r.startLine ?? 0),
        endLine: Number(r.endLine ?? 0),
        distance: 1 - (r.score ?? 0),
      }));
  }

  async count(repoName?: string): Promise<number> {
    const rn = this.requireRepoName(repoName);
    const colName = repoCollectionName(this.config.collectionName, rn);
    const client = await this.getClient();
    // Milvus SDK v3 returns { data: number } directly (not array-of-object)
    const result = await client.count({ collection_name: colName });
    const d = result.data as unknown;
    if (typeof d === 'number') return d;
    if (Array.isArray(d) && d.length > 0) return (d[0] as any)?.count ?? 0;
    return 0;
  }

  async getExistingHashes(repoName?: string): Promise<Map<string, string>> {
    const rn = this.requireRepoName(repoName);
    const colName = repoCollectionName(this.config.collectionName, rn);
    const client = await this.getClient();
    // If collection doesn't exist yet, return empty map
    const exists = await client.hasCollection({ collection_name: colName });
    if (!exists.value) return new Map();

    const result = await client.query({
      collection_name: colName,
      output_fields: ['nodeId', 'chunkIndex', 'startLine', 'endLine', 'contentHash'],
      limit: 1000000,
    });
    const map = new Map<string, string>();
    for (const r of result.data ?? []) {
      const nodeId = r.nodeId as string | undefined;
      const chunkIndex = r.chunkIndex as number | undefined;
      const startLine = r.startLine as number | undefined;
      const endLine = r.endLine as number | undefined;
      const hash = (r.contentHash as string) ?? '';
      if (nodeId) {
        const hasChunkMetadata =
          chunkIndex !== undefined &&
          chunkIndex !== null &&
          startLine !== undefined &&
          startLine !== null &&
          endLine !== undefined &&
          endLine !== null;
        map.set(nodeId, hasChunkMetadata && hash ? hash : '');
      }
    }
    return map;
  }

  async loadAll(repoName?: string): Promise<VectorStoreCachedEmbedding[]> {
    const rn = this.requireRepoName(repoName);
    const colName = repoCollectionName(this.config.collectionName, rn);
    const client = await this.getClient();
    const exists = await client.hasCollection({ collection_name: colName });
    if (!exists.value) return [];

    const result = await client.query({
      collection_name: colName,
      output_fields: ['nodeId', 'chunkIndex', 'startLine', 'endLine', 'embedding', 'contentHash'],
      limit: 1000000,
    });
    return (result.data ?? []).map((r) => ({
      nodeId: r.nodeId as string,
      chunkIndex: Number(r.chunkIndex ?? 0),
      startLine: Number(r.startLine ?? 0),
      endLine: Number(r.endLine ?? 0),
      embedding: (r.embedding as number[]) ?? [],
      contentHash: (r.contentHash as string) || undefined,
      repoName,
    }));
  }

  isReady(): boolean {
    return this._ready;
  }

  async dispose(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    this._ready = false;
    this._ensuredCollections.clear();
  }
}

async function importMilvusSdk(): Promise<typeof import('@zilliz/milvus2-sdk-node')> {
  try {
    return await import('@zilliz/milvus2-sdk-node');
  } catch {
    throw new Error(
      'Failed to load @zilliz/milvus2-sdk-node. ' +
        'Install it with: npm install @zilliz/milvus2-sdk-node',
    );
  }
}
