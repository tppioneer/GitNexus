import type Parser from 'tree-sitter';
import {
  METHOD_ANNOTATION_TO_HTTP,
  isRouteMemberKey,
} from '../../../ingestion/route-extractors/spring-shared.js';
import type { HttpDetection } from './types.js';
import type { JavaCseRepoContext } from './java-constant-resolver.js';
import { createJavaConstantResolver } from './java-constant-resolver.js';
import { joinRoutePath, parseCseUrl } from './java-cse-url.js';

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
  for (const child of args.namedChildren) {
    if (child.type === 'element_value_pair') {
      const key = child.childForFieldName('key');
      if (!isRouteMemberKey(key ?? undefined)) continue;
      return child.childForFieldName('value');
    }
    return child;
  }
  return null;
}

function nodeName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName('name')?.text ?? null;
}

function collectRestTemplateAliases(root: Parser.SyntaxNode): Set<string> {
  const aliases = new Set<string>();
  const source = root.text;
  const re =
    /\b(?:private|public|protected|final|static|\s)*RestTemplate\s+([A-Za-z_]\w*)\s*=\s*RestTemplateBuilder\s*\.\s*create\s*\(/g;
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

export function scanSpringCseProviders(
  tree: Parser.Tree,
  fileRel: string | undefined,
  repoContext: JavaCseRepoContext | undefined,
): HttpDetection[] {
  const resolver = createJavaConstantResolver(repoContext, fileRel);
  const out: HttpDetection[] = [];

  visit(tree.rootNode, (node) => {
    if (node.type !== 'class_declaration') return;
    let prefix = '';
    for (const ann of annotationsOf(node)) {
      if (annotationName(ann) !== 'RequestMapping') continue;
      const resolved = resolver.resolveExpression(routeValueExpression(ann));
      if (resolved !== null) prefix = resolved;
    }

    const scanMethods = (cur: Parser.SyntaxNode): void => {
      for (const child of cur.namedChildren) {
        if (child.type === 'method_declaration') {
          const methodName = nodeName(child);
          for (const ann of annotationsOf(child)) {
            const httpMethod = METHOD_ANNOTATION_TO_HTTP[annotationName(ann) ?? ''];
            if (!httpMethod) continue;
            const methodPath = resolver.resolveExpression(routeValueExpression(ann));
            if (methodPath === null) continue;
            out.push({
              role: 'provider',
              framework: 'spring-cse',
              method: httpMethod,
              path: joinRoutePath(prefix, methodPath),
              name: methodName,
              confidence: 0.9,
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

export function scanRestTemplateCseConsumers(
  tree: Parser.Tree,
  fileRel: string | undefined,
  repoContext: JavaCseRepoContext | undefined,
): HttpDetection[] {
  const resolver = createJavaConstantResolver(repoContext, fileRel);
  const aliases = collectRestTemplateAliases(tree.rootNode);
  const out: HttpDetection[] = [];

  visit(tree.rootNode, (node) => {
    if (node.type !== 'method_invocation') return;
    const methodName = node.childForFieldName('name')?.text;
    if (!methodName) return;
    if (!REST_TEMPLATE_TO_HTTP[methodName] && methodName !== 'exchange') return;
    const object = node.childForFieldName('object')?.text;
    if (!object || !isKnownRestTemplateReceiver(object, aliases)) return;

    const args = argumentNodes(node);
    const rawUrl = resolver.resolveExpression(args[0]);
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
      name: null,
      confidence: 0.95,
      serviceRef: cse.serviceRef,
      ...(cse.appId ? { appId: cse.appId } : {}),
      ...(cse.queryTemplate ? { queryTemplate: cse.queryTemplate } : {}),
    });
  });

  return out;
}
