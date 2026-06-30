/**
 * Stable synthetic UID generation for CSE-link contracts.
 *
 * When the graph does not have a real symbol UID for a contract anchor,
 * we generate a deterministic synthetic UID so the contract still has a
 * non-empty, stable identifier. The UID is derived from the contract's
 * structural properties (file, method, class, line, HTTP method, path,
 * service identity) so it remains stable across repeated syncs of the
 * same source code.
 *
 * Uses the same hashing approach as GitNexus `generateId()` conventions:
 * a deterministic label prefix plus a stable hash of canonical inputs.
 */

import { createHash } from 'node:crypto';

export interface SyntheticUidInput {
  pluginId: string;
  role: 'provider' | 'consumer';
  filePath: string;
  enclosingClass?: string;
  enclosingMethod?: string;
  startLine?: number;
  httpMethod: string;
  normalizedPath: string;
  serviceIdentity: string;
}

/**
 * Generate a stable synthetic UID for a CSE contract.
 *
 * The output format is `CseLinkProvider:<hash>` or `CseLinkConsumer:<hash>`.
 * The hash is computed from the canonical JSON of the input fields, sorted
 * by key. Absolute paths, timestamps, and scan order are excluded.
 */
export function generateSyntheticUid(input: SyntheticUidInput): string {
  const prefix = input.role === 'provider' ? 'CseLinkProvider' : 'CseLinkConsumer';

  const canonical = JSON.stringify({
    class: input.enclosingClass ?? '',
    filePath: input.filePath.replace(/\\/g, '/'),
    httpMethod: input.httpMethod,
    line: input.startLine ?? 0,
    method: input.enclosingMethod ?? '',
    normalizedPath: input.normalizedPath,
    pluginId: input.pluginId,
    role: input.role,
    serviceIdentity: input.serviceIdentity,
  });

  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${prefix}:${hash}`;
}
