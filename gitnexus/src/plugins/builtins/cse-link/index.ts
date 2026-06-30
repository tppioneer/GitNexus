import type {
  GroupContractPlugin,
  GroupPluginContext,
  PluginDiagnostic,
  PluginMetric,
  PluginTranslator,
} from '../../plugin-api.js';
import { CseLinkExtractor } from './cse-link-extractor.js';
import { cseLinkBundle } from './i18n/index.js';
import { createCseExactMatcher } from './matching.js';

function activeLocale(): 'en' | 'zh-CN' {
  const raw =
    process.env.GITNEXUS_LANG ??
    process.env.LC_ALL ??
    process.env.LC_MESSAGES ??
    process.env.LANG ??
    'en';
  return raw.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function createTranslator(locale: 'en' | 'zh-CN'): PluginTranslator {
  const primary = cseLinkBundle.resources[locale] ?? cseLinkBundle.resources.en;
  const fallback = cseLinkBundle.resources.en;
  return {
    t(key, vars = {}) {
      const template = primary[key] ?? fallback[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(vars[name] ?? `{{${name}}}`),
      );
    },
  };
}

const cseLinkPlugin: GroupContractPlugin = {
  id: 'cse-link',
  version: '0.1.0',

  createRuntime() {
    const diagnostics: PluginDiagnostic[] = [];
    const metrics: PluginMetric[] = [];
    const locale = activeLocale();
    const context: GroupPluginContext = {
      locale,
      createTranslator: () => createTranslator(locale),
      reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      reportMetric: (metric) => metrics.push(metric),
    };
    const extractor = new CseLinkExtractor(context);

    return {
      extension: {
        httpExtractor: extractor,
        runExactMatch: createCseExactMatcher(context),
        // A partial CSE registry is more dangerous than a failed sync.
        // Throwing before registry write preserves the previous valid data.
        abortOnRepoError: true,
      },
      getReport() {
        return {
          id: 'cse-link',
          version: '0.1.0',
          diagnostics: [...diagnostics],
          metrics: [...metrics],
        };
      },
    };
  },
};

export default cseLinkPlugin;
