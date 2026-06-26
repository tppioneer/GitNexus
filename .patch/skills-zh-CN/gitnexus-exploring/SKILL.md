---
name: gitnexus-exploring
description: "当用户询问代码如何工作、想理解架构、追踪执行流或探索不熟悉的代码部分时使用（远程模式）。示例：\"X 是怎么工作的？\"、\"谁调用了这个函数？\"、\"给我看认证流程\""
---

# 用 GitNexus 探索代码（远程模式）

## 适用场景

- "认证是怎么实现的？"
- "项目的整体结构是什么？"
- "给我看看主要组件"
- "数据库逻辑在哪里？"
- 理解从未见过的代码
- 新人上手新模块——知识图谱就是你的代码地图

## 远程模式须知

| 概念 | 说明 |
|------|------|
| **图谱返回的文件路径指向服务端** | 探索阶段用 `read_remote_file` 阅读源码实现，不要用本地 `Read` 去验证图谱结果——源文件在远程服务器上，本地不一定有 |
| **知识图谱是团队的共享地图** | 索引由服务端定期维护，反映基准分支 `develop` 的代码结构 |
| **多仓库需带 `repo` 参数** | 远程服务器可能索引了多个仓库，`query`/`context`/`impact` 必须指明 `repo` |
| **`service` 参数用于微服务/大仓** | monorepo 用 `service` 限定到特定子项目 |
| **索引可能滞后于最新提交** | CI 定时索引，新代码可能还没进索引 |

## 工作流

```
1. list_repos({})                                  → 发现团队有哪些仓库已索引
2. READ gitnexus://repo/{name}/context              → 代码库概览 + 检查索引是否过期
3. READ gitnexus://repo/{name}/clusters             → 了解有哪些功能模块
4. query({search_query: "<概念>", repo: "<仓库名>"}) → 找到相关执行流
5. context({name: "<符号名>", repo: "<仓库名>"})     → 深入看具体符号
6. READ gitnexus://repo/{name}/process/{name}        → 追踪完整执行流
7. read_remote_file({file_path: "<路径>"})           → 阅读图谱定位到的源码实现
```

> 步骤 2 提示"Index is stale"→ 联系服务端管理员触发 CI 索引更新。
> 如果 `query` 返回的符号不熟悉——可能索引的是 `develop` 分支而你在 `feature` 分支上。

## 探索模式速查

| 你要什么 | 怎么做 |
|---------|--------|
| "这个项目长什么样？" | READ `context` + `clusters` |
| "认证流程涉及哪些函数？" | `query({search_query: "authentication"})` |
| "这个函数被谁调用了？" | `context({name: "函数名"})` |
| "这两个函数之间的调用链？" | `trace({from: "A", to: "B"})` |
| "整个执行流逐步骤" | READ `process/{name}` |
| "这个函数的具体代码是怎么写的？" | `read_remote_file({file_path: "src/..."})` |
| "这个模块有哪些文件和类？" | READ `cluster/{name}` |

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
- [ ] read_remote_file 阅读关键源文件的实现细节
- [ ] 用 `context`、`trace`、`query` 继续深挖，图谱已有全部结构信息
- [ ] 理解完成后，可自由 `Read`/`Edit` 你自己的本地文件来实现修改方案（skill 内的限制仅适用于验证图谱结果的阶段）
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

如果返回空结果：索引过期、搜索词太宽泛/太具体、或该概念用不同命名习惯。联系管理员触发重新索引。

**context** —— 符号的 360° 全景视图，锚定必须有 `name` 或 `uid`：

```
context({name: "validateUser", repo: "my-app"})
→ Incoming: loginHandler, apiMiddleware
→ Outgoing: checkToken, getUserById
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

**trace 失败兜底**：当 trace 返回 `no_path` 或 `ambiguous` 时，用 `read_remote_file` 打开 `furthest.filePath` 或候选符号的 `filePath` 查看源码，结合 `context` 和 `cypher`（找实现类）手动补全调用链。

**cypher** —— 需要自定义查询时使用（先读 schema）：

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "validateUser"})
RETURN caller.name, caller.filePath
```

**read_remote_file** —— 从远程服务器读取索引仓库中的源文件（图谱探索的最后一步）：

```
read_remote_file({file_path: "src/payments/processor.ts", repo: "my-app"})
→ 返回带行号的 Markdown 代码块

read_remote_file({file_path: "src/large-module.ts", start_line: 50, end_line: 120, repo: "my-app"})
→ 只返回第 50-120 行，避免大文件 token 溢出
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

7. 用 context 深入看 fetchRates 在 shared-lib 中的入/出引用
   → 发现它依赖了一个外部汇率 API 的 HTTP 调用

8. read_remote_file({file_path: "src/payments/processor.ts", repo: "my-app"})
   → 阅读 processPayment 的完整实现代码
```

## 陷阱与提示

> **⚠️ 探索阶段：用 `read_remote_file` 阅读远程源码，不要用本地 `Read` 去验证图谱路径。** 源文件在远程服务器上，用 `read_remote_file` 工具来阅读实现细节；`context`、`trace`、`process` 用于理解结构和关系。**这条限制只作用于探索验证步骤：你仍然可以自由 `Read`/`Edit` 你自己的本地仓库来写代码。**

| 陷阱 | 提示 |
|------|------|
| 想去看源文件验证图谱结果 | 用 `read_remote_file({file_path})` 阅读远程源码实现 |
| 结果命中了不认识的符号 | 继续用 `context({name})` 展开它 |
| context 返回 ambiguous | 用 `file_path` 或 `uid` 消歧 |
| trace 返回 no_path | 链条在动态调用/反射/外部 API 处断了——用 context 手动跳 |
| 新功能搜不到 | 索引可能还没更新——确认 lastCommit 是否包含目标代码 |
