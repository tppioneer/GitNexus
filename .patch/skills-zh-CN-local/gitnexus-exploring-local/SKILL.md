---
name: gitnexus-exploring-local-zh
description: "当用户询问代码如何工作、想理解架构、追踪执行流或探索不熟悉的代码部分时使用（本地模式）。示例：\"X 是怎么工作的？\"、\"谁调用了这个函数？\"、\"给我看认证流程\""
---

# 用 GitNexus 探索代码（本地模式）

## 适用场景

- "认证是怎么实现的？"
- "项目的整体结构是什么？"
- "给我看看主要组件"
- "数据库逻辑在哪里？"
- 理解从未见过的代码
- 新人上手新模块——直接看知识图谱，最后读源文件验证

## 本地模式须知

你在同一台机器上拥有代码和索引，图谱中的文件路径直接对应本地文件。

| 概念 | 说明 |
|------|------|
| **文件路径 = 本地路径** | `query`/`context` 返回的 filePath 就是本地绝对路径，直接 `Read` 打开 |
| **索引由你自己维护** | 过期了就运行 `node .gitnexus/run.cjs analyze` |
| **`detect_changes` 覆盖全范围** | `"all"` / `"staged"` / `"unstaged"` / `"compare"` 四种 scope 均可使用 |
| **`rename` 直接在本地执行** | 图辅助重命名会直接修改你本地的源文件 |

## 工作流

```
1. list_repos({})                                   → 发现已索引仓库
2. READ gitnexus://repo/{name}/context               → 代码库概览 + 检查索引是否过期
3. READ gitnexus://repo/{name}/clusters              → 了解有哪些功能模块（社区检测结果）
4. query({search_query: "<你想理解的概念>"})            → 找到相关执行流
5. context({name: "<符号名>"})                 → 深入看具体符号
6. READ gitnexus://repo/{name}/process/{name}         → 追踪完整执行流
7. Read 源文件确认实现细节
```

> 步骤 2 提示"Index is stale"→ 运行 `node .gitnexus/run.cjs analyze`。

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
- [ ] Read 图谱返回的 filePath 打开源文件确认细节
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
query({search_query: "支付处理"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ 符号按执行流分组，附带文件位置
```

**context** —— 符号的 360° 全景视图，锚定必须有 `name` 或 `uid`：

```
context({name: "validateUser"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (第 2/5 步), TokenRefresh (第 1/3 步)
```

如果 `name` 含糊（多个文件里都有 `validateUser`），`context` 返回候选人列表。用 `file_path` 或 `uid` 消歧。

**trace** —— 两个符号间的最短调用路径：

```
trace({from: "processCheckout", to: "fetchRates"})
→ status: ok, hopCount: 3
→ hops: processCheckout → validatePayment → verifyCard → fetchRates
```

## 示例："支付处理是怎么实现的？"

```
1. list_repos → my-app（已索引）

2. READ gitnexus://repo/my-app/context       → 918 符号, 45 执行流, 新鲜 ✅

3. READ gitnexus://repo/my-app/clusters      → Payments, Auth, API, Database, ...

4. query({search_query: "支付处理"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund

5. context({name: "processPayment"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction

6. trace({from: "checkoutHandler", to: "saveTransaction"})
   → checkoutHandler → processPayment → saveTransaction (置信度 1.0/0.95/1.0)

7. Read src/payments/processor.ts 确认实现细节
```

## 陷阱与提示

| 陷阱 | 提示 |
|------|------|
| context 返回 ambiguous 候选人 | 用 `file_path` 或 `uid` 消歧，别猜 |
| trace 返回 no_path | 链条在某个动态调用（反射/回调/外部 API）处断了——用 context 手动跳 |
| 新代码搜不到 | 索引过期了——运行 `node .gitnexus/run.cjs analyze` 更新 |
| 跨模块引用不理解 | 用 `context` 看符号的 processes 列——它告诉你参与了哪些端到端流程 |
