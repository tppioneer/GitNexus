---
name: gitnexus-pr-review-local-zh
description: "当用户想要审查 PR、理解 PR 改了什么、评估合并风险或检查测试覆盖时使用（本地模式）。示例：\"审查这个 PR\"、\"PR #42 改了哪些？\"、\"这个 PR 安全吗？\""
---

# 用 GitNexus 审查 PR（本地模式）

## 适用场景

- "审查这个 PR"
- "PR #42 改了哪些？"
- "这个 PR 安全吗？"
- "这个 PR 的爆炸半径多大？"
- "这个 PR 有没有缺测试？"

## 本地模式须知

你需要在本地有仓库的 clone，且索引已更新到当前基准分支。审查前先 `git fetch origin`。

## 工作流

```
1. gh pr diff <number> 或 git diff base...head               → 获取 diff
2. detect_changes({scope: "compare", base_ref: "main"})     → 将 diff 映射到受影响执行流
3. 针对每个被改的符号:
   impact({target: "<symbol>", direction: "upstream"})       → 每个改动的爆炸半径
4. context({name: "<关键符号>"})                     → 理解调用者/被调用者
5. READ gitnexus://repo/{name}/processes                      → 检查受影响执行流
6. Read 被改的源文件
7. 汇总发现 + 风险评估
```

> "Index is stale" → 运行 `node .gitnexus/run.cjs analyze`。

## Checklist

```
- [ ] git fetch origin && 确认本地索引新鲜
- [ ] 获取 PR diff
- [ ] detect_changes({scope: "compare", base_ref: "main"}) 映射改动到执行流
- [ ] impact 分析每个非平凡被改符号
- [ ] 审查 d=1 项（WILL BREAK）— 调用者是否 PR 中都更新了？
- [ ] context 查看关键被改符号的完整关系
- [ ] Read 被改的源文件
- [ ] 检查受影响执行流是否有测试覆盖
- [ ] 评估整体风险等级
```

## 审查维度

| 维度 | GitNexus 如何帮助 |
|------|------------------|
| **正确性** | `context` 查看调用者——改动是否与它们兼容？ |
| **爆炸半径** | `impact` 显示 d=1/d=2/d=3 依赖——有没有遗漏？ |
| **完整性** | `detect_changes` 显示所有受影响执行流——是否都处理了？ |
| **测试覆盖** | `impact({includeTests: true})` 显示哪些测试接触了改动代码 |
| **破坏性变更** | PR diff 外的 d=1 上游项 = 潜在 breakage |

## 工具说明

**detect_changes** —— 比较分支差异：

```
detect_changes({scope: "compare", base_ref: "main"})
→ Changed: 8 符号, 4 文件
→ Affected processes: CheckoutFlow, RefundFlow
→ Risk: MEDIUM
```

**impact with tests** —— 检查测试覆盖：

```
impact({target: "validatePayment", direction: "upstream", includeTests: true})
→ Tests: validatePayment.test.ts [direct], checkout.integration.test.ts [via processCheckout]
```

## 示例："审查 PR #42"

```
1. gh pr diff 42 → 4 文件改动: payments.ts, checkout.ts, types.ts, utils.ts

2. detect_changes({scope: "compare", base_ref: "main"})
   → Changed: validatePayment, PaymentInput, formatAmount
   → Affected processes: CheckoutFlow, RefundFlow
   → Risk: MEDIUM

3. impact({target: "validatePayment", direction: "upstream"})
   → d=1: processCheckout, webhookHandler (WILL BREAK)
   → webhookHandler 不在 PR diff 中——潜在 breakage!

4. context({name: "PaymentInput"})
   → createPayment 不在 PR 中但依赖了变更的类型——破坏性变更!

5. Read src/payments/processor.ts, src/types/payments.ts 确认

6. 审查总结: MEDIUM 风险, 2 处 breakage 需修复, formatAmount 改动 OK
```
