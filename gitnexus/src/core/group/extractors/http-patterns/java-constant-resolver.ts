import path from 'node:path';
import type Parser from 'tree-sitter';
import { unquoteLiteral } from '../tree-sitter-scanner.js';
import type { JavaCseRules } from './java-cse-rules.js';

export interface JavaCseRepoContext {
  serviceName?: string;
  constantsByFile: Map<string, FileConstantIndex>;
  constantsByClass: Map<string, Map<string, string>>;
  externalConstantsByClass: Map<string, Map<string, string>>;
  externalConstantsBySimpleName: Map<string, Map<string, string>>;
}

interface FileConstantIndex {
  byName: Map<string, string>;
  imports: Map<string, string>;
  uriHelpers: Set<string>;
}

export interface JavaConstantResolver {
  resolveExpression(node: Parser.SyntaxNode | undefined | null): string | null;
}

const STRING_CONSTANT_RE =
  /(?:public|private|protected|static|final|\s)*\bString\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
const IMPORT_RE = /\bimport\s+(?:static\s+)?([A-Za-z_][\w.]*\.[A-Za-z_]\w*)\s*;/g;
const CLASS_RE = /\b(?:class|interface)\s+([A-Za-z_]\w*)\b/g;
const URI_HELPER_RE =
  /\bURI\s+([A-Za-z_]\w*)\s*\(\s*String\s+[A-Za-z_]\w*\s*\)\s*\{[^{}]*return\s+URI\.create\s*\(\s*[A-Za-z_]\w*\s*\)\s*;/g;

function stripComments(source: string): string {
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

function packageName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx).replace(/\//g, '.') : '';
}

function splitConcat(expr: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
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

function unquoteToken(token: string): string | null {
  const trimmed = token.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return null;
}

function collectFileIndex(
  filePath: string,
  source: string,
  externalByClass: Map<string, Map<string, string>>,
  externalBySimple: Map<string, Map<string, string>>,
): FileConstantIndex {
  const clean = stripComments(source);
  const byName = new Map<string, string>();
  const imports = new Map<string, string>();
  const uriHelpers = new Set<string>();

  for (const match of clean.matchAll(IMPORT_RE)) {
    const fqcn = match[1];
    if (!fqcn) continue;
    imports.set(fqcn.split('.').pop() ?? fqcn, fqcn);
  }

  for (const match of clean.matchAll(URI_HELPER_RE)) {
    if (match[1]) uriHelpers.add(match[1]);
  }

  let changed = true;
  while (changed) {
    changed = false;
    STRING_CONSTANT_RE.lastIndex = 0;
    for (const match of clean.matchAll(STRING_CONSTANT_RE)) {
      const name = match[1];
      const expr = match[2];
      if (!name || !expr || byName.has(name)) continue;
      const value = resolveTextExpression(
        expr,
        byName,
        new Map(),
        imports,
        externalByClass,
        externalBySimple,
      );
      if (value !== null) {
        byName.set(name, value);
        changed = true;
      }
    }
  }

  return { byName, imports, uriHelpers };
}

function resolveTextExpression(
  expr: string,
  local: Map<string, string>,
  constantsByClass: Map<string, Map<string, string>>,
  imports: Map<string, string>,
  externalByClass = new Map<string, Map<string, string>>(),
  externalBySimple = new Map<string, Map<string, string>>(),
): string | null {
  const parts = splitConcat(expr);
  if (parts.length > 1) {
    const resolved = parts.map((part) =>
      resolveTextExpression(
        part,
        local,
        constantsByClass,
        imports,
        externalByClass,
        externalBySimple,
      ),
    );
    return resolved.every((part): part is string => part !== null) ? resolved.join('') : null;
  }
  const token = expr.trim();
  const literal = unquoteToken(token);
  if (literal !== null) return literal;
  if (/^[A-Za-z_]\w*$/.test(token)) return local.get(token) ?? null;
  const field = /^(.+)\.([A-Za-z_]\w*)$/.exec(token);
  if (!field) return null;
  const owner = field[1] ?? '';
  const key = field[2] ?? '';
  const imported = imports.get(owner);
  return (
    constantsByClass.get(owner)?.get(key) ??
    (imported ? constantsByClass.get(imported)?.get(key) : undefined) ??
    externalByClass.get(owner)?.get(key) ??
    (imported ? externalByClass.get(imported)?.get(key) : undefined) ??
    externalBySimple.get(owner)?.get(key) ??
    null
  );
}

export function buildJavaCseRepoContext(args: {
  files: string[];
  readFile: (rel: string) => string | null;
  rules: JavaCseRules;
}): JavaCseRepoContext {
  const constantsByFile = new Map<string, FileConstantIndex>();
  const constantsByClass = new Map<string, Map<string, string>>();
  const externalConstantsByClass = new Map<string, Map<string, string>>();
  const externalConstantsBySimpleName = new Map<string, Map<string, string>>();
  let serviceName: string | undefined;

  for (const rule of args.rules.externalConstants) {
    const constants = new Map(Object.entries(rule.constants));
    externalConstantsByClass.set(rule.className, constants);
    externalConstantsBySimpleName.set(rule.className.split('.').pop() ?? rule.className, constants);
  }

  const serviceCandidates = [
    'code/webapp/src/main/resources/application.yaml',
    'code/webapp/src/main/resources/application.yml',
    'code/webapp/src/main/resources/application.properties',
    'src/main/resources/application.yaml',
    'src/main/resources/application.yml',
    'src/main/resources/application.properties',
    ...args.files.filter((file) =>
      /^(?:code\/.*|src\/main\/resources\/.*)(?:application|bootstrap)\.(?:ya?ml|properties)$/i.test(
        file.replace(/\\/g, '/'),
      ),
    ),
  ];
  for (const rel of serviceCandidates) {
    if (serviceName) break;
    const source = args.readFile(rel);
    if (!source) continue;
    serviceName =
      /service_description\s*:\s*[\r\n]+(?:[ \t]+[^\r\n]*[\r\n]+)*?[ \t]+name\s*:\s*["']?([^"'\r\n#]+)["']?/m.exec(
        source,
      )?.[1]?.trim() ??
      /service_description\.name\s*=\s*([^\r\n#]+)/.exec(source)?.[1]?.trim();
  }

  for (const rel of args.files.filter((file) => file.endsWith('.java'))) {
    const source = args.readFile(rel);
    if (!source) continue;
    const index = collectFileIndex(
      rel,
      source,
      externalConstantsByClass,
      externalConstantsBySimpleName,
    );
    constantsByFile.set(rel, index);
    const pkg = packageName(rel);
    for (const match of stripComments(source).matchAll(CLASS_RE)) {
      const className = match[1];
      if (!className) continue;
      constantsByClass.set(className, index.byName);
      if (pkg) constantsByClass.set(`${pkg}.${className}`, index.byName);
      constantsByClass.set(path.basename(rel, '.java'), index.byName);
    }
  }

  return {
    ...(serviceName ? { serviceName } : {}),
    constantsByFile,
    constantsByClass,
    externalConstantsByClass,
    externalConstantsBySimpleName,
  };
}

export function createJavaConstantResolver(
  ctx: JavaCseRepoContext | undefined,
  fileRel: string | undefined,
): JavaConstantResolver {
  const fileIndex = fileRel && ctx ? ctx.constantsByFile.get(fileRel) : undefined;
  const imports = fileIndex?.imports ?? new Map<string, string>();
  const local = fileIndex?.byName ?? new Map<string, string>();

  const resolveText = (text: string): string | null =>
    ctx
      ? resolveTextExpression(
          text,
          local,
          ctx.constantsByClass,
          imports,
          ctx.externalConstantsByClass,
          ctx.externalConstantsBySimpleName,
        )
      : resolveTextExpression(text, local, new Map(), imports);

  const resolveExpression = (node: Parser.SyntaxNode | undefined | null): string | null => {
    if (!node) return null;
    if (node.type === 'string_literal') return unquoteLiteral(node.text);
    if (node.type === 'identifier' || node.type === 'field_access') return resolveText(node.text);
    if (node.type === 'binary_expression') return resolveText(node.text);
    if (node.type === 'method_invocation') {
      const name = node.childForFieldName('name')?.text;
      const object = node.childForFieldName('object')?.text;
      const args = node.childForFieldName('arguments')?.namedChildren ?? [];
      if (name === 'create' && object === 'URI' && args[0]) return resolveExpression(args[0]);
      if (name && fileIndex?.uriHelpers.has(name) && args[0]) return resolveExpression(args[0]);
    }
    return null;
  };

  return { resolveExpression };
}
