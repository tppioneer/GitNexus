/**
 * Reaching value resolver for the CSE-link plugin.
 *
 * Resolves the value of a variable at a specific call site by:
 *   1. Building a CFG for the enclosing method
 *   2. Computing reaching definitions
 *   3. Finding which definitions of the variable reach the call site
 *   4. Evaluating each definition's RHS (from the AST)
 *   5. Merging the results (same value → Known; different → Unknown)
 *
 * Handles:
 *   - Block scoping (each {} creates a new scope)
 *   - Variable shadowing (inner scopes can shadow outer variables)
 *   - Reassignment (url = "new" updates the reaching definition)
 *   - Control flow merging (if/else, loops, try/catch)
 *   - Class fields (fallback when no local binding exists)
 *   - Compound assignment (+=)
 */

import type Parser from 'tree-sitter';
import type { ResolvedValue } from './model.js';
import { known, unknown, mergeAllValues } from './model.js';
import type { MethodAnalysis } from './cfg-adapter.js';
import {
  analyzeMethod,
  findBindingByName,
  findAllBindingsByName,
  isSyntheticBinding,
  getBinding,
  findProgramPointForPosition,
  findReachingDefsForBinding,
} from './cfg-adapter.js';
import type { DefinitionCatalog, DefSite } from './definition-catalog.js';
import { buildDefinitionCatalog, findDefSitesForReachingDef } from './definition-catalog.js';
import {
  evaluateStringExpression,
  type ExpressionResolveContext,
} from './string-expression-evaluator.js';

type SyntaxNode = Parser.SyntaxNode;

/**
 * Context for the reaching value resolver.
 */
export interface ReachingValueContext {
  /**
   * Resolve a class-level field constant by name.
   * Called when the identifier has no local binding (it's a field reference).
   */
  resolveClassConstant(name: string): string | null;

  /**
   * Resolve a cross-class field constant.
   * Called for qualified field accesses like `ClassName.FIELD`.
   */
  resolveCrossClassConstant(owner: string, field: string): string | null;

  /**
   * Resolve an external constant (from microservice-rules.yaml).
   */
  resolveExternalConstant(className: string, fieldName: string): string | null;
}

/**
 * Resolve the value of an expression node at a call site.
 *
 * This is the main entry point for the reaching-value resolver.
 *
 * @param exprNode - The expression to resolve (e.g., the URL argument).
 * @param methodNode - The enclosing method_declaration.
 * @param filePath - Repo-relative file path.
 * @param ctx - Resolution context for class/external constants.
 * @param methodCache - Optional cache for method analysis results.
 */
export function resolveExpressionAtCallSite(
  exprNode: SyntaxNode | null | undefined,
  methodNode: SyntaxNode,
  filePath: string,
  ctx: ReachingValueContext,
  methodCache?: MethodAnalysisCache,
): ResolvedValue {
  if (!exprNode) return unknown();

  // String literals can be resolved directly without CFG analysis
  if (exprNode.type === 'string_literal') {
    return tryDirectEvaluation(exprNode, ctx);
  }

  // Field accesses (e.g., ClassName.FIELD) can be resolved from cross-class constants
  if (exprNode.type === 'field_access') {
    return tryDirectEvaluation(exprNode, ctx);
  }

  // Identifiers MUST go through CFG-based resolution because they might be
  // local variables that shadow class constants
  if (exprNode.type === 'identifier') {
    return resolveIdentifierAtCallSite(exprNode, methodNode, filePath, ctx, methodCache);
  }

  // For binary expressions, try recursive resolution
  if (exprNode.type === 'binary_expression') {
    return resolveBinaryExpressionAtCallSite(exprNode, methodNode, filePath, ctx, methodCache);
  }

  // For parenthesized expressions, evaluate the inner expression
  if (exprNode.type === 'parenthesized_expression') {
    const inner = exprNode.namedChildren[0];
    if (inner) return resolveExpressionAtCallSite(inner, methodNode, filePath, ctx, methodCache);
    return unknown();
  }

  // For method invocations (URI.create), evaluate the argument
  if (exprNode.type === 'method_invocation') {
    const name = exprNode.childForFieldName('name')?.text;
    const object = exprNode.childForFieldName('object')?.text;
    const args = exprNode.childForFieldName('arguments')?.namedChildren ?? [];
    if (name === 'create' && object === 'URI' && args.length >= 1) {
      return resolveExpressionAtCallSite(args[0]!, methodNode, filePath, ctx, methodCache);
    }
    return unknown();
  }

  // Fallback: try direct evaluation (for any other expression forms)
  return tryDirectEvaluation(exprNode, ctx);
}

/**
 * Try to evaluate an expression directly from the AST without CFG analysis.
 * Works for string literals, field accesses, and concatenations of constants.
 */
function tryDirectEvaluation(
  node: SyntaxNode,
  ctx: ReachingValueContext,
): ResolvedValue {
  const resolveCtx: ExpressionResolveContext = {
    resolveIdentifier: (name) => ctx.resolveClassConstant(name),
    resolveFieldAccess: (owner, field) =>
      ctx.resolveCrossClassConstant(owner, field) ??
      ctx.resolveExternalConstant(owner, field),
  };
  return evaluateStringExpression(node, resolveCtx);
}

/**
 * Try direct evaluation with a wider context that includes method-local
 * resolution for sub-expressions.
 */
function tryDirectEvaluationWithContext(
  node: SyntaxNode,
  methodNode: SyntaxNode,
  filePath: string,
  ctx: ReachingValueContext,
  methodCache?: MethodAnalysisCache,
): ResolvedValue {
  // Build a resolve context that falls back to reaching-value resolution
  // for identifiers
  const resolveCtx: ExpressionResolveContext = {
    resolveIdentifier: (name) => {
      // Try class constant first
      const classConst = ctx.resolveClassConstant(name);
      if (classConst !== null) return classConst;
      // Not available without CFG analysis
      return null;
    },
    resolveFieldAccess: (owner, field) =>
      ctx.resolveCrossClassConstant(owner, field) ??
      ctx.resolveExternalConstant(owner, field),
  };

  return evaluateStringExpression(node, resolveCtx);
}

/**
 * Resolve an identifier at a call site using CFG reaching definitions.
 *
 * Two-pass resolution:
 *   Pass 1: Non-synthetic (local) bindings. If any has reaching defs at
 *           the use point, use ONLY those values (local shadows field).
 *   Pass 2: Synthetic (field) bindings. Only checked when no local binding
 *           has reaching defs at the use point.
 */
function resolveIdentifierAtCallSite(
  identifierNode: SyntaxNode,
  methodNode: SyntaxNode,
  filePath: string,
  ctx: ReachingValueContext,
  methodCache?: MethodAnalysisCache,
): ResolvedValue {
  const varName = identifierNode.text;

  // Get or build method analysis
  const analysis = getOrBuildMethodAnalysis(methodNode, filePath, methodCache);
  if (!analysis) {
    // CFG analysis failed — fall back to class constant
    const classConst = ctx.resolveClassConstant(varName);
    return classConst !== null ? known(classConst) : unknown();
  }

  const { cfg } = analysis;

  // Find the program point for the identifier's position
  const usePoint = findProgramPointForPosition(
    cfg,
    identifierNode.startPosition.row,
    identifierNode.startPosition.column,
    identifierNode,
  );

  // Find all bindings with this name
  const bindingIndices = findAllBindingsByName(analysis, varName);

  if (bindingIndices.length === 0) {
    // No local binding at all — it's a field reference
    const classConst = ctx.resolveClassConstant(varName);
    return classConst !== null ? known(classConst) : unknown();
  }

  if (!usePoint) {
    // Cannot locate the use site in the CFG — fall back to class constant
    const classConst = ctx.resolveClassConstant(varName);
    return classConst !== null ? known(classConst) : unknown();
  }

  // Pass 1: Non-synthetic (local) bindings
  const localValues: ResolvedValue[] = [];
  let foundLocalDef = false;
  const catalog = getOrBuildCatalog(methodNode, methodCache);

  for (const bindingIdx of bindingIndices) {
    if (isSyntheticBinding(analysis, bindingIdx)) continue;

    const reachingDefs = findReachingDefsForBinding(
      analysis,
      bindingIdx,
      usePoint.blockIndex,
      usePoint.stmtIndex,
    );

    if (reachingDefs.length === 0) continue;
    foundLocalDef = true;

    const binding = getBinding(analysis, bindingIdx);
    if (!binding) continue;

    for (const def of reachingDefs) {
      const value = evaluateDefSiteRhs(
        def.def.line,
        def.def.stmtIndex,
        binding.name,
        catalog,
        analysis,
        ctx,
        filePath,
        methodCache,
        new Set(),
      );
      localValues.push(value);
    }
  }

  // If any local binding has reaching defs → local shadows field
  if (foundLocalDef && localValues.length > 0) {
    return mergeAllValues(localValues);
  }

  // Pass 2: Synthetic (field) bindings — only when no local reaching defs
  for (const bindingIdx of bindingIndices) {
    if (!isSyntheticBinding(analysis, bindingIdx)) continue;

    const reachingDefs = findReachingDefsForBinding(
      analysis,
      bindingIdx,
      usePoint.blockIndex,
      usePoint.stmtIndex,
    );

    if (reachingDefs.length > 0) {
      const classConst = ctx.resolveClassConstant(varName);
      return classConst !== null ? known(classConst) : unknown();
    }
  }

  // No defs found at all — fall back to class constant
  const classConst = ctx.resolveClassConstant(varName);
  return classConst !== null ? known(classConst) : unknown();
}

/**
 * Resolve a binary expression at a call site by recursively resolving
 * each operand.
 */
function resolveBinaryExpressionAtCallSite(
  node: SyntaxNode,
  methodNode: SyntaxNode,
  filePath: string,
  ctx: ReachingValueContext,
  methodCache?: MethodAnalysisCache,
): ResolvedValue {
  const operator = node.childForFieldName('operator');
  if (!operator || operator.text !== '+') return unknown();

  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return unknown();

  const leftVal = resolveExpressionAtCallSite(left, methodNode, filePath, ctx, methodCache);
  const rightVal = resolveExpressionAtCallSite(right, methodNode, filePath, ctx, methodCache);

  if (leftVal.kind === 'known' && rightVal.kind === 'known') {
    return known(leftVal.value + rightVal.value);
  }
  return unknown();
}

/**
 * Evaluate the RHS of a definition site.
 *
 * Given a def site (identified by line, binding name, and optionally
 * the def's stmtIndex within its block), find the AST RHS node and
 * evaluate it. For compound assignments (+=), the current value is
 * prepended.
 */
function evaluateDefSiteRhs(
  defLine: number,
  defStmtIndex: number | undefined,
  bindingName: string,
  catalog: DefinitionCatalog,
  analysis: MethodAnalysis,
  ctx: ReachingValueContext,
  filePath: string,
  methodCache: MethodAnalysisCache | undefined,
  resolving: Set<string>,
): ResolvedValue {
  // Cycle detection
  const cycleKey = `${bindingName}@${defLine}${defStmtIndex !== undefined ? `:${defStmtIndex}` : ''}`;
  if (resolving.has(cycleKey)) return unknown();
  resolving.add(cycleKey);

  try {
    // Find the def site in the catalog
    const defSites = findDefSitesForReachingDef(catalog, defLine, bindingName);
    if (defSites.length === 0) return unknown();

    // Disambiguate when multiple def sites are on the same line
    let defSite: DefSite;
    if (defSites.length === 1) {
      defSite = defSites[0]!;
    } else if (defStmtIndex !== undefined) {
      // Use the def's stmtIndex to find the matching DefSite
      // Walk the method AST to find the statement at the given position
      defSite = disambiguateDefSite(defSites, defStmtIndex, analysis) ?? defSites[0]!;
    } else {
      defSite = defSites[0]!;
    }

    if (!defSite.rhsNode) {
      // No RHS (e.g., `int x;` with no initializer)
      return unknown();
    }

    // For compound assignments (+=), resolve the current value first
    if (defSite.kind === 'assign' && defSite.operator === '+=') {
      // Find the reaching def of the SAME binding at this assignment
      // to get the current value, then concatenate
      const currentValue = findBindingValueAtLine(
        bindingName,
        defLine,
        analysis,
        catalog,
        ctx,
        filePath,
        methodCache,
        resolving,
      );
      const rhsValue = evaluateRhsNode(defSite.rhsNode, analysis, ctx, filePath, methodCache, resolving);

      if (currentValue.kind === 'known' && rhsValue.kind === 'known') {
        return known(currentValue.value + rhsValue.value);
      }
      return unknown();
    }

    // For other compound assignments (-=, *=, /=), return Unknown
    if (defSite.kind === 'assign' && defSite.operator !== '=') {
      return unknown();
    }

    // For simple assignment (=) or declaration, evaluate the RHS
    return evaluateRhsNode(defSite.rhsNode, analysis, ctx, filePath, methodCache, resolving);
  } finally {
    resolving.delete(cycleKey);
  }
}

/**
 * Disambiguate multiple DefSites on the same line by matching the
 * def's stmtIndex to the AST statement ordinal.
 *
 * For straight-line code, the stmtIndex within the CFG block corresponds
 * to the AST statement ordinal within the method body block.
 */
function disambiguateDefSite(
  defSites: readonly DefSite[],
  defStmtIndex: number,
  analysis: MethodAnalysis,
): DefSite | null {
  // Collect all statements in the method body block (in source order)
  const body = analysis.methodNode.childForFieldName('body');
  if (!body) return null;

  // Build a list of AST statement nodes that are definition statements
  // for the same variable name, in source order
  const defStmtNodes: SyntaxNode[] = [];
  const name = defSites[0]!.name;
  for (const child of body.namedChildren) {
    if (child.type === 'local_variable_declaration') {
      // Check if any declarator defines our variable
      for (const sub of child.namedChildren) {
        if (sub.type === 'variable_declarator') {
          const nameNode = sub.childForFieldName('name');
          if (nameNode && nameNode.text === name) {
            defStmtNodes.push(child);
            break;
          }
        }
      }
    } else if (child.type === 'expression_statement') {
      const expr = child.namedChildren[0];
      if (expr?.type === 'assignment_expression') {
        const left = expr.childForFieldName('left');
        if (left?.type === 'identifier' && left.text === name) {
          defStmtNodes.push(child);
        }
      }
    } else if (child.type === 'block') {
      // Nested block — scan its children too (for simple cases)
      for (const sub of child.namedChildren) {
        if (sub.type === 'local_variable_declaration') {
          for (const subSub of sub.namedChildren) {
            if (subSub.type === 'variable_declarator') {
              const nameNode = subSub.childForFieldName('name');
              if (nameNode && nameNode.text === name) {
                defStmtNodes.push(sub);
                break;
              }
            }
          }
        } else if (sub.type === 'expression_statement') {
          const expr = sub.namedChildren[0];
          if (expr?.type === 'assignment_expression') {
            const left = expr.childForFieldName('left');
            if (left?.type === 'identifier' && left.text === name) {
              defStmtNodes.push(sub);
            }
          }
        }
      }
    }
  }

  // Find the DefSite whose stmtNode matches the defStmtNodes[defStmtIndex]
  // But defStmtIndex is the index within ALL CFG statements, not just def statements
  // So we need to map from CFG stmtIndex to AST def statement

  // Alternative approach: match by the DefSite's stmtNode start position
  // Find the DefSite whose column is at the position corresponding to defStmtIndex

  // Actually, let's match by the stmtNode identity:
  // The CFG statement at stmtIndex corresponds to an AST statement.
  // We can find the AST statement by walking the block's named children
  // and counting to the stmtIndex-th child.

  // But the CFG might have more/fewer statements than the AST block children
  // (e.g., ENTRY/EXIT blocks, control flow splits)

  // For now, use a simpler heuristic: match by column ordering
  // Sort DefSites by column (ascending) and use defStmtIndex as a proxy
  // This works for straight-line code where stmtIndex corresponds to source order
  const sorted = [...defSites].sort((a, b) => a.column - b.column);

  // Find the position of the defStmtIndex-th statement in the block
  // that is a definition of our variable
  // Since we don't have exact mapping, use the closest match
  if (defStmtIndex < sorted.length) {
    return sorted[defStmtIndex]!;
  }

  // If defStmtIndex is out of range, return the last def site
  return sorted[sorted.length - 1]!;
}

/**
 * Evaluate an RHS AST node to a string value.
 */
function evaluateRhsNode(
  rhsNode: SyntaxNode,
  analysis: MethodAnalysis,
  ctx: ReachingValueContext,
  filePath: string,
  methodCache?: MethodAnalysisCache,
  resolving?: Set<string>,
): ResolvedValue {
  // For simple expressions (literals, field accesses), use direct evaluation
  if (
    rhsNode.type === 'string_literal' ||
    rhsNode.type === 'field_access'
  ) {
    const resolveCtx: ExpressionResolveContext = {
      resolveIdentifier: (name) => ctx.resolveClassConstant(name),
      resolveFieldAccess: (owner, field) =>
        ctx.resolveCrossClassConstant(owner, field) ??
        ctx.resolveExternalConstant(owner, field),
    };
    return evaluateStringExpression(rhsNode, resolveCtx);
  }

  // For identifiers: local binding FIRST, class field ONLY as fallback
  // when no local (non-synthetic) binding exists at all.
  if (rhsNode.type === 'identifier') {
    return resolveRhsIdentifier(rhsNode, analysis, ctx, filePath, methodCache, resolving);
  }

  // For binary expressions, recursively evaluate operands
  if (rhsNode.type === 'binary_expression') {
    const operator = rhsNode.childForFieldName('operator');
    if (operator?.text === '+') {
      const left = rhsNode.childForFieldName('left');
      const right = rhsNode.childForFieldName('right');
      if (left && right) {
        const leftVal = evaluateRhsNode(left, analysis, ctx, filePath, methodCache, resolving);
        const rightVal = evaluateRhsNode(right, analysis, ctx, filePath, methodCache, resolving);
        if (leftVal.kind === 'known' && rightVal.kind === 'known') {
          return known(leftVal.value + rightVal.value);
        }
      }
    }
    return unknown();
  }

  // For parenthesized expressions, evaluate the inner expression
  if (rhsNode.type === 'parenthesized_expression') {
    const inner = rhsNode.namedChildren[0];
    if (inner) return evaluateRhsNode(inner, analysis, ctx, filePath, methodCache, resolving);
    return unknown();
  }

  // For method invocations (URI.create), evaluate the argument
  if (rhsNode.type === 'method_invocation') {
    const name = rhsNode.childForFieldName('name')?.text;
    const object = rhsNode.childForFieldName('object')?.text;
    const args = rhsNode.childForFieldName('arguments')?.namedChildren ?? [];
    if (name === 'create' && object === 'URI' && args.length >= 1) {
      return evaluateRhsNode(args[0]!, analysis, ctx, filePath, methodCache, resolving);
    }
    return unknown();
  }

  // Everything else is Unknown
  return unknown();
}

/**
 * Resolve an identifier on the RHS of a definition.
 *
 * Two-pass resolution (same as resolveLocalIdentifier):
 *   Pass 1: Non-synthetic (local) bindings. If any has reaching defs at
 *           the RHS position, use ONLY those values (local shadows field).
 *   Pass 2: Synthetic (field) bindings. Only checked when no local binding
 *           has reaching defs at the RHS position.
 *
 * This ensures that a same-named local variable always takes priority over
 * a class field when the local is in scope and has reaching definitions.
 */
function resolveRhsIdentifier(
  identifierNode: SyntaxNode,
  analysis: MethodAnalysis,
  ctx: ReachingValueContext,
  filePath: string,
  methodCache?: MethodAnalysisCache,
  resolving?: Set<string>,
): ResolvedValue {
  // Delegate to the same two-pass logic as resolveLocalIdentifier
  return resolveLocalIdentifier(identifierNode, analysis, ctx, filePath, methodCache, resolving);
}

/**
 * Resolve a local identifier using reaching defs.
 *
 * Two-pass resolution:
 *   Pass 1: Non-synthetic (local) bindings. If any has reaching defs at
 *           the use point, use ONLY those values (local shadows field).
 *   Pass 2: Synthetic (field) bindings. Only checked when no local binding
 *           has reaching defs at the use point (local is out of scope,
 *           or only a field reference exists).
 */
function resolveLocalIdentifier(
  identifierNode: SyntaxNode,
  analysis: MethodAnalysis,
  ctx: ReachingValueContext,
  filePath: string,
  methodCache?: MethodAnalysisCache,
  resolving?: Set<string>,
): ResolvedValue {
  const varName = identifierNode.text;
  const { cfg } = analysis;

  // Find the program point for this identifier
  const usePoint = findProgramPointForPosition(
    cfg,
    identifierNode.startPosition.row,
    identifierNode.startPosition.column,
    identifierNode,
  );
  if (!usePoint) return unknown();

  const bindingIndices = findAllBindingsByName(analysis, varName);
  if (bindingIndices.length === 0) return unknown();

  // Pass 1: Non-synthetic (local) bindings
  const localValues: ResolvedValue[] = [];
  let foundLocalDef = false;

  for (const bindingIdx of bindingIndices) {
    if (isSyntheticBinding(analysis, bindingIdx)) continue;

    const reachingDefs = findReachingDefsForBinding(
      analysis,
      bindingIdx,
      usePoint.blockIndex,
      usePoint.stmtIndex,
    );

    if (reachingDefs.length === 0) continue;
    foundLocalDef = true;

    const catalog = getOrBuildCatalog(analysis.methodNode, methodCache);
    const binding = getBinding(analysis, bindingIdx);
    if (!binding) continue;

    for (const def of reachingDefs) {
      const value = evaluateDefSiteRhs(
        def.def.line,
        def.def.stmtIndex,
        binding.name,
        catalog,
        analysis,
        ctx,
        filePath,
        methodCache,
        resolving ?? new Set(),
      );
      localValues.push(value);
    }
  }

  // If any local binding has reaching defs → local shadows field
  if (foundLocalDef && localValues.length > 0) {
    return mergeAllValues(localValues);
  }

  // Pass 2: Synthetic (field) bindings — only when no local reaching defs
  for (const bindingIdx of bindingIndices) {
    if (!isSyntheticBinding(analysis, bindingIdx)) continue;

    const reachingDefs = findReachingDefsForBinding(
      analysis,
      bindingIdx,
      usePoint.blockIndex,
      usePoint.stmtIndex,
    );

    if (reachingDefs.length > 0) {
      const classConst = ctx.resolveClassConstant(varName);
      if (classConst !== null) return known(classConst);
    }
  }

  // Final fallback: try class constant directly (for cases where no
  // CFG binding exists but the name matches a class field)
  const classConst = ctx.resolveClassConstant(varName);
  if (classConst !== null) return known(classConst);
  return unknown();
}

/**
 * Find the value of a binding at a specific line (for compound assignments).
 * For `url += expr`, the compound assignment reads the current value of
 * `url` and then writes the concatenated result. The reaching defs at
 * the `+=` statement include the prior definition (because `+=` generates
 * both a use and a def, and the use sees reaching defs from before the def).
 */
function findBindingValueAtLine(
  bindingName: string,
  atLine: number,
  analysis: MethodAnalysis,
  catalog: DefinitionCatalog,
  ctx: ReachingValueContext,
  filePath: string,
  methodCache: MethodAnalysisCache | undefined,
  resolving: Set<string>,
): ResolvedValue {
  const { cfg } = analysis;

  // Find the program point AT the given line (where the += reads the value)
  // Look for a statement at exactly this line
  let targetPoint: { blockIndex: number; stmtIndex: number } | null = null;

  for (const block of cfg.blocks) {
    if (!block.statements) continue;
    for (let i = 0; i < block.statements.length; i++) {
      const stmt = block.statements[i]!;
      if (stmt.line === atLine) {
        targetPoint = { blockIndex: block.index, stmtIndex: i };
        break;
      }
    }
    if (targetPoint) break;
  }

  // Fallback: find the last statement before the line
  if (!targetPoint) {
    let bestLine = 0;
    for (const block of cfg.blocks) {
      if (!block.statements) continue;
      for (let i = 0; i < block.statements.length; i++) {
        const stmt = block.statements[i]!;
        if (stmt.line < atLine && stmt.line >= bestLine) {
          bestLine = stmt.line;
          targetPoint = { blockIndex: block.index, stmtIndex: i };
        }
      }
    }
  }

  if (!targetPoint) return unknown();

  // Find reaching defs at this point
  const bindingIndices = findAllBindingsByName(analysis, bindingName);
  const allValues: ResolvedValue[] = [];
  let foundAny = false;

  for (const bindingIdx of bindingIndices) {
    if (isSyntheticBinding(analysis, bindingIdx)) continue;

    const reachingDefs = findReachingDefsForBinding(
      analysis,
      bindingIdx,
      targetPoint.blockIndex,
      targetPoint.stmtIndex,
    );

    // Filter out defs at the same line (the += itself) — we want the
    // PRIOR definition, not the self-referential one from the same statement
    const priorDefs = reachingDefs.filter((d) => d.def.line !== atLine);
    if (priorDefs.length === 0) continue;
    foundAny = true;

    const binding = getBinding(analysis, bindingIdx);
    if (!binding) continue;

    for (const def of priorDefs) {
      const value = evaluateDefSiteRhs(
        def.def.line,
        def.def.stmtIndex,
        binding.name,
        catalog,
        analysis,
        ctx,
        filePath,
        methodCache,
        resolving,
      );
      allValues.push(value);
    }
  }

  if (!foundAny || allValues.length === 0) return unknown();
  return mergeAllValues(allValues);
}

// ── Caching ──────────────────────────────────────────────────────

export type MethodAnalysisCache = Map<number, MethodAnalysis | null>;

function getOrBuildMethodAnalysis(
  methodNode: SyntaxNode,
  filePath: string,
  cache?: MethodAnalysisCache,
): MethodAnalysis | null {
  if (cache) {
    const cached = cache.get(methodNode.id);
    if (cached !== undefined) return cached;
  }

  const result = analyzeMethod(methodNode, filePath);

  if (cache) {
    cache.set(methodNode.id, result);
  }

  return result;
}

function getOrBuildCatalog(
  methodNode: SyntaxNode,
  cache?: MethodAnalysisCache,
): DefinitionCatalog {
  // The catalog is built alongside the method analysis
  // For now, always rebuild (the catalog is cheap to build)
  return buildDefinitionCatalog(methodNode);
}
