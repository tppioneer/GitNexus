---
name: gitnexus-pr-review
description: "当用户想要审查 PR、理解 PR 改了什么、评估合并风险或检查测试覆盖时使用（远程模式）。"
---

# 用 GitNexus 审查 PR（远程模式）

## 前提条件

需要仓库的本地 clone，并已 `git fetch origin` 确保基准分支是最新的。

## 工作流

```
1. gh pr diff <number> 或 git diff base...head                    → 获取 diff
2. detect_changes({scope: "compare", base_ref: "develop"})       → 映射 diff 到执行流
3. impact({target: "<符号>", direction: "upstream", repo: "<>"})  → 每个改动的爆炸半径
4. context({name: "<关键符号>", repo: "<>"})              → 理解调用者/被调用者
5. READ gitnexus://repo/{name}/processes                           → 检查受影响执行流
6. 汇总发现 + 风险评估
```

> "Index is stale" → 联系服务端管理员触发 CI 索引更新。审查前确认远程索引已同步到最新基准分支。

## Checklist

```
- [ ] git fetch origin && 确认远程索引新鲜
- [ ] detect_changes({scope: "compare", base_ref: "develop"})
- [ ] impact 分析每个非平凡被改符号
- [ ] 审查 d=1 项——PR diff 外的调用者 = 潜在 breakage
- [ ] context 查看关键被改符号的完整关系
- [ ] impact({includeTests: true}) 检查测试覆盖
- [ ] 评估风险等级
```

## 审查维度

| 维度 | GitNexus 如何帮助 |
|------|------------------|
| **正确性** | `context` 查看调用者——改动兼容吗？ |
| **爆炸半径** | `impact` 显示 d=1/d=2/d=3 依赖 |
| **完整性** | `detect_changes` 显示所有受影响执行流 |
| **测试覆盖** | `impact({includeTests: true})` |
| **破坏性变更** | PR diff 外的 d=1 项 = 潜在 breakage |

## 示例："审查 PR #42"

```
1. gh pr diff 42 → 4 文件改动

2. detect_changes({scope: "compare", base_ref: "develop", repo: "my-app"})
   → Changed: validatePayment, PaymentInput, formatAmount
   → Affected: CheckoutFlow, RefundFlow → Risk: MEDIUM

3. impact({target: "validatePayment", direction: "upstream", repo: "my-app"})
   → d=1: processCheckout, webhookHandler (WILL BREAK)
   → webhookHandler 不在 PR diff 中——潜在 breakage!

4. context({name: "PaymentInput", repo: "my-app"})
   → createPayment 不在 PR 中但依赖了变更的类型——破坏性变更!

5. 审查总结: MEDIUM 风险, 2 处 breakage, formatAmount 改动 OK
```

## 审查输出模板

```markdown
## PR Review: <title>

**Risk: LOW / MEDIUM / HIGH / CRITICAL**

### Changes Summary
- <N> 符号改动跨 <M> 文件, <P> 执行流受影响

### Findings
1. **[严重度]** 描述 + GitNexus 证据 + 受影响调用者

### Missing Coverage
- PR 中未更新的调用者: ...
- 未测试的执行流: ...

### Recommendation
APPROVE / REQUEST CHANGES / NEEDS DISCUSSION
```
