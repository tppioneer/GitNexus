---
name: gitnexus-pr-review-zh
description: "当用户想要审查 PR、理解 PR 改了什么、评估合并风险或检查测试覆盖时使用。示例：\"审查这个 PR\"、\"PR #42 改了哪些？\"、\"这个 PR 安全吗？\""
---

# 用 GitNexus 审查 PR

## 适用场景

- "审查这个 PR"
- "PR #42 改了哪些？"
- "这个 PR 安全吗？"
- "这个 PR 的爆炸半径多大？"
- "这个 PR 有没有缺测试？"
- 合并前审查别人的代码改动

## 工作流

```
1. gh pr diff <number>                                    → 获取原始 diff
2. detect_changes({scope: "compare", base_ref: "main"})  → 将 diff 映射到受影响执行流
3. 针对每个被改的符号:
   impact({target: "<symbol>", direction: "upstream"})    → 每个改动的爆炸半径
4. context({name: "<关键符号>"})                  → 理解调用者/被调用者
5. READ gitnexus://repo/{name}/processes                   → 检查受影响执行流
6. 汇总发现 + 风险评估
```

> "Index is stale" → 联系服务端管理员触发 CI 索引更新。审查 PR 前请确认远程索引已同步到最新 `main` 分支。

## Checklist

```
- [ ] 获取 PR diff（gh pr diff 或 git diff base...head）
- [ ] detect_changes 将改动映射到受影响执行流
- [ ] impact 分析每个非平凡被改符号
- [ ] 审查 d=1 项（WILL BREAK）— 调用者是否都更新了？
- [ ] context 查看关键被改符号的完整关系
- [ ] 检查受影响执行流是否有测试覆盖
- [ ] 评估整体风险等级
- [ ] 输出审查总结
```

## 审查维度

| 维度 | GitNexus 如何帮助 |
|------|------------------|
| **正确性** | `context` 查看调用者——改动是否与它们兼容？ |
| **爆炸半径** | `impact` 显示 d=1/d=2/d=3 依赖——有没有遗漏？ |
| **完整性** | `detect_changes` 显示所有受影响执行流——是否都处理了？ |
| **测试覆盖** | `impact({includeTests: true})` 显示哪些测试接触了改动代码 |
| **破坏性变更** | PR diff 外的 d=1 上游项 = 潜在 breakage |

## 风险评估

| 信号 | 风险 |
|------|------|
| 改动 <3 符号, 0-1 执行流 | LOW |
| 改动 3-10 符号, 2-5 执行流 | MEDIUM |
| 改动 >10 符号或大量执行流 | HIGH |
| 改动涉及认证、支付或数据完整性代码 | CRITICAL |
| PR diff 外存在 d=1 调用者 | 潜在 breakage——需标记 |

## 示例："审查 PR #42"

```
1. gh pr diff 42 > /tmp/pr42.diff
   → 4 文件改动: payments.ts, checkout.ts, types.ts, utils.ts

2. detect_changes({scope: "compare", base_ref: "main"})
   → Changed: validatePayment, PaymentInput, formatAmount
   → Affected processes: CheckoutFlow, RefundFlow
   → Risk: MEDIUM

3. impact({target: "validatePayment", direction: "upstream"})
   → d=1: processCheckout, webhookHandler (WILL BREAK)
   → webhookHandler 不在 PR diff 中——潜在 breakage!

4. impact({target: "PaymentInput", direction: "upstream"})
   → d=1: validatePayment（在 PR 中）, createPayment（不在 PR 中）
   → createPayment 还在用旧的 PaymentInput 结构——破坏性变更!

5. context({name: "formatAmount"})
   → 被 12 个函数调用——但改动向后兼容（加了可选参数）

6. 审查总结:
   - MEDIUM 风险——3 个被改符号影响 2 个执行流
   - BUG: webhookHandler 调用了 validatePayment 但没更新签名
   - BUG: createPayment 依赖了已变更的 PaymentInput 类型
   - OK: formatAmount 改动向后兼容
   - 测试: checkout.test.ts 覆盖了 processCheckout 路径，但 webhook 没测试
```

## 审查输出模板

```markdown
## PR Review: <title>

**Risk: LOW / MEDIUM / HIGH / CRITICAL**

### Changes Summary
- <N> 符号改动跨 <M> 文件
- <P> 执行流受影响

### Findings
1. **[严重度]** 发现描述
   - GitNexus 工具给出的证据
   - 受影响的调用者/执行流

### Missing Coverage
- PR 中未更新的调用者: ...
- 未测试的执行流: ...

### Recommendation
APPROVE / REQUEST CHANGES / NEEDS DISCUSSION
```
