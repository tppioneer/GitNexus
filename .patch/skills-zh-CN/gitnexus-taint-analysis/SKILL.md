---
name: gitnexus-taint-analysis-zh
description: "当操作、审查或扩展 GitNexus 的 CFG/污点/PDG 子系统（--pdg 层）时使用。需 `analyze --pdg`。"
---

# GitNexus CFG 与污点分析

可选的 `--pdg` 程序分析子系统的专业知识。

## 分层基底

```
L1  CFG             每个函数的基本块 + 控制流边
L2  REACHING_DEF    GEN/KILL def→use 数据依赖
L3  Taint (过程内)  基于 RD fact 的 source→sink，扣除 sanitizer
L4  Taint (过程间)  基于 CALLS 图组合每个函数的摘要
```

- **Worker 构建，主线程求解。** 绝不在主线程重新解析。
- **纯求解器契约。** 所有求解器纯函数、确定性、无副作用。

## 过程内污点（L3）

从匹配的 source 到匹配的 sink 做前向可达性分析，被 sanitizer 杀死。

- **Kind-set 消毒模型：** 污点携带被中和的 SinkKind 集合；sink 除非其 kind 在集合中否则触发。
- 持久化为 `TAINTED` 边（BasicBlock→BasicBlock）。

## 过程间污点（L4）

Sharir-Pnueli 函数式摘要方法。每个函数归约为紧凑摘要，通过 `CALLS` 图组合。

| 边 | 含义 |
|----|------|
| `param→return` | 参数流到返回值 |
| `param→sink` | 参数到达建模的 sink |
| `source→return` | 函数生成并返回 source |

**不动点求解：** 单元为 `(function, parameter, source)`，单调收敛。

## 已知漏报

- 闭包/回调（`arr.forEach(() => sink(y))`）
- 字段/属性流（`obj.x = taint; sink(obj.y)`）
- 过程间上下文不敏感

**没有发现不代表安全。**

## 添加 source / sink / sanitizer

编辑语言模型，通过 `registerBuiltinTaintModels` 注册。sanitizer 的 `neutralizes` 列出精确的 sink kind。添加 fixture + 单元测试。
