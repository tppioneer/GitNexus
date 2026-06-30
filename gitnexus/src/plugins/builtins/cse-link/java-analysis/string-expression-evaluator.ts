/**
 * AST-based string expression evaluator for the CSE-link plugin.
 *
 * Evaluates Java string expressions by walking the tree-sitter AST,
 * NOT by splitting raw text. This avoids false positives from string
 * content that looks like operators (e.g., `"/x+=y"`).
 *
 * Supported expression forms:
 *   - string_literal: "hello" → "hello" (with escape processing)
 *   - identifier: URL → looked up via the constant resolver callback
 *   - field_access: com.acme.Routes.PREFIX → cross-class constant
 *   - binary_expression with '+': string concatenation
 *   - parenthesized_expression: (expr) → evaluate inner
 *   - method_invocation: URI.create("...") → evaluate argument
 *
 * Unsupported forms return Unknown.
 */

import type Parser from 'tree-sitter';
import type { ResolvedValue } from './model.js';
import { known, unknown, mergeValues } from './model.js';
import { unquoteJavaString } from './ast-utils.js';

type SyntaxNode = Parser.SyntaxNode;

/**
 * Context for resolving identifiers and field references during
 * expression evaluation.
 */
export interface ExpressionResolveContext {
  /**
   * Resolve a bare identifier to a string value.
   * Called for identifiers that are not string literals.
   * Returns null if the identifier cannot be resolved.
   */
  resolveIdentifier(name: string): string | null;

  /**
   * Resolve a field access (owner.field) to a string value.
   * Returns null if the field cannot be resolved.
   */
  resolveFieldAccess(owner: string, field: string): string | null;
}

/**
 * Evaluate a string expression AST node.
 *
 * @param node - The expression node to evaluate.
 * @param ctx - Resolution context for identifiers and field accesses.
 * @returns The resolved string value, or Unknown.
 */
export function evaluateStringExpression(
  node: SyntaxNode | null | undefined,
  ctx: ExpressionResolveContext,
): ResolvedValue {
  if (!node) return unknown();

  switch (node.type) {
    case 'string_literal':
      return evaluateStringLiteral(node);

    case 'identifier':
      return evaluateIdentifier(node, ctx);

    case 'field_access':
      return evaluateFieldAccess(node, ctx);

    case 'binary_expression':
      return evaluateBinaryExpression(node, ctx);

    case 'parenthesized_expression':
      return evaluateParenthesized(node, ctx);

    case 'method_invocation':
      return evaluateMethodInvocation(node, ctx);

    default:
      return unknown();
  }
}

function evaluateStringLiteral(node: SyntaxNode): ResolvedValue {
  const text = node.text;
  const unquoted = unquoteJavaString(text);
  if (unquoted === null) return unknown();
  return known(unquoted);
}

function evaluateIdentifier(
  node: SyntaxNode,
  ctx: ExpressionResolveContext,
): ResolvedValue {
  const name = node.text;
  const value = ctx.resolveIdentifier(name);
  return value !== null ? known(value) : unknown();
}

function evaluateFieldAccess(
  node: SyntaxNode,
  ctx: ExpressionResolveContext,
): ResolvedValue {
  // field_access: object.field
  const object = node.childForFieldName('object');
  const field = node.childForFieldName('field');
  if (!object || !field) return unknown();

  // Build the full owner path by walking the object chain
  const ownerPath = buildFieldAccessPath(object);
  if (!ownerPath) return unknown();

  const value = ctx.resolveFieldAccess(ownerPath, field.text);
  return value !== null ? known(value) : unknown();
}

/**
 * Build a dotted path from a field_access chain.
 * e.g., `com.acme.Routes` → "com.acme.Routes"
 */
function buildFieldAccessPath(node: SyntaxNode): string | null {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'field_access') {
    const object = node.childForFieldName('object');
    const field = node.childForFieldName('field');
    if (!object || !field) return null;
    const basePath = buildFieldAccessPath(object);
    if (!basePath) return null;
    return `${basePath}.${field.text}`;
  }
  // For other node types (e.g., `this.field`), use the text directly
  if (node.type === 'this' || node.type === 'super') return node.text;
  return null;
}

function evaluateBinaryExpression(
  node: SyntaxNode,
  ctx: ExpressionResolveContext,
): ResolvedValue {
  const operator = node.childForFieldName('operator');
  if (!operator || operator.text !== '+') return unknown();

  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return unknown();

  const leftVal = evaluateStringExpression(left, ctx);
  const rightVal = evaluateStringExpression(right, ctx);

  if (leftVal.kind === 'known' && rightVal.kind === 'known') {
    return known(leftVal.value + rightVal.value);
  }
  return unknown();
}

function evaluateParenthesized(
  node: SyntaxNode,
  ctx: ExpressionResolveContext,
): ResolvedValue {
  // parenthesized_expression: (expr) — the inner expression is the
  // first named child
  const inner = node.namedChildren[0];
  if (!inner) return unknown();
  return evaluateStringExpression(inner, ctx);
}

function evaluateMethodInvocation(
  node: SyntaxNode,
  ctx: ExpressionResolveContext,
): ResolvedValue {
  const name = node.childForFieldName('name')?.text;
  const object = node.childForFieldName('object')?.text;
  const args = node.childForFieldName('arguments')?.namedChildren ?? [];

  // URI.create("...")
  if (name === 'create' && object === 'URI' && args.length >= 1) {
    return evaluateStringExpression(args[0], ctx);
  }

  // Other method invocations → Unknown (dynamic)
  return unknown();
}

/**
 * Evaluate a text expression string (for backward compatibility with
 * provider scanning that doesn't have an AST node). This is a fallback
 * that handles simple cases: string literals, identifiers, and '+'
 * concatenation of known constants.
 *
 * DO NOT use this for consumer scanning — use evaluateStringExpression
 * with proper AST nodes instead.
 */
export function evaluateTextExpression(
  text: string,
  resolveIdentifier: (name: string) => string | null,
  resolveFieldAccess: (owner: string, field: string) => string | null,
): ResolvedValue {
  const trimmed = text.trim();

  // String literal
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const unquoted = unquoteJavaString(trimmed);
    return unquoted !== null ? known(unquoted) : unknown();
  }

  // Try splitting on '+' (respecting quotes)
  const parts = splitConcatSafe(trimmed);
  if (parts.length > 1) {
    const resolved = parts.map((p) =>
      evaluateTextExpression(p, resolveIdentifier, resolveFieldAccess),
    );
    if (resolved.every((r) => r.kind === 'known')) {
      return known(resolved.map((r) => (r as { value: string }).value).join(''));
    }
    return unknown();
  }

  // Identifier
  if (/^[A-Za-z_]\w*$/.test(trimmed)) {
    const value = resolveIdentifier(trimmed);
    return value !== null ? known(value) : unknown();
  }

  // Field access (dotted path)
  const fieldMatch = /^(.+)\.([A-Za-z_]\w*)$/.exec(trimmed);
  if (fieldMatch) {
    const owner = fieldMatch[1] ?? '';
    const field = fieldMatch[2] ?? '';
    const value = resolveFieldAccess(owner, field);
    return value !== null ? known(value) : unknown();
  }

  return unknown();
}

/**
 * Split a concatenation expression on '+' while respecting string literals.
 * Returns the parts, trimmed.
 */
function splitConcatSafe(expr: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote && expr[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '+') {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
