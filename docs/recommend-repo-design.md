# Plan: `recommend_repo` MCP Tool

## Context

当前 `list_repos` 只能列出仓库名和统计信息，AI 工具无法判断"哪个仓库最可能包含我需要的代码"。

目标：在每个仓库中可选放置 `.gitnexus/REPO_DESC.md`（中文功能描述），GitNexus 在 `analyze` 时自动向量化并写入一份全局索引。新增 MCP 工具 `recommend_repo`，接收自然语言查询，返回 top_k 最匹配的仓库推荐。AI 工具拿到结果后直接用 `repo` 参数构造其它 MCP 调用。

## 架构

```
构建（gitnexus analyze 完成后触发）
  <repoPath>/.gitnexus/REPO_DESC.md
    → repo-index/update.ts: updateRepoInIndex(repoPath)
      → 读文件 → 按配置规则分段 → embedText() 逐段向量化
        → ~/.gitnexus/repo-index.lbug（upsert 该 repo 的所有段）

查询（MCP 运行时）
  recommend_repo({ query: "...", top_k: 3 })
    → repo-index/query.ts: recommendRepos(query, topK)
      → embedQuery() → QUERY_VECTOR_INDEX → 按 repo 归并 → 返回 top_k
```

## 数据模型

`~/.gitnexus/repo-index.lbug` — 全局唯一独立 LadybugDB（参考 `bridge-db` 模式）：

```sql
CREATE NODE TABLE RepoDesc (
  id STRING,            -- "{repoName}:{segmentIndex}"
  name STRING,          -- repo registry 名称
  repoPath STRING,      -- 仓库绝对路径
  segmentIndex INT32,   -- 段序号（0 表示整篇文档）
  segmentTitle STRING,  -- 段标题
  content STRING,       -- 该段原始文本
  embedding FLOAT[384],
  indexedAt STRING,     -- ISO timestamp
  PRIMARY KEY (id)
);

CALL CREATE_VECTOR_INDEX('RepoDesc', 'repo_desc_idx', 'embedding', metric := 'cosine');
```

无 REPO_DESC.md 的仓库不在表中出现。重复 analyze 时 upsert（先 DELETE 该 repo 的全部段，再 INSERT 新版）。

## 分段规则（可选）

默认整个文件为 1 段（`segmentIndex = 0`）。用户可在 REPO_DESC.md 的 frontmatter 中配置分段：

```markdown
---
chunk_by: "##"         # 按二级标题分段
chunk_min: 50          # 小于 50 字符的段与下一段合并
---
## 概述
...

## 核心功能
...
```

不设 frontmatter 或不设 `chunk_by` 则退化为单段。

## 查询归并

向量搜索返回段级别匹配，按 repo name 归并取最高分：

```
QUERY_VECTOR_INDEX → 段级别结果:
  api-server:0 (score 0.92)
  api-server:1 (score 0.68)
  web-client:0 (score 0.85)
  shared-lib:0 (score 0.72)

归并 → Top 3:
  api-server    0.92
  web-client    0.85
  shared-lib    0.72
```

## 修改清单

总计 **3 个现有文件微调 + 7 个新文件**，改动量合计约 10 行。

### 修改 1: `gitnexus/src/mcp/tools.ts`（+3 行）

```typescript
// 文件末尾
import { RECOMMEND_REPO_TOOL } from '../core/repo-index/tool-def.js';
GITNEXUS_TOOLS.push(RECOMMEND_REPO_TOOL);
```

### 修改 2: `gitnexus/src/mcp/local/local-backend.ts`（+4 行）

顶部 import：
```typescript
import { recommendRepos } from '../core/repo-index/query.js';
```

`callTool()` 中，`resolveRepo()` 之前：
```typescript
if (method === 'recommend_repo') return recommendRepos(params);
```

### 修改 3: `gitnexus/src/core/run-analyze.ts`（+3 行）

`runFullAnalysis` 返回前：
```typescript
import { updateRepoInIndex } from './repo-index/update.js';
await updateRepoInIndex(repoPath).catch(() => {});
```

### 新增 7 个文件（均在 `gitnexus/src/core/repo-index/`）

| 文件 | 职责 |
|------|------|
| `tool-def.ts` | `RECOMMEND_REPO_TOOL` 定义（name/description/inputSchema/annotations），独立于 tools.ts |
| `schema.ts` | DDL + 版本常量 `REPO_INDEX_SCHEMA_VERSION` + `REPO_INDEX_SCHEMA_QUERIES` |
| `db.ts` | DB 生命周期：`openForRead(globalDir)` / `openForWrite(globalDir)` / `close()`，参考 bridge-db 原生 API 模式 |
| `embed.ts` | 薄封装：`embedText()` / `embedQuery()`，import 核心 `embedder.ts` |
| `chunk.ts` | 分段器：解析 frontmatter → 按规则拆分 → `Segment[]` |
| `update.ts` | `updateRepoInIndex(repoPath)`：analyze 钩子，单仓库 upsert |
| `query.ts` | `recommendRepos(query, topK)`：打开只读 DB → embed → QUERY_VECTOR_INDEX → 归并 → 返回 `{ results: [{ name, repoPath, score }] }` |

## 工具定义

```typescript
{
  name: 'recommend_repo',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '自然语言查询，描述你寻找的功能' },
      top_k: { type: 'number', description: '返回条数，默认 3，最大 20', default: 3, minimum: 1, maximum: 20 },
    },
    required: ['query'],
  },
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
}
```

返回结构：
```typescript
{
  results: [
    { name: "api-server",    repoPath: "/data/repos/api-server",    score: 0.92 },
    { name: "web-client",    repoPath: "/data/repos/web-client",    score: 0.85 },
    { name: "shared-lib",    repoPath: "/data/repos/shared-lib",    score: 0.72 },
  ],
}
```

## 拒绝列表

- **不注册 CLI 命令**
- **不注册 server.ts 的 next-step hint**
- **不修改 analyze 以外的现有文件**

## 验证

1. 建临时仓库 + `.gitnexus/REPO_DESC.md` → `gitnexus analyze` → 确认 `repo-index.lbug` 生成
2. 调 `recommend_repo({ query: "匹配的描述" })` → 验证正确排序
3. 仓库无 REPO_DESC.md → analyze 静默跳过 → recommend_repo 不返回该仓库
4. 设置 `chunk_by: "##"` 后重新 analyze → 验证按段存储、归并正确
5. 重复 analyze 不产生重复段记录
