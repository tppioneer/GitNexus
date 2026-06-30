/**
 * CSE-link Java scanner.
 *
 * Tree-sitter based detection of:
 *   - CSE provider: Spring Controller with @RequestMapping mappings
 *   - CSE consumer: RestTemplate calls with cse:// URLs
 *
 * Only recognizes the patterns listed in the design doc § 10 and § 11
 * support matrices. Unsupported patterns are silently skipped.
 */

import type Parser from 'tree-sitter';
import {
  METHOD_ANNOTATION_TO_HTTP,
  isRouteMemberKey,
} from '../../../core/ingestion/route-extractors/spring-shared.js';
import type { JavaCseRepoContext, JavaConstantResolver } from './java-constant-resolver.js';
import { createJavaConstantResolver } from './java-constant-resolver.js';
import { joinRoutePath, parseCseUrl } from './cse-url.js';

/**
 * Raw detection result. Converted to ExtractedContract by the extractor.
 */
export interface CseDetection {
  role: 'provider' | 'consumer';
  framework: string;
  method: string;
  path: string;
  name: string | null;
  confidence: number;
  serviceRef?: string;
  appId?: string;
  queryTemplate?: string;
  /** Repo-relative file path of the detection origin. */
  filePath?: string;
  /** 1-based start line of the detection in the source file (invocation line for consumers). */
  startLine?: number;
  /** Enclosing class name (when available). */
  enclosingClass?: string;
  /**
   * 1-based start line of the enclosing method declaration.
   * Used as a stable, overload-aware method identity for dedup and UID
   * generation. Two consumers from the same method body share this value;
   * two overloaded (same-name-different-params) methods have different values.
   */
  methodStartLine?: number;
}

const REST_TEMPLATE_TO_HTTP: Record<string, string> = {
  getForObject: 'GET',
  getForEntity: 'GET',
  postForObject: 'POST',
  postForEntity: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patchForObject: 'PATCH',
};

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

function visit(node: Parser.SyntaxNode, fn: (node: Parser.SyntaxNode) => void): void {
  fn(node);
  for (const child of node.namedChildren) visit(child, fn);
}

function annotationsOf(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  return modifiers?.namedChildren.filter((child) => child.type === 'annotation') ?? [];
}

function annotationName(annotation: Parser.SyntaxNode): string | null {
  return annotation.childForFieldName('name')?.text ?? null;
}

function routeValueExpression(annotation: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const args = annotation.childForFieldName('arguments');
  if (!args) return null;
  let result: Parser.SyntaxNode | null = null;
  for (const child of args.namedChildren) {
    if (child.type === 'element_value_pair') {
      const key = child.childForFieldName('key');
      if (!isRouteMemberKey(key ?? undefined)) continue;
      result = child.childForFieldName('value');
      break;
    }
    if (!result) result = child;
  }
  if (result?.type === 'element_value_array_initializer') {
    const elements = result.namedChildren;
    if (elements.length === 1) return elements[0];
    return null;
  }
  return result;
}

/**
 * Try to extract an HTTP method string from a `@RequestMapping`-style
 * annotation by looking at its `method` attribute (set to e.g.
 * `RequestMethod.POST`). Returns null when no `method` attribute is
 * present or when it cannot be statically resolved.
 */
function requestMethodFromAnnotation(ann: Parser.SyntaxNode): string | null {
  const args = ann.childForFieldName('arguments');
  if (!args) return null;
  for (const child of args.namedChildren) {
    if (child.type !== 'element_value_pair') continue;
    const key = child.childForFieldName('key');
    if (!key || key.text !== 'method') continue;
    const value = child.childForFieldName('value');
    if (!value) continue;
    // Accept both RequestMethod.GET and the bare GET identifier.
    const raw = value.text.trim();
    const method = raw.split('.').pop()?.toUpperCase() ?? '';
    if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH') {
      return method;
    }
    return null;
  }
  return null;
}

/**
 * Try to extract a path string from a `@RequestMapping`-style annotation
 * by checking `value`, `path`, or positional argument. Returns null when
 * the path cannot be statically resolved.
 */
function requestPathFromAnnotation(
  ann: Parser.SyntaxNode,
  resolver: JavaConstantResolver,
): string | null {
  return resolver.resolveExpression(routeValueExpression(ann));
}

function nodeName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName('name')?.text ?? null;
}

/**
 * Strip line and block comments from Java source so regex-based detection
 * (e.g. RestTemplateBuilder.create() aliases) only sees live code, not
 * commented-out TODOs or migration scratch.
 */
function stripJavaComments(source: string): string {
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
      if (ch === '\r' || ch === '\n') lineComment = false;
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

function collectRestTemplateAliases(root: Parser.SyntaxNode): Set<string> {
  const aliases = new Set<string>();
  // Run on comment-stripped source so commented-out RestTemplate
  // assignments (e.g. migration TODOs) are not picked up as live aliases.
  // The regex tolerates an optional `<TypeParam>` between RestTemplate
  // and the variable name (e.g. `RestTemplate<OrderDTO> rt = ...`).
  const source = stripJavaComments(root.text);
  const re =
    /\b(?:private|public|protected|final|static|\s)*RestTemplate(?:\s*<[^>]+>)?\s+([A-Za-z_]\w*)\s*=\s*RestTemplateBuilder\s*\.\s*create\s*\(/g;
  for (const match of source.matchAll(re)) {
    if (match[1]) aliases.add(match[1]);
  }
  return aliases;
}

function isInlineBuilderCall(objectText: string): boolean {
  return /(?:^|[^\w.])RestTemplateBuilder\s*\.\s*create\s*\(\s*\)\s*$/.test(objectText);
}

function isKnownRestTemplateReceiver(objectText: string, aliases: Set<string>): boolean {
  if (isInlineBuilderCall(objectText)) return true;
  if (aliases.has(objectText)) return true;
  if (objectText.startsWith('this.') && aliases.has(objectText.slice('this.'.length))) return true;
  return false;
}

function argumentNodes(call: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return call.childForFieldName('arguments')?.namedChildren ?? [];
}

function methodFromExchangeArg(node: Parser.SyntaxNode | undefined): string | null {
  if (!node) return null;
  const text = node.text.trim();
  const bare = text.split('.').pop()?.toUpperCase() ?? '';
  return HTTP_METHODS.has(bare) ? bare : null;
}

/**
 * Scan a Java file for CSE provider detections (Spring Controller mappings).
 */
export function scanSpringCseProviders(
  tree: Parser.Tree,
  fileRel: string | undefined,
  repoContext: JavaCseRepoContext | undefined,
): CseDetection[] {
  const resolver = createJavaConstantResolver(repoContext, fileRel);
  const out: CseDetection[] = [];

  visit(tree.rootNode, (node) => {
    if (node.type !== 'class_declaration') return;
    let prefix = '';
    let hasClassMapping = false;
    let classMappingResolved = false;

    for (const ann of annotationsOf(node)) {
      if (annotationName(ann) !== 'RequestMapping') continue;
      hasClassMapping = true;
      const resolved = resolver.resolveExpression(routeValueExpression(ann));
      if (resolved !== null) {
        prefix = resolved;
        classMappingResolved = true;
      }
    }

    if (hasClassMapping && !classMappingResolved) return;

    const className = nodeName(node);
    const scanMethods = (cur: Parser.SyntaxNode): void => {
      for (const child of cur.namedChildren) {
        if (child.type === 'method_declaration') {
          const methodName = nodeName(child);
          for (const ann of annotationsOf(child)) {
            const annName = annotationName(ann);
            let httpMethod: string | undefined | null = METHOD_ANNOTATION_TO_HTTP[annName ?? ''];
            // For @RequestMapping, try the explicit method=RequestMethod.POST form.
            if (!httpMethod && annName === 'RequestMapping') {
              httpMethod = requestMethodFromAnnotation(ann);
            }
            if (!httpMethod) continue;
            const methodPath = requestPathFromAnnotation(ann, resolver);
            if (methodPath === null) continue;
            out.push({
              role: 'provider',
              framework: 'spring-cse',
              method: httpMethod,
              path: joinRoutePath(prefix, methodPath),
              name: methodName,
              confidence: 0.9,
              ...(fileRel ? { filePath: fileRel } : {}),
              startLine: child.startPosition.row + 1,
              ...(className ? { enclosingClass: className } : {}),
              ...(repoContext?.serviceName ? { serviceRef: repoContext.serviceName } : {}),
            });
          }
          continue;
        }
        if (
          child !== node &&
          (child.type === 'class_declaration' || child.type === 'interface_declaration')
        ) {
          continue;
        }
        scanMethods(child);
      }
    };
    scanMethods(node);
  });

  return out;
}

/**
 * Scan a Java file for CSE consumer detections (RestTemplate calls with
 * cse:// URLs). Only recognizes calls on trusted RestTemplate receivers
 * created via `RestTemplateBuilder.create()`.
 */
export function scanRestTemplateCseConsumers(
  tree: Parser.Tree,
  fileRel: string | undefined,
  repoContext: JavaCseRepoContext | undefined,
): CseDetection[] {
  const resolver = createJavaConstantResolver(repoContext, fileRel);
  const aliases = collectRestTemplateAliases(tree.rootNode);
  const out: CseDetection[] = [];

  visit(tree.rootNode, (node) => {
    if (node.type !== 'method_invocation') return;
    const methodName = node.childForFieldName('name')?.text;
    if (!methodName) return;
    if (!REST_TEMPLATE_TO_HTTP[methodName] && methodName !== 'exchange') return;
    const object = node.childForFieldName('object')?.text;
    if (!object || !isKnownRestTemplateReceiver(object, aliases)) return;

    // Find enclosing class/method BEFORE resolving the URL arg so the
    // resolver can scope local-variable lookups to this specific method
    // declaration node (handles overloaded methods, block scoping, etc.).
    let enclosingClass: string | undefined;
    let enclosingMethodNode: Parser.SyntaxNode | undefined;
    let parent = node.parent;
    while (parent) {
      if (!enclosingMethodNode && parent.type === 'method_declaration') {
        enclosingMethodNode = parent;
      }
      if (!enclosingClass && parent.type === 'class_declaration') {
        enclosingClass = nodeName(parent) ?? undefined;
        break;
      }
      parent = parent.parent;
    }
    const enclosingMethod = enclosingMethodNode ? nodeName(enclosingMethodNode) ?? undefined : undefined;

    const args = argumentNodes(node);
    const rawUrl = resolver.resolveExpression(args[0], enclosingMethodNode);
    if (rawUrl === null) return;
    const cse = parseCseUrl(rawUrl);
    if (!cse) return;

    const httpMethod =
      methodName === 'exchange'
        ? methodFromExchangeArg(args[1])
        : REST_TEMPLATE_TO_HTTP[methodName];
    if (!httpMethod) return;

    out.push({
      role: 'consumer',
      framework: 'spring-rest-template-cse',
      method: httpMethod,
      path: cse.pathTemplate,
      name: enclosingMethod ?? null,
      confidence: 0.95,
      serviceRef: cse.serviceRef,
      ...(fileRel ? { filePath: fileRel } : {}),
      startLine: node.startPosition.row + 1,
      ...(enclosingClass ? { enclosingClass } : {}),
      ...(enclosingMethodNode ? { methodStartLine: enclosingMethodNode.startPosition.row + 1 } : {}),
      ...(cse.appId ? { appId: cse.appId } : {}),
      ...(cse.queryTemplate ? { queryTemplate: cse.queryTemplate } : {}),
    });
  });

  return out;
}
