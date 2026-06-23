---
name: gitnexus-exploring-zh
description: "当用户询问代码如何工作、想理解架构、追踪执行流或探索不熟悉的代码部分时使用。示例：\"X 是怎么工作的？\"、\"谁调用了这个函数？\"、\"给我看认证流程\""
---

# 用 GitNexus 探索代码

## 适用场景

- "认证是怎么实现的？"
- "项目的整体结构是什么？"
- "给我看看主要组件"
- "数据库逻辑在哪里？"
- 理解从未见过的代码
- 新人上手新模块——直接看知识图谱而非翻文件

## 远程团队部署须知

在远程模式下，你对本地文件的理解和知识图谱的关系如下：

| 概念 | 说明 |
|------|------|
| **知识图谱是团队的共享地图** | 索引由服务端定期维护，反映的是基准分支 `develop` 的代码结构 |
| **你本地的文件可能落后/超前** | 图谱中的文件路径是索引时刻服务端上的路径，通常与本地 clone 路径一致 |
| **多仓库场景必须带 `repo` 参数** | 远程服务器可能索引了多个仓库，`query`/`context`/`impact` 必须指明 `repo`，否则走默认仓库 |
| **`service` 参数用于微服务/大仓** | 如果是大仓（monorepo），用 `service` 参数限定到特定子项目 |
| **索引可能滞后于最新提交** | 如果索引是凌晨 CI 跑的而你今天早上刚拉了新代码，新文件/新函数可能还没进索引 |

## 工作流

```
1. list_repos({})                                  → 发现团队有哪些仓库已索引
2. READ gitnexus://repo/{name}/context              → 代码库概览 + 检查索引是否过期
3. READ gitnexus://repo/{name}/clusters             → 了解有哪些功能模块（社区检测结果）
4. query({search_query: "<你想理解的概念>", repo: "<仓库名>"})  → 找到相关执行流
5. context({name: "<符号名>", repo: "<仓库名>"})     → 深入看具体符号
6. READ gitnexus://repo/{name}/process/{name}        → 追踪完整执行流
```

> 步骤 2 提示"Index is stale"→ 联系服务端管理员触发 CI 索引更新。远程模式下开发者无法本地执行 `analyze`。
> 如果 `query` 返回的符号在本地文件中找不到——可能索引的是 `develop` 分支而你在 `feature` 分支上，文件结构发生了变化。

## 探索模式速查

| 你要什么 | 怎么做 | Token 代价 |
|---------|--------|-----------|
| "这个项目长什么样？" | READ `gitnexus://repo/{name}/context` + `clusters` | ~450 |
| "认证流程涉及哪些函数？" | `query({search_query: "authentication"})` | ~500-1500 |
| "这个函数被谁调用了？" | `context({name: "函数名"})` | ~500-1000 |
| "这两个函数之间的调用链？" | `trace({from: "A", to: "B"})` | ~300-800 |
| "整个执行流逐步骤" | READ `gitnexus://repo/{name}/process/{name}` | ~200 |
| "这个模块有哪些文件和类？" | READ `gitnexus://repo/{name}/cluster/{name}` | ~500 |

## Checklist

```
- [ ] list_repos 确认目标仓库已索引
- [ ] READ gitnexus://repo/{name}/context 获取概况 + 确认新鲜度
- [ ] 可选：READ clusters 了解功能模块分布
- [ ] query 搜索你想理解的概念
- [ ] 查看返回的 processes，挑最相关的深入
- [ ] context 看关键符号的调用者/被调用者
- [ ] trace 看两个符号之间的最短路径（如果需要）
- [ ] READ process 资源获取逐步执行路径
- [ ] 读本地源文件确认实现细节
```

## 资源

| 资源 | 内容 | Token 消耗 |
|------|------|-----------|
| `gitnexus://repos` | 已索引仓库列表 | ~100 |
| `gitnexus://repo/{name}/context` | 统计信息、过期警告 | ~150 |
| `gitnexus://repo/{name}/clusters` | 所有功能模块及内聚度评分 | ~300 |
| `gitnexus://repo/{name}/cluster/{name}` | 模块成员及文件路径 | ~500 |
| `gitnexus://repo/{name}/processes` | 所有执行流 | ~500 |
| `gitnexus://repo/{name}/process/{name}` | 逐步执行路径 | ~200 |
| `gitnexus://repo/{name}/schema` | Cypher 查询的图 Schema | ~150 |

## 工具说明

**query** —— 找到与概念相关的执行流（混合 BM25 + 语义搜索）：

```
query({search_query: "支付处理", repo: "my-app"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ 符号按执行流分组，附带文件位置
```

如果返回空结果，说明索引中没有匹配的代码。可能的原因：索引过期（新代码还没进）、搜索词太宽泛/太具体、或者这个概念用不同的命名惯例。如果代码确认存在但搜不到，联系管理员触发重新索引。

**context** —— 符号的 360° 全景视图，锚定必须有 `name` 或 `uid`：

```
context({name: "validateUser", repo: "my-app"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (第 2/5 步), TokenRefresh (第 1/3 步)
```

如果 `name` 含糊（比如多个文件里都有 `validateUser`），`context` 返回候选人列表而非瞎猜。用 `file_path` 或 `uid` 消歧。

**trace** —— 两个符号间的最短调用路径，一次调用代替 3-8 次手动的 context 跳转：

```
trace({from: "processCheckout", to: "fetchRates", repo: "my-app"})
→ status: ok, hopCount: 3
→ hops: processCheckout → validatePayment → verifyCard → fetchRates
```

当路径不存在时，`trace` 显示最远可达的节点——精确指出调用链在哪里断的（动态分发、反射或外部边界）。

**cypher** —— 需要自定义查询时使用（先读 schema）：

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "validateUser"})
RETURN caller.name, caller.filePath
```

## 示例："支付处理是怎么实现的？"

```
1. list_repos → my-app（已索引）, shared-lib（已索引）

2. READ gitnexus://repo/my-app/context       → 918 符号, 45 执行流, 新鲜 ✅

3. READ gitnexus://repo/my-app/clusters      → Payments, Auth, API, Database, ...

4. query({search_query: "支付处理", repo: "my-app"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund

5. context({name: "processPayment", repo: "my-app"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction
   → Outgoing: fetchRates（在 shared-lib 中！跨仓库调用）

6. trace({from: "checkoutHandler", to: "saveTransaction", repo: "my-app"})
   → checkoutHandler → processPayment → saveTransaction (置信度 1.0/0.95/1.0)

7. 读本地文件 src/payments/processor.ts 确认实现细节
```

## 陷阱与提示

| 陷阱 | 提示 |
|------|------|
| query 结果命中了不认识的符号 | 文件路径是服务端上的——检查你的本地 clone 是否最新 |
| context 返回 ambiguous 候选人 | 用 `file_path` 或 `uid` 消歧，别猜 |
| trace 返回 no_path | 链条在某个动态调用（反射/回调/外部 API）处断了——用 context 手动跳 |
| 新功能搜不到 | 索引可能还没更新——确认索引的 lastCommit 是否包含你的目标代码 |
| 跨模块引用不理解 | 用 `context` 看符号的 processes 列——它告诉你这个符号参与了哪些端到端流程 |
