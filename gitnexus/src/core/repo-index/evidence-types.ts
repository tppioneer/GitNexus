export type RepoEvidenceSource = 'analyze' | 'group_sync';

export type RepoEvidenceKind =
  | 'repo_summary'
  | 'repo_desc'
  | 'service_summary'
  | 'route'
  | 'process'
  | 'contract'
  | 'cross_link'
  | 'workspace_dep';

export interface RepoEvidenceDocument {
  id: string;
  repoName: string;
  repoPath: string;
  source: RepoEvidenceSource;
  kind: RepoEvidenceKind;
  groupName?: string;
  groupRepoPath?: string;
  service?: string;
  role?: string;
  title: string;
  content: string;
  sourcePath?: string;
  symbolUid?: string;
  symbolName?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface StoredRepoEvidence extends RepoEvidenceDocument {
  metadata: Record<string, unknown>;
  confidence: number;
  indexedAt: string;
  distance?: number;
  lexicalScore?: number;
  structuredScore?: number;
  score?: number;
}

export interface EvidenceUpsertScope {
  source: RepoEvidenceSource;
  repoName?: string;
  groupName?: string;
}

export function evidenceEmbeddingText(doc: RepoEvidenceDocument): string {
  return [
    doc.title,
    doc.content,
    doc.kind,
    doc.role ?? '',
    doc.service ?? '',
    doc.sourcePath ?? '',
    doc.symbolName ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function stableEvidenceId(parts: Array<string | number | undefined>): string {
  return parts
    .map((p) =>
      String(p ?? '')
        .replace(/[^\w./:-]+/g, '_')
        .slice(0, 160),
    )
    .join(':');
}
