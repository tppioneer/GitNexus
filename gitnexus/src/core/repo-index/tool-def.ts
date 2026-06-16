import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        default?: unknown;
        items?: { type: string };
        enum?: string[];
        minimum?: number;
        maximum?: number;
        minLength?: number;
      }
    >;
    required: string[];
  };
}

const READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const RECOMMEND_REPO_TOOL: ToolDefinition = {
  name: 'recommend_repo',
  description: `Recommend indexed repositories relevant to a natural language query.

Searches the repo description index (built from each repo's optional .gitnexus/REPO_DESC.md)
and returns the top-k most semantically similar repositories. Uses the same 384-dim embedding
model as the code search.

OUTPUT: Returns { results: [{ name, repoPath, score }] } — ranked by cosine similarity.
Only repos with a .gitnexus/REPO_DESC.md file are returned; repos without one are invisible.

WHEN TO USE: Before query/context/impact when you are not sure which indexed repository
contains the relevant code. The recommended repo name can then be used as the "repo" parameter
of other tools.`,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language query describing the functionality or module you are looking for.',
      },
      top_k: {
        type: 'number',
        description: 'Number of results to return (default: 3, min: 1, max: 20).',
        default: 3,
        minimum: 1,
        maximum: 20,
      },
    },
    required: ['query'],
  },
};
