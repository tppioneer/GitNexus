/**
 * Definition catalog for the CSE-link plugin.
 *
 * Maps CFG definition sites (blockIndex, stmtIndex) to the AST nodes
 * that perform the definition (declaration RHS or assignment RHS).
 * This is the bridge between the reaching-definitions solver (which
 * works in CFG space) and the AST-based expression evaluator.
 *
 * The catalog is built by walking the method AST once and recording
 * every definition site with its position, binding name, and RHS node.
 * At query time, the reaching-value resolver looks up the catalog by
 * line number and binding name to find the RHS for a given def site.
 */

import type Parser from 'tree-sitter';
import type { FunctionCfg, StatementFacts } from '../../../../core/ingestion/cfg/types.js';

type SyntaxNode = Parser.SyntaxNode;

/**
 * A recorded definition site in the method AST.
 */
export interface DefSite {
  /** 1-based line number (matching StatementFacts.line). */
  readonly line: number;
  /** 0-based column of the name/operator node. */
  readonly column: number;
  /** The variable name being defined. */
  readonly name: string;
  /** The RHS expression node (initializer or assignment RHS). */
  readonly rhsNode: SyntaxNode | null;
  /** Kind of definition. */
  readonly kind: 'decl' | 'assign';
  /** Assignment operator text ('=', '+=', '-=', etc.). Only for 'assign'. */
  readonly operator?: string;
  /** The full AST statement node containing this definition. */
  readonly stmtNode: SyntaxNode;
}

/**
 * Catalog of all definition sites in a method, indexed for fast lookup.
 */
export interface DefinitionCatalog {
  /** All def sites, in source order. */
  readonly sites: readonly DefSite[];
  /** Lookup: line → def sites at that line. */
  readonly byLine: ReadonlyMap<number, readonly DefSite[]>;
  /** Lookup: name → def sites for that variable name. */
  readonly byName: ReadonlyMap<string, readonly DefSite[]>;
  /**
   * Lookup: (line, column) → DefSite.
   * Used for precise same-line disambiguation when multiple defs
   * of the same variable are on the same line.
   */
  readonly byLineAndColumn: ReadonlyMap<string, DefSite>;
}

/**
 * Build a definition catalog by walking a method's AST.
 *
 * Records:
 *   - local_variable_declaration: each variable_declarator with an initializer
 *   - expression_statement containing assignment_expression: the assignment
 *   - assignment_expression in other positions (e.g., for-init)
 */
export function buildDefinitionCatalog(
  methodNode: SyntaxNode,
): DefinitionCatalog {
  const sites: DefSite[] = [];

  const body = methodNode.childForFieldName('body');
  if (!body) return { sites, byLine: new Map(), byName: new Map(), byLineAndColumn: new Map() };

  walkForDefs(body, sites);

  // Build indexes
  const byLine = new Map<number, DefSite[]>();
  const byName = new Map<string, DefSite[]>();
  const byLineAndColumn = new Map<string, DefSite>();

  for (const site of sites) {
    let lineSites = byLine.get(site.line);
    if (!lineSites) {
      lineSites = [];
      byLine.set(site.line, lineSites);
    }
    lineSites.push(site);

    let nameSites = byName.get(site.name);
    if (!nameSites) {
      nameSites = [];
      byName.set(site.name, nameSites);
    }
    nameSites.push(site);

    // Key by line:column for precise lookup
    byLineAndColumn.set(`${site.line}:${site.column}`, site);
  }

  return { sites, byLine, byName, byLineAndColumn };
}

/**
 * Recursively walk an AST subtree, recording definition sites.
 * Does NOT descend into nested methods, constructors, or lambdas
 * (they have their own CFG scope).
 */
function walkForDefs(node: SyntaxNode, sites: DefSite[]): void {
  const type = node.type;

  // Don't descend into nested functions
  if (
    type === 'method_declaration' ||
    type === 'constructor_declaration' ||
    type === 'compact_constructor_declaration' ||
    type === 'lambda_expression'
  ) {
    return;
  }

  if (type === 'local_variable_declaration') {
    recordLocalVarDecl(node, sites);
    // Don't recurse — declarators are handled by recordLocalVarDecl
    return;
  } else if (type === 'expression_statement') {
    const expr = node.namedChildren[0];
    if (expr && expr.type === 'assignment_expression') {
      recordAssignment(expr, node, sites);
    }
    // Don't recurse into the expression — we've already handled the assignment
    return;
  } else if (type === 'assignment_expression') {
    // Standalone assignment (e.g., in for-init)
    recordAssignment(node, node, sites);
  } else if (type === 'for_statement') {
    // for-init can contain local_variable_declaration or assignment
    const init = node.childForFieldName('init');
    if (init) {
      if (init.type === 'local_variable_declaration') {
        recordLocalVarDecl(init, sites);
      } else if (init.type === 'assignment_expression') {
        recordAssignment(init, init, sites);
      }
    }
    // Also walk the body (which may contain more defs)
    const bodyNode = node.childForFieldName('body');
    if (bodyNode) walkForDefs(bodyNode, sites);
    const condition = node.childForFieldName('condition');
    if (condition) walkForDefs(condition, sites);
    const update = node.childForFieldName('update');
    if (update) walkForDefs(update, sites);
    return; // don't double-walk children
  } else if (type === 'enhanced_for_statement') {
    // The loop variable is a def, but it's not a string constant source
    // (it comes from iteration, not a string expression)
    const bodyNode = node.childForFieldName('body');
    if (bodyNode) walkForDefs(bodyNode, sites);
    const valueNode = node.childForFieldName('value');
    if (valueNode) walkForDefs(valueNode, sites);
    return;
  }

  // Recurse into children for other statement types
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkForDefs(child, sites);
  }
}

function recordLocalVarDecl(
  declNode: SyntaxNode,
  sites: DefSite[],
): void {
  for (const child of declNode.namedChildren) {
    if (child.type !== 'variable_declarator') continue;
    const nameNode = child.childForFieldName('name');
    const valueNode = child.childForFieldName('value');
    if (!nameNode) continue;

    sites.push({
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column,
      name: nameNode.text,
      rhsNode: valueNode ?? null,
      kind: 'decl',
      stmtNode: declNode,
    });
  }
}

function recordAssignment(
  assignNode: SyntaxNode,
  stmtNode: SyntaxNode,
  sites: DefSite[],
): void {
  const left = assignNode.childForFieldName('left');
  const right = assignNode.childForFieldName('right');
  const opNode = assignNode.childForFieldName('operator');
  if (!left || !opNode) return;

  // Only record simple identifier assignments (not field writes like obj.field = ...)
  if (left.type !== 'identifier') return;

  sites.push({
    line: left.startPosition.row + 1,
    column: left.startPosition.column,
    name: left.text,
    rhsNode: right ?? null,
    kind: 'assign',
    operator: opNode.text,
    stmtNode: stmtNode,
  });
}

/**
 * Find the definition site(s) that match a CFG reaching def.
 *
 * Given a def site from the reaching-definitions solver (block, stmt, line)
 * and a binding name, find the matching AST def site.
 *
 * Matching criteria:
 *   1. Same line number
 *   2. Same variable name
 *
 * If multiple def sites match (e.g., multi-declarator statement), returns
 * all of them. The caller should evaluate each and merge.
 */
export function findDefSitesForReachingDef(
  catalog: DefinitionCatalog,
  line: number,
  bindingName: string,
): readonly DefSite[] {
  const lineSites = catalog.byLine.get(line);
  if (!lineSites) return [];

  // Filter by name
  return lineSites.filter((s) => s.name === bindingName);
}
