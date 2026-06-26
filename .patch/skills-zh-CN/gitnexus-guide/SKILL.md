---
name: gitnexus-guide
description: "当用户询问 GitNexus 本身（远程团队模式）——可用工具、如何查询知识图谱、MCP 资源、图 schema 或工作流参考时使用。"
---

# GitNexus 指南（远程模式）

## 部署模式

当前 skill 面向**远程 HTTP 团队共享模式**——知识图谱部署在服务端，由 CI 维护，开发者通过 MCP HTTP 连接查询。

| 概念 | 说明 |
|------|------|
| **图谱是权威信息来源** | 索引的代码在远程服务端。探索代码时以图谱为准，不要尝试 Read 图谱路径来验证。理解完代码后可自由操作本地文件 |
| **索引由服务端 CI 维护** | 开发者不触发 `analyze`，过期了联系管理员。 |
| **多仓库需带 `repo` 参数** | 远程服务器可能索引了多个仓库，`query`/`context`/`impact` 必须指明 `repo`。 |

> 如需本地个人版，切换到 `skills-zh-CN-local/` 目录下的同名 skill。

## 入口：从这里开始

1. **读取 `gitnexus://repo/{name}/context`** — 代码库概览 + 检查索引新鲜度
2. **对照下表找到匹配的 skill**，**读取那个 skill 文件**
3. **按照该 skill 的工作流和 checklist 执行**

> 步骤 1 提示索引过期 → 联系服务端管理员触发 CI 索引更新。

## Skill 速查

| 任务 | 读取的 Skill |
|------|-------------|
| 理解架构 / "X 是怎么工作的？" | `gitnexus-exploring` |
| 爆炸半径 / "改 X 会破坏什么？" | `gitnexus-impact-analysis` |
| 追 Bug / "为什么 X 失败了？" | `gitnexus-debugging` |
| 重命名 / 提取 / 拆分 / 重构 | `gitnexus-refactoring` |
| 工具、资源、Schema 参考 | `gitnexus-guide`（本文件） |
| 审查 PR | `gitnexus-pr-review` |
| 控制/数据依赖查询（需 `--pdg`） | `gitnexus-pdg-query` |
| 污点分析引擎（需 `--pdg`） | `gitnexus-taint-analysis` |
| 服务端 CLI 命令参考 | `gitnexus-cli` |

## 工具参考

| 工具 | 作用 |
|------|------|
| `query` | 按执行流分组的代码智能搜索 |
| `context` | 360° 符号全景——分好类的引用关系 + 参与的执行流 |
| `impact` | 符号爆炸半径——深度 1/2/3 的受影响者 + 置信度 |
| `trace` | 两个符号间的最短路径 |
| `detect_changes` | Git-diff 影响分析（仅 `"compare"` 模式有意义） |
| `rename` | 图辅助的多文件安全改名（需本地 clone） |
| `cypher` | 原始图查询 |
| `list_repos` | 发现已索引的仓库 |

## 资源参考

| 资源 | 内容 |
|------|------|
| `gitnexus://repo/{name}/context` | 统计信息、过期检查 |
| `gitnexus://repo/{name}/clusters` | 所有功能模块及内聚度评分 |
| `gitnexus://repo/{name}/cluster/{clusterName}` | 模块成员 |
| `gitnexus://repo/{name}/processes` | 所有执行流 |
| `gitnexus://repo/{name}/process/{processName}` | 逐步执行路径 |
| `gitnexus://repo/{name}/schema` | Cypher 查询用的图 Schema |

## 图 Schema

**节点：** File, Function, Class, Interface, Method, Community, Process
**边（CodeRelation.type）：** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS
