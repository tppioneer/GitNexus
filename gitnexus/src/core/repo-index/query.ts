/**
 * Query-time recommend_repo implementation over the materialized RepoEvidence
 * index. The index is intentionally recommendation-grade: it stores routes,
 * contracts, cross-links, service summaries, and repo summaries instead of
 * duplicating every per-repo code chunk.
 */

import { getGlobalDir } from '../../storage/repo-manager.js';
import { closeForRead, openForRead, type ReadHandle } from './db.js';
import { embedQuery } from './embed.js';
import {
  REPO_EVIDENCE_INDEX_NAME,
  REPO_EVIDENCE_TABLE_NAME,
} from './schema.js';
import type { RepoEvidenceKind, StoredRepoEvidence } from './evidence-types.js';

export interface RepoRecommendationEvidence {
  kind: string;
  role: string;
  title: string;
  content: string;
  sourcePath: string;
  symbolName: string;
  confidence: number;
  score: number;
  metadata: Record<string, unknown>;
}

export interface RepoRecommendation {
  name: string;
  repoPath: string;
  service?: string;
  groupName?: string;
  groupRepoPath?: string;
  score: number;
  matchedKinds: string[];
  reasons: string[];
  evidence: RepoRecommendationEvidence[];
}

interface RecommendParams {
  query: string;
  topK: number;
  granularity: 'repo' | 'service';
  group?: string;
  service?: string;
  kinds?: Set<string>;
  includeEvidence: boolean;
}

export async function recommendRepos(
  params: Record<string, unknown>,
): Promise<{ results: RepoRecommendation[] } | { error: string }> {
  const parsed = parseRecommendParams(params);
  if ('error' in parsed) return parsed;

  const globalDir = getGlobalDir();
  let handle: ReadHandle | null;
  try {
    handle = await openForRead(globalDir);
  } catch {
    return { results: [] };
  }
  if (!handle) return { results: [] };

  try {
    let queryVec: number[] | null = null;
    try {
      queryVec = await embedQuery(parsed.query);
    } catch {
      queryVec = null;
    }

    const fetchLimit = Math.max(parsed.topK * 20, 100);
    let semanticHits: StoredRepoEvidence[] = [];
    if (queryVec) {
      try {
        semanticHits = await queryVectorEvidence(handle, queryVec, fetchLimit);
      } catch {
        semanticHits = await queryExactEvidence(handle, queryVec, fetchLimit);
      }
    }

    const lexicalHits = await queryLexicalEvidence(handle, parsed.query, fetchLimit);
    const fused = fuseEvidence([...semanticHits, ...lexicalHits], parsed);
    const ranked = aggregateRecommendations(fused, parsed);

    return { results: ranked };
  } finally {
    await closeForRead(handle).catch(() => {});
  }
}

function parseRecommendParams(
  raw: Record<string, unknown>,
): RecommendParams | { error: string } {
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (!query) return { error: 'query parameter is required and cannot be empty.' };

  const granularity = raw.granularity === 'service' ? 'service' : 'repo';
  const kinds =
    Array.isArray(raw.kinds) && raw.kinds.length > 0
      ? new Set(raw.kinds.map((k) => String(k).trim()).filter(Boolean))
      : undefined;

  return {
    query,
    topK: clampTopK(raw.top_k),
    granularity,
    group: typeof raw.group === 'string' ? raw.group.trim() || undefined : undefined,
    service: typeof raw.service === 'string' ? raw.service.trim().replace(/\/+$/, '') : undefined,
    kinds,
    includeEvidence: raw.include_evidence !== false,
  };
}

async function queryVectorEvidence(
  handle: ReadHandle,
  queryVec: number[],
  fetchLimit: number,
): Promise<StoredRepoEvidence[]> {
  const vecStr = `[${queryVec.join(',')}]`;
  const result = await handle.conn.query(`
    CALL QUERY_VECTOR_INDEX('${REPO_EVIDENCE_TABLE_NAME}', '${REPO_EVIDENCE_INDEX_NAME}',
      CAST(${vecStr} AS FLOAT[${queryVec.length}]), ${fetchLimit})
    YIELD node AS ev, distance
    WHERE distance < 0.75
    RETURN ev.id AS id, ev.repoName AS repoName, ev.repoPath AS repoPath,
      ev.groupName AS groupName, ev.groupRepoPath AS groupRepoPath, ev.service AS service,
      ev.source AS source, ev.kind AS kind, ev.role AS role, ev.title AS title,
      ev.content AS content, ev.sourcePath AS sourcePath, ev.symbolUid AS symbolUid,
      ev.symbolName AS symbolName, ev.confidence AS confidence, ev.metadata AS metadata,
      ev.indexedAt AS indexedAt, distance
    ORDER BY distance
  `);
  return (await drainRows(result)).map(rowToEvidence).filter(isEvidence);
}

async function queryExactEvidence(
  handle: ReadHandle,
  queryVec: number[],
  fetchLimit: number,
): Promise<StoredRepoEvidence[]> {
  const result = await handle.conn.query(`
    MATCH (ev:${REPO_EVIDENCE_TABLE_NAME})
    RETURN ev.id AS id, ev.repoName AS repoName, ev.repoPath AS repoPath,
      ev.groupName AS groupName, ev.groupRepoPath AS groupRepoPath, ev.service AS service,
      ev.source AS source, ev.kind AS kind, ev.role AS role, ev.title AS title,
      ev.content AS content, ev.sourcePath AS sourcePath, ev.symbolUid AS symbolUid,
      ev.symbolName AS symbolName, ev.confidence AS confidence, ev.metadata AS metadata,
      ev.indexedAt AS indexedAt, ev.embedding AS embedding
  `);
  return (await drainRows(result))
    .map((row) => {
      const ev = rowToEvidence(row);
      if (!ev) return null;
      ev.distance = cosineDistance(queryVec, (row.embedding ?? row[17] ?? []) as number[]);
      return ev;
    })
    .filter(isEvidence)
    .filter((ev) => (ev.distance ?? 1) < 0.75)
    .sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1))
    .slice(0, fetchLimit);
}

async function queryLexicalEvidence(
  handle: ReadHandle,
  query: string,
  fetchLimit: number,
): Promise<StoredRepoEvidence[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const result = await handle.conn.query(`
    MATCH (ev:${REPO_EVIDENCE_TABLE_NAME})
    RETURN ev.id AS id, ev.repoName AS repoName, ev.repoPath AS repoPath,
      ev.groupName AS groupName, ev.groupRepoPath AS groupRepoPath, ev.service AS service,
      ev.source AS source, ev.kind AS kind, ev.role AS role, ev.title AS title,
      ev.content AS content, ev.sourcePath AS sourcePath, ev.symbolUid AS symbolUid,
      ev.symbolName AS symbolName, ev.confidence AS confidence, ev.metadata AS metadata,
      ev.indexedAt AS indexedAt
  `);

  return (await drainRows(result))
    .map(rowToEvidence)
    .filter(isEvidence)
    .map((ev) => {
      ev.lexicalScore = lexicalScore(ev, tokens);
      ev.structuredScore = structuredScore(ev, query);
      return ev;
    })
    .filter((ev) => (ev.lexicalScore ?? 0) > 0 || (ev.structuredScore ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.structuredScore ?? 0) + (b.lexicalScore ?? 0) -
        ((a.structuredScore ?? 0) + (a.lexicalScore ?? 0)),
    )
    .slice(0, fetchLimit);
}

function fuseEvidence(
  hits: StoredRepoEvidence[],
  params: RecommendParams,
): StoredRepoEvidence[] {
  const byId = new Map<string, StoredRepoEvidence>();
  for (const hit of hits) {
    if (!passesFilters(hit, params)) continue;
    const scored = { ...hit, score: scoreEvidence(hit) };
    const existing = byId.get(scored.id);
    if (!existing || (scored.score ?? 0) > (existing.score ?? 0)) {
      byId.set(scored.id, scored);
    }
  }
  return Array.from(byId.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function aggregateRecommendations(
  evidence: StoredRepoEvidence[],
  params: RecommendParams,
): RepoRecommendation[] {
  const groups = new Map<string, StoredRepoEvidence[]>();
  for (const ev of evidence) {
    const key =
      params.granularity === 'service'
        ? `${ev.repoName}\0${ev.service || ''}`
        : ev.repoName.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(ev);
    groups.set(key, list);
  }

  return Array.from(groups.values())
    .map((items) => {
      items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const best = items[0];
      const top = items.slice(0, 5);
      const top3 = items.slice(0, 3);
      const avgTop3 = top3.reduce((sum, ev) => sum + (ev.score ?? 0), 0) / top3.length;
      const diversity = new Set(top.map((ev) => ev.kind)).size;
      const aggregate = (best.score ?? 0) * 0.65 + avgTop3 * 0.25 + Math.min(diversity, 4) * 0.025;

      return {
        name: best.repoName,
        repoPath: best.repoPath,
        service: params.granularity === 'service' && best.service ? best.service : undefined,
        groupName: best.groupName || undefined,
        groupRepoPath: best.groupRepoPath || undefined,
        score: roundScore(aggregate),
        matchedKinds: Array.from(new Set(top.map((ev) => ev.kind))),
        reasons: top.slice(0, 3).map(reasonForEvidence),
        evidence: params.includeEvidence ? top.map(toRecommendationEvidence) : [],
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, params.topK);
}

function passesFilters(ev: StoredRepoEvidence, params: RecommendParams): boolean {
  if (params.group && ev.groupName !== params.group) return false;
  if (params.service && !(ev.service || '').startsWith(params.service)) return false;
  if (params.kinds && !params.kinds.has(ev.kind)) return false;
  return true;
}

function scoreEvidence(ev: StoredRepoEvidence): number {
  const semantic = ev.distance === undefined ? 0 : Math.max(0, 1 - ev.distance);
  const lexical = ev.lexicalScore ?? 0;
  const structured = ev.structuredScore ?? 0;
  const confidence = Math.max(0, Math.min(1, ev.confidence));
  const raw = semantic * 0.45 + lexical * 0.2 + structured * 0.25 + confidence * 0.1;
  return Math.min(1, raw * kindBoost(ev.kind));
}

function kindBoost(kind: RepoEvidenceKind): number {
  switch (kind) {
    case 'contract':
      return 1.2;
    case 'cross_link':
      return 1.15;
    case 'route':
      return 1.15;
    case 'process':
      return 1.1;
    case 'service_summary':
      return 1.05;
    default:
      return 1;
  }
}

function reasonForEvidence(ev: StoredRepoEvidence): string {
  if (ev.kind === 'contract') return `Matched ${ev.role || 'contract'} ${ev.title}`;
  if (ev.kind === 'cross_link') return `Matched cross-repo link ${ev.title}`;
  if (ev.kind === 'service_summary') return `Matched service summary ${ev.service || ev.title}`;
  return `Matched ${ev.kind} ${ev.title}`;
}

function toRecommendationEvidence(ev: StoredRepoEvidence): RepoRecommendationEvidence {
  return {
    kind: ev.kind,
    role: ev.role ?? '',
    title: ev.title,
    content: ev.content,
    sourcePath: ev.sourcePath ?? '',
    symbolName: ev.symbolName ?? '',
    confidence: ev.confidence,
    score: roundScore(ev.score ?? 0),
    metadata: ev.metadata,
  };
}

function rowToEvidence(row: any): StoredRepoEvidence | null {
  const metadataRaw = String(row.metadata ?? row[15] ?? '{}');
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(metadataRaw);
  } catch {
    metadata = {};
  }

  const id = String(row.id ?? row[0] ?? '');
  const repoName = String(row.repoName ?? row[1] ?? '');
  if (!id || !repoName) return null;

  return {
    id,
    repoName,
    repoPath: String(row.repoPath ?? row[2] ?? ''),
    groupName: String(row.groupName ?? row[3] ?? ''),
    groupRepoPath: String(row.groupRepoPath ?? row[4] ?? ''),
    service: String(row.service ?? row[5] ?? ''),
    source: row.source ?? row[6],
    kind: row.kind ?? row[7],
    role: String(row.role ?? row[8] ?? ''),
    title: String(row.title ?? row[9] ?? ''),
    content: String(row.content ?? row[10] ?? ''),
    sourcePath: String(row.sourcePath ?? row[11] ?? ''),
    symbolUid: String(row.symbolUid ?? row[12] ?? ''),
    symbolName: String(row.symbolName ?? row[13] ?? ''),
    confidence: Number(row.confidence ?? row[14] ?? 1),
    metadata,
    indexedAt: String(row.indexedAt ?? row[16] ?? ''),
    distance:
      row.distance !== undefined || row[17] !== undefined
        ? Number(row.distance ?? row[17])
        : undefined,
  } as StoredRepoEvidence;
}

function isEvidence(ev: StoredRepoEvidence | null): ev is StoredRepoEvidence {
  return ev !== null;
}

function tokenize(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_./:-]+/u)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2),
    ),
  );
}

function lexicalScore(ev: StoredRepoEvidence, tokens: string[]): number {
  const haystack = [
    ev.title,
    ev.content,
    ev.repoName,
    ev.groupRepoPath,
    ev.service,
    ev.sourcePath,
    ev.symbolName,
    JSON.stringify(ev.metadata),
  ]
    .join(' ')
    .toLowerCase();
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return Math.min(1, hits / Math.max(tokens.length, 1));
}

function structuredScore(ev: StoredRepoEvidence, query: string): number {
  const q = query.toLowerCase();
  const meta = ev.metadata;
  const candidates = [
    meta.contractId,
    meta.path,
    meta.topicName,
    meta.service,
    ev.service,
    ev.sourcePath,
  ]
    .map((v) => (typeof v === 'string' ? v.toLowerCase() : ''))
    .filter(Boolean);
  if (candidates.some((candidate) => q.includes(candidate) || candidate.includes(q))) return 1;
  if (/\/[\w{}:.[\]-]+/.test(query) && candidates.some((candidate) => q.includes(candidate))) {
    return 0.8;
  }
  return 0;
}

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

function clampTopK(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(1, Math.min(20, Math.floor(raw)));
  }
  return 3;
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function drainRows(result: any): Promise<any[]> {
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
