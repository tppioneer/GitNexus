import {
  type VectorStore,
} from './vector-store.js';
import type {
  VectorStoreConfig,
  KuzuConfig,
} from './vector-store-config.js';

export const createVectorStore = async (
  config: VectorStoreConfig,
): Promise<VectorStore> => {
  switch (config.kind) {
    case 'kuzu': {
      const { KuzuVectorStore } = await import('./kuzu-vector-store.js');
      return new KuzuVectorStore();
    }
    case 'milvus': {
      const { MilvusVectorStore } = await import('./milvus-vector-store.js');
      return new MilvusVectorStore(config);
    }
    default:
      throw new Error(`Unknown vector store kind: ${(config as any).kind}`);
  }
};

export const isMilvusConfig = (config: VectorStoreConfig): config is import('./vector-store-config.js').MilvusConfig =>
  config.kind === 'milvus';

export const isKuzuConfig = (config: VectorStoreConfig): config is KuzuConfig =>
  config.kind === 'kuzu';
