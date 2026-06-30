import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadJavaCseRules, RulesError } from '../../../../../src/plugins/builtins/cse-link/rules.js';

function writeYaml(dir: string, content: string): string {
  const rulesDir = path.join(dir, '.gitnexus');
  fs.mkdirSync(rulesDir, { recursive: true });
  const filePath = path.join(rulesDir, 'microservice-rules.yaml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('loadJavaCseRules', () => {
  it('returns defaults and filePresent=false when rules file does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      const result = loadJavaCseRules(tmpDir);
      expect(result.filePresent).toBe(false);
      expect(result.rules).toEqual({ externalConstants: [] });
      expect(result.testSourceRoots).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads successfully when only version is present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, 'version: 1\n');
      const result = loadJavaCseRules(tmpDir);
      expect(result.filePresent).toBe(true);
      expect(result.rules).toEqual({ externalConstants: [] });
      expect(result.testSourceRoots).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads successfully with only testSourceRoots', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, 'version: 1\ntestSourceRoots:\n  - src/componentTest\n');
      const result = loadJavaCseRules(tmpDir);
      expect(result.filePresent).toBe(true);
      expect(result.rules).toEqual({ externalConstants: [] });
      expect(result.testSourceRoots).toEqual(['src/componentTest']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads successfully with only externalConstants', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, 'version: 1\nexternalConstants:\n  - className: Routes\n    constants:\n      PREFIX: /rest/v1\n');
      const result = loadJavaCseRules(tmpDir);
      expect(result.filePresent).toBe(true);
      expect(result.rules.externalConstants).toHaveLength(1);
      expect(result.rules.externalConstants[0].className).toBe('Routes');
      expect(result.rules.externalConstants[0].constants).toEqual({ PREFIX: '/rest/v1' });
      expect(result.testSourceRoots).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads successfully with only javaHttpClients', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, 'version: 1\njavaHttpClients:\n  - externalConstants:\n      - className: Routes\n        constants:\n          PREFIX: /api/v2\n');
      const result = loadJavaCseRules(tmpDir);
      expect(result.filePresent).toBe(true);
      expect(result.rules.externalConstants).toHaveLength(1);
      expect(result.rules.externalConstants[0].className).toBe('Routes');
      expect(result.rules.externalConstants[0].constants).toEqual({ PREFIX: '/api/v2' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('javaHttpClients entry without externalConstants is valid', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, 'version: 1\njavaHttpClients:\n  - className: SomeHttpClient\n');
      const result = loadJavaCseRules(tmpDir);
      expect(result.filePresent).toBe(true);
      // javaHttpClients entry missing externalConstants is treated as empty
      expect(result.rules.externalConstants).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws RulesError when externalConstants is wrong type', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, 'version: 1\nexternalConstants: invalid\n');
      expect(() => loadJavaCseRules(tmpDir)).toThrow(RulesError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws RulesError when testSourceRoots is wrong type', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, 'version: 1\ntestSourceRoots: invalid\n');
      expect(() => loadJavaCseRules(tmpDir)).toThrow(RulesError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws RulesError when javaHttpClients is wrong type', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, 'version: 1\njavaHttpClients: invalid\n');
      expect(() => loadJavaCseRules(tmpDir)).toThrow(RulesError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws RulesError when javaHttpClients entry is not an object', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, 'version: 1\njavaHttpClients:\n  - not-an-object\n');
      expect(() => loadJavaCseRules(tmpDir)).toThrow(RulesError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads a valid multi-field config successfully', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, [
        'version: 1',
        'externalConstants:',
        '  - className: Routes',
        '    constants:',
        '      PREFIX: /api/v1',
        'testSourceRoots:',
        '  - src/componentTest',
        '  - src/e2eTest',
        'javaHttpClients:',
        '  - externalConstants:',
        '      - className: FeignRoutes',
        '        constants:',
        '          BASE: /feign',
      ].join('\n') + '\n');
      const result = loadJavaCseRules(tmpDir);
      expect(result.filePresent).toBe(true);
      expect(result.rules.externalConstants).toHaveLength(2);
      expect(result.rules.externalConstants[0].className).toBe('Routes');
      expect(result.rules.externalConstants[0].constants).toEqual({ PREFIX: '/api/v1' });
      expect(result.rules.externalConstants[1].className).toBe('FeignRoutes');
      expect(result.rules.externalConstants[1].constants).toEqual({ BASE: '/feign' });
      expect(result.testSourceRoots).toEqual(['src/componentTest', 'src/e2eTest']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('missing version is tolerated (compat v1)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      writeYaml(tmpDir, 'testSourceRoots:\n  - src/componentTest\n');
      const result = loadJavaCseRules(tmpDir);
      expect(result.filePresent).toBe(true);
      expect(result.testSourceRoots).toEqual(['src/componentTest']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws RulesError when externalConstants exceed MAX_EXTERNAL_CONSTANT_CLASSES (100)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
    try {
      // Generate 101 classes — one above the limit
      const lines = ['version: 1', 'externalConstants:'];
      for (let i = 1; i <= 101; i++) {
        lines.push(`  - className: C${i}`);
        lines.push('    constants:');
        lines.push(`      K${i}: v${i}`);
      }
      writeYaml(tmpDir, lines.join('\n') + '\n');
      expect(() => loadJavaCseRules(tmpDir)).toThrow(RulesError);
      expect(() => loadJavaCseRules(tmpDir)).toThrow(/Too many external constant classes/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
