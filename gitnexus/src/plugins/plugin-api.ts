/**
 * Minimal API for optional, built-in group-sync plugins.
 *
 * Core group code knows only the generic GroupSyncExtension interface.
 * Plugin discovery, diagnostics, metrics, and localization stay here.
 */

import type { GroupSyncExtension } from '../core/group/sync.js';

export type PluginDiagnosticSeverity = 'info' | 'warning' | 'error';

export type PluginDiagnosticCode =
  | 'UNSUPPORTED_REPOSITORY'
  | 'NO_APPLICABLE_REPOSITORIES'
  | 'MISSING_SERVICE_NAME'
  | 'AMBIGUOUS_SERVICE_NAME'
  | 'UNRESOLVED_CSE_URL'
  | 'UNRESOLVED_HTTP_METHOD'
  | 'UNTRUSTED_REST_TEMPLATE_RECEIVER'
  | 'UNSUPPORTED_REST_TEMPLATE_OVERLOAD'
  | 'UNRESOLVED_CONTROLLER_PREFIX'
  | 'UNSUPPORTED_SPRING_MAPPING'
  | 'AMBIGUOUS_PROVIDER_MATCH'
  | 'AMBIGUOUS_SYMBOL'
  | 'EXPANSION_LIMIT_EXCEEDED'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'TEST_SOURCE_ROOT_INVALID'
  | 'FILE_PARSE_FAILED'
  | 'PLUGIN_EXTRACTION_FAILED'
  | 'RULES_INVALID';

export interface PluginDiagnostic {
  pluginId: string;
  repo: string;
  filePath?: string;
  line?: number;
  severity: PluginDiagnosticSeverity;
  code: PluginDiagnosticCode;
  message: string;
  details?: Record<string, unknown>;
}

export type PluginMetricName =
  | 'files_scanned'
  | 'java_files_parsed'
  | 'files_skipped'
  | 'constants_indexed'
  | 'providers_detected'
  | 'consumers_detected'
  | 'duration_ms'
  | 'diagnostics_peak';

export interface PluginMetric {
  pluginId: string;
  repo: string;
  name: PluginMetricName;
  value: number;
}

export interface PluginI18nBundle {
  namespace: string;
  resources: {
    en: Record<string, string>;
    'zh-CN'?: Record<string, string>;
  };
}

export interface PluginTranslator {
  t(key: string, vars?: Record<string, unknown>): string;
}

export interface GroupPluginContext {
  locale: string;
  createTranslator(namespace: string): PluginTranslator;
  reportDiagnostic(diagnostic: PluginDiagnostic): void;
  reportMetric(metric: PluginMetric): void;
}

export interface PluginReport {
  id: string;
  version: string;
  diagnostics: PluginDiagnostic[];
  metrics: PluginMetric[];
}

export interface GroupPluginRuntime {
  extension: GroupSyncExtension;
  getReport(): PluginReport;
}

export interface GroupContractPlugin {
  id: string;
  version: string;
  createRuntime(): GroupPluginRuntime;
}
