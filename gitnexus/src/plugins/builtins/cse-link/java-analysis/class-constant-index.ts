/**
 * Per-class field constant index for the CSE-link plugin.
 *
 * Builds an index of String field constants for each Java class in a
 * file, properly isolating fields by class scope. Two classes with the
 * same field name do NOT collide — each class has its own field map.
 *
 * Only final String fields with compile-time constant initializers are
 * indexed. Non-final fields, non-String fields, and fields without
 * initializers are excluded.
 *
 * The index also tracks imports and the package name for FQCN resolution.
 */

import type Parser from 'tree-sitter';
import type { ResolvedValue } from './model.js';
import { known, unknown } from './model.js';
import {
  visitAst,
  extractImports,
  extractPackageName,
  unquoteJavaString,
  isFinalField,
  collectClassDeclarations,
} from './ast-utils.js';

type SyntaxNode = Parser.SyntaxNode;

/**
 * Per-class field constants. Keys are field names; values are the
 * resolved string values.
 */
export interface ClassFieldIndex {
  /** The simple class name. */
  readonly simpleName: string;
  /** Fully qualified class name (package + simple name). */
  readonly fqcn: string;
  /** Field name → resolved string value. */
  readonly fields: ReadonlyMap<string, string>;
}

/**
 * File-level index: per-class fields, imports, and package info.
 */
export interface FileIndex {
  /** Per-class field indexes, keyed by simple class name. */
  readonly byClassName: ReadonlyMap<string, ClassFieldIndex>;
  /** Per-class field indexes, keyed by FQCN. */
  readonly byFqcn: ReadonlyMap<string, ClassFieldIndex>;
  /** Import map: simple name → FQCN. */
  readonly imports: ReadonlyMap<string, string>;
  /** Package name (may be empty for default package). */
  readonly packageName: string;
}

/**
 * Build a file-level index from a parsed Java file.
 *
 * @param source - The raw Java source text (used for import/package extraction).
 * @param tree - The parsed tree-sitter tree.
 * @param filePath - Repo-relative file path (used for package inference fallback).
 * @param resolveFieldExpr - Callback to resolve a field initializer expression.
 *   For class-level constants, only other class constants and literals are available.
 *   The callback receives the expression node and returns the resolved value.
 */
export function buildFileIndex(
  source: string,
  tree: Parser.Tree,
  filePath: string,
  resolveFieldExpr: (exprNode: SyntaxNode) => ResolvedValue,
): FileIndex {
  const imports = extractImports(source);
  const packageName = extractPackageName(source);

  const byClassName = new Map<string, ClassFieldIndex>();
  const byFqcn = new Map<string, ClassFieldIndex>();

  const classDecls = collectClassDeclarations(tree.rootNode);

  for (const { name: className, node: classNode } of classDecls) {
    const fields = collectClassFields(classNode, resolveFieldExpr);
    const fqcn = packageName ? `${packageName}.${className}` : className;

    const classIndex: ClassFieldIndex = {
      simpleName: className,
      fqcn,
      fields,
    };

    byClassName.set(className, classIndex);
    byFqcn.set(fqcn, classIndex);
  }

  return { byClassName, byFqcn, imports, packageName };
}

/**
 * Collect final String field constants from a single class body.
 * Only reads field_declaration nodes that are direct children of the
 * class_body.
 */
function collectClassFields(
  classNode: SyntaxNode,
  resolveFieldExpr: (exprNode: SyntaxNode) => ResolvedValue,
): Map<string, string> {
  const fields = new Map<string, string>();

  // Find the class_body
  const classBody = classNode.childForFieldName('body') ??
    classNode.namedChildren.find((c) => c.type === 'class_body');
  if (!classBody) return fields;

  // Iterate direct children of class_body (not nested classes' fields)
  for (const child of classBody.namedChildren) {
    if (child.type !== 'field_declaration') continue;

    // Only index final String fields
    if (!isFinalField(child)) continue;
    if (!isStringField(child)) continue;

    // Extract variable_declarator(s) with initializers
    for (const sub of child.namedChildren) {
      if (sub.type !== 'variable_declarator') continue;
      const nameNode = sub.childForFieldName('name');
      const valueNode = sub.childForFieldName('value');
      if (!nameNode || !valueNode) continue;

      const fieldName = nameNode.text;
      if (fields.has(fieldName)) continue; // first-writer-wins

      const resolved = resolveFieldExpr(valueNode);
      if (resolved.kind === 'known') {
        fields.set(fieldName, resolved.value);
      }
      // Unknown values are not indexed (conservative)
    }
  }

  return fields;
}

/**
 * Check if a field_declaration has type String.
 */
function isStringField(fieldDecl: SyntaxNode): boolean {
  // The type is typically the first named child that is a type node
  for (const child of fieldDecl.namedChildren) {
    if (
      child.type === 'type_identifier' ||
      child.type === 'generic_type' ||
      child.type === 'scoped_type_identifier'
    ) {
      return child.text === 'String';
    }
    // Stop searching after we hit the type (before declarators)
    if (child.type === 'variable_declarator') break;
  }
  return false;
}

/**
 * Look up a constant by simple class name and field name.
 */
export function lookupBySimpleName(
  index: FileIndex,
  className: string,
  fieldName: string,
): string | null {
  const classIndex = index.byClassName.get(className);
  return classIndex?.fields.get(fieldName) ?? null;
}

/**
 * Look up a constant by FQCN and field name.
 */
export function lookupByFqcn(
  index: FileIndex,
  fqcn: string,
  fieldName: string,
): string | null {
  const classIndex = index.byFqcn.get(fqcn);
  return classIndex?.fields.get(fieldName) ?? null;
}

/**
 * Look up a constant by a possibly-qualified class reference and field name.
 *
 * Resolution order:
 *   1. If owner is a FQCN → direct lookup
 *   2. If owner is an imported simple name → resolve to FQCN, then lookup
 *   3. If owner is a simple class name in this file → direct lookup
 */
export function lookupFieldConstant(
  index: FileIndex,
  owner: string,
  fieldName: string,
): string | null {
  // Try as FQCN
  const byFqcn = lookupByFqcn(index, owner, fieldName);
  if (byFqcn !== null) return byFqcn;

  // Try as imported name
  const imported = index.imports.get(owner);
  if (imported) {
    const byImport = lookupByFqcn(index, imported, fieldName);
    if (byImport !== null) return byImport;
  }

  // Try as simple class name in this file
  return lookupBySimpleName(index, owner, fieldName);
}

/**
 * Look up a bare identifier as a field constant. Searches ALL classes
 * in the file for a matching field name. Returns the value only if
 * exactly one class defines this field (unambiguous).
 *
 * If multiple classes define the same field name, returns null (ambiguous).
 */
export function lookupUnqualifiedFieldConstant(
  index: FileIndex,
  fieldName: string,
): string | null {
  let found: string | null = null;
  for (const classIndex of index.byClassName.values()) {
    const value = classIndex.fields.get(fieldName);
    if (value !== undefined) {
      if (found !== null && found !== value) return null; // ambiguous
      found = value;
    }
  }
  return found;
}

/**
 * Build a flat field map from the file index for backward-compatible
 * provider scanning. This merges all classes' fields into one map,
 * which is only safe when there's one class per file or when field
 * names don't collide.
 *
 * For consumer scanning, use the per-class lookups instead.
 */
export function buildFlatFieldMap(index: FileIndex): Map<string, string> {
  const flat = new Map<string, string>();
  for (const classIndex of index.byClassName.values()) {
    for (const [name, value] of classIndex.fields) {
      flat.set(name, value);
    }
  }
  return flat;
}
