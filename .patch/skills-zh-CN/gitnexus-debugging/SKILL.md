---
name: gitnexus-debugging-zh
description: "当用户在调试 Bug、追踪错误或问为什么某段代码失败时使用（远程模式）。示例：\"为什么 X 失败了？\"、\"这个错误从哪来的？\"、\"追踪这个 Bug\""
---

# 用 GitNexus 调试（远程模式）

## 适用场景

- "为什么这个函数会失败？"
- "追踪这个错误从哪来的"
- "谁调用了这个方法？"
- "这个接口返回 500"

## 远程模式须知

知识图谱是你的调试入口——通过调用链和执行流定位根因。图谱返回的文件路径指向服务端，调试阶段用图谱工具完成推理，然后用 `read_remote_file` 阅读可疑源码确认根因。确认后可自由操作本地文件来修复。

> "Index is stale" → 联系服务端管理员触发 CI 索引更新。

## 工作流

```
1. query({search_query: "<错误或症状>", repo: "<仓库名>"})   → 找到相关执行流
2. context({name: "<可疑符号>", repo: "<仓库名>"})   → 查看调用者/被调用者
3. READ gitnexus://repo/{name}/process/{name}                → 追踪执行流
4. trace({from: "A", to: "B", repo: "<仓库名>"})     → 最短调用路径
5. cypher 自定义查询（如果需要）
6. read_remote_file({file_path: "<路径>"})           → 阅读可疑源码确认根因
```

## Checklist

```
- [ ] 理解症状
- [ ] query 搜索错误文本或相关代码
- [ ] 从返回的执行流中锁定可疑函数
- [ ] context 查看调用者和被调用者
- [ ] 如果涉及，通过 process 资源追踪执行流
- [ ] trace 看最短调用路径
- [ ] cypher 自定义查询（如果需要）
- [ ] read_remote_file 阅读可疑源码确认根因
```

## 调试模式速查

| 症状 | GitNexus 方法 |
|------|--------------|
| 错误消息 | `query` 搜错误文本 → `context` 查看 throw 点 |
| 错误返回值 | `context` 看函数 → 追踪被调用者的数据流 |
| 间歇性故障 | `context` → 找外部调用、异步依赖 |
| 性能问题 | `context` → 找调用者最多的符号（热路径） |
| 近期回归 | `detect_changes` 查看改动影响了哪些地方 |
| "A 怎么到 B？" | `trace` 一次调用找到最短调用链 |

## 工具说明

**query** —— 找到与错误相关的代码：

```
query({search_query: "支付验证错误"})
→ Processes: CheckoutFlow, ErrorHandling
→ Symbols: validatePayment, handlePaymentError, PaymentException
```

**context** —— 可疑符号的完整上下文：

```
context({name: "validatePayment"})
→ Incoming calls: processCheckout, webhookHandler
→ Outgoing calls: verifyCard, fetchRates（外部 API!）
→ Processes: CheckoutFlow（第 3/7 步）
```

**trace** —— "A 怎么调用到 B？"一次查询搞定：

```
trace({ from: "processCheckout", to: "fetchRates" })
→ status: ok, hopCount: 3
→ hops: processCheckout → validatePayment → verifyCard → fetchRates
→ edges: CALLS (1.0), CALLS (0.95), CALLS (1.0)
```

**read_remote_file** —— 阅读图谱定位到的可疑源码文件：

```
read_remote_file({file_path: "src/services/fetchRates.ts", repo: "my-app"})
→ 返回带行号的 Markdown 代码块

read_remote_file({file_path: "src/large-handler.ts", start_line: 80, end_line: 150, repo: "my-app"})
→ 只返回第 80-150 行，聚焦关键逻辑
```

## 示例："支付接口间歇性 500"

```
1. query({search_query: "支付错误处理", repo: "my-app"})
   → Processes: CheckoutFlow, ErrorHandling
   → Symbols: validatePayment, handlePaymentError

2. context({name: "validatePayment", repo: "my-app"})
   → Outgoing calls: verifyCard, fetchRates（外部 API!）

3. trace({from: "validatePayment", to: "fetchRates", repo: "my-app"})
   → validatePayment → verifyCard → fetchRates

4. READ gitnexus://repo/my-app/process/CheckoutFlow
   → Step 3: validatePayment → 调用了 fetchRates（外部调用）

5. read_remote_file({file_path: "src/services/fetchRates.ts", repo: "my-app"})
   → 确认 fetchRates 实现中 fetch() 调用确实没有配置 timeout

6. 根因: fetchRates 调用外部 API 没有适当超时
```
