---
name: gitnexus-guide-zh
description: "当用户询问 GitNexus 本身——可用工具、如何查询知识图谱、MCP 资源、图 schema 或工作流参考时使用。示例：\"GitNexus 有哪些工具可用？\"、\"怎么用 GitNexus？\""
---

# GitNexus 指南

GitNexus 全部 MCP 工具、资源和知识图谱 Schema 的快速参考。

## 部署模式

GitNexus 支持两种部署模式：

| 模式 | 架构 | 适用场景 |
|------|------|---------|
| **本地 stdio** | Agent ← stdio → 本地 GitNexus MCP | 个人开发，一台机器 |
| **远程 HTTP（团队共享）** | Agent ← HTTP → 远程 GitNexus 服务器 | 团队共享知识图谱，CI 定时索引 |

> **当前 skill 面向远程部署模式。** 索引由服务端 CI/定时任务维护，开发者不作为索引的触发者——所以 skill 中不再出现 `node .gitnexus/run.cjs analyze` 指令。若你是个人本地使用，请将 `mcp.json` 改回 stdio 模式：`"command": "npx", "args": ["-y", "gitnexus@latest", "mcp"]`。

### 远程模式下各 Skill 的行为变化

| 变化 | 说明 |
|------|------|
| 不再提示 `node .gitnexus/run.cjs analyze` | 索引由服务端维护，开发者无法本地触发 |
| `detect_changes({scope: "compare", ...})` | 仍需本地 git clone + `git fetch origin`，比较的是本地 HEAD vs 远程索引的 `lastCommit` |
| `detect_changes({scope: "all"})` | 映射本地工作区改动到受影响执行流，依赖服务端索引的新鲜度 |
| `rename` 工具 | 在本地文件上执行编辑，图关系从远程查 |

## 入口：从这里开始

无论做什么——理解代码、排错、影响分析、重构：

1. **读取 `gitnexus://repo/{name}/context`** — 代码库概览 + 检查索引是否过期
2. **对照下表找到匹配的 skill**，**读取那个 skill 文件**
3. **按照该 skill 的工作流和 checklist 执行**

> 如果步骤 1 提示索引过期：远程模式下联系服务端管理员触发 CI 索引更新；本地模式运行 `node .gitnexus/run.cjs analyze`。

## Skill 速查

| 任务 | 读取的 Skill |
|------|-------------|
| 理解架构 / "X 是怎么工作的？" | `gitnexus-exploring` |
| 爆炸半径 / "改 X 会破坏什么？" | `gitnexus-impact-analysis` |
| 追 Bug / "为什么 X 失败了？" | `gitnexus-debugging` |
| 重命名 / 提取 / 拆分 / 重构 | `gitnexus-refactoring` |
| 工具、资源、Schema 参考 | `gitnexus-guide`（本文件） |
| 索引、状态、清理、Wiki 等 CLI 命令 | `gitnexus-cli` |

## 工具参考

| 工具 | 作用 |
|------|------|
| `query` | 按执行流分组的代码智能搜索——与概念相关的执行流 |
| `context` | 360° 符号全景——分好类的引用关系 + 参与的执行流 |
| `impact` | 符号爆炸半径——深度 1/2/3 的受影响者 + 置信度 |
| `trace` | 两个符号间的最短路径——"A 怎么调用到 B？"一次查询搞定 |
| `detect_changes` | Git-diff 影响分析——当前改动影响了什么 |
| `rename` | 图辅助的多文件安全改名——附带置信度标记 |
| `cypher` | 原始图查询（先读 `gitnexus://repo/{name}/schema`） |
| `explain` | 持久化污点发现——source→sink 数据流（需 `analyze --pdg`） |
| `pdg_query` | 控制/数据依赖——什么条件控制了 X（CDG）/ Y 从哪流过来（REACHING_DEF）；需 `analyze --pdg` |
| `check` | 检查图不变量，如循环 import |
| `list_repos` | 发现已索引的仓库（分页——`limit`/`offset`） |

### 分页查询 `list_repos`

```jsonc
{
  "repositories": [
    { "name": "...", "path": "...", "indexedAt": "...", "lastCommit": "...", "stats": { } }
  ],
  "pagination": {
    "total": 437,
    "limit": 50,
    "offset": 0,
    "returned": 50,
    "hasMore": true,
    "nextOffset": 50
  }
}
```

持续用 `offset` 设为 `pagination.nextOffset` 调用直到 `hasMore` 为 false。

### 污点发现 (`explain`)

`explain` 返回 `gitnexus analyze --pdg` 记录的过程内污点发现——每条都带 sink 类别、source/sink 行号、有序跳转路径。

- `explain {}` — 枚举仓库全部发现
- `explain { target: "src/vuln.ts" }` — 某文件中的发现
- `explain { target: "runUserCommand" }` — 某函数中的发现

### 控制与数据依赖 (`pdg_query`)

`pdg_query` 读取 CDG + REACHING_DEF 层：
- `pdg_query({ mode: "controls", target: "..." })` — CDG："什么条件控制 X 执行？"
- `pdg_query({ mode: "flows", target: "...", variable?: "..." })` — REACHING_DEF：函数内的 def→use 边

### 最短路径 (`trace`)

`trace` 回答"A 怎么调用到 B？"——一次调用代替 3-8 次手动 `context`/`impact` 跳转。

- `trace({ from: "validateUser", to: "executeQuery" })`
- 返回：`hops`（每一步的 name/filePath/startLine）+ `edges`（每步的 relType/confidence）

## 资源参考

轻量级读取（~100-500 tokens），用于导航：

| 资源 | 内容 |
|------|------|
| `gitnexus://repo/{name}/context` | 统计信息、过期检查 |
| `gitnexus://repo/{name}/clusters` | 所有功能模块及内聚度评分 |
| `gitnexus://repo/{name}/cluster/{clusterName}` | 模块成员 |
| `gitnexus://repo/{name}/processes` | 所有执行流 |
| `gitnexus://repo/{name}/process/{processName}` | 逐步执行路径 |
| `gitnexus://repo/{name}/schema` | Cypher 查询用的图 Schema |

## 图 Schema

**节点类型：** File, Function, Class, Interface, Method, Community, Process
**关系类型（通过 CodeRelation.type）：** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
RETURN caller.name, caller.filePath
```
