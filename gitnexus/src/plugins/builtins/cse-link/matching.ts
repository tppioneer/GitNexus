import type {
  CrossLink,
  MatchingConfig,
  StoredContract,
} from '../../../core/group/types.js';
import {
  buildProviderIndex,
  normalizeContractId,
  runExactMatch,
  type MatchResult,
} from '../../../core/group/matching.js';
import type { GroupPluginContext } from '../../plugin-api.js';

function metaString(contract: StoredContract, key: string): string | undefined {
  const value = contract.meta?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isCseContract(contract: StoredContract): boolean {
  return contract.meta?.sourcePlugin === 'cse-link';
}

function instanceKey(contract: StoredContract): string {
  const serviceIdentity =
    contract.role === 'consumer'
      ? metaString(contract, 'serviceRef')
      : metaString(contract, 'serviceName') ?? metaString(contract, 'serviceRef');

  return [
    contract.repo,
    contract.role,
    normalizeContractId(contract.contractId),
    contract.symbolUid,
    serviceIdentity ?? '',
  ].join('\0');
}

function buildNoisyFilter(config?: MatchingConfig): (contractId: string) => boolean {
  const excludePaths = config?.exclude_links_paths?.length
    ? new Set(config.exclude_links_paths.map((path) => path.replace(/\/+$/, '')))
    : new Set<string>();
  const excludeParamOnly = config?.exclude_links_param_only_paths === true;

  return (contractId: string): boolean => {
    if (!contractId.startsWith('http::')) return false;
    const parts = contractId.split('::');
    if (parts.length < 3) return false;
    const path = parts.slice(2).join('::').replace(/\/+$/, '');
    if (excludePaths.has(path)) return true;
    if (!excludeParamOnly) return false;
    const segments = path.split('/').filter(Boolean);
    return segments.length > 0 && segments.every((segment) => segment === '{param}');
  };
}

function toCrossLink(consumer: StoredContract, provider: StoredContract): CrossLink {
  return {
    from: {
      repo: consumer.repo,
      service: consumer.service,
      symbolUid: consumer.symbolUid,
      symbolRef: consumer.symbolRef,
    },
    to: {
      repo: provider.repo,
      service: provider.service,
      symbolUid: provider.symbolUid,
      symbolRef: provider.symbolRef,
    },
    type: consumer.type,
    contractId: consumer.contractId,
    matchType: 'exact',
    confidence: 1,
  };
}

/**
 * CSE-specific exact matching. serviceRef/serviceName semantics remain inside
 * the plugin and therefore cannot change matching for baseline contracts.
 */
export function createCseExactMatcher(
  context: GroupPluginContext,
): (
  contracts: StoredContract[],
  providerIndex: Map<string, StoredContract[]>,
  matchingConfig?: MatchingConfig,
) => MatchResult {
  return (contracts, _providerIndex, matchingConfig): MatchResult => {
    const baselineContracts = contracts.filter((contract) => !isCseContract(contract));
    const baselineIndex = buildProviderIndex(baselineContracts, matchingConfig);
    const baseline = runExactMatch(baselineContracts, baselineIndex, matchingConfig);

    const cseContracts = contracts.filter(isCseContract);
    const noisy = buildNoisyFilter(matchingConfig);
    const providersById = new Map<string, StoredContract[]>();
    for (const provider of cseContracts) {
      if (provider.role !== 'provider' || noisy(provider.contractId)) continue;
      const key = normalizeContractId(provider.contractId);
      const providers = providersById.get(key) ?? [];
      providers.push(provider);
      providersById.set(key, providers);
    }

    const matched: CrossLink[] = [...baseline.matched];
    const matchedConsumers = new Set<string>();
    const matchedProviders = new Set<string>();

    for (const consumer of cseContracts) {
      if (consumer.role !== 'consumer' || noisy(consumer.contractId)) continue;
      const serviceRef = metaString(consumer, 'serviceRef');
      if (!serviceRef) continue;

      const candidates = (providersById.get(normalizeContractId(consumer.contractId)) ?? []).filter(
        (provider) => {
          const serviceName =
            metaString(provider, 'serviceName') ?? metaString(provider, 'serviceRef');
          if (serviceName !== serviceRef) return false;
          if (provider.repo !== consumer.repo) return true;
          return Boolean(
            provider.service &&
              consumer.service &&
              provider.service !== consumer.service,
          );
        },
      );

      const uniqueCandidates = [
        ...new Map(candidates.map((provider) => [instanceKey(provider), provider])).values(),
      ];

      if (uniqueCandidates.length > 1) {
        context.reportDiagnostic({
          pluginId: 'cse-link',
          repo: consumer.repo,
          filePath: consumer.symbolRef.filePath,
          severity: 'warning',
          code: 'AMBIGUOUS_PROVIDER_MATCH',
          message:
            `Ambiguous provider match for ${consumer.contractId}: ` +
            `${uniqueCandidates.length} providers match service "${serviceRef}".`,
          details: {
            contractId: consumer.contractId,
            serviceRef,
            candidates: uniqueCandidates.map((provider) => ({
              repo: provider.repo,
              symbolUid: provider.symbolUid,
              symbolName: provider.symbolName,
              filePath: provider.symbolRef.filePath,
              serviceName: metaString(provider, 'serviceName'),
            })),
          },
        });
        continue;
      }

      const provider = uniqueCandidates[0];
      if (!provider) continue;
      matched.push(toCrossLink(consumer, provider));
      matchedConsumers.add(instanceKey(consumer));
      matchedProviders.add(instanceKey(provider));
    }

    const cseUnmatched = cseContracts.filter((contract) => {
      if (noisy(contract.contractId)) return false;
      const key = instanceKey(contract);
      return contract.role === 'provider'
        ? !matchedProviders.has(key)
        : !matchedConsumers.has(key);
    });

    return {
      matched,
      unmatched: [...baseline.unmatched, ...cseUnmatched],
    };
  };
}
