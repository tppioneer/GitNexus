/**
 * Repo-index LadybugDB schema for the recommend_repo tool.
 * Separate from both the per-repo knowledge graph and the bridge contract DB.
 */

export const REPO_INDEX_SCHEMA_VERSION = 1;

export const REPO_DESC_SCHEMA = `
CREATE NODE TABLE RepoDesc (
  id STRING,
  name STRING,
  repoPath STRING,
  segmentIndex INT32,
  segmentTitle STRING DEFAULT '',
  content STRING DEFAULT '',
  embedding FLOAT[384],
  indexedAt STRING DEFAULT '',
  PRIMARY KEY (id)
)`;

export const REPO_DESC_INDEX_NAME = 'repo_desc_idx';

export const CREATE_VECTOR_INDEX_QUERY = `CALL CREATE_VECTOR_INDEX('RepoDesc', '${REPO_DESC_INDEX_NAME}', 'embedding', metric := 'cosine')`;

export const REPO_INDEX_SCHEMA_QUERIES = [REPO_DESC_SCHEMA];
