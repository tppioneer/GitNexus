/**
 * Segmenter for REPO_DESC.md files.
 *
 * Default: entire file is one segment (segmentIndex = 0).
 * When frontmatter specifies chunk_by (e.g. "##"), the file is split
 * by that delimiter and each segment gets its own embedding row.
 */

export interface Segment {
  index: number;
  title: string;
  content: string;
}

export interface ChunkConfig {
  /** Delimiter to split by (e.g. "##"). Omit for single-segment. */
  chunk_by?: string;
  /** Merge segments shorter than this into the previous segment. Default 0 (never merge). */
  chunk_min?: number;
}

/**
 * Parse YAML-like frontmatter from a markdown string.
 * Returns the parsed config and the body (content after `---`).
 */
function parseFrontmatter(raw: string): { config: ChunkConfig; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---\n') && !trimmed.startsWith('---\r\n')) {
    return { config: {}, body: raw };
  }

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { config: {}, body: raw };
  }

  const fmBlock = trimmed.slice(4, endIdx);
  const body = trimmed.slice(endIdx + 4).trimStart();

  const config: ChunkConfig = {};
  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === 'chunk_by') {
      config.chunk_by = value.replace(/^["']|["']$/g, '');
    } else if (key === 'chunk_min') {
      config.chunk_min = parseInt(value, 10) || undefined;
    }
  }

  return { config, body };
}

/**
 * Split markdown body into segments based on config.
 */
export function chunkMarkdown(raw: string): Segment[] {
  const { config, body } = parseFrontmatter(raw);

  if (!config.chunk_by) {
    // Single segment: entire file
    const clean = body.trim();
    if (!clean) return [];
    return [{ index: 0, title: '', content: clean }];
  }

  const delimiter = config.chunk_by;
  const minLen = config.chunk_min ?? 0;

  // Split by delimiter, keep delimiter as part of the next segment's title
  const parts = body.split(new RegExp(`(?=^${escapeRegex(delimiter)}\\s)`, 'm'));

  let segments: Segment[] = [];
  let idx = 0;

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Extract title from first line
    const newlineIdx = trimmed.indexOf('\n');
    const firstLine = newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx);
    const title = firstLine.replace(new RegExp(`^${escapeRegex(delimiter)}\\s*`), '').trim();
    const content = trimmed;

    segments.push({ index: idx, title, content });
    idx++;
  }

  // Merge short segments with previous
  if (minLen > 0 && segments.length > 1) {
    const merged: Segment[] = [];
    for (const seg of segments) {
      if (merged.length > 0 && seg.content.length < minLen) {
        const prev = merged[merged.length - 1];
        prev.content += '\n\n' + seg.content;
        prev.title = prev.title || seg.title;
      } else {
        merged.push(seg);
      }
    }
    segments = merged;
    // Re-index
    segments.forEach((s, i) => (s.index = i));
  }

  return segments;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
