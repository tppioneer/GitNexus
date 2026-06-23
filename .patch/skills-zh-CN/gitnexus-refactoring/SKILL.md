---
name: gitnexus-refactoring
description: "当用户想要安全地重命名、提取、拆分、移动或重构代码时使用（远程模式）。需在有本地 clone 的前提下。"
---

# 用 GitNexus 重构（远程模式）

## 前提条件

`rename` 工具需要本地文件系统副本才能执行编辑。**确保你有仓库的本地 clone。**

> "Index is stale" → 联系服务端管理员触发 CI 索引更新。

## 适用场景

- "安全地重命名这个函数"
- "把这个提取成模块"
- "拆分这个服务"

## Checklists

### 重命名符号

```
- [ ] rename({symbol_name: "oldName", new_name: "newName", dry_run: true}) — 预览
- [ ] 审查 graph edits（高置信度）和 ast_search edits（需人工确认）
- [ ] rename({..., dry_run: false}) — 执行编辑
- [ ] detect_changes({scope: "compare", base_ref: "develop"}) — 验证
- [ ] 运行受影响执行流的测试
```

### 提取模块 / 拆分函数

```
- [ ] context({name: target}) — 查看所有入/出引用
- [ ] impact({target, direction: "upstream"}) — 找到所有外部调用者
- [ ] 提取/拆分代码，更新引用
- [ ] detect_changes({scope: "compare", base_ref: "develop"}) — 验证
- [ ] 运行受影响执行流的测试
```

## 工具说明

**rename** —— 自动化多文件重命名：

```
rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: true})
→ 12 处编辑, 10 graph edits（高置信度）, 2 ast_search edits（需审查）
```

**impact** —— 先映射所有依赖者：

```
impact({target: "validateUser", direction: "upstream", repo: "my-app"})
→ d=1: loginHandler, apiMiddleware
```

**detect_changes** —— 验证改动范围：

```
detect_changes({scope: "compare", base_ref: "develop", repo: "my-app"})
```
