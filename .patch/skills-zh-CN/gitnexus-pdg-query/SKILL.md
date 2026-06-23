---
name: gitnexus-pdg-query-zh
description: "当查询或扩展 GitNexus 的 PDG 控制/数据依赖面（pdg_query MCP 工具、CDG/REACHING_DEF 边）或推理\"什么控制 X\" / \"Y 从哪里流过来\" / guard 子句时使用。示例：\"什么 guard 了这个语句？\"、\"追踪这个变量在函数内的流向\"、\"为什么 pdg_query 结果是空的？\""
---

# GitNexus PDG 查询面

`pdg_query` MCP 工具及控制/数据依赖边的专业知识——可选的 `--pdg` 程序依赖层。在操作 `gitnexus/src/mcp/local/local-backend.ts`（`_pdgQueryImpl`）或理解 `pdg_query` 结果之前请先读此文件。

## 适用场景

- "什么条件下这个语句会执行？"（守卫谓词）
- "这个变量在函数内怎么流动？"（def→use）
- Guard 子句发现（early-return guard）
- 扩展或审查 `pdg_query` / CDG / REACHING_DEF 读路径
- Debug 空的或意外的 `pdg_query` 结果

## 分层基底（构建顺序）

`pdg_query` 运行在污点分析**同一张图**上。每层通过 `--pdg` 可选开启。

```
L1  CFG            每个函数的基本块 + 控制流边           (M1)
L2  REACHING_DEF   GEN/KILL def→use 数据依赖（纯求解器）  (M2)
L5  CDG            Ferrante 控制依赖（后支配者树）       (M5)
```

全部三层都是 `BasicBlock → BasicBlock` 边，存在同一个 `CodeRelation` 表中（按 `type` 属性区分）。**没有** `Function → BasicBlock` 边。

## 两种模式

- `pdg_query({ mode: 'controls', target })` — CDG。每条边：控制谓词块 → 被依赖块 + `reason` 中的分支方向（`'T'` = true 分支, `'F'` = false 分支）。指向 early-return/throw 块的边标记了 `guard: true`。
- `pdg_query({ mode: 'flows', target, variable? })` — REACHING_DEF def→use 边；`variable` 可选过滤。

`target` **必填**——文件路径或符号/函数名（解析方式同 `context()`）。

## 注意事项

- **始终 anchored + LIMIT-bounded。** LadybugDB 没有 rel-property index，未锚定的 `[:CDG*]` 路径扫描是无界的。
- **BasicBlock↔符号的关联是重建出来的。** 没有 `Function→BasicBlock` 边：通过 id 前缀匹配 + startLine 范围关联。
- **没有 PDG 层 → 返回提示，不报错。** 如果仓库没用 `--pdg` 索引，返回 `{ results: [], note: "no PDG layer …" }`。
- **仅过程内。** 跨函数流是污点分析的领域（`explain`）。
