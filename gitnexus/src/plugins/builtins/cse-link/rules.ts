/**
 * CSE-link rules configuration.
 *
 * Reads `.gitnexus/microservice-rules.yaml` from the analyzed repo.
 * Validates version, limits, path safety. YAML/field errors produce
 * `RULES_INVALID` — the caller must reject extraction for that repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface JavaExternalConstantRule {
  className: string;
  constants: Record<string, string>;
}

export interface JavaCseRules {
  externalConstants: JavaExternalConstantRule[];
}

export const DEFAULT_JAVA_CSE_RULES: JavaCseRules = {
  externalConstants: [],
};

// ─── Hard limits ───────────────────────────────────────────────────────────

const MAX_EXTERNAL_CONSTANT_CLASSES = 100;
const MAX_CONSTANTS_PER_CLASS = 100;
const MAX_TEST_SOURCE_ROOTS = 20;
const MAX_STRING_LENGTH = 4096;

interface RawRuleFile {
  version?: number;
  javaHttpClients?: Array<{ externalConstants?: JavaExternalConstantRule[] }>;
  externalConstants?: JavaExternalConstantRule[];
  testSourceRoots?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesError';
  }
}

/**
 * Validate version field. Missing version is tolerated with an info-level
 * note; unknown higher versions are rejected.
 */
function validateVersion(raw: unknown): void {
  if (raw === undefined || raw === null) return; // missing = compat with v1
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new RulesError(`Invalid rules version: ${raw}. Expected a positive integer.`);
  }
  if (raw > 1) {
    throw new RulesError(
      `Unsupported rules version ${raw}. Highest supported: 1. Refusing extraction.`,
    );
  }
}

/**
 * Validate and normalize externalConstants. Returns empty array when raw is
 * undefined (field absent). Throws RulesError when field is present but
 * not an array, or when any entry fails validation.
 */
function normalizeExternalConstants(raw: unknown): JavaExternalConstantRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new RulesError('externalConstants must be an array.');
  const out: JavaExternalConstantRule[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      throw new RulesError('Each entry in externalConstants must be an object.');
    }
    if (typeof item.className !== 'string' || item.className.trim() === '') {
      throw new RulesError('externalConstants entry: className must be a non-empty string.');
    }
    if (item.className.length > MAX_STRING_LENGTH) {
      throw new RulesError('externalConstants entry: className too long.');
    }
    if (!isRecord(item.constants)) {
      throw new RulesError(`externalConstants entry '${item.className}': constants must be a mapping.`);
    }
    const constants: Record<string, string> = {};
    for (const [key, value] of Object.entries(item.constants)) {
      if (key.length > MAX_STRING_LENGTH) {
        throw new RulesError(`Key too long in externalConstants '${item.className}': ${key.substring(0, 80)}...`);
      }
      if (typeof value !== 'string') {
        throw new RulesError(`externalConstants '${item.className}'.${key}: value must be a string.`);
      }
      if (value.length > MAX_STRING_LENGTH) {
        throw new RulesError(`Value too long in externalConstants '${item.className}'.${key}.`);
      }
      constants[key] = value;
    }
    if (Object.keys(constants).length > MAX_CONSTANTS_PER_CLASS) {
      throw new RulesError(
        `Too many constants in class '${item.className}' (${Object.keys(constants).length}). Limit: ${MAX_CONSTANTS_PER_CLASS}.`,
      );
    }
    out.push({ className: item.className, constants });
  }
  if (out.length > MAX_EXTERNAL_CONSTANT_CLASSES) {
    throw new RulesError(
      `Too many external constant classes (${out.length}). Limit: ${MAX_EXTERNAL_CONSTANT_CLASSES}.`,
    );
  }
  return out;
}

/**
 * Validate and normalize javaHttpClients. Returns empty array when raw is
 * undefined (field absent). Throws RulesError when field is present but
 * not an array, or when any item is not an object. Each item's
 * externalConstants field follows the same optional semantics as the
 * top-level field.
 */
function normalizeJavaHttpClients(raw: unknown): JavaExternalConstantRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new RulesError('javaHttpClients must be an array.');
  const out: JavaExternalConstantRule[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      throw new RulesError('Each entry in javaHttpClients must be an object.');
    }
    out.push(...normalizeExternalConstants(item.externalConstants));
  }
  return out;
}

export interface LoadedRules {
  rules: JavaCseRules;
  testSourceRoots: string[];
  /** True when the rules file was present and valid (even if empty). */
  filePresent: boolean;
}

/**
 * Load rules from `<repoPath>/.gitnexus/microservice-rules.yaml`.
 * Throws RulesError on validation failure — the caller must reject
 * extraction for this repo and emit a RULES_INVALID diagnostic.
 */
export function loadJavaCseRules(repoPath: string): LoadedRules {
  const filePath = path.join(repoPath, '.gitnexus', 'microservice-rules.yaml');
  if (!fs.existsSync(filePath)) {
    return { rules: DEFAULT_JAVA_CSE_RULES, testSourceRoots: [], filePresent: false };
  }

  let parsed: RawRuleFile;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const loaded = yaml.load(content);
    if (!loaded || typeof loaded !== 'object') {
      throw new RulesError('microservice-rules.yaml is empty or not an object.');
    }
    parsed = loaded as RawRuleFile;
  } catch (err) {
    if (err instanceof RulesError) throw err;
    throw new RulesError(
      `Failed to parse microservice-rules.yaml: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  validateVersion(parsed.version);

  const externalConstants = [
    ...normalizeExternalConstants(parsed.externalConstants),
    ...normalizeJavaHttpClients(parsed.javaHttpClients),
  ];

  const testSourceRoots = parseTestSourceRoots(parsed.testSourceRoots, repoPath);

  return {
    rules: { externalConstants },
    testSourceRoots,
    filePresent: true,
  };
}

/**
 * Validate testSourceRoots entries. Uses repoPath as resolution base.
 * Rejects absolute paths, standalone `..` segments, symlink escapes,
 * non-strings, empty values, and values exceeding the length limit.
 */
function parseTestSourceRoots(raw: unknown, repoPath: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new RulesError('testSourceRoots must be an array.');
  }
  if (raw.length > MAX_TEST_SOURCE_ROOTS) {
    throw new RulesError(
      `Too many testSourceRoots (${raw.length}). Limit: ${MAX_TEST_SOURCE_ROOTS}.`,
    );
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new RulesError('Each testSourceRoot must be a non-empty string.');
    }
    if (entry.length > MAX_STRING_LENGTH) {
      throw new RulesError(
        `testSourceRoot value exceeds max length (${MAX_STRING_LENGTH}): ${entry.substring(0, 80)}...`,
      );
    }
    if (path.isAbsolute(entry)) {
      throw new RulesError(`testSourceRoot must not be absolute: '${entry}'.`);
    }
    const normalized = entry.replace(/\\\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
    const segments = normalized.split('/');
    for (const seg of segments) {
      if (seg === '..') {
        throw new RulesError(`testSourceRoot must not contain parent traversal: '${entry}'.`);
      }
    }
    const resolved = path.resolve(repoPath, normalized);
    const repoResolved = path.resolve(repoPath);
    if (!resolved.startsWith(repoResolved + path.sep) && resolved !== repoResolved) {
      throw new RulesError(`testSourceRoot would escape the repo root: '${entry}'.`);
    }
    out.push(normalized);
  }
  return out;
}