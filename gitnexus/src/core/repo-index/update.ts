/**
 * Analyze-time hook: update one repo's recommendation evidence.
 *
 * This is best-effort by design. The recommendation index is a materialized
 * routing aid for MCP clients; it must never block the primary analyze output.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { detectServiceBoundaries } from '../group/service-boundary-detector.js';
import { chunkMarkdown } from './chunk.js';
import { stableEvidenceId, type RepoEvidenceDocument } from './evidence-types.js';
import { upsertRepoEvidence } from './evidence-writer.js';

export interface AnalyzeEvidenceStats {
  files?: number;
  nodes?: number;
  edges?: number;
  communities?: number;
  processes?: number;
  embeddings?: number;
}

export interface UpdateRepoEvidenceFromAnalyzeInput {
  repoPath: string;
  repoName: string;
  stats?: AnalyzeEvidenceStats;
}

export async function updateRepoEvidenceFromAnalyze(
  input: UpdateRepoEvidenceFromAnalyzeInput,
): Promise<void> {
  const repoPath = path.resolve(input.repoPath);
  const docs: RepoEvidenceDocument[] = [
    buildRepoSummaryEvidence(input.repoName, repoPath, input.stats),
    ...(await buildServiceSummaryEvidence(input.repoName, repoPath)),
    ...(await buildRepoDescEvidence(input.repoName, repoPath)),
  ];

  await upsertRepoEvidence(
    { source: 'analyze', repoName: input.repoName },
    docs.filter((doc) => doc.content.trim().length > 0),
  );
}

/**
 * Backwards-compatible name for the old analyze hook. Prefer
 * updateRepoEvidenceFromAnalyze so registry aliases are preserved.
 */
export async function updateRepoInIndex(repoPath: string): Promise<void> {
  const repoName = path.basename(path.resolve(repoPath));
  await updateRepoEvidenceFromAnalyze({ repoPath, repoName });
}

function buildRepoSummaryEvidence(
  repoName: string,
  repoPath: string,
  stats?: AnalyzeEvidenceStats,
): RepoEvidenceDocument {
  const statsParts = [
    statPart(stats?.files, 'files'),
    statPart(stats?.nodes, 'symbols'),
    statPart(stats?.edges, 'relationships'),
    statPart(stats?.communities, 'communities'),
    statPart(stats?.processes, 'processes'),
    statPart(stats?.embeddings, 'embedding chunks'),
  ].filter(Boolean);

  const content =
    statsParts.length > 0
      ? `Repository ${repoName} is indexed by GitNexus with ${statsParts.join(', ')}.`
      : `Repository ${repoName} is indexed by GitNexus.`;

  return {
    id: stableEvidenceId(['analyze', repoName, 'repo_summary']),
    repoName,
    repoPath,
    source: 'analyze',
    kind: 'repo_summary',
    title: `Repository ${repoName}`,
    content,
    confidence: 0.75,
    metadata: { stats: stats ?? {} },
  };
}

async function buildServiceSummaryEvidence(
  repoName: string,
  repoPath: string,
): Promise<RepoEvidenceDocument[]> {
  let boundaries;
  try {
    boundaries = await detectServiceBoundaries(repoPath);
  } catch {
    return [];
  }

  return boundaries.slice(0, 300).map((b) => ({
    id: stableEvidenceId(['analyze', repoName, 'service_summary', b.servicePath]),
    repoName,
    repoPath,
    source: 'analyze' as const,
    kind: 'service_summary' as const,
    service: b.servicePath,
    title: `Service ${b.serviceName}`,
    content:
      `Repository ${repoName} contains service ${b.serviceName} at ${b.servicePath}. ` +
      `Detected service markers: ${b.markers.join(', ')}.`,
    confidence: b.confidence,
    metadata: {
      serviceName: b.serviceName,
      markers: b.markers,
    },
  }));
}

async function buildRepoDescEvidence(
  repoName: string,
  repoPath: string,
): Promise<RepoEvidenceDocument[]> {
  const descPath = path.join(repoPath, '.gitnexus', 'REPO_DESC.md');
  let raw: string;
  try {
    raw = await fs.readFile(descPath, 'utf-8');
  } catch {
    return [];
  }

  return chunkMarkdown(raw).map((seg) => ({
    id: stableEvidenceId(['analyze', repoName, 'repo_desc', seg.index]),
    repoName,
    repoPath,
    source: 'analyze' as const,
    kind: 'repo_desc' as const,
    title: seg.title || `Repository description ${seg.index + 1}`,
    content: seg.content,
    confidence: 1,
    metadata: { segmentIndex: seg.index },
  }));
}

function statPart(value: number | undefined, label: string): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} ${label}` : '';
}
