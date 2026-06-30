import { describe, expect, it } from 'vitest';
import type { StoredContract } from '../../../../../src/core/group/types.js';
import { createCseExactMatcher } from '../../../../../src/plugins/builtins/cse-link/matching.js';
import type {
  GroupPluginContext,
  PluginDiagnostic,
} from '../../../../../src/plugins/plugin-api.js';

function contract(
  role: 'provider' | 'consumer',
  repo: string,
  uid: string,
  serviceName: string,
): StoredContract {
  return {
    contractId: 'http::GET::/orders/{param}',
    type: 'http',
    role,
    repo,
    symbolUid: uid,
    symbolRef: { filePath: `${repo}/${uid}.java`, name: uid },
    symbolName: uid,
    confidence: 1,
    meta: {
      sourcePlugin: 'cse-link',
      ...(role === 'provider'
        ? { serviceName }
        : { serviceRef: serviceName }),
    },
  };
}

function context(diagnostics: PluginDiagnostic[]): GroupPluginContext {
  return {
    locale: 'en',
    createTranslator: () => ({ t: (key) => key }),
    reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    reportMetric: () => {},
  };
}

describe('cse-link matching', () => {
  it('uses service identity to disambiguate providers with the same API', () => {
    const diagnostics: PluginDiagnostic[] = [];
    const match = createCseExactMatcher(context(diagnostics));
    const consumer = contract('consumer', 'consumer', 'call', 'order-service');
    const orderProvider = contract('provider', 'orders', 'getOrder', 'order-service');
    const inventoryProvider = contract('provider', 'inventory', 'getOrder', 'inventory-service');

    const result = match([consumer, orderProvider, inventoryProvider], new Map());

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].to.repo).toBe('orders');
    expect(diagnostics).toHaveLength(0);
  });

  it('does not link when multiple provider instances remain ambiguous', () => {
    const diagnostics: PluginDiagnostic[] = [];
    const match = createCseExactMatcher(context(diagnostics));
    const consumer = contract('consumer', 'consumer', 'call', 'order-service');
    const providerA = contract('provider', 'orders-a', 'getOrderA', 'order-service');
    const providerB = contract('provider', 'orders-b', 'getOrderB', 'order-service');

    const result = match([consumer, providerA, providerB], new Map());

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(3);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('AMBIGUOUS_PROVIDER_MATCH');
  });

  it('keeps same-API consumers as distinct instances', () => {
    const diagnostics: PluginDiagnostic[] = [];
    const match = createCseExactMatcher(context(diagnostics));
    const consumerA = contract('consumer', 'consumer', 'callA', 'order-service');
    const consumerB = contract('consumer', 'consumer', 'callB', 'order-service');
    const provider = contract('provider', 'orders', 'getOrder', 'order-service');

    const result = match([consumerA, consumerB, provider], new Map());

    expect(result.matched).toHaveLength(2);
    expect(result.unmatched).toHaveLength(0);
  });
});
