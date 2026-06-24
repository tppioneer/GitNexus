---
name: gitnexus-refactoring-local-zh
description: "当用户想要安全地重命名、提取、拆分、移动或重构代码时使用（本地模式）。示例：\"重命名这个函数\"、\"把这个提取成模块\"、\"重构这个类\"、\"把这个移到单独文件\""
---

# 用 GitNexus 重构（本地模式）

## 适用场景

- "安全地重命名这个函数"
- "把这个提取成模块"
- "拆分这个服务"
- "把这个移到新文件"
- 任何涉及重命名、提取、拆分或重构的任务

## 本地模式须知

`rename` 工具直接在本地文件系统上执行编辑。先用 `dry_run: true` 预览，确认无误后再执行。

## 工作流

```
1. impact({target: "X", direction: "upstream"})  → 映射所有依赖者
2. query({search_query: "X"})                            → 找到涉及 X 的执行流
3. context({name: "X"})                           → 查看所有入/出引用
4. 规划更新顺序: 接口 → 实现 → 调用者 → 测试
```

> "Index is stale" → 运行 `node .gitnexus/run.cjs analyze`。

## Checklists

### 重命名符号

```
- [ ] rename({symbol_name: "oldName", new_name: "newName", dry_run: true}) — 预览全部编辑
- [ ] 审查 graph edits（高置信度）和 ast_search edits（需人工确认）
- [ ] 确认无误: rename({..., dry_run: false}) — 执行编辑
- [ ] detect_changes() — 验证只有预期文件被改动
- [ ] 运行受影响执行流的测试
```

### 提取模块

```
- [ ] context({name: target}) — 查看所有入/出引用
- [ ] impact({target, direction: "upstream"}) — 找到所有外部调用者
- [ ] 定义新模块接口
- [ ] 提取代码，更新 import
- [ ] detect_changes() — 验证影响范围
- [ ] 运行受影响执行流的测试
```

### 拆分函数/服务

```
- [ ] context({name: target}) — 理解所有被调用者
- [ ] 按职责分组被调用者
- [ ] impact({target, direction: "upstream"}) — 映射需更新的调用者
- [ ] 创建新函数/服务
- [ ] 更新调用者
- [ ] detect_changes() — 验证影响范围
- [ ] 运行受影响执行流的测试
```

## 工具说明

**rename** —— 自动化多文件重命名，直接在本地文件执行：

```
rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: true})
→ 12 处编辑, 跨 8 个文件
→ 10 graph edits（高置信度）, 2 ast_search edits（需审查）

rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: false})
→ 已执行 12 处编辑, 跨 8 个文件

detect_changes({scope: "all"})
→ 验证只有预期文件被改动
```

**impact** —— 先映射所有依赖者：

```
impact({target: "validateUser", direction: "upstream"})
→ d=1: loginHandler, apiMiddleware, testUtils
→ Affected Processes: LoginFlow, TokenRefresh
```

## 示例：把 `validateUser` 重命名为 `authenticateUser`

```
1. rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: true})
   → 12 处编辑: 10 graph（安全）, 2 ast_search（需审查）

2. 审查 ast_search 编辑（config.json：动态引用!）

3. rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: false})
   → 已执行 12 处编辑, 跨 8 个文件

4. detect_changes({scope: "all"})
   → Affected: LoginFlow, TokenRefresh
   → Risk: MEDIUM — 运行这两个流的测试
```
