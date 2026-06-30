/**
 * CSE-link integration test.
 *
 * Creates temporary Java Spring fixture repos, runs the real
 * CseLinkExtractor against them, then feeds the extracted contracts
 * through the matching pipeline to verify cross-link generation.
 *
 * This test is self-contained: it creates temp directories and does
 * not depend on the real fixture projects or the user's registry.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CseLinkExtractor } from '../../../../../src/plugins/builtins/cse-link/cse-link-extractor.js';
import type {
  GroupPluginContext,
  PluginDiagnostic,
  PluginMetric,
  PluginTranslator,
} from '../../../../../src/plugins/plugin-api.js';
import type { RepoHandle } from '../../../../../src/core/group/types.js';
import type { ExtractedContract } from '../../../../../src/core/group/types.js';
import { createCseExactMatcher } from '../../../../../src/plugins/builtins/cse-link/matching.js';

interface RepoSetup {
  tmpDir: string;
  name: string;
  serviceName: string;
  contracts: ExtractedContract[];
}

function makeContext(): {
  context: GroupPluginContext;
  diagnostics: PluginDiagnostic[];
  metrics: PluginMetric[];
} {
  const diagnostics: PluginDiagnostic[] = [];
  const metrics: PluginMetric[] = [];
  return {
    context: {
      locale: 'en',
      createTranslator: (_ns: string): PluginTranslator => ({ t: (key: string) => key }),
      reportDiagnostic: (d: PluginDiagnostic) => diagnostics.push(d),
      reportMetric: (m: PluginMetric) => metrics.push(m),
    },
    diagnostics,
    metrics,
  };
}

function makeRepo(repoPath: string, id: string): RepoHandle {
  return { id, path: id, repoPath, storagePath: repoPath };
}

/**
 * Build a temporary repo with a Spring Controller (provider) or
 * RestTemplate consumer (consumer) and an application.yaml.
 */
function buildProviderRepo(baseDir: string, serviceName: string, body: string): string {
  const src = path.join(baseDir, 'src', 'main', 'java', 'com', 'acme');
  const res = path.join(baseDir, 'src', 'main', 'resources');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(
    path.join(res, 'application.yaml'),
    `service_description:\n  name: ${serviceName}\n`,
  );
  fs.writeFileSync(path.join(src, 'Controller.java'), body);
  return baseDir;
}

function buildConsumerRepo(
  baseDir: string,
  serviceName: string,
  body: string,
  rulesYaml?: string,
): string {
  const src = path.join(baseDir, 'src', 'main', 'java', 'com', 'acme');
  const res = path.join(baseDir, 'src', 'main', 'resources');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(
    path.join(res, 'application.yaml'),
    `service_description:\n  name: ${serviceName}\n`,
  );
  fs.writeFileSync(path.join(src, 'Client.java'), body);
  if (rulesYaml) {
    const gitnexus = path.join(baseDir, '.gitnexus');
    fs.mkdirSync(gitnexus, { recursive: true });
    fs.writeFileSync(path.join(gitnexus, 'microservice-rules.yaml'), rulesYaml);
  }
  return baseDir;
}

describe('CSE-link integration', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
    tmpDirs.length = 0;
  });

  async function extractSingle(
    tmpDir: string,
    repoId: string,
  ): Promise<ExtractedContract[]> {
    const { context } = makeContext();
    const extractor = new CseLinkExtractor(context);
    const repo = makeRepo(tmpDir, repoId);
    if (await extractor.canExtract(repo)) {
      return extractor.extract(null, tmpDir, repo);
    }
    return [];
  }

  // ── 1. Provider + consumer across two temp repos ──

  it('creates cross-link between provider and consumer', async () => {
    const provDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-prov-'));
    const consDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-cons-'));
    tmpDirs.push(provDir, consDir);

    buildProviderRepo(
      provDir,
      'order-service',
      `package com.acme;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/rest/v1")
public class Controller {
  @GetMapping("/orders/{id}")
  public String get(@PathVariable String id) { return id; }
}`,
    );

    buildConsumerRepo(
      consDir,
      'consumer-one',
      `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String fetch(String id) {
    return rt.getForObject("cse://order-service/rest/v1/orders/{id}", String.class, id);
  }
}`,
    );

    const providers = await extractSingle(provDir, 'provider');
    const consumers = await extractSingle(consDir, 'consumer');

    expect(providers.length).toBeGreaterThan(0);
    expect(consumers.length).toBeGreaterThan(0);

    const httpProviders = providers.filter((c) => c.role === 'provider');
    const httpConsumers = consumers.filter((c) => c.role === 'consumer');

    // Verify source_authoritative
    for (const c of httpConsumers) {
      expect(c.meta.extractionStrategy).toBe('source_authoritative');
    }

    // Match by contractId
    for (const cons of httpConsumers) {
      const match = httpProviders.find((p) => p.contractId === cons.contractId);
      expect(match).toBeDefined();
    }

    const { context } = makeContext();
    const match = createCseExactMatcher(context);
    const result = match(
      [
        ...providers.map((contract) => ({ ...contract, repo: 'provider' })),
        ...consumers.map((contract) => ({ ...contract, repo: 'consumer' })),
      ],
      new Map(),
    );
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].to.repo).toBe('provider');
  });

  // ── 2. Overloaded methods resolve independently ──

  it('overloaded methods produce distinct contracts', async () => {
    const consDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-over-'));
    tmpDirs.push(consDir);

    buildConsumerRepo(
      consDir,
      'svc',
      `package com.acme;
import org.springframework.web.client.*;
public class Svc {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String get(String name) {
    String url = "cse://svc/by-name";
    return rt.getForObject(url, String.class, name);
  }
  public String get(long id) {
    String url = "cse://svc/by-id";
    return rt.getForObject(url, String.class, id);
  }
}`,
    );

    const contracts = await extractSingle(consDir, 'svc');
    const consumers = contracts.filter((c) => c.role === 'consumer');
    expect(consumers.length).toBe(2);
    expect(consumers.map((c) => c.meta.path).sort()).toEqual(['/by-id', '/by-name']);
  });

  // ── 3. Sibling block URLs resolve independently ──

  it('sibling blocks resolve different URLs', async () => {
    const consDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-blk-'));
    tmpDirs.push(consDir);

    buildConsumerRepo(
      consDir,
      'svc',
      `package com.acme;
import org.springframework.web.client.*;
public class Pick {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String pick(boolean f) {
    if (f) {
      String url = "cse://svc/left";
      return rt.getForObject(url, String.class);
    } else {
      String url = "cse://svc/right";
      return rt.getForObject(url, String.class);
    }
  }
}`,
    );

    const contracts = await extractSingle(consDir, 'svc');
    const consumers = contracts.filter((c) => c.role === 'consumer');
    expect(consumers.length).toBe(2);
    expect(consumers.map((c) => c.meta.path).sort()).toEqual(['/left', '/right']);
  });

  // ── 4. Same-method multi-branch call collapses to one contract ──

  it('multi-branch calls collapse to one contract per method', async () => {
    const consDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-dedup-'));
    tmpDirs.push(consDir);

    buildConsumerRepo(
      consDir,
      'svc',
      `package com.acme;
import org.springframework.web.client.*;
public class Svc {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String search(String q, String cat) {
    String url = "cse://svc/search?q={q}";
    if (cat != null) {
      url += "&cat={cat}";
      return rt.getForObject(url, String.class, q, cat);
    }
    return rt.getForObject(url, String.class, q);
  }
}`,
    );

    const contracts = await extractSingle(consDir, 'svc');
    const consumers = contracts.filter((c) => c.role === 'consumer');
    // Two branches in the same method → same contractId + serviceRef → deduped
    expect(consumers.length).toBe(1);
    expect(consumers[0].symbolName).toBe('search');
    expect(consumers[0].meta.path).toBe('/search');
    expect(consumers[0].meta.queryTemplate).toContain('q={q}');
    expect(consumers[0].meta.queryTemplate).toContain('cat={cat}');
  });

  // ── 5. Different services are NOT merged ──

  it('different serviceRefs produce separate contracts even with same path', async () => {
    const consDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-svc-'));
    tmpDirs.push(consDir);

    buildConsumerRepo(
      consDir,
      'svc',
      `package com.acme;
import org.springframework.web.client.*;
public class Multi {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String fetch1() {
    return rt.getForObject("cse://svc-a/api/get", String.class);
  }
  public String fetch2() {
    return rt.getForObject("cse://svc-b/api/get", String.class);
  }
}`,
    );

    const contracts = await extractSingle(consDir, 'svc');
    const consumers = contracts.filter((c) => c.role === 'consumer');
    expect(consumers.length).toBe(2);
    // Different serviceRefs → not deduped even though both are GET /api/get
    const refs = consumers.map((c) => c.meta.serviceRef).sort();
    expect(refs).toEqual(['svc-a', 'svc-b']);
  });

  // ── 6. Different methods are NOT merged ──

  it('different methods produce separate contracts for same API', async () => {
    const consDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-meth-'));
    tmpDirs.push(consDir);

    buildConsumerRepo(
      consDir,
      'svc',
      `package com.acme;
import org.springframework.web.client.*;
public class Multi {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String call1() {
    return rt.getForObject("cse://svc/api/get", String.class);
  }
  public String call2() {
    return rt.getForObject("cse://svc/api/get", String.class);
  }
}`,
    );

    const contracts = await extractSingle(consDir, 'svc');
    const consumers = contracts.filter((c) => c.role === 'consumer');
    // Same contractId, same serviceRef, different methods → should be deduped?
    // Wait — same contractId + serviceRef + method identity = deduped
    // Different methods → different methodStartLine → NOT deduped
    expect(consumers.length).toBe(2);
  });

  // ── 7. Test source filtering with custom root ──

  it('excludes consumers from test and componentTest sources', async () => {
    const consDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-tf-'));
    tmpDirs.push(consDir);

    const base = consDir;
    const main = path.join(base, 'src', 'main', 'java', 'com', 'acme');
    const test = path.join(base, 'src', 'test', 'java', 'com', 'acme');
    const compTest = path.join(base, 'src', 'componentTest', 'java', 'com', 'acme');
    const res = path.join(base, 'src', 'main', 'resources');
    fs.mkdirSync(main, { recursive: true });
    fs.mkdirSync(test, { recursive: true });
    fs.mkdirSync(compTest, { recursive: true });
    fs.mkdirSync(res, { recursive: true });

    fs.writeFileSync(
      path.join(res, 'application.yaml'),
      'service_description:\n  name: my-svc\n',
    );

    // Production consumer — should appear
    fs.writeFileSync(
      path.join(main, 'RealClient.java'),
      `package com.acme;
import org.springframework.web.client.*;
public class RealClient {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String get() {
    return rt.getForObject("cse://svc/api", String.class);
  }
}`,
    );

    // Test source consumer — should NOT appear
    fs.writeFileSync(
      path.join(test, 'TestClient.java'),
      `package com.acme;
import org.springframework.web.client.*;
public class TestClient {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String get() {
    return rt.getForObject("cse://svc/test-api", String.class);
  }
}`,
    );

    // Component test — should NOT appear with custom root config
    fs.writeFileSync(
      path.join(compTest, 'ComponentTestClient.java'),
      `package com.acme;
import org.springframework.web.client.*;
public class ComponentTestClient {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String get() {
    return rt.getForObject("cse://svc/comp-api", String.class);
  }
}`,
    );

    // Rules with testSourceRoots
    const rulesYaml = [
      'version: 1',
      'testSourceRoots:',
      '  - src/componentTest',
    ].join('\n');
    const gitnexus = path.join(base, '.gitnexus');
    fs.mkdirSync(gitnexus, { recursive: true });
    fs.writeFileSync(path.join(gitnexus, 'microservice-rules.yaml'), rulesYaml);

    const contracts = await extractSingle(base, 'my-svc');
    const consumers = contracts.filter((c) => c.role === 'consumer');
    // Only the production consumer should be present
    expect(consumers.length).toBe(1);
    expect(consumers[0].meta.path).toBe('/api');
    expect(consumers[0].meta.serviceRef).toBe('svc');
  });

  // ── 8. Provider annotation prefix correctly joined ──

  it('correctly joins class-level and method-level paths in provider', async () => {
    const provDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-join-'));
    tmpDirs.push(provDir);

    buildProviderRepo(
      provDir,
      'api-svc',
      `package com.acme;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/v2")
public class Ctrl {
  @GetMapping("/items/{id}")
  public String get(@PathVariable String id) { return id; }
}`,
    );

    const contracts = await extractSingle(provDir, 'api-svc');
    const providers = contracts.filter((c) => c.role === 'provider');
    expect(providers.length).toBe(1);
    expect(providers[0].contractId).toBe('http::GET::/api/v2/items/{param}');
  });

  // ── P1-3 fix: import priority over simple class name ──

  it('P1-fix-3a: explicit import resolves to imported class, not other same-named class', async () => {
    const consDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-p13a-'));
    tmpDirs.push(consDir);

    const srcA = path.join(consDir, 'src', 'main', 'java', 'com', 'a');
    const srcZ = path.join(consDir, 'src', 'main', 'java', 'com', 'z');
    const srcClient = path.join(consDir, 'src', 'main', 'java', 'com', 'client');
    const res = path.join(consDir, 'src', 'main', 'resources');
    fs.mkdirSync(srcA, { recursive: true });
    fs.mkdirSync(srcZ, { recursive: true });
    fs.mkdirSync(srcClient, { recursive: true });
    fs.mkdirSync(res, { recursive: true });

    fs.writeFileSync(
      path.join(res, 'application.yaml'),
      'service_description:\n  name: my-svc\n',
    );

    // Two same-named classes in different packages
    fs.writeFileSync(
      path.join(srcA, 'Routes.java'),
      `package com.a;
public class Routes {
  public static final String PATH = "/wanted-a";
}`,
    );
    fs.writeFileSync(
      path.join(srcZ, 'Routes.java'),
      `package com.z;
public class Routes {
  public static final String PATH = "/wanted-z";
}`,
    );

    // Client explicitly imports com.z.Routes
    fs.writeFileSync(
      path.join(srcClient, 'Client.java'),
      `package com.client;
import org.springframework.web.client.*;
import com.z.Routes;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  public void call() {
    String url = "cse://svc" + Routes.PATH;
    rt.getForObject(url, String.class);
  }
}`,
    );

    const contracts = await extractSingle(consDir, 'my-svc');
    const consumers = contracts.filter((c) => c.role === 'consumer');
    expect(consumers.length).toBe(1);
    expect(consumers[0].meta.path).toBe('/wanted-z');
    expect(consumers[0].meta.serviceRef).toBe('svc');
  });

  it('P1-fix-3b: swapping file scan order must not change result', async () => {
    const consDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-p13b-'));
    tmpDirs.push(consDir);

    const srcA = path.join(consDir, 'src', 'main', 'java', 'com', 'a');
    const srcZ = path.join(consDir, 'src', 'main', 'java', 'com', 'z');
    const srcClient = path.join(consDir, 'src', 'main', 'java', 'com', 'client');
    const res = path.join(consDir, 'src', 'main', 'resources');
    fs.mkdirSync(srcA, { recursive: true });
    fs.mkdirSync(srcZ, { recursive: true });
    fs.mkdirSync(srcClient, { recursive: true });
    fs.mkdirSync(res, { recursive: true });

    fs.writeFileSync(
      path.join(res, 'application.yaml'),
      'service_description:\n  name: my-svc\n',
    );

    // Create com.z FIRST (different order from P1-fix-3a)
    fs.writeFileSync(
      path.join(srcZ, 'Routes.java'),
      `package com.z;
public class Routes {
  public static final String PATH = "/wanted-z";
}`,
    );
    fs.writeFileSync(
      path.join(srcA, 'Routes.java'),
      `package com.a;
public class Routes {
  public static final String PATH = "/wanted-a";
}`,
    );

    // Client imports com.z.Routes
    fs.writeFileSync(
      path.join(srcClient, 'Client.java'),
      `package com.client;
import org.springframework.web.client.*;
import com.z.Routes;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  public void call() {
    String url = "cse://svc" + Routes.PATH;
    rt.getForObject(url, String.class);
  }
}`,
    );

    const contracts = await extractSingle(consDir, 'my-svc');
    const consumers = contracts.filter((c) => c.role === 'consumer');
    expect(consumers.length).toBe(1);
    // Must be same result regardless of file scan order
    expect(consumers[0].meta.path).toBe('/wanted-z');
  });

  it('P1-fix-3c: ambiguous simple name without import returns no consumer', async () => {
    const consDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-int-p13c-'));
    tmpDirs.push(consDir);

    const srcA = path.join(consDir, 'src', 'main', 'java', 'com', 'a');
    const srcZ = path.join(consDir, 'src', 'main', 'java', 'com', 'z');
    const srcClient = path.join(consDir, 'src', 'main', 'java', 'com', 'client');
    const res = path.join(consDir, 'src', 'main', 'resources');
    fs.mkdirSync(srcA, { recursive: true });
    fs.mkdirSync(srcZ, { recursive: true });
    fs.mkdirSync(srcClient, { recursive: true });
    fs.mkdirSync(res, { recursive: true });

    fs.writeFileSync(
      path.join(res, 'application.yaml'),
      'service_description:\n  name: my-svc\n',
    );

    fs.writeFileSync(
      path.join(srcA, 'Routes.java'),
      `package com.a;
public class Routes {
  public static final String PATH = "/wanted-a";
}`,
    );
    fs.writeFileSync(
      path.join(srcZ, 'Routes.java'),
      `package com.z;
public class Routes {
  public static final String PATH = "/wanted-z";
}`,
    );

    // Client uses Routes without import — ambiguous, should NOT resolve
    fs.writeFileSync(
      path.join(srcClient, 'Client.java'),
      `package com.client;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  public void call() {
    String url = "cse://svc" + Routes.PATH;
    rt.getForObject(url, String.class);
  }
}`,
    );

    const contracts = await extractSingle(consDir, 'my-svc');
    const consumers = contracts.filter((c) => c.role === 'consumer');
    // Ambiguous — no import to disambiguate → no consumer
    expect(consumers.length).toBe(0);
  });
});
