---
name: gitnexus-impact-analysis-local
description: "当用户想知道改某个东西会破坏什么、或需要改代码前的安全分析时使用（本地模式）。示例：\"改 X 安全吗？\"、\"谁依赖这个？\"、\"会影响什么？\""
---

# 用 GitNexus 做影响分析（本地模式）

## 适用场景

- "改动这个函数安全吗？"
- "如果改 X 会破坏什么？"
- "给我看爆炸半径"
- "谁在用这个代码？"
- 做任何非平凡代码改动之前
- 提交之前——运行 `detect_changes()` 理解你的改动影响到什么

## 本地模式须知

| 概念 | 说明 |
|------|------|
| **索引由你自己维护** | 过期了就运行 `node .gitnexus/run.cjs analyze` |
| **`detect_changes` 全范围可用** | `"all"` / `"staged"` / `"unstaged"` 针对本地工作区；`"compare"` 比较分支 |
| **`rename` 直接修改本地文件** | 图辅助重命名在你的文件系统上执行编辑 |

## 工作流

```
1. impact({target: "X", direction: "upstream"})  → 谁依赖这个
2. READ gitnexus://repo/{name}/processes                   → 检查受影响的执行流
3. detect_changes()                               → 将当前 git 改动映射到受影响执行流
4. 评估风险并报告
```

> "Index is stale" → 运行 `node .gitnexus/run.cjs analyze`。

## Checklist

```
- [ ] impact({target, direction: "upstream"}) 找到所有依赖者
- [ ] 优先审查 d=1 项（这些 WILL BREAK）
- [ ] 检查高置信度（>0.8）的依赖
- [ ] READ processes 检查受影响的执行流
- [ ] detect_changes() 做 pre-commit 检查：unstaged 看全部、staged 看已暂存
- [ ] 评估风险等级并报告
```

## 输出理解

| 深度 | 风险等级 | 含义 |
|------|---------|------|
| d=1 | **WILL BREAK** | 直接调用者/导入者 |
| d=2 | LIKELY AFFECTED | 间接依赖 |
| d=3 | MAY NEED TESTING | 传递性影响 |

## 风险评估

| 影响范围 | 风险 |
|---------|------|
| <5 符号, 少量执行流 | LOW |
| 5-15 符号, 2-5 执行流 | MEDIUM |
| >15 符号或大量执行流 | HIGH |
| 关键路径（认证、支付） | CRITICAL |

## 工具说明

**impact** —— 符号爆炸半径主工具：

```
impact({target: "validateUser", direction: "upstream", minConfidence: 0.8, maxDepth: 3})

→ d=1 (WILL BREAK):
  - loginHandler (src/auth/login.ts:42) [CALLS, 100%]
  - apiMiddleware (src/api/middleware.ts:15) [CALLS, 100%]
→ d=2 (LIKELY AFFECTED):
  - authRouter (src/routes/auth.ts:22) [CALLS, 95%]
```

**detect_changes** —— 基于 git-diff 的影响分析：

```
detect_changes({scope: "staged"})      → 仅已暂存改动
detect_changes({scope: "all"})         → 全部未提交改动
detect_changes({scope: "unstaged"})    → 仅未暂存改动
detect_changes({scope: "compare", base_ref: "main"})  → 比较当前分支 vs main
```

## 示例："改 validateUser 会破坏什么？"

```
1. impact({target: "validateUser", direction: "upstream"})
   → d=1: loginHandler, apiMiddleware (WILL BREAK)
   → d=2: authRouter, sessionManager (LIKELY AFFECTED)

2. READ gitnexus://repo/my-app/processes
   → LoginFlow 和 TokenRefresh 涉及 validateUser

3. detect_changes({scope: "all"})
   → 在提交前确认你的改动只影响预期的执行流

4. Risk: 2 个直接调用者, 2 个执行流 = MEDIUM
```
