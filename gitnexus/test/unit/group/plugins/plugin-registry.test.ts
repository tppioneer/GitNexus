import { describe, expect, it } from 'vitest';
import {
  listBuiltinPluginIds,
  loadBuiltinGroupPlugin,
  UnknownPluginError,
} from '../../../../src/plugins/plugin-registry.js';

describe('plugin-registry', () => {
  it('lists known plugin IDs', () => {
    expect(listBuiltinPluginIds()).toContain('cse-link');
  });

  it('loads cse-link and creates a sync runtime', async () => {
    const plugin = await loadBuiltinGroupPlugin('cse-link');
    expect(plugin.id).toBe('cse-link');
    expect(plugin.createRuntime().extension.httpExtractor?.type).toBe('http');
  });

  it('rejects unknown plugins', async () => {
    await expect(loadBuiltinGroupPlugin('unknown-plugin')).rejects.toThrow(UnknownPluginError);
  });
});
