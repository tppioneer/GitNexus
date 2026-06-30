/**
 * Static whitelist for built-in group-sync plugins.
 *
 * Arbitrary paths, URLs, and npm packages are intentionally unsupported.
 */

import type { GroupContractPlugin } from './plugin-api.js';

type BuiltinPluginLoader = () => Promise<{ default: GroupContractPlugin }>;

const BUILTIN_GROUP_PLUGINS: Record<string, BuiltinPluginLoader> = {
  'cse-link': () => import('./builtins/cse-link/index.js'),
};

export function listBuiltinPluginIds(): string[] {
  return Object.keys(BUILTIN_GROUP_PLUGINS);
}

export class UnknownPluginError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly available: string[],
  ) {
    super(
      `Unknown built-in group plugin: ${pluginId}\nAvailable plugins: ${available.join(', ')}`,
    );
    this.name = 'UnknownPluginError';
  }
}

export async function loadBuiltinGroupPlugin(id: string): Promise<GroupContractPlugin> {
  const loader = BUILTIN_GROUP_PLUGINS[id];
  if (!loader) {
    throw new UnknownPluginError(id, listBuiltinPluginIds());
  }

  let mod: { default: GroupContractPlugin };
  try {
    mod = await loader();
  } catch (err) {
    throw new Error(
      `Failed to load built-in plugin "${id}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const plugin = mod.default;
  if (!plugin || typeof plugin !== 'object' || plugin.id !== id) {
    throw new Error(`Plugin "${id}" did not export a matching manifest.`);
  }
  return plugin;
}
