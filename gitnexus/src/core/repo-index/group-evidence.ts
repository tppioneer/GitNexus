import { readRegistry } from '../../storage/repo-manager.js';
import type { CrossLink, GroupConfig, StoredContract } from '../group/types.js';
import { stableEvidenceId, type RepoEvidenceDocument } from './evidence-types.js';
import { upsertRepoEvidence } from './evidence-writer.js';

export interface UpdateRepoEvidenceFromGroupSyncInput {
  groupName: string;
  repos: GroupConfig['repos'];
  contracts: StoredContract[];
  crossLinks: CrossLink[];
}

export async function updateRepoEvidenceFromGroupSync(
  input: UpdateRepoEvidenceFromGroupSyncInput,
): Promise<void> {
  const repoInfo = await buildRepoInfo(input.repos);
  const docs = [
    ...input.contracts.map((contract) => contractToEvidence(input.groupName, contract, repoInfo)),
    ...input.crossLinks.flatMap((link) => crossLinkToEvidence(input.groupName, link, repoInfo)),
  ].filter((doc): doc is RepoEvidenceDocument => doc !== null);

  await upsertRepoEvidence({ source: 'group_sync', groupName: input.groupName }, docs);
}

interface RepoInfo {
  registryName: string;
  repoPath: string;
}

async function buildRepoInfo(groupRepos: GroupConfig['repos']): Promise<Map<string, RepoInfo>> {
  const registry = await readRegistry();
  const byName = new Map(registry.map((entry) => [entry.name, entry]));
  const out = new Map<string, RepoInfo>();

  for (const [groupRepoPath, registryName] of Object.entries(groupRepos)) {
    const entry = byName.get(registryName);
    out.set(groupRepoPath, {
      registryName,
      repoPath: entry?.path ?? '',
    });
  }

  return out;
}

function contractToEvidence(
  groupName: string,
  contract: StoredContract,
  repoInfo: Map<string, RepoInfo>,
): RepoEvidenceDocument | null {
  const info = repoInfo.get(contract.repo);
  if (!info) return null;

  const title = `${contract.role} ${contract.type} ${contract.contractId}`;
  const content = [
    `Repository ${info.registryName} ${contract.role === 'provider' ? 'provides' : 'consumes'} ${contract.type} contract ${contract.contractId}.`,
    contract.service ? `Service: ${contract.service}.` : '',
    contract.symbolName ? `Symbol: ${contract.symbolName}.` : '',
    contract.symbolRef.filePath ? `File: ${contract.symbolRef.filePath}.` : '',
    metadataSummary(contract.meta),
  ]
    .filter(Boolean)
    .join(' ');

  return {
    id: stableEvidenceId([
      'group_sync',
      groupName,
      'contract',
      contract.repo,
      contract.role,
      contract.contractId,
      contract.symbolUid || contract.symbolRef.filePath,
    ]),
    repoName: info.registryName,
    repoPath: info.repoPath,
    groupName,
    groupRepoPath: contract.repo,
    service: contract.service,
    source: 'group_sync',
    kind: 'contract',
    role: contract.role,
    title,
    content,
    sourcePath: contract.symbolRef.filePath,
    symbolUid: contract.symbolUid,
    symbolName: contract.symbolName,
    confidence: contract.confidence,
    metadata: {
      type: contract.type,
      role: contract.role,
      contractId: contract.contractId,
      meta: contract.meta,
    },
  };
}

function crossLinkToEvidence(
  groupName: string,
  link: CrossLink,
  repoInfo: Map<string, RepoInfo>,
): Array<RepoEvidenceDocument | null> {
  const fromInfo = repoInfo.get(link.from.repo);
  const toInfo = repoInfo.get(link.to.repo);
  if (!fromInfo || !toInfo) return [];

  const commonMeta = {
    type: link.type,
    contractId: link.contractId,
    matchType: link.matchType,
    fromRepo: link.from.repo,
    toRepo: link.to.repo,
  };

  return [
    {
      id: stableEvidenceId([
        'group_sync',
        groupName,
        'cross_link',
        'consumer',
        link.from.repo,
        link.to.repo,
        link.contractId,
        link.from.symbolUid || link.from.symbolRef.filePath,
      ]),
      repoName: fromInfo.registryName,
      repoPath: fromInfo.repoPath,
      groupName,
      groupRepoPath: link.from.repo,
      service: link.from.service,
      source: 'group_sync',
      kind: 'cross_link',
      role: 'consumer',
      title: `Consumes ${link.type} ${link.contractId}`,
      content:
        `Repository ${fromInfo.registryName} consumes ${toInfo.registryName} through ${link.type} contract ${link.contractId}. ` +
        `Match type: ${link.matchType}.`,
      sourcePath: link.from.symbolRef.filePath,
      symbolUid: link.from.symbolUid,
      symbolName: link.from.symbolRef.name,
      confidence: link.confidence,
      metadata: commonMeta,
    },
    {
      id: stableEvidenceId([
        'group_sync',
        groupName,
        'cross_link',
        'provider',
        link.to.repo,
        link.from.repo,
        link.contractId,
        link.to.symbolUid || link.to.symbolRef.filePath,
      ]),
      repoName: toInfo.registryName,
      repoPath: toInfo.repoPath,
      groupName,
      groupRepoPath: link.to.repo,
      service: link.to.service,
      source: 'group_sync',
      kind: 'cross_link',
      role: 'provider',
      title: `Provides ${link.type} ${link.contractId}`,
      content:
        `Repository ${toInfo.registryName} is consumed by ${fromInfo.registryName} through ${link.type} contract ${link.contractId}. ` +
        `Match type: ${link.matchType}.`,
      sourcePath: link.to.symbolRef.filePath,
      symbolUid: link.to.symbolUid,
      symbolName: link.to.symbolRef.name,
      confidence: link.confidence,
      metadata: commonMeta,
    },
  ];
}

function metadataSummary(meta: Record<string, unknown>): string {
  const parts = [
    typeof meta.method === 'string' ? `Method: ${meta.method}.` : '',
    typeof meta.path === 'string' ? `Path: ${meta.path}.` : '',
    typeof meta.topicName === 'string' ? `Topic: ${meta.topicName}.` : '',
    typeof meta.service === 'string' ? `Contract service: ${meta.service}.` : '',
    typeof meta.package === 'string' ? `Package: ${meta.package}.` : '',
  ].filter(Boolean);
  return parts.join(' ');
}
