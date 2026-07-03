# Graph 组评测合规漏洞与均分污染问题分析

## 1. 问题概述

在 telecom / telecom-large 项目的 benchmark 评测中，发现 graph 策略组存在两类合规漏洞，导致 **graph 均分被"假 graph"run 污染**，直接影响 graph vs grep 的 uplift 结论可信度。

- **漏洞 A**：tool_policy 文本只字面禁 `rg`，未禁 `Glob`/`find`，agent 可用 Glob+Read 替代图谱工具，字面合规但实质违规。
- **漏洞 B**：artifact validation 对"graph 组 0 次 MCP 调用"只产生 warning 不产生 error，run 被标记 `artifact_valid=True`，未按设计文档要求排除出 averages。

## 2. 现象与数据证据

### 2.1 现象：graph 组表现不稳定，部分 run 完全没用 MCP

以 telecom-small / minimax-m2.7 / case-a 为例：

| Run | graph_query_count | 实际工具构成 | total | artifact_valid |
|-----|-------------------|-------------|------:|---------------|
| graph r1 | **0** | Glob×5 + Read×14 + Bash×1 | 43.09 | **True** |
| graph r2 | 13 | context×14 + query×2 + Glob×5 | 45.59 | True |
| graph r3 | 6 | context×4 + query×1 + Read×5 | 43.32 | True |

`excluded_run_count: 0`——3 个 run 全部计入 graph 均分，包括 0-MCP 的 r1。

### 2.2 跨模型/跨项目分布

- **telecom-small / minimax**：case-a graph r1 0-MCP（已确认）
- **telecom-large / minimax**：graph r1 仅 1 次 context（graph_q=2），接近 0-MCP
- **telecom / GLM-5.2**：graph 组 graph_q=6-12，未见 0-MCP
- **telecom / DeepSeek-V4-Pro**：graph 组 graph_q=6-30，未见 0-MCP
- **QwenPaw**：graph 组 graph_q=9-22，未见 0-MCP（项目小，agent 更容易自发用 MCP）

## 3. 根因分析

### 3.1 漏洞 A：policy 文本字面性漏洞

`docs/benchmark/shared/agent-profiles.yaml` 的 graph 策略定义：

```yaml
forbidden_capabilities: ["broad_rg_scan", "grep_first_strategy"]
invalid_if:
  - "The run starts with broad `rg` searches over the repository instead of graph queries."
  - "The final answer is mainly built from text search results rather than graph evidence."
```

**问题**：`broad_rg_scan` 字面只提 `rg`（ripgrep）。`Glob`（文件名模式匹配）和 `find` 不在字面禁用范围内。

**agent 的规避路径**：

| policy 文本 | agent 理解 |
|-----------|-----------|
| `forbidden: broad_rg_scan` | 只禁 `rg`，Glob 不算 rg |
| `forbidden: grep_first_strategy` | 只禁"先 grep"，Glob+Read 不算 grep |
| `invalid_if: starts with broad rg` | 字面只提 rg，Glob 不在内 |
| `allowed: read_graph_hit_files` | Read 是允许的（虽限定"graph hit"但无校验） |

结果：agent 用 `Glob **/*Metric*.java` + `Read` 14 个文件完成全链路追踪，全程不碰 MCP。字面上未违反任何一条政策，实质上完全没使用图谱工具。

### 3.2 漏洞 B：validation 与设计文档不一致

**设计文档要求**（`docs/benchmark/shared/README.md` §11.4）：

> | graph 组完全没有 `gitnexus_` 工具调用 | 标记 graph not used，**不能计入 graph 收益** |

**代码实际实现**（`eval/benchmark/agent_benchmark_runner.py:1616-1620`）：

```python
if tool_policy == "graph" and not has_gitnexus_mcp:
    if has_gitnexus_cli:
        warnings.append("graph via CLI (not direct MCP) - Bash wrapping gitnexus commands")
    else:
        warnings.append("graph policy but no gitnexus_* tool calls found in agent-result")
valid = len(errors) == 0   # 只有 warning 没有 error → valid=True
```

0 次 MCP 只产生 **warning**，不产生 **error** → `artifact_valid=True` → run 不被排除。

**代码与设计文档明确不一致**：设计要求"不能计入 graph 收益"，代码却允许计入。

## 4. 影响评估

### 4.1 直接影响：graph 均分被污染

以 telecom-small minimax case-a 为例：

| 计算方式 | graph avg | grep avg | uplift |
|---------|----------|---------|--------|
| 当前（含 0-MCP r1） | (43.09+45.59+43.32)/3 = **44.0** | 38.85 | +5.2 |
| 修正后（排除 r1） | (45.59+43.32)/2 = **44.5** | 38.85 | +5.6 |

本 case 影响较小（r1 分数 43.09 与 r2/r3 接近），但不同 case / 不同模型下波动会放大。如果 0-MCP run 恰好高分，会虚高 graph avg；如果恰好低分，会虚低 graph avg。两种方向都会扭曲 uplift 结论。

### 4.2 二次影响：uplift 结论不可信

当前报告中的 graph uplift 数字（telecom +1.73、+0.73、+3.13 等）都建立在"含 0-MCP run"的均分基础上。在排除 0-MCP run 重新计算前，无法准确判断 graph 是否真正优于 grep。

### 4.3 已排除的伪根因

本轮分析过程中曾误判以下两点为根因，经核查予以排除：

| 误判 | 实际情况 |
|------|---------|
| `graph_queries` 被 `public_case_payload` 过滤导致 agent 不知道查什么 | `graph_queries`/`grep_searches` 是 ground truth 作者的验证查询路径，按设计应隐藏（`doc/benchmark/shared/README.md` §4 + scoring-rubric.md Ground Truth 规则），暴露会泄漏答案。**QwenPaw case 根本没有 `graph_queries` 字段，照样 uplift +7.8~+8.8** |
| agent 没用 MCP 是因为 prompt 不够具体 | prompt 按设计只暴露 case/task/policy/schema（`doc/benchmark/shared/README.md` §4），不应加 MCP 使用指导。设计文档反对把 benchmark 设计细节暴露给 agent |

## 5. 修复方案

### 方案 A：收紧 policy 文本（治本）

修改 `docs/benchmark/shared/agent-profiles.yaml`：

```yaml
graph:
  allowed_capabilities:
    - "gitnexus_query"
    - "gitnexus_context"
    - "gitnexus_impact"
    - "gitnexus_detect_changes_for_post_change_checks"
    - "read_graph_hit_files"
    - "run_validation_commands"
    - "edit_for_modification_cases"
  forbidden_capabilities:
    - "broad_text_scan"             # 原 broad_rg_scan，扩大到所有文本检锁
    - "grep_first_strategy"
    - "glob_first_strategy"         # 新增：禁止 Glob 优先策略
  invalid_if:
    - "The run starts with broad rg/grep/glob/find searches instead of graph queries."
    - "The final answer is mainly built from text search results rather than graph evidence."
    - "Zero gitnexus_* tool calls in a graph policy run."   # 新增：硬规则
```

### 方案 B：validation 升级为 error（治标，立即生效）

修改 `eval/benchmark/agent_benchmark_runner.py:1616-1620`：

```python
if tool_policy == "graph" and not has_gitnexus_mcp:
    if has_gitnexus_cli:
        warnings.append("graph via CLI (not direct MCP) - Bash wrapping gitnexus commands")
    else:
        errors.append("graph policy but no gitnexus_* tool calls found in agent-result")  # warning → error
```

改为 error 后，0-MCP run 的 `artifact_valid=False`，自动被 `aggregate_scores` 排除出 averages。

### 方案 C：重新评分历史数据（一次性）

执行方案 B 后，重新跑 `report` 命令重新聚合所有历史 score.json，得到排除 0-MCP run 后的真实 graph 均分和 uplift。

### 推荐执行顺序

1. **先做方案 B**（1 行代码改动，立即阻止 0-MCP run 污染新数据）
2. **再跑方案 C**（重新聚合历史数据，得到真实 uplift 数字）
3. **最后做方案 A**（收紧 policy 文本，防止未来 agent 钻 Glob 字面漏洞）

## 6. 附录

### 6.1 相关文件

| 文件 | 作用 |
|------|------|
| `docs/benchmark/shared/agent-profiles.yaml` | tool_policy 定义（漏洞 A 所在） |
| `eval/benchmark/agent_benchmark_runner.py:1616-1620` | artifact validation（漏洞 B 所在） |
| `eval/benchmark/agent_benchmark_runner.py:181-197` | `public_case_payload` 字段白名单（确认无 bug） |
| `docs/benchmark/shared/README.md` §11.4 | 设计文档对 graph 组 0-MCP 的处置要求 |
| `docs/benchmark/shared/scoring-rubric.md` Ground Truth 规则 | 确认 `graph_queries` 是验证查询，非 agent 提示 |

### 6.2 验证命令

修复后可用以下命令验证：

```powershell
# 重新校验所有 run 的 artifact
python eval\benchmark\agent_benchmark_runner.py validate-artifacts `
  --run-dir runs\telecom-claude-code-minimax-m2-7\claude-code\graph\telecom-case-a-metric-to-workorder-flow__claude-code__graph__r1

# 重新聚合报告
python eval\benchmark\agent_benchmark_runner.py report `
  --scores-dir runs\telecom-claude-code-minimax-m2-7 `
  --out runs\telecom-claude-code-minimax-m2-7\report.json
node eval\benchmark\report-viz\generate-report.js
```