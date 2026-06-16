/**
 * Repo-index LadybugDB schema for the recommend_repo tool.
 * Separate from both the per-repo knowledge graph and the bridge contract DB.
 */

export const REPO_INDEX_SCHEMA_VERSION = 2;

export const REPO_EVIDENCE_TABLE_NAME = 'RepoEvidence';
export const REPO_EVIDENCE_INDEX_NAME = 'repo_evidence_idx';

export const REPO_EVIDENCE_SCHEMA = `
CREATE NODE TABLE ${REPO_EVIDENCE_TABLE_NAME} (
  id STRING,
  repoName STRING,
  repoPath STRING,
  groupName STRING DEFAULT '',
  groupRepoPath STRING DEFAULT '',
  service STRING DEFAULT '',
  source STRING,
  kind STRING,
  role STRING DEFAULT '',
  title STRING DEFAULT '',
  content STRING DEFAULT '',
  sourcePath STRING DEFAULT '',
  symbolUid STRING DEFAULT '',
  symbolName STRING DEFAULT '',
  confidence DOUBLE DEFAULT 1.0,
  metadata STRING DEFAULT '{}',
  embedding FLOAT[384],
  indexedAt STRING DEFAULT '',
  PRIMARY KEY (id)
)`;

export const CREATE_VECTOR_INDEX_QUERY = `CALL CREATE_VECTOR_INDEX('${REPO_EVIDENCE_TABLE_NAME}', '${REPO_EVIDENCE_INDEX_NAME}', 'embedding', metric := 'cosine')`;

export const REPO_INDEX_SCHEMA_QUERIES = [REPO_EVIDENCE_SCHEMA];
