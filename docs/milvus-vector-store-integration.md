# Plan: Milvus Vector Store Integration

## 目录

- [Context](#context)
- [架构](#架构)
- [数据模型](#数据模型)
- [VectorStore 接口](#vectorstore-接口)
- [配置](#配置)
- [glibc 兼容性](#glibc-兼容性)
- [性能对比](#性能对比)
- [修改清单](#修改清单)
- [代码量评估（精确）](#代码量评估精确)
- [部署](#部署)
- [风险与回退](#风险与回退)
- [拒绝列表](#拒绝列表)
- [验证](#验证)

---

## Context

当前 GitNexus 的向量存储和检索完全依赖 LadybugDB/Kuzu 内嵌的 VECTOR 扩展（HNSW + cosine），存在以下局限：

| 问题 | 影响 | 根因 |
|------|------|------|
| **glibc 2.38 崩溃** | `analyze --embeddings` 在索引构建阶段 SIGSEGV 退出 | `CALL CREATE_VECTOR_INDEX` → DuckDB VECTOR 扩展 → usearch HNSW → `aligned_alloc` 不兼容 C17 严格化 → 返回 NULL → 写入 → SIGSEGV |
| **Windows 向量搜索不可用** | 语义搜索永远回退到精确扫描 | `INSTALL VECTOR` 在 Windows 触发 SIGSEGV，进程无法捕获（`lbug-adapter.ts:1882`） |
| **索引构建慢且不可增量** | 每次 analyze 重建全量 HNSW 索引 | usearch 在 DuckDB 内单线程执行 |
| **无法复用现有基础设施** | 企业已有 Milvus 集群 | Kuzu 是嵌入式数据库，不支持外部向量存储 |

> glibc 崩溃完整分析见 `docs/embedding-glibc-crash-analysis.md`。已有绕过方案（`LD_PRELOAD=jemalloc`、`MALLOC_ARENA_MAX=2`）但不根治。

目标：引入 `VectorStore` 抽象层，支持 Kuzu（默认，零行为变化）和 Milvus 两种后端，通过环境变量切换。Embedding 生成（transformers.js / HTTP）保持不变。

## 架构

```
┌──────────────────────────────────────────────────┐
│  Embedding 生成（不变）                           │
│  embedder.ts / http-client.ts                     │
│  · 本地: transformers.js snowflake-arctic-384d    │
│  · 远程: OpenAI 兼容 /v1/embeddings               │
├──────────────────────────────────────────────────┤
│  Pipeline 编排（微调）                             │
│  embedding-pipeline.ts                            │
│  · 节点查询 → 分块 → 文本生成 → 批量 Embedding    │
│  · 写入: vectorStore.insert()    ← 抽象入口       │
│  · 索引: vectorStore.createIndex()                │
├──────────────────────────────────────────────────┤
│  VectorStore 接口（新增）                          │
│  vector-store.ts                                  │
│  · insert / deleteByNodeIds / search / count      │
├──────────────────────────────────────────────────┤
│  实现层（二选一，env 切换）                        │
│  ┌─────────────────┐  ┌─────────────────────────┐│
│  │ KuzuVectorStore  │  │ MilvusVectorStore       ││
│  │ (默认，零改动)    │  │ @zilliz/milvus2-sdk-   ││
│  │ 现有 CodeEmbedding│  │ node (纯 JS gRPC)       ││
│  │ 表 + HNSW        │  │ 独立 collection          ││
│  └─────────────────┘  └─────────────────────────┘│
└──────────────────────────────────────────────────┘
         ↓ 搜索时
  hybrid-search.ts (BM25 + RRF 融合，不变)
```

### 元数据分工

| 存储 | 内容 | 模式 |
|------|------|------|
| Kuzu/LadybugDB | 图节点（File/Function/Class/...）、关系、BM25 索引 | 两种模式均使用 |
| Kuzu `CodeEmbedding` 表 | 向量 + nodeId 外键 | 仅 Kuzu 模式 |
| Milvus `code_embeddings` collection | 向量 + nodeId 外键 | 仅 Milvus 模式 |

搜索时，向量检索返回 `(nodeId, distance, chunkIndex)`，再回查 Kuzu 获取元数据（`name/filePath/label`）。Kuzu 始终是元数据的唯一权威来源。

### 依赖：为什么 `@zilliz/milvus2-sdk-node` 无 native 风险

```
@zilliz/milvus2-sdk-node 的依赖链：
  ├─ @grpc/grpc-js          ← 纯 JS gRPC（Google 官方维护）
  ├─ @grpc/proto-loader     ← 纯 JS protobuf 加载
  └─ protobufjs             ← 纯 JS 序列化

全程无 C/C++ native addon，不调用 glibc，不受 glibc 版本影响。
```

## 数据模型

### Kuzu 模式（现有，不变）

```sql
CREATE NODE TABLE CodeEmbedding (
  id STRING,              -- "{nodeId}:{chunkIndex}"
  nodeId STRING,          -- 外键 → 代码节点 ID
  chunkIndex INT32,
  startLine INT64,
  endLine INT64,
  embedding FLOAT[384],
  contentHash STRING,
  PRIMARY KEY (id)
);

CALL CREATE_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 'embedding', metric := 'cosine');
```

### Milvus 模式（新增）

```
Collection: code_embeddings
┌──────────────┬──────────────────┬──────────────────────────┐
│ Field        │ Type             │ Note                     │
├──────────────┼──────────────────┼──────────────────────────┤
│ id           │ VarChar(256)     │ primary key              │
│ nodeId       │ VarChar(512)     │ 外键 → Kuzu 节点 ID       │
│ chunkIndex   │ Int32            │                          │
│ startLine    │ Int64            │                          │
│ endLine      │ Int64            │                          │
│ contentHash  │ VarChar(64)      │ 增量更新标识              │
│ embedding    │ FloatVector(384) │                          │
└──────────────┴──────────────────┴──────────────────────────┘

Index: HNSW, metric_type=COSINE, M=16, efConstruction=200
Search: metric_type=COSINE, ef=64
```

Collection 由 `MilvusVectorStore.ensureCollection()` 在首次 `insert` 时自动创建，操作者无需手动建表。

## VectorStore 接口

```typescript
// gitnexus/src/core/embeddings/vector-store.ts

export interface VectorRecord {
  id: string;
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embedding: number[];
  contentHash?: string;
}

export interface VectorSearchResult {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  distance: number;        // cosine distance，越小越相似
}

export interface VectorStore {
  /** 批量插入（同 id 覆盖） */
  insert(records: VectorRecord[]): Promise<void>;

  /** 按 nodeId 批量删除（增量更新用） */
  deleteByNodeIds(nodeIds: string[]): Promise<void>;

  /** 创建/重建向量索引 */
  createIndex(): Promise<boolean>;

  /** 向量相似搜索，返回 topK（按 distance 升序） */
  search(queryVector: number[], topK: number, maxDistance?: number): Promise<VectorSearchResult[]>;

  /** 向量总数 */
  count(): Promise<number>;

  /** 后端是否就绪（已加载 + 可搜索） */
  isReady(): boolean;

  /** 释放连接资源 */
  dispose(): Promise<void>;
}
```

### KuzuVectorStore 实现要点

从现有两处代码抽取，零行为变化：

| 方法 | 抽取来源 |
|------|---------|
| `insert()` | `embedding-pipeline.ts:190-215` `batchInsertEmbeddings()` |
| `deleteByNodeIds()` | `embedding-pipeline.ts:352-366` stale DELETE 块 |
| `createIndex()` | `embedding-pipeline.ts:225-238` `createVectorIndex()` |
| `search()` | `embedding-pipeline.ts:609-634` + `local-backend.ts:1626-1651` `CALL QUERY_VECTOR_INDEX` 逻辑 |
| `count()` | `MATCH (e:CodeEmbedding) RETURN count(e)` |
| `isReady()` | `loadVectorExtension(undefined, { policy: 'load-only' })` |
| `exactScan()` | `embedding-pipeline.ts:637-668` 精确 cosine 扫描回退 |

### MilvusVectorStore 实现要点

```typescript
// gitnexus/src/core/embeddings/milvus-vector-store.ts

import { MilvusClient } from '@zilliz/milvus2-sdk-node';

export class MilvusVectorStore implements VectorStore {
  private client: MilvusClient;
  private collectionName: string;
  private dim: number;
  private _ready = false;

  constructor(config: MilvusConfig) { ... }

  // --- 生命周期 ---
  private async ensureCollection(): Promise<void> {
    // hasCollection → 不存在则 createCollection + createIndex + loadCollectionSync
  }

  // --- VectorStore 实现 ---
  async insert(records: VectorRecord[]): Promise<void> {
    await this.ensureCollection();
    await this.client.insert({ collection_name, data: records.map(toMilvusRow) });
    await this.client.flushSync({ collection_names: [collection_name] });
  }

  async deleteByNodeIds(nodeIds: string[]): Promise<void> {
    const expr = `nodeId in [${nodeIds.map(id => `"${id}"`).join(', ')}]`;
    await this.client.delete({ collection_name, expr });
  }

  async search(queryVector: number[], topK: number, maxDistance = 0.5): Promise<VectorSearchResult[]> {
    const result = await this.client.search({
      collection_name,
      vector: queryVector,
      limit: topK,
      output_fields: ['nodeId', 'chunkIndex', 'startLine', 'endLine'],
      params: { metric_type: 'COSINE' },
    });
    return result.results
      .filter(r => (r.score ?? 0) >= 1 - maxDistance)
      .map(r => ({
        nodeId: r.nodeId as string,
        chunkIndex: r.chunkIndex as number,
        startLine: r.startLine as number,
        endLine: r.endLine as number,
        distance: 1 - (r.score ?? 0),   // similarity → distance
      }));
  }

  async createIndex(): Promise<boolean> { ... }
  async count(): Promise<number> { ... }
  isReady(): boolean { return this._ready; }
  async dispose(): Promise<void> { ... }
}
```

错误处理策略：连接失败 / 超时 → 抛出明确错误，调用方（pipeline / semanticSearch）捕获后回退到 Kuzu 精确扫描。写入路径失败 → 终止 pipeline（不静默丢数据）。

## 配置

沿用现有 env-var 模式（参考 `http-client.ts:35-59` 的 `readConfig()`）：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `GITNEXUS_VECTOR_STORE` | `kuzu` | `kuzu` 或 `milvus` |
| `GITNEXUS_MILVUS_ADDRESS` | — | Milvus gRPC 地址，必填（Milvus 模式） |
| `GITNEXUS_MILVUS_TOKEN` | — | 认证 token（Zilliz Cloud 使用） |
| `GITNEXUS_MILVUS_USERNAME` | — | 用户名（可选） |
| `GITNEXUS_MILVUS_PASSWORD` | — | 密码（可选） |
| `GITNEXUS_MILVUS_COLLECTION` | `code_embeddings` | 集合名（可选） |
| `GITNEXUS_EMBEDDING_DIMS` | `384` | 向量维度 |

```bash
# 最简开发环境
GITNEXUS_VECTOR_STORE=milvus \
GITNEXUS_MILVUS_ADDRESS=localhost:19530 \
npx gitnexus analyze --embeddings

# 生产环境（Milvus + HTTP embedding，进程中零 native）
GITNEXUS_VECTOR_STORE=milvus \
GITNEXUS_MILVUS_ADDRESS=milvus.internal:19530 \
GITNEXUS_MILVUS_COLLECTION=gitnexus_prod \
GITNEXUS_EMBEDDING_URL=https://embedding.internal/v1 \
GITNEXUS_EMBEDDING_MODEL=text-embedding-3-small \
npx gitnexus analyze --embeddings
```

默认（不设 env var）行为与当前完全一致，走 Kuzu VECTOR 路径。

## glibc 兼容性

### 为什么 Milvus SDK 不受影响

```
Kuzu VECTOR 路径（进程内 native，依赖 glibc）：
  Node.js → LadybugDB native → DuckDB C++ → VECTOR 扩展
    → usearch C++ → aligned_alloc() → glibc
      ├─ 2.34: 正常
      └─ 2.38: SIGSEGV

Milvus 路径（纯 JS gRPC，不经 glibc）：
  Node.js → @grpc/grpc-js (纯 JS Buffer) → TCP socket
    → Milvus 服务端 (独立进程，自己的 C++ runtime + allocator)
```

| 组件 | glibc 2.28 | glibc 2.34 | glibc 2.38 | 说明 |
|------|-----------|-----------|-----------|------|
| Kuzu VECTOR 索引构建 | ⚠️ fallocate 大磁盘 | ✅ 正常 | ❌ SIGSEGV | usearch `aligned_alloc` 不兼容 |
| Kuzu VECTOR 搜索 | ✅ | ✅ | ⚠️ 潜在风险 | SIMD 对齐分配 |
| Milvus SDK 安装 | ✅ | ✅ | ✅ | 纯 JS，`npm install` 即可 |
| Milvus 服务端 | ✅ | ✅ | ✅ | Docker / 独立部署，自带 runtime |
| ONNX Runtime 推理 | ✅ | ✅ | ✅ | 从未崩溃过 |

**结论：Milvus SDK 安装不受 glibc 版本约束。Milvus 服务端运行在自己的容器/进程中，与宿主 glibc 无关。**

### 崩溃路径对比

| 操作 | Kuzu 模式 (native) | Milvus 模式 | 经过宿主 glibc？ |
|------|--------------------|------------|-------------------|
| 向量写入 | `INSERT INTO CodeEmbedding` | gRPC → Milvus `Insert` | ❌ |
| **索引构建** | **`CALL CREATE_VECTOR_INDEX` → usearch → SIGSEGV** | gRPC → Milvus `CreateIndex` | ❌ |
| 向量搜索 | `CALL QUERY_VECTOR_INDEX` → usearch SIMD | gRPC → Milvus `Search` | ❌ |
| Embedding 推理 | ONNX Runtime `malloc` | 同左 / HTTP 移出 | ✅（未崩溃过） |
| 图数据写入 | DuckDB I/O | 同左 | ✅（未崩溃过） |

若同时启用 HTTP embedding，GitNexus 进程中零 native `malloc`/`aligned_alloc` 调用：

```bash
GITNEXUS_VECTOR_STORE=milvus \
GITNEXUS_MILVUS_ADDRESS=localhost:19530 \
GITNEXUS_EMBEDDING_URL=https://embedding/v1 \
GITNEXUS_EMBEDDING_MODEL=text-embedding-3-small \
npx gitnexus analyze --embeddings
```

## 性能对比

### 索引构建（analyze 阶段）

| 指标 | Kuzu usearch | Milvus Knowhere | 差距 |
|------|-------------|-----------------|------|
| 并行度 | 单线程（DuckDB 内） | 多线程 | **3-10×** |
| 100K 向量构建（估算） | 数分钟，2-3 GB RAM | 数秒到数十秒 | **10-50×** |
| glibc 2.38 | ❌ 崩溃 | ✅ 正常 | ∞ |
| 增量构建 | 不支持（全量重建 HNSW） | 支持增量 insert + 后台 merge | 显著 |

### 向量搜索（MCP 查询路径）

单次 `semanticSearch` 调用的延迟分解：

```
embedText(query)          ████████████████████  50-200ms  (主导)
向量检索                   ▏  Kuzu:  ~0.5ms
                          ▎  Milvus: ~3ms (gRPC 开销)
回查 Kuzu 元数据           ▎  ~2-5ms
BM25 + RRF 融合            ▏  ~1ms
───────────────────────────────────────────
总延迟                     ~55-210ms
```

Embedding 推理占延迟的 90%+，向量检索本身的差异（2-3ms）完全感知不到。

| 数据集规模 | Kuzu (进程内) | Milvus (gRPC localhost) | 快者 |
|-----------|--------------|------------------------|------|
| < 1K 向量 | ~0.1ms | ~1-2ms | 持平 |
| 10K-100K | ~0.3-1ms | ~2-5ms | 持平 |
| 100K-1M | ~1-5ms | ~2-5ms | 持平 |
| > 1M | 压力增大 | ~3-8ms（稳定，可水平扩展） | **Milvus** |
| 高并发 | DuckDB 单写者瓶颈 | 原生并发支持 | **Milvus** |

**结论：搜索延迟在 GitNexus 场景下无实际差异（瓶颈在 embedding 推理）。索引构建 Milvus 快 10-50×。真正的性能提升是"从崩溃到完成"。**

## 修改清单

### 涉及文件一览

```
gitnexus/src/core/embeddings/
├── vector-store.ts              [新增] VectorStore 接口 + 类型
├── vector-store-config.ts       [新增] 配置解析
├── vector-store-factory.ts      [新增] 工厂函数
├── kuzu-vector-store.ts         [新增] Kuzu 实现（从现有代码抽取）
├── milvus-vector-store.ts       [新增] Milvus 实现
├── embedding-pipeline.ts        [修改] 5 处替换
│   ├── import + runEmbeddingPipeline 签名  → 新增 vectorStore 参数
│   ├── Phase 3 stale 删除                  → vectorStore.deleteByNodeIds()
│   ├── Phase 3 向量写入                    → vectorStore.insert()
│   ├── Phase 4 索引创建                    → vectorStore.createIndex()
│   └── semanticSearch() 向量搜索           → vectorStore.search()
├── index.ts                     [修改] 新增 export
│
gitnexus/src/core/
├── run-analyze.ts               [修改] 注入 VectorStore 实例（10 行）
│
gitnexus/src/mcp/local/
├── local-backend.ts             [修改] semanticSearch() 内 CALL QUERY_VECTOR_INDEX
│                                       → vectorStore.search()（30 行）
```

### 修改 1: `embedding-pipeline.ts`

| 位置 | 行号 | 改动方向 | 行数变化 |
|------|------|---------|---------|
| 文件头部 | — | `import { VectorStore } from './vector-store.js'` | +1 |
| `runEmbeddingPipeline` 签名 | 261-272 | 新增 `vectorStore?: VectorStore` 参数 | +1 |
| Phase 3 增量删除 | 347-366 | DELETE 块 → `await vectorStore.deleteByNodeIds(staleNodeIds)` | -17 / +3 |
| Phase 3 向量写入 | 513-518 | `batchInsertEmbeddings(...)` → `await vectorStore.insert(dbUpdates)` | -1 / +1 |
| Phase 4 索引创建 | 547 | `createVectorIndex(executeQuery)` → `await vectorStore.createIndex()` | -1 / +1 |
| `semanticSearch()` 向量搜索 | 609-634 | `CALL QUERY_VECTOR_INDEX(...)` 块 → `await vectorStore.search(queryVec, ...)` | -25 / +5 |

`batchInsertEmbeddings` 和 `createVectorIndex` 两个函数保留（KuzuVectorStore 内部引用），标记为 `@deprecated`。

### 修改 2: `run-analyze.ts`（行 875 附近）

```typescript
// 现有代码：
const embeddingResult = await runEmbeddingPipeline(
  executeQuery,
  executeWithReusedStatement,
  (p) => { ... },
  {},
  ...,
);

// 改为：
import { resolveVectorStoreConfig } from './embeddings/vector-store-config.js';
import { createVectorStore } from './embeddings/vector-store-factory.js';

const storeConfig = resolveVectorStoreConfig();
const vectorStore = storeConfig.kind === 'milvus'
  ? await createVectorStore(storeConfig)
  : undefined;

const embeddingResult = await runEmbeddingPipeline(
  executeQuery,
  executeWithReusedStatement,
  (p) => { ... },
  {},
  cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
  { repoName: projectName, serverName },
  existingEmbeddings,
  vectorStore,   // ← 新增最后一个参数
);
```

### 修改 3: `local-backend.ts`（行 1608 附近）

MCP 查询路径的 `semanticSearch()` 方法，将 `CALL QUERY_VECTOR_INDEX` 块替换为 `vectorStore.search()`。逻辑与 `embedding-pipeline.ts:semanticSearch()` 的改动相同。

### 修改 4: `embeddings/index.ts`

```typescript
export * from './vector-store.js';
export * from './vector-store-config.js';
export * from './vector-store-factory.js';
export * from './kuzu-vector-store.js';
export * from './milvus-vector-store.js';
```

## 代码量评估（精确）

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 文件                                行数    类型
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 新增文件（6 个）
   vector-store.ts                   50    接口 + 类型
   vector-store-config.ts            40    env 解析
   vector-store-factory.ts           30    switch(kind)
   kuzu-vector-store.ts             220    抽取（非新逻辑）
   milvus-vector-store.ts           280    核心新代码
   index.ts 增量                       3    新增 export
                                    ────
   新增合计                         623
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 修改现有文件（3 个）
   embedding-pipeline.ts            -60 → +15  (净删 45)
   run-analyze.ts                     +10
   local-backend.ts                 -68 → +10  (净删 58)
                                    ────
   改动合计                          35 行净增
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 总计                               ~660 行净增
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**真正需要写的新逻辑代码：**

| 部分 | 行数 | 复杂度 |
|------|------|--------|
| `milvus-vector-store.ts` | 280 | 中 — gRPC 调用 + Collection 管理 + 错误处理 |
| `vector-store-config.ts` | 40 | 低 |
| `vector-store-factory.ts` | 30 | 低 |
| `vector-store.ts` | 50 | 低（纯类型） |
| **合计** | **~400** | |

其余 260 行是 `KuzuVectorStore` 的搬移（现有逻辑抽取）和 3 个修改文件中的胶水代码（实际净删除更多）。

## 部署

### 开发 / 测试环境

```bash
# 1. 一行拉起 Milvus Standalone
docker run -d --name milvus-standalone \
  -p 19530:19530 -p 9091:9091 \
  milvusdb/milvus:latest

# 2. 安装 GitNexus（Milvus SDK 为可选依赖）
npm install @zilliz/milvus2-sdk-node   # 仅在启用 Milvus 时需要

# 3. 运行 analyze（首次自动创建 collection + index）
GITNEXUS_VECTOR_STORE=milvus \
GITNEXUS_MILVUS_ADDRESS=localhost:19530 \
npx gitnexus analyze --embeddings

# 4. MCP 查询（自动走 gRPC 搜索）
GITNEXUS_VECTOR_STORE=milvus \
GITNEXUS_MILVUS_ADDRESS=localhost:19530 \
npx gitnexus serve
```

### 生产环境

| 组件 | 选项 | 说明 |
|------|------|------|
| Milvus 服务 | Milvus Cluster / Zilliz Cloud | 高可用、自动扩缩容 |
| Embedding 服务 | 自建 / OpenAI / Voyage / Cohere | 任何 OpenAI 兼容 `/v1/embeddings` 端点 |
| GitNexus | `npx gitnexus serve` | MCP 进程，纯 JS |

### 依赖策略

`@zilliz/milvus2-sdk-node` 作为 **optionalDependency**，不安装时 Kuzu 模式正常运行。仅在设置 `GITNEXUS_VECTOR_STORE=milvus` 时才要求该依赖存在，factory 函数在 import 失败时给出明确安装提示。

## 风险与回退

| 风险 | 缓解 |
|------|------|
| Milvus SDK 引入 native 依赖 | 不存在 — `@zilliz/milvus2-sdk-node` 纯 JS gRPC |
| Milvus 连接失败（搜索） | 回退到 Kuzu 精确 cosine 扫描，日志 warn |
| Milvus 连接失败（写入） | 终止 pipeline 并报错（不静默丢数据），操作者可回退到 Kuzu 模式重试 |
| 维度不匹配 | Config 解析时校验 `GITNEXUS_EMBEDDING_DIMS`，首次 insert 时 Milvus 侧 schema 校验 |
| 元数据冗余 | 不在 Milvus 存 `name/filePath/label`，仅存 `nodeId` → 回查 Kuzu |
| `npm test` 引入 Milvus 依赖 | 不设为 `devDependency`，CI 环境中 `GITNEXUS_VECTOR_STORE=kuzu`（默认） |
| 回退到 Kuzu 模式后 glibc 崩溃 | `LD_PRELOAD=jemalloc` 仍然可用 |

## 拒绝列表

- ❌ **不替换 embedding 模型**（Milvus 是向量数据库，不是 embedding 服务）
- ❌ **不新增 CLI 命令**（全部通过 env var 配置）
- ❌ **不修改 `chunker.ts` / `text-generator.ts` / `hybrid-search.ts`**
- ❌ **不引入新的持久化文件**（配置完全通过 env vars）
- ❌ **MCP 工具定义不变**（`query` / `context` / `impact` 等工具签名不变）
- ❌ **不在 `npm test` 默认 suite 中跑 Milvus 测试**

## 验证

| # | 场景 | 验证方法 | 期望结果 |
|---|------|---------|---------|
| 1 | **Kuzu 回归**（不设 env var） | 全量 analyze → semanticSearch | 行为与当前版本完全一致 |
| 2 | **Milvus 写入** | `GITNEXUS_VECTOR_STORE=milvus` → analyze | `code_embeddings` collection 中有对应记录 |
| 3 | **Milvus 搜索** | `semanticSearch("authentication middleware")` | 返回匹配的代码节点 |
| 4 | **增量更新** | 修改一个文件 → re-analyze | 仅变化的节点被 `deleteByNodeIds` + `insert`，未变化的保持 |
| 5 | **Milvus 宕机回退** | 停 Milvus → 执行搜索 | 自动回退精确 cosine 扫描 + 日志 warn |
| 6 | **hybrid-search** | BM25 + Milvus 语义 → RRF | 融合排序正确 |
| 7 | **glibc 2.38** | 确认环境的 analyze --embeddings | 正常完成（无 SIGSEGV） |
| 8 | **Windows** | Milvus 模式下 analyze + search | 正常（无 VECTOR INSTALL 的 SIGSEGV 问题） |
