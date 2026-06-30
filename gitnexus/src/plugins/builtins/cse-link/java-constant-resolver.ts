/**
 * Java constant resolver for the CSE-link plugin.
 *
 * This is the public facade. It assembles the per-file index and
 * exposes a resolver API to the provider/consumer scanners.
 *
 * Implementation delegates to:
 *   - class-constant-index.ts: per-class field isolation
 *   - string-expression-evaluator.ts: AST-based expression evaluation
 *   - reaching-value-resolver.ts: CFG-based reaching-value resolution
 *
 * Resolves string constants from:
 *   - String literals
 *   - File-local constants (same class)
 *   - Cross-class constants (same repo)
 *   - External constants (from microservice-rules.yaml)
 *
 * Supports string concatenation (`+`), field access chains, and
 * `URI.create()` wrappers. Method-local variables use CFG-based
 * reaching-definitions analysis for correct scope, shadowing, and
 * reassignment handling.
 */

import path from 'node:path';
import type Parser from 'tree-sitter';
import type { JavaCseRules } from './rules.js';
import {
  buildFileIndex,
  lookupFieldConstant,
  lookupUnqualifiedFieldConstant,
  buildFlatFieldMap,
  type FileIndex,
} from './java-analysis/class-constant-index.js';
import {
  evaluateStringExpression,
  evaluateTextExpression,
  type ExpressionResolveContext,
} from './java-analysis/string-expression-evaluator.js';
import {
  resolveExpressionAtCallSite,
  type ReachingValueContext,
  type MethodAnalysisCache,
} from './java-analysis/reaching-value-resolver.js';
import { known, unknown, type ResolvedValue } from './java-analysis/model.js';

export interface JavaCseRepoContext {
  serviceName?: string;
  serviceNameCandidates: string[];
  /** Per-file indexes (keyed by repo-relative file path). */
  fileIndexes: Map<string, FileIndex>;
  /** @deprecated Use fileIndexes instead. Flat field maps for backward compat. */
  constantsByFile: Map<string, FileConstantIndex>;
  /** @deprecated Use per-class lookups. Flat map of class simple name → fields. */
  constantsByClass: Map<string, Map<string, string>>;
  externalConstantsByClass: Map<string, Map<string, string>>;
  externalConstantsBySimpleName: Map<string, Map<string, string>>;
}

/** @deprecated Legacy file index shape. Kept for backward compat. */
interface FileConstantIndex {
  byName: Map<string, string>;
  imports: Map<string, string>;
  uriHelpers: Set<string>;
}

export interface JavaConstantResolver {
  /**
   * Resolve an expression node to a string value.
   *
   * When `scopeNode` is provided (the enclosing method_declaration),
   * the resolver uses CFG-based reaching-definitions to correctly
   * handle block scoping, shadowing, reassignment, and control flow
   * merging. When omitted, only class-level constants are available
   * (suitable for provider annotation resolution).
   */
  resolveExpression(
    node: Parser.SyntaxNode | undefined | null,
    scopeNode?: Parser.SyntaxNode,
  ): string | null;
}

const URI_HELPER_RE =
  /\bURI\s+([A-Za-z_]\w*)\s*\(\s*String\s+[A-Za-z_]\w*\s*\)\s*\{[^{}]*return\s+URI\.create\s*\(\s*[A-Za-z_]\w*\s*\)\s*;/g;

function packageName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 1 ? normalized.slice(0, idx).replace(/\//g, '.') : '';
}

// ── Repo context builder ────────────────────────────────────────

export function buildJavaCseRepoContext(args: {
  files: string[];
  readFile: (rel: string) => string | null;
  parseFile: (rel: string) => Parser.Tree | null;
  rules: JavaCseRules;
}): JavaCseRepoContext {
  const fileIndexes = new Map<string, FileIndex>();
  const constantsByFile = new Map<string, FileConstantIndex>();
  const constantsByClass = new Map<string, Map<string, string>>();
  const externalConstantsByClass = new Map<string, Map<string, string>>();
  const externalConstantsBySimpleName = new Map<string, Map<string, string>>();

  // Build external constants indexes
  for (const rule of args.rules.externalConstants) {
    const constants = new Map(Object.entries(rule.constants));
    externalConstantsByClass.set(rule.className, constants);
    externalConstantsBySimpleName.set(
      rule.className.split('.').pop() ?? rule.className,
      constants,
    );
  }

  // Service name detection from config files
  const serviceCandidates = [
    'code/webapp/src/main/resources/application.yaml',
    'code/webapp/src/main/resources/application.yml',
    'code/webapp/src/main/resources/application.properties',
    'src/main/resources/application.yaml',
    'src/main/resources/application.yml',
    'src/main/resources/application.properties',
    'src/main/resources/bootstrap.yaml',
    'src/main/resources/bootstrap.yml',
    'src/main/resources/bootstrap.properties',
    ...args.files.filter((file) =>
      /^(?:code\/.*|src\/main\/resources\/.*)(?:application|bootstrap)\.(?:ya?ml|properties)$/i.test(
        file.replace(/\\/g, '/'),
      ),
    ),
  ];

  const foundServiceNames = new Set<string>();
  for (const rel of serviceCandidates) {
    const source = args.readFile(rel);
    if (!source) continue;
    const yamlName =
      /service_description\s*:\s*[\r\n]+(?:[ \t]+[^\r\n]*[\r\n]+)*?[ \t]+name\s*:\s*["']?([^"'\r\n#]+)["']?/m.exec(
        source,
      )?.[1]?.trim();
    const propsName = /service_description\.name\s*=\s*([^\r\n#]+)/.exec(source)?.[1]?.trim();
    const name = yamlName ?? propsName;
    if (name) foundServiceNames.add(name);
  }
  const serviceName =
    foundServiceNames.size === 1 ? ([...foundServiceNames][0] as string) : undefined;

  // Phase 1: Build per-file indexes with field constant resolution
  // First pass: collect raw file indexes without resolving field cross-references
  const rawIndexes = new Map<string, FileIndex>();
  for (const rel of args.files.filter((file) => file.endsWith('.java'))) {
    const source = args.readFile(rel);
    if (!source) continue;
    const tree = args.parseFile(rel);
    if (!tree) continue;

    // Build a preliminary index (field values resolved against literals only)
    const index = buildFileIndex(source, tree, rel, (exprNode) => {
      // Phase 1: only resolve string literals (no cross-field references yet)
      return evaluateStringExpression(exprNode, {
        resolveIdentifier: () => null,
        resolveFieldAccess: () => null,
      });
    });

    rawIndexes.set(rel, index);
  }

  // Phase 2: Build a cross-file class constant map for field resolution
  // FQCN → fields (exact lookup)
  // simpleName → Set<FQCN> (for ambiguity detection)
  const allFieldsByFqcn = new Map<string, Map<string, string>>();
  const allFqcnsBySimpleName = new Map<string, Set<string>>();

  for (const [rel, index] of rawIndexes) {
    for (const [simpleName, classIndex] of index.byClassName) {
      // Track all FQCNs per simple name (for ambiguity detection)
      let fqcnSet = allFqcnsBySimpleName.get(simpleName);
      if (!fqcnSet) {
        fqcnSet = new Set();
        allFqcnsBySimpleName.set(simpleName, fqcnSet);
      }
      fqcnSet.add(classIndex.fqcn);
    }
    for (const [fqcn, classIndex] of index.byFqcn) {
      allFieldsByFqcn.set(fqcn, new Map(classIndex.fields));
    }
  }

  // Phase 3: Rebuild indexes with full cross-field resolution
  for (const rel of args.files.filter((file) => file.endsWith('.java'))) {
    const source = args.readFile(rel);
    if (!source) continue;
    const tree = args.parseFile(rel);
    if (!tree) continue;

    const rawIndex = rawIndexes.get(rel);
    if (!rawIndex) continue;

    // Build a resolve callback that can look up cross-class constants
    const resolveFieldExpr = (exprNode: Parser.SyntaxNode): ResolvedValue => {
      const ctx: ExpressionResolveContext = {
        resolveIdentifier: (name) => {
          // Look up in same file first
          for (const classIndex of rawIndex.byClassName.values()) {
            const value = classIndex.fields.get(name);
            if (value !== undefined) return value;
          }
          // Cross-file: simple name → only if unique
          const fqcns = allFqcnsBySimpleName.get(name);
          if (fqcns && fqcns.size === 1) {
            const fqcn = [...fqcns][0]!;
            const fields = allFieldsByFqcn.get(fqcn);
            // For bare identifiers, look for a field with the same name
            // (the identifier IS the field name in this context)
            // Actually, bare identifiers in field initializer context
            // refer to fields in the same file — already handled above.
          }
          return null;
        },
        resolveFieldAccess: (owner, field) => {
          // 1. Try as FQCN (exact)
          const byFqcn = allFieldsByFqcn.get(owner);
          if (byFqcn) {
            const value = byFqcn.get(field);
            if (value !== undefined) return value;
          }
          // 2. Try import resolution (exact)
          const imported = rawIndex.imports.get(owner);
          if (imported) {
            const byImport = allFieldsByFqcn.get(imported);
            if (byImport) {
              const value = byImport.get(field);
              if (value !== undefined) return value;
            }
          }
          // 3. Try current package + owner (exact)
          if (rawIndex.packageName) {
            const pkgFqcn = `${rawIndex.packageName}.${owner}`;
            const byPkg = allFieldsByFqcn.get(pkgFqcn);
            if (byPkg) {
              const value = byPkg.get(field);
              if (value !== undefined) return value;
            }
          }
          // 4. Try simple name — ONLY if unique across all files
          const fqcns = allFqcnsBySimpleName.get(owner);
          if (fqcns && fqcns.size === 1) {
            const fqcn = [...fqcns][0]!;
            const bySimple = allFieldsByFqcn.get(fqcn);
            if (bySimple) {
              const value = bySimple.get(field);
              if (value !== undefined) return value;
            }
          }
          // 5. Try external constants (by FQCN then simple name)
          const extByClass = externalConstantsByClass.get(owner);
          if (extByClass) {
            const value = extByClass.get(field);
            if (value !== undefined) return value;
          }
          if (imported) {
            const extByImport = externalConstantsByClass.get(imported);
            if (extByImport) {
              const value = extByImport.get(field);
              if (value !== undefined) return value;
            }
          }
          const extBySimple = externalConstantsBySimpleName.get(owner);
          if (extBySimple) {
            const value = extBySimple.get(field);
            if (value !== undefined) return value;
          }
          return null;
        },
      };
      return evaluateStringExpression(exprNode, ctx);
    };

    const index = buildFileIndex(source, tree, rel, resolveFieldExpr);
    fileIndexes.set(rel, index);

    // Build legacy flat index for backward compat
    const flatFields = buildFlatFieldMap(index);
    const uriHelpers = new Set<string>();
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const match of clean.matchAll(URI_HELPER_RE)) {
      if (match[1]) uriHelpers.add(match[1]);
    }

    constantsByFile.set(rel, {
      byName: flatFields,
      imports: new Map(index.imports),
      uriHelpers,
    });

    // Build legacy class → fields map (keyed by FQCN to avoid same-name collisions)
    const pkg = index.packageName;
    for (const [simpleName, classIndex] of index.byClassName) {
      const fieldMap = new Map(classIndex.fields);
      // Key by FQCN (primary)
      constantsByClass.set(classIndex.fqcn, fieldMap);
      // Key by simple name ONLY if not already taken (for backward compat)
      if (!constantsByClass.has(simpleName)) {
        constantsByClass.set(simpleName, fieldMap);
      }
      // Also key by file base name for backward compat (only if unique)
      const fileBaseName = path.basename(rel, '.java');
      if (!constantsByClass.has(fileBaseName)) {
        constantsByClass.set(fileBaseName, fieldMap);
      }
    }
  }

  return {
    ...(serviceName ? { serviceName } : {}),
    serviceNameCandidates: [...foundServiceNames].sort(),
    fileIndexes,
    constantsByFile,
    constantsByClass,
    externalConstantsByClass,
    externalConstantsBySimpleName,
  };
}

// ── Resolver factory ────────────────────────────────────────────

export function createJavaConstantResolver(
  ctx: JavaCseRepoContext | undefined,
  fileRel: string | undefined,
): JavaConstantResolver {
  const fileIndex = fileRel && ctx ? ctx.fileIndexes.get(fileRel) : undefined;
  const legacyIndex = fileRel && ctx ? ctx.constantsByFile.get(fileRel) : undefined;
  const imports = fileIndex?.imports ?? legacyIndex?.imports ?? new Map<string, string>();
  const flatFields = fileIndex ? buildFlatFieldMap(fileIndex) : (legacyIndex?.byName ?? new Map<string, string>());
  const uriHelpers = legacyIndex?.uriHelpers ?? new Set<string>();

  // Per-file method analysis cache (shared across all resolutions in the same file)
  const methodCache: MethodAnalysisCache = new Map();

  /**
   * Build the expression resolve context for class-level resolution
   * (no method scope).
   */
  const buildClassLevelContext = (): ExpressionResolveContext => ({
    resolveIdentifier: (name: string): string | null => {
      if (!ctx) return null;
      // Look up in same file's fields
      const localValue = lookupUnqualifiedFieldConstant(fileIndex!, name);
      if (localValue !== null) return localValue;
      // Look up in flat fields (cross-file)
      const flatValue = flatFields.get(name);
      if (flatValue !== undefined) return flatValue;
      return null;
    },
    resolveFieldAccess: (owner: string, field: string): string | null => {
      if (!ctx) return null;
      // 1. Look up in same file by qualified name (FQCN, import, simple name in file)
      if (fileIndex) {
        const localValue = lookupFieldConstant(fileIndex, owner, field);
        if (localValue !== null) return localValue;
      }
      const isFqcn = owner.includes('.');
      // 2. If owner is a FQCN (contains dot), do exact FQCN lookup
      if (isFqcn) {
        const byFqcn = ctx.constantsByClass.get(owner);
        if (byFqcn) {
          const value = byFqcn.get(field);
          if (value !== undefined) return value;
        }
        // External constants by FQCN
        const extByFqcn = ctx.externalConstantsByClass.get(owner);
        if (extByFqcn) {
          const value = extByFqcn.get(field);
          if (value !== undefined) return value;
        }
      }
      // 3. Explicit import → resolve to FQCN → exact lookup
      const importedFqcn = imports.get(owner);
      if (importedFqcn) {
        const byImport = ctx.constantsByClass.get(importedFqcn);
        if (byImport) {
          const value = byImport.get(field);
          if (value !== undefined) return value;
        }
        const extByImport = ctx.externalConstantsByClass.get(importedFqcn);
        if (extByImport) {
          const value = extByImport.get(field);
          if (value !== undefined) return value;
        }
      }
      // 4. Current package + owner (exact)
      if (fileIndex?.packageName) {
        const pkgFqcn = `${fileIndex.packageName}.${owner}`;
        const byPkg = ctx.constantsByClass.get(pkgFqcn);
        if (byPkg) {
          const value = byPkg.get(field);
          if (value !== undefined) return value;
        }
      }
      // 5. External constants by simple name
      const extBySimple = ctx.externalConstantsBySimpleName.get(owner);
      if (extBySimple) {
        const value = extBySimple.get(field);
        if (value !== undefined) return value;
      }
      // 6. Simple name lookup — ONLY if the simple name is unambiguous
      // Count how many distinct FQCNs end with this simple name
      if (!isFqcn) {
        let matchCount = 0;
        let matchedValue: string | undefined;
        for (const [key, fieldMap] of ctx.constantsByClass.entries()) {
          if (key.endsWith(`.${owner}`) || key === owner) {
            matchCount++;
            const v = fieldMap.get(field);
            if (v !== undefined) matchedValue = v;
          }
        }
        // Only return if unique match
        if (matchCount === 1 && matchedValue !== undefined) return matchedValue;
        // Ambiguous or not found → return null
      }
      return null;
    },
  });

  /**
   * Build the reaching value context for method-level resolution.
   */
  const buildMethodLevelContext = (): ReachingValueContext => {
    const classCtx = buildClassLevelContext();
    return {
      resolveClassConstant: (name) => classCtx.resolveIdentifier(name),
      resolveCrossClassConstant: (owner, field) => classCtx.resolveFieldAccess(owner, field),
      resolveExternalConstant: (className, fieldName) => {
        if (!ctx) return null;
        return (
          ctx.externalConstantsByClass.get(className)?.get(fieldName) ??
          ctx.externalConstantsBySimpleName.get(className)?.get(fieldName) ??
          null
        );
      },
    };
  };

  const resolveExpression = (
    node: Parser.SyntaxNode | undefined | null,
    scopeNode?: Parser.SyntaxNode,
  ): string | null => {
    if (!node) return null;

    // Method-level resolution (consumer scanning)
    if (scopeNode) {
      const methodCtx = buildMethodLevelContext();
      const result = resolveExpressionAtCallSite(
        node,
        scopeNode,
        fileRel ?? '',
        methodCtx,
        methodCache,
      );
      return result.kind === 'known' ? result.value : null;
    }

    // Class-level resolution (provider scanning)
    const classCtx = buildClassLevelContext();

    // Expression type dispatch
    if (node.type === 'string_literal') {
      const text = node.text;
      if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        return text.slice(1, -1).replace(/\\(.)/g, '$1');
      }
      return text;
    }

    if (node.type === 'identifier') {
      return classCtx.resolveIdentifier(node.text);
    }

    if (node.type === 'field_access') {
      const objectNode = node.childForFieldName('object');
      const fieldNode = node.childForFieldName('field');
      if (!objectNode || !fieldNode) return null;
      return classCtx.resolveFieldAccess(
        buildFieldAccessPath(objectNode),
        fieldNode.text,
      );
    }

    if (node.type === 'binary_expression') {
      const result = evaluateStringExpression(node, classCtx);
      return result.kind === 'known' ? result.value : null;
    }

    if (node.type === 'method_invocation') {
      const name = node.childForFieldName('name')?.text;
      const object = node.childForFieldName('object')?.text;
      const args = node.childForFieldName('arguments')?.namedChildren ?? [];
      if (name === 'create' && object === 'URI' && args[0]) {
        return resolveExpression(args[0]);
      }
      if (name && uriHelpers.has(name) && args[0]) {
        return resolveExpression(args[0]);
      }
    }

    return null;
  };

  return { resolveExpression };
}

/**
 * Build a dotted path from a field_access node chain.
 */
function buildFieldAccessPath(node: Parser.SyntaxNode): string {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'field_access') {
    const object = node.childForFieldName('object');
    const field = node.childForFieldName('field');
    if (!object || !field) return node.text;
    return `${buildFieldAccessPath(object)}.${field.text}`;
  }
  return node.text;
}
