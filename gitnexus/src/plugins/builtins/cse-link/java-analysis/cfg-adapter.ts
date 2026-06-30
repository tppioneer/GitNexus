/**
 * CFG adapter for the CSE-link plugin.
 *
 * Wraps the GitNexus CFG infrastructure (createJavaCfgVisitor and
 * computeReachingDefs) to provide method-level analysis results
 * needed by the reaching-value resolver.
 *
 * This module is the ONLY cse-link module that imports from the core
 * CFG infrastructure. It translates between the CFG's internal
 * representation (FunctionCfg, DefUseFact) and the plugin's needs
 * (which bindings reach which call sites).
 */

import type Parser from 'tree-sitter';
import type {
  FunctionCfg,
  BindingEntry,
} from '../../../../core/ingestion/cfg/types.js';
import type {
  FunctionDefUse,
  DefUseFact,
} from '../../../../core/ingestion/cfg/reaching-defs.js';
import { createJavaCfgVisitor } from '../../../../core/ingestion/cfg/visitors/java.js';
import { computeReachingDefs } from '../../../../core/ingestion/cfg/reaching-defs.js';

type SyntaxNode = Parser.SyntaxNode;

/**
 * Analysis result for a single method.
 */
export interface MethodAnalysis {
  /** The CFG for the method. */
  readonly cfg: FunctionCfg;
  /** Reaching definitions result. */
  readonly reachingDefs: FunctionDefUse;
  /** The method AST node. */
  readonly methodNode: SyntaxNode;
}

/**
 * Build a CFG and compute reaching definitions for a Java method.
 *
 * Returns null if the method cannot be analyzed (abstract, no body,
 * CFG build failure, etc.).
 *
 * @param methodNode - The method_declaration AST node.
 * @param filePath - Repo-relative file path (used by the CFG builder).
 */
export function analyzeMethod(
  methodNode: SyntaxNode,
  filePath: string,
): MethodAnalysis | null {
  try {
    const visitor = createJavaCfgVisitor();
    if (!visitor.isFunction(methodNode)) return null;

    const cfg = visitor.buildFunctionCfg(methodNode, filePath);
    if (!cfg) return null;

    // Compute reaching defs with a reasonable fact limit
    const reachingDefs = computeReachingDefs(cfg, { maxFacts: 10_000 });

    return { cfg, reachingDefs, methodNode };
  } catch {
    // Never throw — a malformed method should not crash the plugin
    return null;
  }
}

/**
 * Find all def→use facts for a specific binding at a specific use site.
 *
 * The use site is identified by (blockIndex, stmtIndex) in the CFG.
 * Returns all facts where the use matches and the binding matches.
 */
export function findReachingDefsForBinding(
  analysis: MethodAnalysis,
  bindingIdx: number,
  useBlockIndex: number,
  useStmtIndex: number,
): readonly DefUseFact[] {
  return analysis.reachingDefs.facts.filter(
    (f) =>
      f.bindingIdx === bindingIdx &&
      f.use.blockIndex === useBlockIndex &&
      f.use.stmtIndex === useStmtIndex,
  );
}

/**
 * Find the binding index for a variable name. Returns -1 if not found.
 *
 * If there are multiple bindings with the same name (shadowing),
 * returns the FIRST one. The caller should handle shadowing by
 * checking reaching defs at the relevant use site.
 */
export function findBindingByName(
  analysis: MethodAnalysis,
  name: string,
): number {
  const bindings = analysis.reachingDefs.bindings;
  for (let i = 0; i < bindings.length; i++) {
    if (bindings[i]?.name === name) return i;
  }
  return -1;
}

/**
 * Find ALL binding indices for a variable name (handles shadowing).
 */
export function findAllBindingsByName(
  analysis: MethodAnalysis,
  name: string,
): number[] {
  const result: number[] = [];
  const bindings = analysis.reachingDefs.bindings;
  for (let i = 0; i < bindings.length; i++) {
    if (bindings[i]?.name === name) result.push(i);
  }
  return result;
}

/**
 * Check if a binding is synthetic (no in-function declaration site).
 * Synthetic bindings represent fields, globals, or imported names.
 */
export function isSyntheticBinding(
  analysis: MethodAnalysis,
  bindingIdx: number,
): boolean {
  const binding = analysis.reachingDefs.bindings[bindingIdx];
  return binding?.synthetic === true;
}

/**
 * Get the binding entry for a given index.
 */
export function getBinding(
  analysis: MethodAnalysis,
  bindingIdx: number,
): BindingEntry | undefined {
  return analysis.reachingDefs.bindings[bindingIdx];
}

/**
 * Find which (blockIndex, stmtIndex) contains a given AST position.
 *
 * When `astNode` is provided, uses the AST structure to disambiguate
 * multiple statements on the same line: finds the enclosing block
 * statement of the AST node and maps it to the CFG statement by
 * ordinal position within the block.
 *
 * When `astNode` is not provided, falls back to line-based matching
 * (returns the first statement on the matching line).
 *
 * Returns null if no matching statement is found.
 */
export function findProgramPointForPosition(
  cfg: FunctionCfg,
  row: number,
  col: number,
  astNode?: SyntaxNode,
): { blockIndex: number; stmtIndex: number } | null {
  const targetLine = row + 1; // Convert 0-based row to 1-based line

  // If we have an AST node, use AST-based disambiguation for same-line cases
  if (astNode) {
    const astResult = findProgramPointByAst(cfg, astNode, targetLine);
    if (astResult) return astResult;
    // Fall through to line-based matching if AST-based fails
  }

  // First, try exact line match
  const lineMatches: Array<{ blockIndex: number; stmtIndex: number; stmt: typeof cfg.blocks[0]['statements'] extends readonly (infer T)[] | undefined ? T : never }> = [];
  for (const block of cfg.blocks) {
    if (!block.statements) continue;
    for (let i = 0; i < block.statements.length; i++) {
      const stmt = block.statements[i]!;
      if (stmt.line === targetLine) {
        lineMatches.push({ blockIndex: block.index, stmtIndex: i, stmt });
      }
    }
  }

  if (lineMatches.length === 0) {
    // Fallback: find the statement whose block range contains the position
    for (const block of cfg.blocks) {
      if (block.startLine <= targetLine && targetLine <= block.endLine) {
        if (block.statements && block.statements.length > 0) {
          for (let i = block.statements.length - 1; i >= 0; i--) {
            const stmt = block.statements[i]!;
            if (stmt.line <= targetLine) {
              return { blockIndex: block.index, stmtIndex: i };
            }
          }
          return { blockIndex: block.index, stmtIndex: 0 };
        }
      }
    }
    return null;
  }

  if (lineMatches.length === 1) {
    return { blockIndex: lineMatches[0]!.blockIndex, stmtIndex: lineMatches[0]!.stmtIndex };
  }

  // Multiple statements on the same line — try column-based disambiguation
  // using sites[].at (call-site positions)
  if (astNode) {
    const astCol = astNode.startPosition.column;
    // Find the statement whose site is closest to (but not after) the target column
    let bestMatch: typeof lineMatches[0] | null = null;
    let bestSiteCol = -1;
    for (const m of lineMatches) {
      const sites = m.stmt?.sites;
      if (!sites) continue;
      for (const site of sites) {
        if (site.at && site.at[0] === targetLine && site.at[1] <= astCol && site.at[1] > bestSiteCol) {
          bestSiteCol = site.at[1];
          bestMatch = m;
        }
      }
    }
    if (bestMatch) {
      return { blockIndex: bestMatch.blockIndex, stmtIndex: bestMatch.stmtIndex };
    }
  }

  // Last resort: return the last statement on the line
  // (heuristic: the identifier is typically in the last statement — e.g., a call)
  const last = lineMatches[lineMatches.length - 1]!;
  return { blockIndex: last.blockIndex, stmtIndex: last.stmtIndex };
}

/**
 * Use the AST structure to find the CFG statement that corresponds to
 * the enclosing block statement of the given AST node.
 *
 * Walks up from the AST node to find the direct child of the nearest
 * block, then maps it to the CFG statement by ordinal position.
 */
function findProgramPointByAst(
  cfg: FunctionCfg,
  astNode: SyntaxNode,
  targetLine: number,
): { blockIndex: number; stmtIndex: number } | null {
  // Walk up to find the enclosing block statement (direct child of a block)
  let enclosingStmt: SyntaxNode | null = null;
  let enclosingBlock: SyntaxNode | null = null;
  let current: SyntaxNode | null = astNode;
  while (current) {
    if (current.type === 'block' || current.type === 'class_body') {
      // The parent of the block is the enclosing context
      // The enclosing statement is the last node we visited that was a child of this block
      break;
    }
    const parent = current.parent;
    if (parent && (parent.type === 'block' || parent.type === 'class_body')) {
      enclosingStmt = current;
      enclosingBlock = parent;
      break;
    }
    current = current.parent;
  }

  if (!enclosingStmt || !enclosingBlock) return null;

  // Find the ordinal of the enclosing statement within the block's named children
  let stmtOrdinal = -1;
  let childIdx = 0;
  for (const child of enclosingBlock.namedChildren) {
    if (child.id === enclosingStmt.id) {
      stmtOrdinal = childIdx;
      break;
    }
    childIdx++;
  }
  if (stmtOrdinal < 0) return null;

  // Find the CFG block that corresponds to this AST block
  // and the statement at the matching ordinal
  // Strategy: find CFG blocks whose statements are on the target line,
  // then match by ordinal within the block
  for (const block of cfg.blocks) {
    if (!block.statements) continue;
    // Check if this CFG block could correspond to our AST block
    // Heuristic: the CFG block contains statements near the target line
    const hasLineMatch = block.statements.some((s) => s.line === targetLine);
    if (!hasLineMatch) continue;

    // Find the statement on the target line
    for (let i = 0; i < block.statements.length; i++) {
      const stmt = block.statements[i]!;
      if (stmt.line === targetLine) {
        // If the ordinal matches, this is our statement
        // For straight-line code, the ordinal within the CFG block
        // corresponds to the ordinal within the AST block
        if (i === stmtOrdinal) {
          return { blockIndex: block.index, stmtIndex: i };
        }
      }
    }
  }

  // If ordinal matching failed, try a simpler approach:
  // Count how many statements precede the enclosing statement in the AST block,
  // and skip that many statements in the CFG block
  // This is a heuristic that works for straight-line code
  return null;
}

/**
 * Find all use sites for a binding in the reaching defs facts.
 */
export function findAllUseSites(
  analysis: MethodAnalysis,
  bindingIdx: number,
): Array<{ blockIndex: number; stmtIndex: number; line: number }> {
  const seen = new Set<string>();
  const result: Array<{ blockIndex: number; stmtIndex: number; line: number }> = [];

  for (const fact of analysis.reachingDefs.facts) {
    if (fact.bindingIdx !== bindingIdx) continue;
    const key = `${fact.use.blockIndex}:${fact.use.stmtIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      blockIndex: fact.use.blockIndex,
      stmtIndex: fact.use.stmtIndex,
      line: fact.use.line,
    });
  }

  return result;
}
