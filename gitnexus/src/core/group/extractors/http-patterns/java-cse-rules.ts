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

interface RawRuleFile {
  javaHttpClients?: Array<{ externalConstants?: JavaExternalConstantRule[] }>;
  externalConstants?: JavaExternalConstantRule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeExternalConstants(raw: unknown): JavaExternalConstantRule[] {
  if (!Array.isArray(raw)) return [];
  const out: JavaExternalConstantRule[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.className !== 'string' || !isRecord(item.constants)) {
      continue;
    }
    const constants: Record<string, string> = {};
    for (const [key, value] of Object.entries(item.constants)) {
      if (typeof value === 'string') constants[key] = value;
    }
    out.push({ className: item.className, constants });
  }
  return out;
}

export function loadJavaCseRules(repoPath: string): JavaCseRules {
  const filePath = path.join(repoPath, '.gitnexus', 'microservice-rules.yaml');
  if (!fs.existsSync(filePath)) return DEFAULT_JAVA_CSE_RULES;
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf8')) as RawRuleFile | undefined;
    const externalConstants = [
      ...normalizeExternalConstants(parsed?.externalConstants),
      ...(Array.isArray(parsed?.javaHttpClients)
        ? parsed.javaHttpClients.flatMap((client) =>
            normalizeExternalConstants(client.externalConstants),
          )
        : []),
    ];
    return { externalConstants };
  } catch {
    return DEFAULT_JAVA_CSE_RULES;
  }
}
