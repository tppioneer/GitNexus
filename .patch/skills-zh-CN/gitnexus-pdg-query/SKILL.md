---
name: gitnexus-pdg-query
description: "当查询或扩展 GitNexus 的 PDG 控制/数据依赖面（pdg_query MCP 工具、CDG/REACHING_DEF 边）时使用。需 `analyze --pdg`。"
---

# GitNexus PDG 查询面

`pdg_query` MCP 工具及控制/数据依赖边的专业知识——可选的 `--pdg` 程序依赖层。

## 适用场景

- "什么条件下这个语句会执行？"（守卫谓词）
- "这个变量在函数内怎么流动？"（def→use）
- Guard 子句发现（early-return guard）
- Debug 空的或意外的 `pdg_query` 结果

## 分层基底

```
L1  CFG            每个函数的基本块 + 控制流边
L2  REACHING_DEF   GEN/KILL def→use 数据依赖（纯求解器）
L5  CDG            Ferrante 控制依赖（后支配者树）
```

全部三层都是 `BasicBlock → BasicBlock` 边（同一个 `CodeRelation` 表）。**没有** `Function → BasicBlock` 边。

## 两种模式

- `pdg_query({ mode: 'controls', target })` — CDG。每条边带 `reason` 中的分支方向（`'T'`/`'F'`）。指向 early-return/throw 的边标记 `guard: true`。
- `pdg_query({ mode: 'flows', target, variable? })` — REACHING_DEF def→use 边。

`target` **必填**——文件路径或符号/函数名。

## 注意事项

- **始终 anchored + LIMIT-bounded。** 无 rel-property index。
- **没有 PDG 层 → 返回提示，不报错。**
- **仅过程内。** 跨函数流是污点分析的领域（`explain`）。
