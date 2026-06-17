export interface VectorRecord {
  id: string;
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embedding: number[];
  contentHash?: string;
  /** Repo name for multi-repo isolation (required for Milvus, optional for Kuzu) */
  repoName?: string;
}

export interface VectorSearchResult {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  distance: number;
}

export interface VectorStoreCachedEmbedding {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embedding: number[];
  contentHash?: string;
  repoName?: string;
}

export interface VectorStore {
  insert(records: VectorRecord[]): Promise<void>;
  deleteByNodeIds(nodeIds: string[], repoName?: string): Promise<void>;
  createIndex(): Promise<boolean>;
  search(queryVector: number[], topK: number, repoName?: string, maxDistance?: number): Promise<VectorSearchResult[]>;
  count(repoName?: string): Promise<number>;
  getExistingHashes(repoName?: string): Promise<Map<string, string>>;
  loadAll(repoName?: string): Promise<VectorStoreCachedEmbedding[]>;
  isReady(): boolean;
  dispose(): Promise<void>;
}

export type { VectorStoreConfig } from './vector-store-config.js';
