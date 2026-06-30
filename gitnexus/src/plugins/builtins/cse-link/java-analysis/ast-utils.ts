/**
 * Java AST traversal utilities for the CSE-link plugin.
 *
 * Pure helpers that operate on tree-sitter SyntaxNode trees. No CFG or
 * data-flow logic — just structural AST queries used by the resolver
 * modules (class-constant-index, definition-catalog, string-expression-
 * evaluator).
 */

import type Parser from 'tree-sitter';

type SyntaxNode = Parser.SyntaxNode;

/** Walk every named descendant of `root` (including root itself). */
export function visitAst(
  root: SyntaxNode,
  fn: (node: SyntaxNode) => void,
): void {
  fn(root);
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child) visitAst(child, fn);
  }
}

/**
 * Strip Java line and block comments from source text. String and
 * character literals are preserved so that comment-like content inside
 * strings is not mistakenly stripped.
 */
export function stripJavaComments(source: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  let blockComment = false;
  let lineComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (lineComment) {
      if (ch === '\r' || ch === '\n') {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === quote && source[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Regex for Java import statements (captures the FQCN). */
const IMPORT_RE = /\bimport\s+(?:static\s+)?([A-Za-z_][\w.]*\.[A-Za-z_]\w*)\s*;/g;

/**
 * Extract import mappings from Java source: simple name → FQCN.
 * Only the last segment of the FQCN is used as the key (e.g.,
 * `import com.acme.Routes` → `Routes → com.acme.Routes`).
 */
export function extractImports(source: string): Map<string, string> {
  const clean = stripJavaComments(source);
  const imports = new Map<string, string>();
  for (const match of clean.matchAll(IMPORT_RE)) {
    const fqcn = match[1];
    if (!fqcn) continue;
    const simpleName = fqcn.split('.').pop() ?? fqcn;
    imports.set(simpleName, fqcn);
  }
  return imports;
}

/**
 * Extract the package name from a Java source file's `package` declaration.
 * Returns empty string if no package declaration found.
 */
export function extractPackageName(source: string): string {
  const clean = stripJavaComments(source);
  const match = /\bpackage\s+([\w.]+)\s*;/.exec(clean);
  return match?.[1] ?? '';
}

/**
 * Unquote a Java string literal. Handles standard Java escape sequences:
 * \\, \", \', \n, \r, \t, \b, \f, \0, unicode escapes (\uXXXX).
 */
export function unquoteJavaString(text: string): string | null {
  if (text.length < 2) return null;
  if (!(text.startsWith('"') && text.endsWith('"'))) return null;
  const inner = text.slice(1, -1);
  let result = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1]!;
      switch (next) {
        case '\\': result += '\\'; i++; break;
        case '"': result += '"'; i++; break;
        case "'": result += "'"; i++; break;
        case 'n': result += '\n'; i++; break;
        case 'r': result += '\r'; i++; break;
        case 't': result += '\t'; i++; break;
        case 'b': result += '\b'; i++; break;
        case 'f': result += '\f'; i++; break;
        case '0': result += '\0'; i++; break;
        case 'u': {
          if (i + 5 < inner.length) {
            const hex = inner.slice(i + 2, i + 6);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              result += String.fromCharCode(parseInt(hex, 16));
              i += 5;
              break;
            }
          }
          result += ch;
          break;
        }
        default:
          // Unknown escape — keep as-is (conservative)
          result += ch;
          break;
      }
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Compare two tree-sitter positions. Returns negative if a < b,
 * positive if a > b, zero if equal.
 */
export function comparePoints(
  a: Parser.Point,
  b: Parser.Point,
): number {
  return a.row !== b.row ? a.row - b.row : a.column - b.column;
}

/**
 * Check if a position is inside a node's range (inclusive start,
 * exclusive end).
 */
export function isInsideNode(
  pos: Parser.Point,
  node: SyntaxNode,
): boolean {
  return (
    comparePoints(pos, node.startPosition) >= 0 &&
    comparePoints(pos, node.endPosition) < 0
  );
}

/**
 * Find the nearest enclosing statement node for a given position.
 * Walks up from the node at that position to find a statement-level
 * parent (or returns the node itself if it's a statement).
 */
export function findEnclosingStatement(
  root: SyntaxNode,
  pos: Parser.Point,
): SyntaxNode | null {
  // Find the deepest node at this position
  let node = findDeepestNodeAt(root, pos);
  if (!node) return null;

  // Walk up until we find a statement-level node
  const statementTypes = new Set([
    'local_variable_declaration',
    'expression_statement',
    'return_statement',
    'throw_statement',
    'if_statement',
    'while_statement',
    'for_statement',
    'enhanced_for_statement',
    'do_statement',
    'try_statement',
    'switch_expression',
    'block',
  ]);

  while (node) {
    if (statementTypes.has(node.type)) return node;
    if (!node.parent) break;
    node = node.parent;
  }
  return null;
}

/**
 * Find the deepest AST node that contains the given position.
 */
function findDeepestNodeAt(
  root: SyntaxNode,
  pos: Parser.Point,
): SyntaxNode | null {
  let node: SyntaxNode = root;
  outer: while (true) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && isInsideNode(pos, child)) {
        node = child;
        continue outer;
      }
    }
    return node;
  }
}

/**
 * Collect all class_declaration nodes directly in a compilation unit,
 * including nested classes. Each entry includes the class name and the
 * node for further inspection.
 */
export function collectClassDeclarations(
  root: SyntaxNode,
): Array<{ name: string; node: SyntaxNode }> {
  const classes: Array<{ name: string; node: SyntaxNode }> = [];
  visitAst(root, (node) => {
    if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) classes.push({ name, node });
    }
  });
  return classes;
}

/**
 * Get the modifiers text of a declaration node. Returns empty string
 * if no modifiers present.
 */
export function getModifiersText(node: SyntaxNode): string {
  const modifiers = node.namedChildren.find((c) => c.type === 'modifiers');
  return modifiers?.text ?? '';
}

/**
 * Check if a field_declaration has the `final` modifier.
 */
export function isFinalField(fieldDecl: SyntaxNode): boolean {
  const modText = getModifiersText(fieldDecl);
  return /\bfinal\b/.test(modText);
}

/**
 * Check if a field_declaration has the `static` modifier.
 */
export function isStaticField(fieldDecl: SyntaxNode): boolean {
  const modText = getModifiersText(fieldDecl);
  return /\bstatic\b/.test(modText);
}
