---
name: gitnexus-refactoring-zh
description: "当用户想要安全地重命名、提取、拆分、移动或重构代码时使用。示例：\"重命名这个函数\"、\"把这个提取成模块\"、\"重构这个类\"、\"把这个移到单独文件\""
---

# 用 GitNexus 重构

## 适用场景

- "安全地重命名这个函数"
- "把这个提取成模块"
- "拆分这个服务"
- "把这个移到新文件"
- 任何涉及重命名、提取、拆分或重构的任务

## 工作流

```
1. impact({target: "X", direction: "upstream"})  → 映射所有依赖者
2. query({search_query: "X"})                            → 找到涉及 X 的执行流
3. context({name: "X"})                           → 查看所有入/出引用
4. 规划更新顺序: 接口 → 实现 → 调用者 → 测试
```

> "Index is stale" → 联系服务端管理员触发 CI 索引更新。远程模式下开发者无法本地执行 `analyze`。

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

**rename** —— 自动化多文件重命名：

```
rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: true})
→ 12 处编辑, 跨 8 个文件
→ 10 graph edits（高置信度）, 2 ast_search edits（需审查）
→ Changes: [{file_path, edits: [{line, old_text, new_text, confidence}]}]
```

**impact** —— 先映射所有依赖者：

```
impact({target: "validateUser", direction: "upstream"})
→ d=1: loginHandler, apiMiddleware, testUtils
→ Affected Processes: LoginFlow, TokenRefresh
```

**detect_changes** —— 重构后验证改动：

```
detect_changes({scope: "all"})
→ Changed: 8 文件, 12 符号
→ Affected processes: LoginFlow, TokenRefresh
→ Risk: MEDIUM
```

## 风险规则

| 风险因素 | 缓解措施 |
|---------|---------|
| 调用者多（>5） | 使用 rename 自动更新 |
| 跨模块引用 | 用 detect_changes 事后验证 |
| 字符串/动态引用 | query 搜索找到它们 |
| 外部/公开 API | 版本化并正确弃用 |

## 示例：把 `validateUser` 重命名为 `authenticateUser`

```
1. rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: true})
   → 12 处编辑: 10 graph（安全）, 2 ast_search（需审查）
   → 文件: validator.ts, login.ts, middleware.ts, config.json...

2. 审查 ast_search 编辑（config.json：动态引用!）

3. rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: false})
   → 已执行 12 处编辑, 跨 8 个文件

4. detect_changes({scope: "all"})
   → Affected: LoginFlow, TokenRefresh
   → Risk: MEDIUM — 运行这两个流的测试
```
