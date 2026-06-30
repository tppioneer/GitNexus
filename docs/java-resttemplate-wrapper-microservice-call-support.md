# Java RestTemplate CSE Microservice Call Association Design

> Status: draft
>
> Scope: Java Spring services where inter-service HTTP calls are made through `org.springframework.web.client.RestTemplate` instances created by a platform-provided `RestTemplateBuilder.create()` factory instead of standard Feign clients.

---

## Summary

Some Java microservice repositories do not use standard OpenFeign declarations for service-to-service calls. Instead, a platform layer provides a `RestTemplateBuilder.create()` factory whose return value is the standard Spring `org.springframework.web.client.RestTemplate` class. Call sites then use normal RestTemplate methods such as `getForEntity(...)`, `getForObject(...)`, `postForEntity(...)`, and `exchange(...)`.

The URL argument is usually a class-level constant, sometimes a shared constants-class member. Some GET calls use route placeholders such as `{id}` and pass replacement parameters separately.

To associate caller and callee services accurately, GitNexus should model this as a Java RestTemplate consumer extraction problem:

```text
RestTemplate call
  -> resolve URL constant
  -> normalize method + service reference + path template
  -> match against Spring provider routes
  -> produce group-level consumer/provider contracts
```

This should be separate from Feign support. Feign is declarative; this wrapper style is imperative runtime HTTP code.

---

## Context

Current microservice calls may look like this:

```java
private static final String DELETE_BATCH_URL =
    "cse://demo-service/rest/v1/protected/batch/delete-batch?batch_id=%s";

public BatchResult deleteBatch(String batchId) {
    return RestTemplateBuilder.create().exchange(
        DELETE_BATCH_URL,
        HttpMethod.POST,
        requestEntity,
        BatchResult.class
    );
}
```

Or:

```java
private final RestTemplate client = RestTemplateBuilder.create();

public ResponseEntity<EnvDTO> getEnv(String id) {
    return client.getForEntity(EnvUrls.ENV_DETAIL_URL, EnvDTO.class, id);
}
```

The provider service may define:

```java
@RestController
@RequestMapping("/rest/v1/protected")
public class BatchController {
    @PostMapping("/batch/delete-batch")
    public BatchResult deleteBatch(@RequestParam("batch_id") String batchId) {
        ...
    }
}
```

The expected association is:

```text
caller deleteBatch()
  --HTTP POST cse://demo-service/rest/v1/protected/batch/delete-batch?batch_id=%s-->
provider POST /rest/v1/protected/batch/delete-batch
```

---

## Goals

- Detect Java HTTP calls made through standard Spring `RestTemplate` APIs when the instance is produced by `RestTemplateBuilder.create()`.
- Resolve URL arguments when they are string literals, class constants, or shared constants-class fields.
- Preserve route placeholders such as `{id}` and `%s` as path templates instead of requiring runtime values.
- Extract HTTP method from RestTemplate method names or `HttpMethod.X` arguments.
- Split resolved URLs into:
  - raw URL
  - service reference / host
  - normalized path template
  - HTTP method
  - confidence
- Match caller contracts to Spring provider routes across repositories.
- Keep the implementation conservative: prefer high-confidence matches and explicit configuration over broad guessing.

## Non-Goals

- Full Java expression evaluation.
- Runtime Spring bean resolution.
- Arbitrary `UriComponentsBuilder` reconstruction in the first phase.
- Resolving every `@Value("${...}")` configuration reference in the first phase.
- Treating this as Feign support.
- Requiring access to proprietary internal source code during open-environment development.

---

## Supported Call Shapes

### Phase 1: Required

#### Inline factory call with direct string literal

```java
RestTemplateBuilder.create().getForEntity("cse://demo-service/path/{id}", EnvDTO.class, id);
```

#### Same-class string constant

```java
private static final String ENV_URL = "cse://demo-service/path/{id}";

RestTemplateBuilder.create().getForEntity(ENV_URL, EnvDTO.class, id);
```

#### Shared constants-class field

```java
RestTemplateBuilder.create().getForEntity(EnvUrlConstants.ENV_URL, EnvDTO.class, id);
```

#### Exchange with explicit method

```java
RestTemplateBuilder.create().exchange(ENV_URL, HttpMethod.POST, requestEntity, Resp.class);
```

#### Exchange with static-imported or bare HTTP method

```java
import static org.springframework.http.HttpMethod.POST;

RestTemplateBuilder.create().exchange(ENV_URL, POST, requestEntity, Resp.class);
```

#### RestTemplate alias from factory return

```java
RestTemplate client = RestTemplateBuilder.create();
client.getForEntity(ENV_URL, EnvDTO.class, id);
```

#### Simple string concatenation

```java
private static final String ENV_ROOT = "cse://app:demo-service/rest/v1";
private static final String ENV_URL = ENV_ROOT + "/gde-envs/{id}";
```

#### Member field alias

```java
private final RestTemplate client = RestTemplateBuilder.create();
client.exchange(ENV_URL, HttpMethod.DELETE, entity, Resp.class);
```

#### Local variable URL

```java
String url = "cse://demo-service/path?id={id}";
RestTemplateBuilder.create().getForEntity(url, Resp.class, id);
```

#### Interface constants

```java
interface EnvUrls {
    String ENV_URL = "cse://demo-service/path/{id}";
}

RestTemplateBuilder.create().getForEntity(EnvUrls.ENV_URL, Resp.class, id);
```

#### URI.create(...)

```java
RestTemplateBuilder.create().exchange(URI.create(DELETE_URL), HttpMethod.POST, entity, Resp.class);
```

#### URI returned by a local helper

```java
private URI buildRealUri(String url) {
    return URI.create(url);
}

RestTemplateBuilder.create().exchange(buildRealUri(DELETE_URL), HttpMethod.POST, entity, Resp.class);
```

### Phase 2: Recommended

#### Deeper URI helper chains

```java
private URI buildRealUri(String url) {
    return someSharedUriFactory.wrap(url);
}
```

### Phase 3: Deferred

```java
@Value("${env.service.url}")
private String envServiceUrl;

String.format("%s/gde-envs/%s", envServiceUrl, id);
UriComponentsBuilder.fromHttpUrl(envServiceUrl).path("/gde-envs/{id}");
```

---

## Proposed Architecture

### 0. Development and Validation Constraints

This feature is designed for a split environment:

- Development happens in the open GitNexus workspace using synthetic/de-identified fixtures.
- Validation against real company code happens later in an internal network where proprietary source cannot be shared back.
- Missing internal rules should be discovered through diagnostics and configuration updates, not by requiring source-code access in the open environment.

Therefore, the implementation should be:

- configuration-driven for internal SDK names and external constants
- diagnostic-rich for unsupported or unresolved patterns
- conservative by default: unresolved inputs do not produce authoritative contracts
- covered by synthetic fixtures that mimic the target shapes without exposing proprietary code

Internal-network validation should feed back only de-identified signals such as:

```text
[java-rest-template] unresolved external constant: com.company.sdk.RoutePrefix.REST
[java-rest-template] unsupported dynamic service URL: cse://%s/path
[java-rest-template] unresolved URI helper: buildRealUri(...)
[group-http-match] matched consumer=... service=demo-service method=POST path=/rest/v1/protected/batch
```

These diagnostics should be enough to improve configuration or add generic extractor support without exposing company code.

### 0.1 Low-Intrusion Patch Strategy

This is a customization on top of an open-source project, so the implementation should minimize merge/rebase friction when upgrading GitNexus.

Guidelines:

- Prefer additive modules over modifying large shared files.
- Keep CSE-specific behavior behind configuration and Java-specific extractor hooks.
- Reuse existing group HTTP contract types and Spring route primitives where possible.
- Avoid changing public graph schema unless absolutely necessary.
- Avoid broad changes to existing RestTemplate/WebClient/Feign behavior.
- Keep diagnostics opt-in or development-gated to avoid noisy default indexing.
- Put synthetic fixtures and tests close to existing Java HTTP/group extractor tests.

Suggested module boundaries:

```text
gitnexus/src/core/group/extractors/http-patterns/java-cse-rules.ts
  - rule schema/types/defaults for CSE RestTemplate support

gitnexus/src/core/group/extractors/http-patterns/java-cse-url.ts
  - cse:// parser
  - path-template normalization

gitnexus/src/core/group/extractors/http-patterns/java-constant-resolver.ts
  - local/imported/external constant resolution
  - simple concatenation

gitnexus/src/core/group/extractors/http-patterns/java-resttemplate-cse.ts
  - RestTemplateBuilder.create() consumer extraction
  - URI.create(...) and simple helper support
```

Existing files should ideally only receive narrow integration points, for example:

```text
java.ts
  - imports CSE helper modules
  - appends extracted consumer/provider contracts
```

This keeps the custom patch easy to isolate, review, and reapply onto newer upstream GitNexus versions.

### 1. Java RestTemplate Consumer Extractor

Add a Java-specific extractor that recognizes RestTemplate method calls from:

- inline factory chains: `RestTemplateBuilder.create().getForEntity(...)`
- local variable aliases: `RestTemplate client = RestTemplateBuilder.create(); client.getForEntity(...)`
- member field aliases: `private final RestTemplate client = RestTemplateBuilder.create(); client.exchange(...)`
- member access calls: `this.client.getForEntity(...)` when `client` is known to come from `RestTemplateBuilder.create()`

The first implementation should treat the project-imported internal SDK `RestTemplateBuilder.create()` as the primary source of trusted RestTemplate instances. The exact internal SDK package does not need to be hardcoded into the design; repository configuration can identify the trusted factory name. The target projects are expected to use this internal SDK builder rather than the open-source Spring Boot `RestTemplateBuilder`.

The returned object should be treated as a standard `org.springframework.web.client.RestTemplate`, so extraction should use standard Spring RestTemplate method semantics:

```yaml
javaHttpClients:
  - name: spring-rest-template-from-builder
    language: java

    factories:
      - type: RestTemplateBuilder
        methods: [create]
        returns: org.springframework.web.client.RestTemplate

    calls:
      - method: getForObject
        urlArgIndex: 0
        httpMethod: GET
      - method: getForEntity
        urlArgIndex: 0
        httpMethod: GET
      - method: postForObject
        urlArgIndex: 0
        httpMethod: POST
      - method: postForEntity
        urlArgIndex: 0
        httpMethod: POST
      - method: put
        urlArgIndex: 0
        httpMethod: PUT
      - method: delete
        urlArgIndex: 0
        httpMethod: DELETE
      - method: patchForObject
        urlArgIndex: 0
        httpMethod: PATCH
      - method: exchange
        urlArgIndex: 0
        httpMethodArgIndex: 1
        supportedSignatures:
          - "exchange(String url, HttpMethod method, ...)"
          - "exchange(URI url, HttpMethod method, ...)"
        httpMethodPatterns:
          - "HttpMethod.{method}"
          - "RequestMethod.{method}"
          - "{method}"
        defaultHttpMethod: UNKNOWN
```

Configured wrappers such as `query(...)` should be treated as extensions. The built-in default path should prefer Spring's stable RestTemplate API.

### 1.1 Configurable Extraction Rules

The wrapper matching rules should be configuration-driven. Platform HTTP wrappers often change faster than GitNexus releases, and different organizations may use different factory names, method names, and argument orders.

The configuration should describe *what* should be recognized:

- wrapper/factory class names
- factory method names
- HTTP call method names
- URL argument positions
- HTTP method inference rules
- supported URL schemes such as `cse://`
- service-name discovery files and keys

The implementation should still own *how* parsing and matching works:

- Java AST traversal
- constant resolution
- URL parsing
- path-template normalization
- route matching
- confidence scoring
- graph edge and contract creation

This keeps configuration expressive enough for platform-specific wrappers without turning it into a scripting language.

Example rule file:

```yaml
extendsDefaults: true

javaHttpClients:
  - name: cse-resttemplate-wrapper
    language: java

    factories:
      - type: RestTemplateBuilder
        methods: [create]
        returns: org.springframework.web.client.RestTemplate

    calls:
      - method: getForEntity
        urlArgIndex: 0
        httpMethod: GET

      - method: exchange
        urlArgIndex: 0
        httpMethodArgIndex: 1
        httpMethodPatterns:
          - "HttpMethod.{method}"
          - "RequestMethod.{method}"
          - "{method}"
        defaultHttpMethod: UNKNOWN

    urlSchemes:
      - scheme: cse
        parser: cseAuthority
        serviceFrom: serviceName
        appIdFrom: optionalPrefix
        pathFrom: pathname
        ignoreQueryForRouteMatch: true

    constants:
      enabled: true
      sameClass: true
      qualifiedClassField: true
      simpleConcat: true
      interfaceConstants: true
      localVariables: true

    externalConstants:
      - className: com.company.sdk.RoutePrefix
        constants:
          REST: /rest
          WEB: /web
          OPEN_API: /openapi
          INTERNAL: /internal

    serviceDiscovery:
      serviceNameFiles:
        preferred:
          - code/webapp/src/main/resources/application.yaml
          - code/webapp/src/main/resources/application.yml
          - code/webapp/src/main/resources/application.properties
        fallbackGlobs:
          - code/**/application.yaml
          - code/**/application.yml
          - code/**/application.properties
          - code/**/bootstrap.yaml
          - code/**/bootstrap.yml
          - code/**/bootstrap.properties
      keys:
        - service_description.name
```

Recommended rule loading order:

```text
built-in defaults
  + repository .gitnexus/microservice-rules.yaml
  + optional CLI-provided rules file
```

Repository rules should be able to extend defaults or replace them:

```yaml
extendsDefaults: true
```

The default should be `true` so adding a project-specific CSE wrapper rule does not accidentally disable built-in support for standard `RestTemplate`, `WebClient`, or Feign-style extractors.

Suggested repo-local file:

```text
.gitnexus/microservice-rules.yaml
```

### 2. URL Constant Resolver

Build a lightweight per-repository URL constant table.

Supported entries:

```java
private static final String ENV_URL = "...";
public static final String ENV_URL = "...";
static final String ENV_URL = "...";
String localUrl = "...";
interface Urls { String ENV_URL = "..."; }
```

Resolution keys:

```text
same file:
  ENV_URL -> "http://env-service/gde-envs/{id}"

qualified:
  EnvUrlConstants.ENV_URL -> "http://env-service/gde-envs/{id}"
```

The expected distribution is:

- `private static final` constants: approximately 70%.
- `public static final` constants: approximately 25%.
- local variables and interface constants: lower volume, but worth supporting in the first implementation when they resolve to string literals.

The first phase should support string literals, direct constant references, and conservative simple string concatenation.

Supported Phase 1 concatenation:

```java
private static final String ROOT = "cse://app:demo-service/rest/v1";
private static final String DELETE_URL = ROOT + "/protected/batch/delete-batch";
private static final String GET_URL = "cse://app:demo-service" + "/path/{id}";
```

Deferred concatenation:

```java
String url = baseUrl + runtimePath;
String url = buildBaseUrl() + "/path";
String url = prefixFromConfig + "/path";
```

Qualified constants should be resolved conservatively. Phase 1 lookup priority:

1. same-file class/interface constants
2. imported class simple name, for example `import com.foo.EnvUrls; EnvUrls.GET_ENV`
3. same-package class simple name
4. configured external SDK constants
5. ambiguous references are diagnostics only and should not produce authoritative contracts

External SDK constants are required when route prefixes are defined outside the indexed repository, for example in an internal second-party SDK:

```java
import com.company.sdk.RoutePrefix;

@RequestMapping(RoutePrefix.REST + "/v1/protected")
```

Configuration:

```yaml
externalConstants:
  - className: com.company.sdk.RoutePrefix
    constants:
      REST: /rest
      WEB: /web
      OPEN_API: /openapi
      INTERNAL: /internal
```

Both imported simple names and fully qualified references should be supported:

```java
@RequestMapping(RoutePrefix.REST + "/v1/protected")
@RequestMapping(com.company.sdk.RoutePrefix.REST + "/v1/protected")
```

External constants should be explicit configuration, not inferred from class or constant names. If an external SDK constant is not configured, GitNexus should emit a diagnostic and skip authoritative contract creation for that unresolved route. This makes the feature safe to run with an incomplete constant table: missing configuration reduces recall but should not reduce precision.

URI values should be resolved when they directly wrap a resolvable URL:

```java
URI.create(DELETE_URL)
URI.create("cse://app:demo-service/path")
buildRealUri(DELETE_URL) // when buildRealUri is a same-class helper that returns URI.create(arg)
```

Arbitrary URI factories, `new URI(...)`, and `UriComponentsBuilder` remain deferred.

The same conservative constant resolver should be reused for provider-side Spring route annotations. In the target repositories, class-level `@RequestMapping` commonly uses a constant for the first path segment after the CSE service name, such as `/web` or `/rest`, followed by hardcoded version/access segments:

```java
private static final String REST_PREFIX = "/rest";

@RequestMapping(REST_PREFIX + "/v1/protected")
public class BatchController {
    @PostMapping("/batch")
    public BatchResult batch(...) {
        ...
    }
}
```

Expected provider route:

```text
POST /rest/v1/protected/batch
```

### 3. URL Normalization

Resolve the URL argument into a normalized consumer contract:

```ts
interface JavaHttpConsumerContract {
  filePath: string;
  lineNumber: number;
  framework: 'spring-rest-template-cse';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'UNKNOWN';
  rawUrl: string;
  scheme?: string;
  serviceRef?: string;
  pathTemplate: string;
  queryTemplate?: string;
  queryParamNames?: string[];
  source:
    | 'literal'
    | 'same-class-constant'
    | 'qualified-constant'
    | 'interface-constant'
    | 'local-variable'
    | 'simple-concat'
    | 'uri-create'
    | 'local-uri-helper'
    | 'unresolved';
  confidence: 'high' | 'medium' | 'low';
}
```

Examples:

```text
http://env-service/gde-envs/{id}
  -> serviceRef = env-service
  -> pathTemplate = /gde-envs/{param}
  -> confidence = high

/gde-envs/{id}
  -> serviceRef = undefined
  -> pathTemplate = /gde-envs/{param}
  -> confidence = medium for same-repo, low for cross-repo
```

### 3.1 CSE URL Scheme Support

CSE service discovery URLs should be treated as first-class service references:

```text
cse://<service-name>/<route-path>?<query-template>
```

Example:

```text
cse://demo-service/rest/v1/protected/batch/delete-batch?batch_id=%s
```

Normalized form:

```text
scheme = cse
serviceRef = demo-service
pathTemplate = /rest/v1/protected/batch/delete-batch
queryTemplate = batch_id=%s
queryParamNames = [batch_id]
```

The query string should be retained for display and possible future `@RequestParam` checks, but it should not participate in route path matching. Provider controllers generally expose query parameters separately from route mappings.

For CSE URLs, `serviceRef` should be considered high-confidence because the URL host is the logical service name rather than a generic network host.

Supported CSE URL variants:

```text
cse://demo-service/path/{id}
cse://demo-service/path?id={id}
cse://demo-service/%s/path
cse://demo-service/rest/v1/%s/delete
```

Normalization rules:

- `cse://<service-name>/<path>` and `cse://<app-id>:<service-name>/<path>` are both valid.
- When an `app-id:` prefix is present, it is retained for diagnostics but does not participate in matching.
- `serviceRef` is the service-name part after `:` when present, otherwise the whole authority segment.
- `{name}` in the path becomes `{param}` for matching.
- `%s` in the path becomes `{param}` for matching.
- `{name}` or `%s` in the query is retained in `queryTemplate` but ignored for route path matching.
- Path segments should not be aggressively URL-decoded. `%s` is a special placeholder token, not percent-encoded data.
- Query parameter names may be URL-decoded for display/diagnostics. Query parameter values do not participate in route matching.
- Dynamic service names such as `cse://%s/path` are unsupported in Phase 1 and should be filtered out or emitted only as diagnostics.
- CSE URLs with ports are out of scope for the first implementation because the observed service references do not include ports.

Examples:

```text
cse://demo-service/rest/v1/%s/delete
  -> serviceRef = demo-service
  -> pathTemplate = /rest/v1/{param}/delete

cse://app-id:demo-service/rest/v1/delete
  -> appId = app-id
  -> serviceRef = demo-service
  -> pathTemplate = /rest/v1/delete

cse://demo-service/path?id={id}
  -> serviceRef = demo-service
  -> pathTemplate = /path
  -> queryTemplate = id={id}
  -> queryParamNames = [id]
```

### 4. Provider Route Matching

Provider routes already come from Spring annotations:

```java
@RequestMapping("/gde-envs")
@GetMapping("/{id}")
```

Provider normalized route:

```text
method = GET
pathTemplate = /gde-envs/{param}
```

Path matching should treat placeholder segment names as equivalent:

```text
/gde-envs/{id}
/gde-envs/{envId}
/gde-envs/:id
```

All three should match the same template shape:

```text
/gde-envs/{param}
```

Provider annotation coverage should reflect the observed distribution:

- `@RequestMapping`: approximately 42.5%, confirmed class-level only for the target repositories.
- `@PostMapping`: approximately 29.3%.
- `@GetMapping`: approximately 18%.
- `@DeleteMapping`: approximately 6%.
- `@PutMapping`: approximately 3.5%.

Because `@RequestMapping` is confirmed class-level only in the target repositories, Phase 1 should treat it as a class/interface prefix. Method-level provider routes should come from `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, and `@PatchMapping`.

Class-level `@RequestMapping` prefix extraction must support:

- string literals
- same-class constants
- qualified constants
- interface constants
- simple concatenation of literals and resolved constants
- configured external SDK constants

This mirrors consumer URL resolution and is required because `/web` and `/rest` prefixes are commonly constants while version/access segments such as `/v1/access` are hardcoded string suffixes.

### 4.1 Path Join and Normalization

Provider and consumer paths should be normalized before matching.

Rules:

1. Trim surrounding whitespace.
2. Treat missing prefix or method path as an empty string.
3. Strip query string and fragment before route matching.
4. Join class-level prefix and method-level path with exactly one `/`.
5. Collapse repeated slashes inside the path.
6. Ensure the normalized path starts with `/`.
7. Remove trailing slash except for root `/`.
8. Normalize path parameters:
   - `{name}` -> `{param}`
   - `:name` -> `{param}`
   - `%s` -> `{param}`
9. Do not aggressively URL-decode path segments. `%s` is a special placeholder token, not percent-encoded data.

Examples:

```text
"/rest/v1/" + "/batch"      -> /rest/v1/batch
"/rest/v1"  + "batch"       -> /rest/v1/batch
"/rest/v1//" + "//batch/"   -> /rest/v1/batch
""           + "/batch"      -> /batch
"/rest"     + ""            -> /rest
"/envs/{id}"                 -> /envs/{param}
"/envs/:id"                  -> /envs/{param}
"/envs/%s"                   -> /envs/{param}
```

Trailing slash should not affect route matching:

```text
/rest/v1/batch
/rest/v1/batch/
```

Both normalize to:

```text
/rest/v1/batch
```

### 5. Service Mapping

For cross-repo matching, `serviceRef` must map to a provider repository/service.

Suggested priority:

1. Explicit `group.yaml` links or service aliases.
2. Provider `service_description.name` from `application.yml`, `application.yaml`, `bootstrap.yml`, `bootstrap.yaml`, or `.properties`.

No other service-name keys are required for the first implementation. Repository name, Maven `artifactId`, Gradle project name, and URL host fallback should not produce authoritative cross-repo matches. They may be logged as diagnostics only.

### 5.1 CSE Service Name Discovery

When matching `serviceRef` to a provider repository, GitNexus should discover service names from Spring configuration files.

Preferred lookup paths:

```text
code/webapp/src/main/resources/application.yaml
code/webapp/src/main/resources/application.yml
code/webapp/src/main/resources/application.properties
```

If no preferred file exists, fall back to recursive search under `code/`:

```text
code/**/application.yaml
code/**/application.yml
code/**/application.properties
code/**/bootstrap.yaml
code/**/bootstrap.yml
code/**/bootstrap.properties
```

Supported keys:

```yaml
service_description:
  name: demo-service-name
```

```properties
service_description.name=demo-service-name
```

Discovered aliases:

```text
demo-service-name -> provider repository/service
```

`service_description.name` is the authoritative service identity for the CSE matching scenario. `spring.application.name` is not required for this feature.

If multiple `service_description.name` values are discovered in one repository, the first implementation should use the preferred `code/webapp/src/main/resources` value when present. If ambiguity remains, it should report a diagnostic and skip authoritative cross-repo matching for that repository until module-level ownership is implemented.

---

## Matching Rules

### High Confidence

All are true:

- HTTP method matches or consumer method is known.
- Consumer has `serviceRef`.
- `serviceRef` maps to one provider service.
- Normalized path template matches provider route.

### Medium Confidence Diagnostics

Medium-confidence cases should be diagnostics only, not default group contract output.

Examples:

- HTTP method is `UNKNOWN`, but service and path match.
- URL is path-only and same-repo route matches.
- Service identity is ambiguous because multiple `service_description.name` values were discovered.

### Low Confidence

Examples:

- Path-only URL matched across repositories.
- Service reference only partially matches repository name.
- URL could not be fully resolved but a suffix path matched.

Medium-confidence, low-confidence, or unresolved matches should not be shown in default route/group contract results. They should be emitted only as diagnostics so users can inspect missing coverage without polluting authoritative impact data.

---

## Relationship to route_map

`route_map` currently displays graph `Route` nodes and `FETCHES` relationships. The first target for this feature should be accurate group-level HTTP contracts, because the primary requirement is microservice-to-microservice association across repositories.

Recommended staged behavior:

1. Cross-repo calls:
   - Emit group-level consumer/provider contracts using `serviceRef + method + pathTemplate`.
   - Match `cse://<service-name>/...` consumers to provider repositories through discovered service names such as `service_description.name`.
   - Use this as the first acceptance target.

2. Same-repo calls:
   - Emit `FETCHES` edges from caller file/symbol to matching `Route`.
   - `route_map` can display these without special cross-repo handling.

3. route_map/api_impact display:
   - Extend route and impact tools later to include cross-repo consumers when querying a group or provider service.

This keeps local route maps useful while letting the group layer handle true microservice topology.

---

## Implementation Plan

### Phase 1: Minimal Viable Support

- Recognize inline `RestTemplateBuilder.create().<RestTemplateMethod>(...)`.
- Recognize local/member aliases created by `RestTemplate client = RestTemplateBuilder.create()`.
- Recognize `client.<method>(...)` and `this.client.<method>(...)` when `client` is known to come from `RestTemplateBuilder.create()`.
- Support standard RestTemplate methods:
  - `getForObject`, `getForEntity` -> `GET`
  - `postForObject`, `postForEntity` -> `POST`
  - `put` -> `PUT`
  - `delete` -> `DELETE`
  - `patchForObject` -> `PATCH`
  - `exchange(url, HttpMethod.X, ...)` -> `X`
- Extract URL from argument index 0.
- Extract method from:
  - RestTemplate method name for shorthand methods
  - `exchange(..., HttpMethod.X, ...)`
  - `exchange(..., X, ...)` when `X` is a bare `GET`, `POST`, `PUT`, `DELETE`, or `PATCH` identifier
  - otherwise `UNKNOWN`
- Resolve:
  - direct string literal
  - same-class string constant
  - qualified constants-class string field
  - interface constants
  - local string literal variables
  - simple string concatenation of literals and resolved constants
  - configured external SDK constants
  - direct `URI.create(<resolved-url>)`
  - same-class URI helpers that directly return `URI.create(arg)`
- Normalize CSE URLs into `serviceRef`, `pathTemplate`, `queryTemplate`, and `queryParamNames`.
- Filter unsupported dynamic-service CSE URLs such as `cse://%s/path` from authoritative matching.
- Read provider service names from `service_description.name`.
- Extract provider routes from:
  - class-level `@RequestMapping` prefixes
  - method-level `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping`
- Resolve provider annotation paths from literals, constants, interface constants, qualified constants, and simple concatenation.
- Join class-level prefixes and method-level paths using the shared path normalization rules.
- Match `serviceRef + method + pathTemplate` against provider routes through group contracts.

### Phase 2: Better Coverage

- Support deeper alias chains beyond direct local/member assignments.
- Support configurable wrapper names and method metadata.
- Add configurable custom methods such as `query(...)` if platform code introduces a non-RestTemplate wrapper.

### Phase 3: Advanced Resolution

- Resolve selected `@Value("${...}")` property placeholders.
- Support selected `String.format(...)` patterns.
- Support common `UriComponentsBuilder` patterns.
- Add diagnostics for unresolved URL expressions.

---

## Diagnostics

The indexer should expose enough information to debug missing associations:

```text
[java-rest-template] matched call: file=..., method=exchange, urlExpr=DELETE_BATCH_URL
[java-rest-template] resolved constant: DELETE_BATCH_URL -> cse://demo-service/rest/v1/protected/batch/delete-batch?batch_id=%s
[java-rest-template] normalized: serviceRef=demo-service pathTemplate=/rest/v1/protected/batch/delete-batch method=POST query=batch_id=%s
[java-rest-template] unresolved URL expression: SomeFactory.url(...)
[group-http-match] serviceRef=demo-service matched repo=demo-provider route=POST /rest/v1/protected/batch/delete-batch
```

These logs should be gated behind a debug or development flag to avoid noisy normal indexing.

---

## Validation Scenarios

### Same-class constant

Input:

```java
private static final String URL = "cse://demo-service/gde-envs/{id}";
RestTemplateBuilder.create().getForEntity(URL, EnvDTO.class, id);
```

Expected:

```text
consumer: GET demo-service /gde-envs/{param}
```

### Constants class

Input:

```java
RestTemplateBuilder.create().getForEntity(EnvUrls.GET_ENV, EnvDTO.class, id);
```

Expected:

```text
EnvUrls.GET_ENV is resolved and matched to provider route.
```

### Exchange method

Input:

```java
RestTemplateBuilder.create().exchange(URL, HttpMethod.DELETE, entity, Resp.class);
```

Expected:

```text
consumer method = DELETE
```

### Placeholder equivalence

Consumer:

```text
/gde-envs/{id}
```

Provider:

```text
/gde-envs/{envId}
```

Expected:

```text
paths match after placeholder normalization.
```

### CSE path placeholder

Consumer:

```text
cse://demo-service/rest/v1/%s/delete
```

Provider:

```text
/rest/v1/{batchId}/delete
```

Expected:

```text
paths match as /rest/v1/{param}/delete.
```

### Query placeholder ignored for route matching

Consumer:

```text
cse://demo-service/path?id={id}
```

Provider:

```text
/path
```

Expected:

```text
route path matches; queryTemplate is retained as id={id}.
```
