# GitNexus Java 路由检测 + CSE 微服务调用关联方案

> 状态：草稿，待根据 CSE 代码示例补充 Part 2 细节

---

## 目录

- [背景](#背景)
- [Part 1: 修复 Java Spring Boot 路由检测](#part-1-修复-java-spring-boot-路由检测)
  - [当前数据流与断点](#当前数据流与断点)
  - [解决方案](#解决方案)
  - [修改文件清单](#修改文件清单)
  - [详细设计](#详细设计)
- [Part 2: CSE 微服务调用关联](#part-2-cse-微服务调用关联)
  - [当前跨仓关联机制](#当前跨仓关联机制)
  - [解决方案](#解决方案-1)
  - [修改文件清单](#修改文件清单-1)
  - [详细设计](#详细设计-1)
- [总体改动量估算](#总体改动量估算)
- [前置确认事项](#前置确认事项)
- [验证方案](#验证方案)

---

## 背景

当前 `route_map` 对 Java 项目返回空。根因是 `JAVA_QUERIES` 缺少注解捕获，Spring Boot 的 `@GetMapping`、`@PostMapping`、`@RequestMapping` 等注解在索引期完全不可见。

同时用户使用 CSE SDK 做微服务间调用（多仓库），需要支持微服务间的调用方↔被调用方关联。

---

## Part 1: 修复 Java Spring Boot 路由检测

### 当前数据流与断点

```
源码 → tree-sitter 解析 → JAVA_QUERIES 匹配 → parse-worker 判断 captureMap['decorator']
                                                            ↓
                                                     ROUTE_DECORATOR_NAMES 检查
                                                            ↓
                                                     ExtractedDecoratorRoute → Route 节点 → route_map
```

**断点**: `JAVA_QUERIES` 没有 `@decorator` 捕获，因此 `captureMap['decorator']` 永远为 `undefined`，路由提取的 if 块（`parse-worker.ts:1325`）永远不进入。

各语言 `tree-sitter-queries.ts` 中的装饰器/注解捕获对比：

| 语言 | 捕获模式 | 状态 |
|------|---------|------|
| TypeScript/JS (356-359行) | `(decorator ... (identifier) @decorator.name ...) @decorator` | ✅ |
| Python (718-724行) | `(decorator ... @decorator.receiver @decorator.name ...) @decorator` | ✅ |
| **Java (728-766行)** | **无注解捕获** | ❌ |

注意：Java 的 tree-sitter 节点类型是 `annotation`/`marker_annotation`（不是 `decorator`），且它们位于 `modifiers` 子节点下，结构不同。

### 解决方案

核心思路：在 `JAVA_QUERIES` 中添加 Java 注解的捕获模式，并在 `parse-worker.ts` 中添加对应的处理逻辑。同时将 `http-patterns/java.ts` 中已有的 Spring 路由扫描逻辑提取为共享模块，避免两边维护。

#### Java 注解的 tree-sitter AST 结构

```scheme
; 方法上的 @GetMapping("/users")
(method_declaration
  modifiers: (modifiers
    (annotation                    ;; ← Java 用 annotation，不是 decorator
      name: (identifier)           ;; → "GetMapping"
      arguments: (annotation_argument_list
        (string_literal)))))       ;; → "/users"

; 类上的 @RequestMapping("/api") — 前缀
(class_declaration
  modifiers: (modifiers
    (annotation
      name: (identifier)           ;; → "RequestMapping"
      arguments: (annotation_argument_list
        (string_literal)))))       ;; → "/api"
```

与 TypeScript 的 `decorator` 对比：
```scheme
; TypeScript: @Get('/users')
(decorator
  name: (identifier)               ;; → "Get"
  arguments: (arguments
    (string
      (string_fragment))))         ;; → "/users"
```

### 修改文件清单

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `gitnexus/src/core/ingestion/tree-sitter-queries.ts` | 修改 | 在 `JAVA_QUERIES` 末尾添加 `@annotation` 捕获模式 |
| 2 | `gitnexus/src/core/ingestion/workers/parse-worker.ts` | 修改 | 添加 `captureMap['annotation']` 处理，与 `@decorator` 处理并行 |
| 3 | `gitnexus/src/core/ingestion/route-extractors/spring.ts` | **新建** | 从 `http-patterns/java.ts` 提取 `scanRouteAnnotations()` 等核心逻辑，输出 `ExtractedDecoratorRoute[]` |
| 4 | `gitnexus/src/core/group/extractors/http-patterns/java.ts` | 修改 | 改为调用共享模块 `spring.ts`，删除本地的重复实现 |

### 详细设计

#### 1. `tree-sitter-queries.ts` — 添加 Java 注解捕获

在 `JAVA_QUERIES`（第 728-766 行）末尾添加以下查询模式：

```scheme
; ── Route annotations on methods ──────────────────────────────────────
; Spring @GetMapping("/path"), @PostMapping("/path"), @RequestMapping("/path") etc.
; Captures the annotation name and argument string so parse-worker can
; produce ExtractedDecoratorRoute entries.
(method_declaration
  modifiers: (modifiers
    (annotation
      name: (identifier) @annotation.name
      arguments: (annotation_argument_list
        (string_literal) @annotation.arg))) @annotation)

; ── Route prefix annotations on classes ───────────────────────────────
; Spring @RequestMapping("/api") on the controller class acts as a URL
; prefix for every method-level @(Get|Post|...)Mapping.
(class_declaration
  modifiers: (modifiers
    (annotation
      name: (identifier) @annotation.name
      arguments: (annotation_argument_list
        (string_literal) @annotation.arg))) @annotation)

; interface-level variants: @RequestMapping on a Feign interface or
; shared API interface
(interface_declaration
  modifiers: (modifiers
    (annotation
      name: (identifier) @annotation.name
      arguments: (annotation_argument_list
        (string_literal) @annotation.arg))) @annotation)
```

关于命名参数 `path = "/api"`：Java 注解支持 `@RequestMapping(path = "/api")` 命名参数形式，AST 中有 `element_value_pair` 节点。先支持字面量形式（覆盖率最高），命名参数形式后续迭代。

#### 2. `parse-worker.ts` — 添加 @annotation 处理

在 decorator 处理块（约第 1325 行）之后，添加平行的 annotation 处理：

```typescript
// Java annotation-based routes (Spring Boot)
// Java uses `annotation` / `marker_annotation` nodes inside `modifiers`,
// structurally different from TS `decorator` and Python `decorator`.
if (captureMap['annotation'] && captureMap['annotation.name']) {
  const annotationName = captureMap['annotation.name'].text;
  const annotationArg = captureMap['annotation.arg']?.text;

  if (ROUTE_DECORATOR_NAMES.has(annotationName)) {
    const routePath = annotationArg || '';
    const method = annotationName.replace('Mapping', '').toUpperCase();
    const httpMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)
      ? method
      : 'GET';
    result.decoratorRoutes.push({
      filePath: file.path,
      routePath,
      httpMethod,
      decoratorName: annotationName,
      lineNumber: captureMap['annotation'].startPosition.row + lineOffset,
    });
  }
  continue;
}
```

**class 级 prefix 传播**：上述处理只生成了独立的方法级路由（如 `/users`），缺少 class 级 `@RequestMapping("/api")` 的 prefix 拼接（完整路径应为 `/api/users`）。

有两种处理方式：
- **方式 A（推荐）**：在 parse-worker 中做两遍扫描——先收集 class 的 prefix，再处理 method 时拼接。将 `http-patterns/java.ts` 的 `scanRouteAnnotations()` 逻辑提取到 `route-extractors/spring.ts`，parse-worker 直接调用。
- **方式 B**：将 prefix 信息写入 `ExtractedDecoratorRoute.prefix` 字段，交给 `routes.ts` 的 `normalizeExtractedRoutePath()` 统一拼接。

推荐方式 A，因为它一次遍历完成且不依赖后续阶段。

#### 3. `route-extractors/spring.ts`（新建）— 共享的 Spring 路由提取器

从 `http-patterns/java.ts` 提取以下函数和常量到新文件：

| 从 `http-patterns/java.ts` 提取 | 说明 |
|--------------------------------|------|
| `METHOD_ANNOTATION_TO_HTTP` | 注解名→HTTP 方法映射 |
| `scanRouteAnnotations(tree)` | 一次遍历收集所有路由注解 |
| `joinPath(prefix, methodPath)` | 拼接 class prefix + method path |
| `unquoteLiteral(text)` | 去除字符串引号 |
| `isRouteMemberKey(keyNode)` | 过滤非路由注解参数 |
| `findEnclosingClass(node)` | 向上查找包裹 class |
| `findEnclosingInterface(node)` | 向上查找包裹 interface |
| `hasAnnotation(node, names)` | 检查节点是否有指定注解 |

新文件的对外接口：

```typescript
// route-extractors/spring.ts

import type Parser from 'tree-sitter';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';

/**
 * Extract Spring Boot route definitions from a parsed Java AST.
 * Handles class-level @RequestMapping prefix propagation to
 * method-level @GetMapping / @PostMapping / etc.
 *
 * @returns ExtractedDecoratorRoute[] ready for the routes pipeline phase.
 */
export function extractSpringRoutes(
  tree: Parser.Tree,
  filePath: string,
  lineOffset: number,
): ExtractedDecoratorRoute[];
```

注意：`http-patterns/java.ts` 目前包含 `scanRouteAnnotations()` 等私有函数约 180 行（第 36-568 行）。提取后：
- `spring.ts`：~300 行（含接口、类型定义、JSDoc）
- `http-patterns/java.ts`：删除本地实现，改为 `import { scanRouteAnnotations, joinPath, ... } from '../../../ingestion/route-extractors/spring.js'`，净减少约 50 行

#### 4. `http-patterns/java.ts` — 调用共享模块

`scanRouteAnnotations()` 的现有调用方在 `http-patterns/java.ts` 内部：

- `scan()` 函数（第 703 行）：`scanRouteAnnotations(tree)` → 用于 Spring provider + OpenFeign consumer
- `collectSpringTypes()` 函数（第 606 行）：`scanRouteAnnotations(tree)` → 用于跨文件接口继承

改为从 `spring.ts` 导入，保持调用方式不变。`spring.ts` 返回 `ExtractedDecoratorRoute[]`（供 ingress 层），`http-patterns` 需要的 `HttpDetection[]` 在上层转换。

---

## Part 2: CSE 微服务调用关联

### 当前跨仓关联机制

GitNexus 有两层消费者关联：

**Ingress 层**（单仓）：
- `tree-sitter-queries.ts` 的 `@route.fetch` 捕获 → `ExtractedFetchCall` → graph 中的 `FETCHES` 边
- 目前 **仅 TypeScript/JS** 有 `@route.fetch` 捕获，Java 完全没有

**Group 层**（跨仓）：
- `http-patterns/java.ts` → tree-sitter 源扫描 → `HttpDetection { role: 'consumer', framework: 'openfeign', ... }`
- 已支持的 Java 消费者模式：`RestTemplate`、`WebClient`、`OkHttp`、`Apache HttpClient`、`OpenFeign`
- `http-route-extractor.ts` 用双策略匹配：
  - **Strategy A**（图边优先）：查询 graph 中的 `FETCHES` / `HANDLES_ROUTE` 边
  - **Strategy B**（源扫描补充）：`http-patterns` 插件直接解析源码
- 跨仓关联通过 `group.yaml` 的 `links` 字段建立

### CSE 调用的特殊性

1. **CSE SDK 专属 API**（非标准 HTTP 客户端）→ 需要新增查询模式
2. **常量代替硬编码字符串**（如 `Constants.USER_SERVICE + "/api/users"`）→ tree-sitter 无法解析常量值
3. **服务名→仓库名映射** → group 层已有 `group.yaml` manifest links 机制
4. **多仓库** → 必须走 group/contract 层

### 解决方案

#### 策略总览

```
CSE 调用代码
     │
     ▼
┌─────────────────────────────────────────────────────┐
│ prepareRepo (预扫描)                                  │
│ 扫描 *Constants.java → 建立 常量名→服务名字符串 映射   │
└─────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────┐
│ scan (逐文件扫描)                                     │
│ tree-sitter 匹配 CSE API 调用模式 → HttpDetection     │
│ 路径部分：tree-sitter 字面量匹配                       │
│ 服务名部分：查 prepareRepo 映射表 + 正则模式           │
└─────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────┐
│ http-route-extractor (跨仓匹配)                       │
│ provider path (被调用方路由) ↔ consumer path (调用方)   │
│ + group.yaml links → 建立跨仓关联                     │
└─────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────┐
│ route_map / api_impact (MCP 工具)                     │
│ 在 group 模式 (@groupName) 下展示跨仓消费者             │
└─────────────────────────────────────────────────────┘
```

#### 2a. 添加 CSE 消费者查询模式

**修改文件**: `gitnexus/src/core/group/extractors/http-patterns/java.ts`

添加 CSE SDK 的 tree-sitter 查询模式。待确认具体 API 后精确编写。以下为几种可能的模式模板：

**模式 1 — CSE RestTemplate 风格**（如 `CseRestTemplate.getForObject(...)`）：
```scheme
(method_invocation
  object: (identifier) @obj (#match? @obj "^(cse|Cse).*")
  name: (identifier) @method
  arguments: (argument_list . (string_literal) @path))
```

**模式 2 — CSE Client Builder 风格**（如 `CseClient.build().call(...)`）：
```scheme
(method_invocation
  object: (method_invocation
    object: (identifier) @client (#match? @client "^(cse|Cse).*")
    name: (identifier) @builder)
  name: (identifier) @method
  arguments: (argument_list . (string_literal) @path))
```

**模式 3 — 服务名作为参数**：
```scheme
; cseClient.call(SERVICE_NAME, "/api/path")
(method_invocation
  object: (identifier) @obj (#match? @obj "cseClient")
  name: (identifier) @method
  arguments: (argument_list
    . (identifier) @service_name      ;; ← 服务名常量
    . (string_literal) @path))        ;; ← API 路径
```

每种模式输出 `HttpDetection { role: 'consumer', framework: 'cse', ... }`。

#### 2b. prepareRepo 常量预扫描

**修改文件**: `gitnexus/src/core/group/extractors/http-patterns/java.ts`

实现 `HttpLanguagePlugin.prepareRepo()`，在逐文件扫描之前先收集常量定义。

**输入**：`*Constants.java`、`*Config.java` 等文件
**输出**：`Map<string, string>`（常量名 → 服务名字符串）

查询模式：

```scheme
; public static final String USER_SERVICE = "user-service";
(field_declaration
  modifiers: (modifiers
    (annotation)  ; @Autowired 等，不要求一定有
    "static"
    "final")
  type: (type_identifier) @type (#eq? @type "String")
  declarator: (variable_declarator
    name: (identifier) @const_name
    value: (string_literal) @const_value))
```

收集到的映射表在 `scan()` 中使用：当 tree-sitter 匹配到服务名引用（如 `@service_name`）时，查表获取实际的服务名字符串。

#### 2c. 跨仓关联

`group.yaml` 已有的 links 机制：

```yaml
repos:
  user-service:
    path: ./user-service
  order-service:
    path: ./order-service

links:
  - from: order-service      # 调用方仓库
    to: user-service          # 被调用方仓库
    type: cse                 # 关联类型
```

Group 层在匹配时：
1. 扫描 `order-service` → 检测到 CSE consumer：方法 `GET`，路径 `/api/users`
2. 扫描 `user-service` → 检测到 Spring provider：方法 `GET`，路径 `/api/users`
3. 结合 `links` 配置 → 建立跨仓关联
4. `route_map` 在 group 模式（`repo: "@groupName"`）下返回带消费者的路由

### 修改文件清单

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `http-patterns/java.ts` | 修改 | 添加 CSE 查询模式 + prepareRepo 常量扫描 |
| 2 | `http-patterns/cse.ts`（可选） | **新建** | 如果 CSE 逻辑足够独立，作为单独的 `HttpLanguagePlugin` |
| 3 | `http-patterns/index.ts` | 修改 | 如新建 cse.ts，注册插件扩展名 |
| 4 | `http-patterns/types.ts` | 修改 | 如需要新的 `framework` 标签或 `HttpDetection` 扩展字段 |

### 详细设计

#### CSE 检测的逻辑流程

```
1. prepareRepo(repoPath, files)
   │
   ├─ 扫描所有 *Constants.java / *Config.java
   ├─ 收集 String 常量定义 → constMap: Map<identifier, "service-name">
   └─ 返回 RepoContext { constMap }
   
2. scan(tree, repoContext, fileRel)
   │
   ├─ 运行 CSE_PATTERNS query
   ├─ 对每个 match:
   │   ├─ 如果 path 是字符串字面量 → 直接使用
   │   ├─ 如果 path 是二元表达式 (SERVICE + "/api/users")：
   │   │   ├─ 解析左侧 identifier
   │   │   ├─ 查 repoContext.constMap → 获取实际服务名
   │   │   └─ 拼接：serviceName + pathSuffix
   │   └─ 输出 HttpDetection { role:'consumer', framework:'cse', method, path, serviceName }
   └─ return HttpDetection[]
```

#### 常量无法解析时的降级策略

当服务名确实来自运行时配置（如 `@Value("${cse.service.name}")`）或方法返回值，tree-sitter 无法静态解析时：

1. 忽略该调用（不打低质量边）
2. 或记录 `serviceName: null`，仅匹配路径部分，标记 `confidence: 0.3`
3. 通过 `group.yaml` 的 `links` 补充跨仓关联

推荐策略 2+3 组合：尽可能提取路径，多仓场景下由 links 补充服务名。

---

## 总体改动量估算

| 部分 | 新建文件 | 修改文件 | 新增代码 | 修改代码 |
|------|---------|---------|---------|---------|
| Part 1: Java 路由检测 | 1 (`spring.ts`) | 2 | ~350 行 | ~60 行 |
| Part 2: CSE 调用关联 | 0-1 (`cse.ts`) | 1-2 | ~130-330 行 | ~10 行 |
| **合计** | **1-2** | **3-4** | **~480-680 行** | **~70 行** |

---

## 前置确认事项

Part 2 的具体实现依赖 CSE SDK 的实际代码模式。需要确认：

- [ ] **CSE SDK 调用示例代码**（截取一段微服务 A 调用微服务 B 的典型代码）
- [ ] **服务名常量的定义方式**（单独的 Constants 类？配置文件？）
- [ ] **服务名→仓库名的映射关系**（是否有映射表文档？填入 `group.yaml`）
- [ ] **CSE SDK 的 Maven/Gradle 依赖和类名**（确认识别的接收器类型名）

---

## 验证方案

### Part 1 验证

1. 对包含 Spring Boot Controller 的 Java 仓库运行索引：
   ```bash
   node .gitnexus/run.cjs analyze
   ```
2. 检查日志输出是否包含：`🗺️ Route registry: N routes`（N > 0）
3. 调用 MCP 工具验证：
   ```
   route_map()
   ```
   应返回 Route 列表，每条包含 `route`、`handler`、`middleware` 字段
4. 验证 class 级 prefix 拼接正确（`@RequestMapping("/api")` + `@GetMapping("/users")` → `/api/users`）
5. 运行现有测试套件：`npm test`，检查无回归

### Part 2 验证

1. 配置 `group.yaml` 包含两个微服务仓库 + CSE links
2. 运行 group 同步构建契约注册表：
   ```bash
   group_sync({ name: "your-group" })
   ```
3. 在 group 模式下调用 route_map：
   ```
   route_map({ repo: "@your-group" })
   ```
4. 确认消费者的 `serviceName`、`framework: 'cse'` 字段正确
5. 跨仓 consumer↔provider 关联出现在正确路由上
