---
name: gitnexus-guide-local-zh
description: "当用户询问 GitNexus 本身（本地模式）——可用工具、如何查询知识图谱、MCP 资源、图 schema 或工作流参考时使用。示例：\"GitNexus 有哪些工具可用？\"、\"怎么用 GitNexus？\""
---

# GitNexus 指南（本地模式）

GitNexus 全部 MCP 工具、资源和知识图谱 Schema 的快速参考。

## 部署模式

当前 skill 面向**本地 stdio 模式**——GitNexus 和代码在同一台机器上，开发者自行维护索引。

| 模式 | 架构 | 适用场景 |
|------|------|---------|
| **本地 stdio（当前）** | Agent ← stdio → 本地 GitNexus MCP | 个人开发，一台机器，自己维护索引 |
| 远程 HTTP（团队共享） | Agent ← HTTP → 远程 GitNexus 服务器 | 团队共享知识图谱，CI 定时索引 |

> 如需远程团队版，切换到 `skills-zh-CN/` 目录下的同名 skill。

## 入口：从这里开始

无论做什么——理解代码、排错、影响分析、重构：

1. **读取 `gitnexus://repo/{name}/context`** — 代码库概览 + 检查索引是否过期
2. **对照下表找到匹配的 skill**，**读取那个 skill 文件**
3. **按照该 skill 的工作流和 checklist 执行**

> 如果步骤 1 提示索引过期，运行 `node .gitnexus/run.cjs analyze`。

## Skill 速查

| 任务 | 读取的 Skill |
|------|-------------|
| 理解架构 / "X 是怎么工作的？" | `gitnexus-exploring-local` |
| 爆炸半径 / "改 X 会破坏什么？" | `gitnexus-impact-analysis-local` |
| 追 Bug / "为什么 X 失败了？" | `gitnexus-debugging-local` |
| 重命名 / 提取 / 拆分 / 重构 | `gitnexus-refactoring-local` |
| 工具、资源、Schema 参考 | `gitnexus-guide-local`（本文件） |
| 索引、状态、清理、Wiki 等 CLI 命令 | `gitnexus-cli-local` |
| 审查 PR | `gitnexus-pr-review-local` |

## 工具参考

| 工具 | 作用 |
|------|------|
| `query` | 按执行流分组的代码智能搜索——与概念相关的执行流 |
| `context` | 360° 符号全景——分好类的引用关系 + 参与的执行流 |
| `impact` | 符号爆炸半径——深度 1/2/3 的受影响者 + 置信度 |
| `trace` | 两个符号间的最短路径——"A 怎么调用到 B？"一次查询搞定 |
| `detect_changes` | Git-diff 影响分析——当前工作区改动影响了什么 |
| `rename` | 图辅助的多文件安全改名——直接在本地文件上执行编辑 |
| `cypher` | 原始图查询（先读 `gitnexus://repo/{name}/schema`） |
| `list_repos` | 发现已索引的仓库 |

### 短路路径

本地模式下可直接操作的快捷方式：

| 快捷操作 | 说明 |
|---------|------|
| 看源文件 | 图谱返回的 filePath 就是本地路径，直接 `Read` 打开 |
| 索引过期 | 自己跑 `node .gitnexus/run.cjs analyze` |
| `detect_changes({scope: "all"})` | 映射本地所有未提交改动到受影响执行流 |
| `detect_changes({scope: "staged"})` | 仅检查已暂存的改动 |
| `rename` | 直接在本地文件系统上执行重命名编辑 |

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
