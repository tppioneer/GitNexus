---
name: gitnexus-taint-analysis-zh
description: "当操作、审查或扩展 GitNexus 的 CFG/污点/PDG 子系统（--pdg 层）或推理 source→sink 数据流发现时使用。示例：\"污点分析在这里怎么工作的？\"、\"为什么 explain 没报告这个流？\"、\"添加新的 sink/source\"、\"审查过程间污点代码\""
---

# GitNexus CFG 与污点分析

可选的 `--pdg` 程序分析子系统的专业知识：控制流图、到达定值、过程内+过程间污点。在操作 `gitnexus/src/core/ingestion/cfg/**` 或 `gitnexus/src/core/ingestion/taint/**` 之前请先读此文件。

## 适用场景

- "污点引擎怎么工作 / 为什么这个流（没）被报告？"
- 向模型中添加 source、sink 或 sanitizer
- 扩展或审查 CFG / 到达定值 / 污点 / 摘要代码
- 理解 `explain` MCP 工具的发现（过程内 vs 过程间）
- Debug `--pdg` 输出中的误报或漏报

## 分层基底（构建顺序）

污点运行在图**之上**，不是图之外。每层通过 `--pdg` 可选开启，默认 `analyze` 运行**字节完全一致**。

```
L1  CFG             每个函数的基本块 + 控制流边           (M1)
L2  REACHING_DEF    GEN/KILL def→use 数据依赖（纯求解器）  (M2)
L3  Taint (过程内)  基于 RD fact 的 source→sink，扣除 sanitizer (M3)
L4  Taint (过程间)  基于 CALLS 图组合每个函数的摘要         (M4)
```

- **Worker 构建，主线程求解。** 解析 worker 构建每个函数的 CFG + 提取 def/use + 调用点信息到 `ParsedFile.cfgSideChannel`（纯数据，非 AST 节点）。主线程运行纯求解器。绝不在主线程重新解析。
- **纯求解器契约。** `computeReachingDefs`、`computeTaintFlows`、`harvestFunctionSummary`、`solveInterprocTaint` 都是纯函数、确定性、无副作用。

## 过程内污点（L3）

基于 RD fact 从匹配的 **source** 到匹配的 **sink** 做前向可达性分析，被 **sanitizer** 杀死。

- **出现位置标记。** 记录了嵌套调用结构，sanitizer 插入判定精确。
- **Kind-set 消毒模型。** 污点携带被中和的 `SinkKind` 集合；sink 除非其 kind 在集合中否则触发。`escape(req.body)` 抑制 xss 但仍触发 sql 注入。
- **语句级发现标识。** 不是块对——块合并会丢失不同的发现。
- 持久化为 `TAINTED` 边（BasicBlock→BasicBlock）；路径在 `reason` 列。

## 过程间污点（L4）——函数/摘要方法

生产方法（Sharir-Pnueli 1981；与 Meta Pysa 和 Mariana Trench、FB Infer 同形）。每个函数被归约为紧凑的**摘要**，摘要通过已解析的 `CALLS` 图组合。

**摘要形状**（全参数粒度）：

| 边 | 含义 |
|----|------|
| `param→return` | 参数流到返回值 |
| `param→callee-arg` | 参数流到调用的第 j 个参数 |
| `param→sink` | 参数到达建模的 sink |
| `source→return` | 函数生成并返回 source |
| `source→callee-arg` | 生成的 source 流到调用中 |
| `callResults` | 用户函数调用的结果流入调用者的 sink/return/callee-arg |

**不动点求解**：单元为 `(function, parameter, source)`。从 `source→callee-arg` 种子出发，通过单调性子格收敛。递归调用只是重新提议已访问的条目。

## 已知漏报类别

- **闭包/回调**（`arr.forEach(() => sink(y))`）
- 字段/属性流（`obj.x = taint; sink(obj.y)`）
- 解构/剩余参数在已污染简单参数之前
- 过程间连接是上下文不敏感的

**没有发现不代表安全。**

## 添加 source / sink / sanitizer

编辑语言模型（如 `taint/typescript-model.ts`），通过显式的 `registerBuiltinTaintModels` 注册。sanitizer 的 `neutralizes` 列出**精确**的 sink kind——绝不用万能杀死。添加 fixture + 在 `test/unit/taint/` 中断言。

## 验证 Checklist

```
1. tsc 干净通过
2. 按目录隔离运行 vitest
3. Flag-off 黄金字节一致性测试
4. bench/cfg/measure.mjs --check
5. 提交前 detect_changes()；编辑共享符号前 impact({direction:'upstream'})
```
