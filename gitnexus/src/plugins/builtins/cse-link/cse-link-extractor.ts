/**
 * CSE-link contract extractor.
 *
 * Implements ContractExtractor for type 'http'. When activated by the
 * plugin system, this extractor replaces the default HttpRouteExtractor
 * for the entire group sync. It only extracts CSE provider and consumer
 * contracts from Java + Spring MVC projects.
 *
 * Pipeline per repo:
 *   1. canExtract(): check Java + Spring MVC capability
 *   2. Load rules from microservice-rules.yaml
 *   3. Build repo context (constants index, service name)
 *   4. Scan files for providers and consumers
 *   5. Filter test source-set consumers
 *   6. Generate contracts with stable UIDs
 *   7. Report diagnostics and metrics
 */

import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { glob } from 'glob';
import type {
  ContractExtractor,
  CypherExecutor,
} from '../../../core/group/contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../../../core/group/types.js';
import { createIgnoreFilter } from '../../../config/ignore-service.js';
import { parseSourceSafe } from '../../../core/tree-sitter/safe-parse.js';
import { readSafe } from '../../../core/group/extractors/fs-utils.js';
import { hasJavaSpringCapability } from './capability.js';
import { isTestSourcePath } from './test-source-filter.js';
import { loadJavaCseRules } from './rules.js';
import { buildJavaCseRepoContext } from './java-constant-resolver.js';
import {
  scanSpringCseProviders,
  scanRestTemplateCseConsumers,
  type CseDetection,
} from './java-scanner.js';
import { generateSyntheticUid } from './synthetic-uid.js';
import { normalizePathTemplate } from './cse-url.js';
import type { GroupPluginContext, PluginDiagnostic } from '../../plugin-api.js';

const JAVA_SCAN_GLOB = '**/*.java';
const MAX_DIAGNOSTICS_PER_REPO = 200;

export class CseLinkExtractor implements ContractExtractor {
  type = 'http' as const;

  constructor(private readonly context: GroupPluginContext) {}

  async canExtract(repo: RepoHandle): Promise<boolean> {
    // File discovery: I/O, glob, and permission errors propagate
    // (syncGroup catches these and enters failedRepos).
    const ignoreFilter = await createIgnoreFilter(repo.repoPath);
    const javaGlob = await glob('**/*.java', {
      cwd: repo.repoPath,
      ignore: ignoreFilter,
      nodir: true,
    });
    const buildGlob = await glob('**/{pom.xml,build.gradle,build.gradle.kts}', {
      cwd: repo.repoPath,
      ignore: ignoreFilter,
      nodir: true,
    });
    // Capability check: false for normal negatives; propagates
    // readFileSync errors as exceptions (enters failedRepos).
    return hasJavaSpringCapability(repo.repoPath, javaGlob.concat(buildGlob));
  }

  async extract(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    // Core sync deliberately knows nothing about plugin capability rules.
    // A non-Java or non-Spring repository is a normal plugin-local skip.
    if (!(await this.canExtract(repo))) return [];

    const startTime = Date.now();
    const diagnostics: PluginDiagnostic[] = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let providersDetected = 0;
    let consumersDetected = 0;

    // Use the plugin's own i18n bundle for diagnostic messages. The
    // translator falls back to English when the active locale lacks a key.
    const translator = this.context.createTranslator('cse-link');
    const t = (key: string, vars?: Record<string, unknown>) => translator.t(key, vars);

    // Load rules (may throw RulesError — caught below for RULES_INVALID)
    let loaded;
    try {
      loaded = loadJavaCseRules(repoPath);
    } catch (rulesErr) {
      const rulesMsg = rulesErr instanceof Error ? rulesErr.message : String(rulesErr);
      diagnostics.push({
        pluginId: 'cse-link',
        repo: repo.id,
        severity: 'error',
        code: 'RULES_INVALID',
        message: `Invalid microservice-rules.yaml: ${rulesMsg}`,
        details: { error: rulesMsg },
      });
      for (const d of diagnostics) this.context.reportDiagnostic(d);
      throw rulesErr;
    }
    const { rules, testSourceRoots } = loaded;

    // Glob Java files
    const ignoreFilter = await createIgnoreFilter(repoPath);
    const files = await glob(JAVA_SCAN_GLOB, {
      cwd: repoPath,
      ignore: ignoreFilter,
      nodir: true,
    });

    filesScanned = files.length;

    // Also glob config files so the service name resolver can detect
    // service_description.name from application*.yaml/bootstrap.* in
    // arbitrary subproject locations, not just the hard-coded ones.
    const configFiles = await glob(
      '**/{src/main/resources,code/**/src/main/resources}/{application,bootstrap}.{yaml,yml,properties}',
      {
        cwd: repoPath,
        ignore: ignoreFilter,
        nodir: true,
      },
    );

    // Create parser and parse all Java files upfront
    const parser = new Parser();
    parser.setLanguage(Java);

    // Cache parsed trees so we can reuse them for field collection and scanning
    const parsedTrees = new Map<string, Parser.Tree | null>();
    for (const rel of files) {
      const content = readSafe(repoPath, rel);
      if (!content) {
        parsedTrees.set(rel, null);
        continue;
      }
      const tree = parseSourceSafe(parser, content);
      parsedTrees.set(rel, tree);
    }

    // Build repo context with access to parsed trees for field collection
    const repoContext = buildJavaCseRepoContext({
      files: [...files, ...configFiles],
      readFile: (rel) => readSafe(repoPath, rel),
      parseFile: (rel) => parsedTrees.get(rel) ?? null,
      rules,
    });

    // Provider gate: without a unique service identity, provider contracts
    // from this repo would carry an empty or wrong serviceName and produce
    // no cross-repo matches. Consumers are still extracted — they carry
    // their own serviceRef from the CSE URL and do not depend on the
    // repo's own service identity.
    const skipProviders = !repoContext.serviceName;

    // Check service name. Three cases:
    //   - 0 candidates: emit MISSING_SERVICE_NAME
    //   - 1 candidate: silent (service name is unambiguous)
    //   - 2+ candidates: emit AMBIGUOUS_SERVICE_NAME with the list
    if (repoContext.serviceNameCandidates.length === 0) {
      diagnostics.push({
        pluginId: 'cse-link',
        repo: repo.id,
        severity: 'warning',
        code: 'MISSING_SERVICE_NAME',
        message: t('missingServiceName', { repo: repo.id }),
      });
    } else if (repoContext.serviceNameCandidates.length > 1) {
      diagnostics.push({
        pluginId: 'cse-link',
        repo: repo.id,
        severity: 'warning',
        code: 'AMBIGUOUS_SERVICE_NAME',
        message: t('ambiguousServiceName', {
          repo: repo.id,
          names: repoContext.serviceNameCandidates.join(', '),
        }),
      });
    }

    // Scan each file using cached parsed trees
    const allDetections: CseDetection[] = [];

    for (const rel of files) {
      const content = readSafe(repoPath, rel);
      if (!content) {
        filesSkipped++;
        continue;
      }

      const tree = parsedTrees.get(rel);
      if (!tree) {
        filesSkipped++;
        diagnostics.push({
          pluginId: 'cse-link',
          repo: repo.id,
          filePath: rel,
          severity: 'warning',
          code: 'FILE_PARSE_FAILED',
          message: t('fileParseFailed', { file: rel }),
        });
        continue;
      }

      // Scan providers
      const providers = scanSpringCseProviders(tree, rel, repoContext);
      allDetections.push(...providers);

      // Scan consumers (skip test sources)
      if (!isTestSourcePath(rel, testSourceRoots)) {
        const consumers = scanRestTemplateCseConsumers(tree, rel, repoContext);
        allDetections.push(...consumers);
      }
    }

    // Convert detections to contracts
    const contracts: ExtractedContract[] = [];
    const seen = new Set<string>();

    for (const d of allDetections) {
      // Provider gate: skip providers when this repo has no unique
      // service identity. Consumers are not affected — they carry their
      // own serviceRef from the CSE URL.
      if (skipProviders && d.role === 'provider') {
        continue;
      }

      const pathNorm = d.role === 'consumer'
        ? normalizePathTemplate(d.path)
        : d.path;
      const contractId = `http::${d.method}::${pathNorm}`;

      // Dedup key uses methodStartLine (method declaration line) for consumer
      // contracts so multiple call sites within the same method (e.g. two
      // branches of searchOrders) produce one contract.  Provider contracts
      // still use startLine (annotation line) since each @Mapping is unique.
      // Overloaded methods are distinguished by their different methodStartLine
      // values.
      const serviceIdentity = d.role === 'consumer'
        ? (d.serviceRef ?? '')
        : (d.serviceRef ?? repoContext.serviceName ?? '');
      const identityLine = d.role === 'consumer' ? (d.methodStartLine ?? d.startLine ?? 0) : (d.startLine ?? 0);
      const dedupKey = `${contractId}|${d.role}|${d.filePath ?? ''}|${identityLine}|${d.name ?? ''}|${serviceIdentity}|${d.enclosingClass ?? ''}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      // Generate stable synthetic UID anchored on enclosing method for
      // consumers (methodStartLine) so all calls from the same method
      // share the same instance identity.  Providers are still anchored
      // on the declaration line.
      const uidLine = d.role === 'consumer' ? identityLine : (d.startLine ?? 0);
      const symbolUid = generateSyntheticUid({
        pluginId: 'cse-link',
        role: d.role,
        filePath: d.filePath ?? '',
        ...(d.enclosingClass ? { enclosingClass: d.enclosingClass } : {}),
        ...(d.name ? { enclosingMethod: d.name } : {}),
        ...(uidLine ? { startLine: uidLine } : {}),
        httpMethod: d.method,
        normalizedPath: pathNorm,
        serviceIdentity,
      });

      const symbolName = d.name ?? (d.role === 'consumer' ? 'fetch' : 'handler');
      const symbolFile = d.filePath ?? '';

      contracts.push({
        contractId,
        type: 'http',
        role: d.role,
        symbolUid,
        symbolRef: { filePath: symbolFile, name: symbolName },
        symbolName,
        confidence: d.confidence,
        meta: {
          sourcePlugin: 'cse-link',
          framework: d.framework,
          extractionStrategy: 'source_authoritative',
          method: d.method,
          path: pathNorm,
          ...(d.role === 'consumer'
            ? {
                serviceRef: d.serviceRef,
                matchPolicy: 'service-exact',
                ...(d.appId ? { appId: d.appId } : {}),
                ...(d.queryTemplate ? { queryTemplate: d.queryTemplate } : {}),
              }
            : {
                serviceName: repoContext.serviceName ?? d.serviceRef,
              }),
        },
      });

      if (d.role === 'provider') providersDetected++;
      else consumersDetected++;
    }

    // Report diagnostics, capped at MAX_DIAGNOSTICS_PER_REPO.
    // Beyond the cap, we report a single aggregate diagnostic with a
    // suppressed count so the operator can still see the issue exists.
    const reported = diagnostics.slice(0, MAX_DIAGNOSTICS_PER_REPO);
    const suppressed = diagnostics.length - reported.length;
    for (const d of reported) {
      this.context.reportDiagnostic(d);
    }
    if (suppressed > 0) {
      this.context.reportDiagnostic({
        pluginId: 'cse-link',
        repo: repo.id,
        severity: 'info',
        code: 'RESOURCE_LIMIT_EXCEEDED',
        message: t('suppressed', { count: suppressed, limit: MAX_DIAGNOSTICS_PER_REPO, repo: repo.id }),
      });
    }

    // Report metrics
    const durationMs = Date.now() - startTime;
    this.context.reportMetric({ pluginId: 'cse-link', repo: repo.id, name: 'files_scanned', value: filesScanned });
    this.context.reportMetric({ pluginId: 'cse-link', repo: repo.id, name: 'files_skipped', value: filesSkipped });
    this.context.reportMetric({ pluginId: 'cse-link', repo: repo.id, name: 'providers_detected', value: providersDetected });
    this.context.reportMetric({ pluginId: 'cse-link', repo: repo.id, name: 'consumers_detected', value: consumersDetected });
    this.context.reportMetric({ pluginId: 'cse-link', repo: repo.id, name: 'duration_ms', value: durationMs });

    return contracts;
  }
}
