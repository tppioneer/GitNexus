---
name: gitnexus-impact-analysis-zh
description: "当用户想知道改某个东西会破坏什么、或需要改代码前的安全分析时使用（远程模式）。示例：\"改 X 安全吗？\"、\"谁依赖这个？\"、\"会影响什么？\""
---

# 用 GitNexus 做影响分析（远程模式）

## 适用场景

- "改动这个函数安全吗？"
- "如果改 X 会破坏什么？"
- "给我看爆炸半径"
- "谁在用这个代码？"
- 做非平凡代码改动之前
- 提交之前——`detect_changes({scope: "compare"})` 比较你的分支 vs 基准分支

## 远程模式须知

| 概念 | 说明 |
|------|------|
| **`detect_changes` 仅 `"compare"` 模式有意义** | 比较本地工作区 vs 远程索引的 lastCommit |
| **索引反映基准分支** | 默认为 `develop`，不是你的 feature 分支 |
| **联系管理员** | 索引过期了自己修不了，需要服务端 CI 触发 |

## 工作流

```
1. impact({target: "X", direction: "upstream", repo: "<仓库名>"})  → 谁依赖这个
2. READ gitnexus://repo/{name}/processes                                    → 检查受影响的执行流
3. detect_changes({scope: "compare", base_ref: "develop"})          → 将分支 diff 映射到受影响执行流
4. 评估风险并报告
```

> "Index is stale" → 联系服务端管理员触发 CI 索引更新。

## Checklist

```
- [ ] impact({target, direction: "upstream", repo}) 找到所有依赖者
- [ ] 优先审查 d=1 项（WILL BREAK）
- [ ] 检查高置信度（>0.8）的依赖
- [ ] READ processes 检查受影响的执行流
- [ ] detect_changes({scope: "compare", base_ref: "develop"}) 映射分支差异
- [ ] 评估风险等级
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
| 关键路径 | CRITICAL |

## 工具说明

**impact**：

```
impact({target: "validateUser", direction: "upstream", minConfidence: 0.8, maxDepth: 3, repo: "my-app"})
→ d=1: loginHandler (src/auth/login.ts:42) [CALLS, 100%]
→ d=2: authRouter (src/routes/auth.ts:22) [CALLS, 95%]
```

**detect_changes**（远程模式下仅 `"compare"` 可用）：

```
detect_changes({scope: "compare", base_ref: "develop", repo: "my-app"})
→ Changed: 5 符号, 3 文件
→ Affected: LoginFlow, TokenRefresh
→ Risk: MEDIUM
```

## 示例："改 validateUser 会破坏什么？"

```
1. impact({target: "validateUser", direction: "upstream", repo: "my-app"})
   → d=1: loginHandler, apiMiddleware (WILL BREAK)
   → d=2: authRouter, sessionManager (LIKELY AFFECTED)

2. READ gitnexus://repo/my-app/processes
   → LoginFlow 和 TokenRefresh 涉及 validateUser

3. detect_changes({scope: "compare", base_ref: "develop", repo: "my-app"})
   → 确认改动影响范围 vs 预期

4. Risk: 2 个直接调用者, 2 个执行流 = MEDIUM
```
