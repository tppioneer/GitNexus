export type VectorStoreKind = 'kuzu' | 'milvus';

/** Milvus collection name max length. */
const MAX_COLLECTION_NAME_LEN = 255;

/** Default prefix length (e.g. "code_embeddings" = 15). */
const DEFAULT_PREFIX_LEN = 15;

/**
 * Sanitize a repo name for use as a Milvus collection name suffix.
 * Milvus allows only letters, numbers, and underscores (1-255 chars);
 * first char must be letter or underscore.
 * Truncates the sanitized suffix so that prefix + suffix ≤ 255 chars.
 */
export const sanitizeCollectionName = (
  repoName: string,
  prefixLen: number = DEFAULT_PREFIX_LEN,
): string => {
  const maxSuffixLen = Math.max(1, MAX_COLLECTION_NAME_LEN - prefixLen);
  const sanitized =
    '_' + repoName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return sanitized.length <= maxSuffixLen ? sanitized : sanitized.slice(0, maxSuffixLen);
};

export interface MilvusConfig {
  kind: 'milvus';
  address: string;
  token?: string;
  username?: string;
  password?: string;
  collectionName: string;
  dims: number;
}

export interface KuzuConfig {
  kind: 'kuzu';
}

export type VectorStoreConfig = KuzuConfig | MilvusConfig;

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const resolveVectorStoreConfig = (): VectorStoreConfig => {
  const kind = (process.env.GITNEXUS_VECTOR_STORE ?? 'kuzu') as VectorStoreKind;

  if (kind === 'milvus') {
    const address = process.env.GITNEXUS_MILVUS_ADDRESS;
    if (!address) {
      throw new Error(
        'GITNEXUS_VECTOR_STORE=milvus requires GITNEXUS_MILVUS_ADDRESS (e.g. localhost:19530)',
      );
    }
    return {
      kind: 'milvus',
      address,
      token: process.env.GITNEXUS_MILVUS_TOKEN,
      username: process.env.GITNEXUS_MILVUS_USERNAME,
      password: process.env.GITNEXUS_MILVUS_PASSWORD,
      collectionName: process.env.GITNEXUS_MILVUS_COLLECTION ?? 'code_embeddings',
      dims: parsePositiveInt(process.env.GITNEXUS_EMBEDDING_DIMS, 384),
    };
  }

  return { kind: 'kuzu' };
};
