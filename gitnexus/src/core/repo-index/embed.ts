/**
 * Thin wrapper around the core embedding pipeline.
 *
 * Reuses the process-wide embedder singleton from core/embeddings/embedder.ts
 * so we share the same ONNX model (no duplicate ~90 MB in memory).
 */

import {
  initEmbedder,
  embedText as coreEmbedText,
  embedBatch as coreEmbedBatch,
  isEmbedderReady,
} from '../embeddings/embedder.js';

/** Embed a single text (for building / updating one repo at a time). */
export async function embedText(text: string): Promise<number[]> {
  const embedder = await initEmbedder();
  const result = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data as ArrayLike<number>);
}

/** Embed multiple texts in one batch (for bulk rebuilds). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const embedder = await initEmbedder();
  const result = await embedder(texts, { pooling: 'mean', normalize: true });
  // result shape: [batch_size, 384]; split into per-text arrays
  const dims = (result.dims?.[1] as number) ?? 384;
  const data = result.data as ArrayLike<number>;
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const start = i * dims;
    embeddings.push(Array.from(Array.prototype.slice.call(data, start, start + dims)));
  }
  return embeddings;
}

/** Synonym: embed a query string. Same model, semantic aligns with stored vectors. */
export const embedQuery = embedText;
