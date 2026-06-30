import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CseLinkExtractor } from '../../../../../src/plugins/builtins/cse-link/cse-link-extractor.js';
import {
  buildJavaCseRepoContext,
  createJavaConstantResolver,
} from '../../../../../src/plugins/builtins/cse-link/java-constant-resolver.js';
import type {
  GroupPluginContext,
  PluginDiagnostic,
  PluginMetric,
  PluginTranslator,
} from '../../../../../src/plugins/plugin-api.js';
import type { RepoHandle } from '../../../../../src/core/group/types.js';

function makeContext(): {
  context: GroupPluginContext;
  diagnostics: PluginDiagnostic[];
  metrics: PluginMetric[];
} {
  const diagnostics: PluginDiagnostic[] = [];
  const metrics: PluginMetric[] = [];
  const context: GroupPluginContext = {
    locale: 'en',
    createTranslator: (_ns: string): PluginTranslator => ({
      t: (key: string) => key,
    }),
    reportDiagnostic: (d: PluginDiagnostic) => diagnostics.push(d),
    reportMetric: (m: PluginMetric) => metrics.push(m),
  };
  return { context, diagnostics, metrics };
}

function makeRepo(repoPath: string): RepoHandle {
  return {
    id: 'test-repo',
    path: 'test-repo',
    repoPath,
    storagePath: repoPath,
  };
}

describe('CseLinkExtractor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-link-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('canExtract', () => {
    it('returns false for repo with no Java files', async () => {
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      expect(await extractor.canExtract(repo)).toBe(false);
    });

    it('returns false for Java-only repo without Spring', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Hello.java'),
        'package com.acme; public class Hello {}',
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      expect(await extractor.canExtract(repo)).toBe(false);
    });

    it('returns true for repo with Spring annotation', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Controller.java'),
        `package com.acme;
import org.springframework.web.bind.annotation.RestController;
@RestController
public class Controller {}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      expect(await extractor.canExtract(repo)).toBe(true);
    });

    it('returns true for repo with Spring Web dependency in pom.xml', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'pom.xml'),
        `<project><dependencies>
          <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
        </dependencies></project>`,
      );
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'App.java'),
        'public class App {}',
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      expect(await extractor.canExtract(repo)).toBe(true);
    });
  });

  describe('extract', () => {
    it('extracts provider contracts from Spring Controller', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'resources'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'resources', 'application.yaml'),
        'service_description:\n  name: order-service\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'OrderController.java'),
        `package com.acme;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/rest/v1")
public class OrderController {
  @GetMapping("/orders/{id}")
  public String get(String id) { return id; }
}`,
      );
      const { context, diagnostics } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers.length).toBe(1);
      expect(providers[0].contractId).toBe('http::GET::/rest/v1/orders/{param}');
      expect(providers[0].meta.serviceName).toBe('order-service');
      // Missing service name diagnostic should NOT be reported.
      const missingServiceDiag = diagnostics.find((d) => d.code === 'MISSING_SERVICE_NAME');
      expect(missingServiceDiag).toBeUndefined();
    });

    it('emits MISSING_SERVICE_NAME when no service_description.name', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Controller.java'),
        `package com.acme;
import org.springframework.web.bind.annotation.*;
@RestController
public class Controller {
  @GetMapping("/api")
  public String get() { return ""; }
}`,
      );
      const { context, diagnostics } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      await extractor.extract(null, tmpDir, repo);
      const missingServiceDiag = diagnostics.find((d) => d.code === 'MISSING_SERVICE_NAME');
      expect(missingServiceDiag).toBeDefined();
    });

    it('extracts consumer contracts with serviceRef', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String query() {
    return rt.getForObject("cse://order-service/rest/orders/{id}", String.class, "1");
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].contractId).toBe('http::GET::/rest/orders/{param}');
      expect(consumers[0].meta.serviceRef).toBe('order-service');
    });

    it('skips test source-set consumers', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'test', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'test', 'java', 'com', 'acme', 'TestClient.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class TestClient {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String q() {
    return rt.getForObject("cse://svc/api/test", String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      expect(contracts.filter((c) => c.role === 'consumer').length).toBe(0);
    });

    it('does not filter production source with "test" package', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'test'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'test', 'Client.java'),
        `package com.acme.test;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String q() {
    return rt.getForObject("cse://svc/api/x", String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      expect(contracts.filter((c) => c.role === 'consumer').length).toBe(1);
    });

    it('generates non-empty synthetic UIDs', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String q() {
    return rt.getForObject("cse://svc/api", String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      expect(contracts.length).toBeGreaterThan(0);
      for (const c of contracts) {
        expect(c.symbolUid).toBeTruthy();
        expect(c.symbolUid.length).toBeGreaterThan(0);
      }
    });

    it('reports metrics after extraction', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Controller.java'),
        `package com.acme;
import org.springframework.web.bind.annotation.*;
@RestController
public class Controller {
  @GetMapping("/api")
  public String get() { return ""; }
}`,
      );
      const { context, metrics } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      await extractor.extract(null, tmpDir, repo);
      const metricNames = metrics.map((m) => m.name);
      expect(metricNames).toContain('files_scanned');
      expect(metricNames).toContain('providers_detected');
      expect(metricNames).toContain('duration_ms');
    });

    it('ignores commented-out RestTemplate aliases (issue #8)', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  // private RestTemplate deprecatedClient = RestTemplateBuilder.create();
  /* private RestTemplate alsoDead = RestTemplateBuilder.create(); */
  public String q() {
    return "no real call here";
  }
}`,
      );
      const { context, metrics } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      expect(contracts.filter((c) => c.role === 'consumer').length).toBe(0);
    });

    it('emits AMBIGUOUS_SERVICE_NAME when configs disagree (issue #9)', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'resources'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'resources', 'application.yaml'),
        'service_description:\n  name: order-service\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'resources', 'bootstrap.yaml'),
        'service_description:\n  name: order-service-v2\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Controller.java'),
        `package com.acme;
import org.springframework.web.bind.annotation.*;
@RestController
public class Controller {
  @GetMapping("/api")
  public String get() { return ""; }
}`,
      );
      const { context, diagnostics } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      await extractor.extract(null, tmpDir, repo);
      const ambig = diagnostics.find((d) => d.code === 'AMBIGUOUS_SERVICE_NAME');
      expect(ambig).toBeDefined();
    });
  });

  describe('method-scoped constant resolution (regression)', () => {
    /**
     * Regression: multiple methods declare `String url` with different values.
     * Each method's RestTemplate call should resolve its OWN url, not the
     * first-in-file declaration — verifying that the resolver correctly
     * separates method-local variables by scope.
     */
    it('each method resolves its own String url local variable', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'OrderServiceClient.java'),
        `package com.acme;
import org.springframework.web.client.*;
import org.springframework.stereotype.Service;

@Service
public class OrderServiceClient {
  private static final String PREFIX = "/rest/v1/orders";
  private static final String SERVICE_REF = "cse://order-service";
  private RestTemplate rt = RestTemplateBuilder.create();

  public String getOrder(String id) {
    String url = SERVICE_REF + PREFIX + "/{id}";
    return rt.getForObject(url, String.class, id);
  }

  public String batchOrders() {
    String url = SERVICE_REF + PREFIX + "/batch";
    return rt.postForObject(url, String.class, null);
  }

  public String searchOrders(String status) {
    String url = SERVICE_REF + PREFIX + "/search?status={status}";
    return rt.getForObject(url, String.class, status);
  }

  public String createOrder() {
    String url = SERVICE_REF + PREFIX;
    return rt.postForObject(url, String.class, null);
  }
}`,
      );
      const { context, diagnostics } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const consumers = contracts.filter((c) => c.role === 'consumer');

      // getOrder → GET /rest/v1/orders/{param}
      const getOrder = consumers.find((c) => c.symbolName === 'getOrder');
      expect(getOrder).toBeDefined();
      expect(getOrder!.meta.method).toBe('GET');
      expect(getOrder!.meta.path).toBe('/rest/v1/orders/{param}');

      // batchOrders → POST /rest/v1/orders/batch
      const batch = consumers.find((c) => c.symbolName === 'batchOrders');
      expect(batch).toBeDefined();
      expect(batch!.meta.method).toBe('POST');
      expect(batch!.meta.path).toBe('/rest/v1/orders/batch');

      // searchOrders → GET /rest/v1/orders/search (query not part of path)
      const search = consumers.find((c) => c.symbolName === 'searchOrders');
      expect(search).toBeDefined();
      expect(search!.meta.method).toBe('GET');
      expect(search!.meta.path).toBe('/rest/v1/orders/search');

      // createOrder → POST /rest/v1/orders
      const create = consumers.find((c) => c.symbolName === 'createOrder');
      expect(create).toBeDefined();
      expect(create!.meta.method).toBe('POST');
      expect(create!.meta.path).toBe('/rest/v1/orders');

      // Each method should produce exactly one consumer detection
      const consumerNames = consumers.map((c) => c.symbolName).sort();
      expect(consumerNames).toEqual(
        ['batchOrders', 'createOrder', 'getOrder', 'searchOrders'].sort(),
      );

      // No duplicate contract IDs — regression: first url must not pollute
      const ids = consumers.map((c) => c.contractId);
      expect(new Set(ids).size).toBe(ids.length);
      // MISSING_SERVICE_NAME is expected — no application.yaml
      expect(diagnostics.filter((d) => d.code !== 'MISSING_SERVICE_NAME').length).toBe(0);
    });

    /**
     * Method with url += conditional query-param append.
     * The initial declaration is resolved, query params are part of the URL.
     */
    it('resolves url with conditional query param append', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;

public class Client {
  private static final String PREFIX = "/rest/v1/items";
  private static final String SVC = "cse://item-service";
  private RestTemplate rt = RestTemplateBuilder.create();

  public String search(String q, String cat) {
    String url = SVC + PREFIX + "/search?q={q}";
    if (cat != null) {
      url += "&cat={cat}";
      return rt.getForObject(url, String.class, q, cat);
    }
    return rt.getForObject(url, String.class, q);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBeGreaterThanOrEqual(1);

      const searchCall = consumers.find((c) => c.symbolName === 'search');
      expect(searchCall).toBeDefined();
      // Path should not include query string
      expect(searchCall!.meta.path).toBe('/rest/v1/items/search');
      // Query template should contain both params
      expect(searchCall!.meta.queryTemplate).toContain('q={q}');
      expect(searchCall!.meta.queryTemplate).toContain('cat={cat}');
    });

    /**
     * Class-level static final constants should still be resolvable
     * across the entire file, even with method-local variables present.
     */
    it('class-level static final constants remain accessible', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'resources'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'resources', 'application.yaml'),
        'service_description:\n  name: test-service\n',
      );
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Controller.java'),
        `package com.acme;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(PREFIX)
public class Controller {
  private static final String PREFIX = "/rest/v2";
  @GetMapping("/items/{id}")
  public String get(@PathVariable String id) { return id; }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers.length).toBe(1);
      expect(providers[0].contractId).toBe('http::GET::/rest/v2/items/{param}');
    });

    /**
     * External constants (from microservice-rules.yaml) must still
     * resolve in method-local expressions.
     */
    it('external constants are accessible in method scope', async () => {
      // Create microservice-rules.yaml
      const rulesPath = path.join(tmpDir, '.gitnexus');
      fs.mkdirSync(rulesPath, { recursive: true });
      fs.writeFileSync(
        path.join(rulesPath, 'microservice-rules.yaml'),
        `version: 1
externalConstants:
  - className: com.acme.ExternalRoutes
    constants:
      PREFIX: /rest/ext/v1
`,
      );
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;

public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();

  public String get() {
    String url = "cse://ext-service" + com.acme.ExternalRoutes.PREFIX + "/items/{id}";
    return rt.getForObject(url, String.class, "1");
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].contractId).toBe('http::GET::/rest/ext/v1/items/{param}');
    });

    // ── Overloaded method resolution ──

    it('resolves overloaded methods independently (same name, different params)', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;

public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();

  public String get(String id) {
    String url = "cse://svc/by-id";
    return rt.getForObject(url, String.class, id);
  }

  public String get(long id) {
    String url = "cse://svc/by-number";
    return rt.getForObject(url, String.class, id);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(2);

      const byId = consumers.find((c) => c.meta.path === '/by-id');
      expect(byId).toBeDefined();
      expect(byId!.meta.serviceRef).toBe('svc');

      const byNumber = consumers.find((c) => c.meta.path === '/by-number');
      expect(byNumber).toBeDefined();
      expect(byNumber!.meta.serviceRef).toBe('svc');

      // Must not both resolve to the same path
      const ids = consumers.map((c) => c.contractId);
      expect(new Set(ids).size).toBe(2);
    });

    it('overloaded methods have distinct symbolUids', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Svc.java'),
        `package com.acme;
import org.springframework.web.client.*;

public class Svc {
  private RestTemplate rt = RestTemplateBuilder.create();

  public String find(String name) {
    String url = "cse://svc/find-by-name";
    return rt.getForObject(url, String.class, name);
  }

  public String find(long id) {
    String url = "cse://svc/find-by-id";
    return rt.getForObject(url, String.class, id);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const consumers = contracts.filter((c) => c.role === 'consumer');
      const uids = consumers.map((c) => c.symbolUid);
      expect(new Set(uids).size).toBe(2);
    });

    // ── Block scoping ──

    it('sibling blocks resolve their own String url independently', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Branch.java'),
        `package com.acme;
import org.springframework.web.client.*;

public class Branch {
  private RestTemplate rt = RestTemplateBuilder.create();

  public String pick(boolean flag) {
    if (flag) {
      String url = "cse://svc/left";
      return rt.getForObject(url, String.class);
    } else {
      String url = "cse://svc/right";
      return rt.getForObject(url, String.class);
    }
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(2);

      const left = consumers.find((c) => c.meta.path === '/left');
      expect(left).toBeDefined();

      const right = consumers.find((c) => c.meta.path === '/right');
      expect(right).toBeDefined();
    });

    it('field shadowed by if-block local variable resolves correctly', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Shadow.java'),
        `package com.acme;
import org.springframework.web.client.*;

public class Shadow {
  private static final String URL = "cse://svc/outer";
  private RestTemplate rt = RestTemplateBuilder.create();

  public String test(boolean flag) {
    if (flag) {
      String URL = "cse://svc/inner";
      rt.getForObject(URL, String.class);
    }
    rt.getForObject(URL, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const consumers = contracts.filter((c) => c.role === 'consumer');
      // Branch-internal call resolves to /inner (local shadows field)
      const inner = consumers.find((c) => c.meta.path === '/inner');
      expect(inner).toBeDefined();
      expect(inner!.meta.serviceRef).toBe('svc');

      // Branch-external call resolves to /outer (field binding restored)
      const outer = consumers.find((c) => c.meta.path === '/outer');
      expect(outer).toBeDefined();
      expect(outer!.meta.serviceRef).toBe('svc');

      expect(consumers.length).toBe(2);
    });

    // ── Declaration order ──

    it('variable declared after call site is not visible for that call', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Ordered.java'),
        `package com.acme;
import org.springframework.web.client.*;

public class Ordered {
  private RestTemplate rt = RestTemplateBuilder.create();

  public String test() {
    // url2 is not declared yet at this point — but the literal works
    String url1 = "cse://svc/first";
    // url2 is not declared yet, so it should NOT resolve
    String result = rt.getForObject(url1, String.class);
    String url2 = "cse://svc/second";
    return result;
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);

      const consumers = contracts.filter((c) => c.role === 'consumer');
      // Only url1 call should be found (url2 is after the call)
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/first');
    });

    // ── P1-1: block scope and shadowing ──

    it('P1-1A: field shadowed by standalone-block local', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private static final String URL = "cse://svc/outer";
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() {
    {
      String URL = "cse://svc/inner";
      rt.getForObject(URL, String.class);
    }
    rt.getForObject(URL, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(2);
      const inner = consumers.find((c) => c.meta.path === '/inner');
      expect(inner).toBeDefined();
      expect(inner!.meta.serviceRef).toBe('svc');
      const outer = consumers.find((c) => c.meta.path === '/outer');
      expect(outer).toBeDefined();
      expect(outer!.meta.serviceRef).toBe('svc');
    });

    it('P1-1C: outer local reassigned inside block retains value after block exit', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() {
    String url = "cse://svc/a";
    {
      url = "cse://svc/b";
    }
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/b');
      expect(consumers[0].meta.serviceRef).toBe('svc');
    });

    it('P1-1D: branch-internal declaration does not escape to merge point', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private static final String URL = "cse://svc/field";
  private RestTemplate rt = RestTemplateBuilder.create();
  void test(boolean flag) {
    if (flag) {
      String localUrl = "cse://svc/branch";
      rt.getForObject(localUrl, String.class);
    }
    rt.getForObject(URL, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(2);
      const branchCall = consumers.find((c) => c.meta.path === '/branch');
      expect(branchCall).toBeDefined();
      const fieldCall = consumers.find((c) => c.meta.path === '/field');
      expect(fieldCall).toBeDefined();
    });

    it('P1-1E: different methods keep same-name locals isolated', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  public String a() {
    String url = "cse://svc/path-a";
    return rt.getForObject(url, String.class);
  }
  public String b() {
    String url = "cse://svc/path-b";
    return rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(2);
      const a = consumers.find((c) => c.symbolName === 'a');
      expect(a!.meta.path).toBe('/path-a');
      const b = consumers.find((c) => c.symbolName === 'b');
      expect(b!.meta.path).toBe('/path-b');
    });

    // ── P1-2: braceless control flow ──

    it('P1-2A: braceless if modifying URL, call after → Unknown, no consumer', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test(boolean flag) {
    String url = "cse://svc/a";
    if (flag)
      url = "cse://svc/b";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(0);
    });

    it('P1-2B: braceless if/else different values → Unknown', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test(boolean flag) {
    String url;
    if (flag)
      url = "cse://svc/x";
    else
      url = "cse://svc/y";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(0);
    });

    it('P1-2C: braceless if/else same value → resolves correctly', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test(boolean flag) {
    String url;
    if (flag)
      url = "cse://svc/same";
    else
      url = "cse://svc/same";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/same');
      expect(consumers[0].meta.serviceRef).toBe('svc');
    });

    it('P1-2D: braceless else-if branches use own values, no sibling pollution', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test(int x) {
    if (x == 1)
      rt.getForObject("cse://svc/one", String.class);
    else if (x == 2)
      rt.getForObject("cse://svc/two", String.class);
    else
      rt.getForObject("cse://svc/other", String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(3);
      const paths = consumers.map((c) => c.meta.path).sort();
      expect(paths).toEqual(['/one', '/other', '/two']);
    });

    it('P1-2E: braceless while modifying URL → no consumer after loop', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test(boolean flag) {
    String url = "cse://svc/a";
    while (flag)
      url = "cse://svc/b";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(0);
    });

    it('P1-2F: call site inside braceless if branch uses correct state', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  String test(boolean flag) {
    String url = "cse://svc/a";
    if (flag)
      return rt.getForObject(url, String.class);
    return rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      // Both calls resolve to /a. Same method, same URL → deduped to 1 contract.
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/a');
      expect(consumers[0].meta.serviceRef).toBe('svc');
    });

    // ── P1-3: assignment operator detection ──

    it('P1-3A: url = "/x+=y" must not generate consumer', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() {
    String url = "cse://svc";
    url = "/x+=y";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(0);
    });

    it('P1-3B: url = "cse://svc/new?token=+=" parses correctly without old-value concat', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() {
    String url = "cse://svc/old";
    url = "cse://svc/new?token=+=";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/new');
      expect(consumers[0].meta.queryTemplate).toBe('token=+=');
      expect(consumers[0].meta.serviceRef).toBe('svc');
    });

    it('P1-3C: url += "&token=+=" correctly concatenates', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() {
    String url = "cse://svc/search?q={q}";
    url += "&token=+=";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/search');
      expect(consumers[0].meta.queryTemplate).toContain('q={q}');
      expect(consumers[0].meta.queryTemplate).toContain('token=+=');
    });

    it('P1-3D: RHS containing -=, *=, /= with plain = must not trigger compound detection', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() {
    String url = "cse://svc/old";
    url = "/path-=a";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      // url = "/path-=a" is not a CSE URL (no cse:// prefix) → no consumer
      expect(consumers.length).toBe(0);
    });

    it('P1-3E: real -=, *=, /= set state to Unknown', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() {
    String url = "cse://svc/prefix";
    url -= "suffix";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      // After -=, state is Unknown → no consumer
      expect(consumers.length).toBe(0);
    });

    // ── Additional regression tests ──

    it('straight reassignment: url=a; url=b; call(url) → /b', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() {
    String url = "cse://svc/a";
    url = "cse://svc/b";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/b');
    });

    it('dynamic assignment overwrites constant → no consumer', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  String buildUrl() { return "cse://svc/dyn"; }
  void test() {
    String url = "cse://svc/a";
    url = buildUrl();
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(0);
    });

    it('braced if with different branches → Unknown', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test(boolean flag) {
    String url = "cse://svc/a";
    if (flag) {
      url = "cse://svc/b";
    } else {
      url = "cse://svc/c";
    }
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(0);
    });

    it('both branches same const → continues resolving', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test(boolean flag) {
    String url = "cse://svc/a";
    if (flag) {
      url = "cse://svc/same";
    } else {
      url = "cse://svc/same";
    }
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/same');
    });

    // ── P1 fix verification: shadowing, same-line, import priority ──

    it('P1-fix-1: local variable shadows class field in binary RHS', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private static final String PREFIX = "cse://svc/class";
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() {
    String PREFIX = "cse://svc/local";
    String url = PREFIX + "/x";
    rt.getForObject(url, String.class);
  }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/local/x');
      expect(consumers[0].meta.serviceRef).toBe('svc');
      // Negative: must NOT produce /class/x
      expect(consumers[0].meta.path).not.toContain('/class/');
    });

    it('P1-fix-2a: same-line local declaration and RestTemplate call', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private static final String URL = "cse://svc/field";
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() { String URL = "cse://svc/local"; rt.getForObject(URL, String.class); }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/local');
      expect(consumers[0].meta.serviceRef).toBe('svc');
    });

    it('P1-fix-2b: same-line decl, reassign, call uses last value', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() { String url="cse://svc/a"; url="cse://svc/b"; rt.getForObject(url, String.class); }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(1);
      expect(consumers[0].meta.path).toBe('/b');
    });

    it('P1-fix-2c: same-line two RestTemplate calls with different URLs', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme', 'Client.java'),
        `package com.acme;
import org.springframework.web.client.*;
public class Client {
  private RestTemplate rt = RestTemplateBuilder.create();
  void test() { rt.getForObject("cse://svc/alpha", String.class); rt.getForObject("cse://svc/beta", String.class); }
}`,
      );
      const { context } = makeContext();
      const extractor = new CseLinkExtractor(context);
      const repo = makeRepo(tmpDir);
      const contracts = await extractor.extract(null, tmpDir, repo);
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.length).toBe(2);
      const paths = consumers.map((c) => c.meta.path).sort();
      expect(paths).toEqual(['/alpha', '/beta']);
    });
  });
});
