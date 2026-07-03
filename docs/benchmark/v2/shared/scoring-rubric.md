# AI Coding 检索能力 Benchmark 评分细则

本文档适用于 `docs/benchmark/v2/` 目录下的各项目 case。评分应基于运行日志、工具调用记录、最终输出和验证结果，而不是凭印象判断。

## 双 Agent 评测要求

当 Claude Code 和 OpenCode 都作为被评测工具时，评分必须同时保留两个维度：

- agent 维度：`claude-code`、`opencode`
- tool_policy 维度：`grep`、`graph`、可选 `mixed`

最小有效矩阵是：

| agent | tool_policy |
| --- | --- |
| `claude-code` | `grep` |
| `claude-code` | `graph` |
| `opencode` | `grep` |
| `opencode` | `graph` |

报告中必须分别计算：

- 同一 agent 下的 `graph - grep` 收益，用于衡量 GitNexus 对该 agent 的帮助。
- 同一 tool_policy 下的 `claude-code - opencode` 差异，用于观察不同 AI Coding 工具自身能力差异。
- 所有 agent 聚合后的 `graph - grep` 收益，用于判断 GitNexus 的跨工具稳定性。

不要把 Claude Code 与 OpenCode 的差异误归因给 GitNexus，也不要把 GitNexus 的收益误归因给某个 agent 本身。

## 运行隔离要求

每次 run 必须记录：

- `case_id`
- `run_id`
- 模型名称与版本
- temperature 或其他采样参数
- 工具策略：`grep`、`graph` 或 `mixed`
- 当前 git commit
- 如果使用图谱工具，记录 GitNexus 索引元信息
- 开始时间和结束时间
- 工具调用列表
- 读取过的文件列表
- 最终回答
- 验证命令及结果
- 评审备注

以下 run 应判为无效，或单独标记为违规样本：

- grep-only 组使用了 GitNexus 图谱工具。
- graph-only 组用大范围 `rg` 扫描替代图谱查询。
- run 开始时上下文里已经包含前一次答案、标准答案或评审意见。
- 修改类 case 从包含无关改动的 dirty worktree 开始。

## 通用 50 分评分表

| 维度 | 分值 | 检查重点 |
| --- | ---: | --- |
| 定位准确性 | 10 | 是否准确找到入口、符号、文件、route 或目标模块。 |
| 覆盖完整性 | 10 | 是否覆盖必要文件、符号、调用方、实现类和测试。 |
| 推理质量 | 10 | 解释是否基于真实代码路径，是否避免编造。 |
| 过程效率 | 10 | 工具调用次数、上下文规模、噪音比例是否合理。 |
| 最终可用性 | 10 | 输出是否能直接用于实现、评审或决策。 |

## 分析类 Case 评分

适用于 L1 / L2 的 analysis-only case，例如执行流追踪、影响分析、架构理解。

评分原则：

- 优先看覆盖率和证据质量，不奖励空泛的长篇回答。
- 如果编造不存在的文件、符号、函数或调用链，应明显扣分。
- 如果把大量无关文件列为核心影响面，应扣分。
- 如果能明确区分“已确认事实”和“合理推测”，应加分。

建议评分表：

| 维度 | 分值 |
| --- | ---: |
| 入口 / 符号定位准确性 | 10 |
| 调用链或影响面完整性 | 10 |
| 证据质量 | 10 |
| 风险与架构约束识别 | 10 |
| 低噪音上下文使用效率 | 10 |

## 修改类 Case 评分

适用于 L3 / L4 的代码修改 case，例如小型真实修改、重构、接口变更。

评分原则：

- 改前影响分析、代码实现、改后验证应分开评分。
- `detect_changes` 属于改后验证能力，不应混入改前检索能力评分。
- graph 组不能仅因调用了 `detect_changes` 得分，关键是是否正确理解并使用结果。
- diff 干净程度很重要：无关重构、格式化大面积 churn、误改文件都应扣分。

建议评分表：

| 维度 | 分值 |
| --- | ---: |
| 改前影响分析 | 10 |
| 实现正确性 | 10 |
| 测试覆盖与验证 | 10 |
| Diff 干净程度 | 10 |
| 改后影响验证 | 10 |

## Token / 上下文效率

如果平台无法提供精确 token 统计，可以使用以下近似指标：

- 检索输出字符数
- 文件读取总字符数
- 工具调用次数
- 搜索 / 查询轮次
- 人工估算的噪音比例

不要只比较原始 token 数。一个较长的 run 如果发现了关键边界情况，仍然可能高分；一个很短的 run 如果漏掉必要影响面，应低分。

## Ground Truth 规则

标准答案必须由多种来源共同确认：

- 人工代码审查
- `rg` 全文搜索
- GitNexus 图谱查询
- 适用时运行测试或 typecheck
- 修改类 case 使用 `git diff` 和 `detect_changes` 校验影响范围

不要只用 GitNexus 图谱输出作为唯一标准答案，否则 benchmark 会天然偏向图谱组。

## 扣分参考

| 问题 | 建议扣分 |
| --- | ---: |
| 找错核心入口或目标符号 | -6 到 -10 |
| 漏掉关键调用方、实现类或测试 | -3 到 -8 |
| 编造不存在的文件、函数或执行流 | -4 到 -10 |
| 把大量无关文件列为核心影响面 | -2 到 -6 |
| 修改类 case 无法通过 typecheck | -5 到 -10 |
| 修改类 case 引入无关 diff | -2 到 -8 |
| 未按工具策略执行 | 标记违规，必要时作废 |

## 加分参考

| 表现 | 建议加分 |
| --- | ---: |
| 明确指出架构约束或 repo 特定规则 | +1 到 +3 |
| 主动区分直接影响和间接影响 | +1 到 +3 |
| 能解释为什么某些文件不在影响范围内 | +1 到 +2 |
| 修改后验证能发现并解释异常影响 | +2 到 +4 |
| 输出可直接转成实施计划或 review checklist | +1 到 +3 |

加分不应让总分超过该 case 的满分。加分项主要用于同分 run 的排序和定性分析。

## 定量报告最低要求

当 benchmark 由其他 AI Coding 工具执行时，评分方不能只接收自然语言报告。每个 run 必须提交 `agent-result.json`、`score.json` 和原始日志路径；最终报告必须同时包含 run 级明细、矩阵聚合、graph uplift 和策略合规四类表格。

### Run 级指标

每个 run 至少统计以下字段：

| 指标 | 来源 | 说明 |
| --- | --- | --- |
| `status` | `agent-result.json.status` | `passed` / `failed` / `invalid` |
| `total` | `score.json.score.total` | 自动预评分总分 |
| `location_accuracy` | `score.json.score.location_accuracy` | 定位入口、文件、符号的准确度 |
| `coverage_completeness` | `score.json.score.coverage_completeness` | 覆盖 ground truth 关键点的完整度 |
| `evidence_quality` | `score.json.score.evidence_quality` | 证据是否可落到文件、符号、行号 |
| `final_usability` | `score.json.score.final_usability` | 结论是否能直接用于实现、评审或决策 |
| `tool_call_count` | `agent-result.json.metrics.tool_call_count` | 总工具调用次数 |
| `files_read_count` | `agent-result.json.metrics.files_read_count` | 读取文件数量 |
| `search_query_count` | `agent-result.json.metrics.search_query_count` | 文本检索次数 |
| `graph_query_count` | `agent-result.json.metrics.graph_query_count` | GitNexus 图谱查询次数 |
| `elapsed_ms` | `agent-result.json.metrics.elapsed_ms` 或 runner 计时 | 运行耗时 |
| `violation_count` | `agent-result.json.violations.length` | 工具策略或数据泄漏违规数量 |

缺失 `agent-result.json`、缺失 `score.json`、缺失核心 metrics 的 run 不应进入平均分，只能列入 invalid run 统计。

### 聚合指标

最终报告至少计算：

| 指标 | 公式 |
| --- | --- |
| `valid_run_count` | 有效 run 数量 |
| `invalid_run_count` | 无效 run 数量 |
| `pass_rate` | `passed_runs / valid_runs` |
| `avg_total` | `mean(score.total)` |
| `median_total` | `median(score.total)` |
| `graph_uplift_abs` | `avg_total(graph) - avg_total(grep)` |
| `graph_uplift_pct` | `graph_uplift_abs / max(avg_total(grep), 1)` |
| `avg_graph_calls` | `mean(metrics.graph_query_count)` |
| `avg_search_calls` | `mean(metrics.search_query_count)` |
| `avg_files_read` | `mean(metrics.files_read_count)` |
| `avg_elapsed_ms` | `mean(metrics.elapsed_ms)` |

报告必须分别按以下切片输出：

- `agent + tool_policy`
- `case + tool_policy`
- `agent + case + tool_policy`
- 所有 agent 聚合后的 `grep` vs `graph`

### Graph 收益判定

不要只因为 graph 组调用了 GitNexus 就判定有收益。建议同时满足以下条件才称为“明确收益”：

- `graph_uplift_abs > 0`
- `location_accuracy` 或 `coverage_completeness` 至少一个提升
- `evidence_quality` 没有明显下降
- `violations` 为空

如果 graph 组分数更高但 `files_read_count`、`search_query_count` 和 `elapsed_ms` 明显上升，应描述为“准确性收益，成本上升”，不能笼统写成“效率提升”。

如果 graph 组分数没有提升，但 `files_read_count` 或 `search_query_count` 明显下降，并且答案质量持平，可描述为“上下文效率收益”。

### 策略合规量化

每个 run 必须做策略审计：

| 场景 | 处理 |
| --- | --- |
| `grep` 组调用 `gitnexus_` 工具 | 标记 forbidden tool，通常判 invalid |
| `graph` 组没有任何 `gitnexus_` 工具调用 | 标记 graph not used，不能计入 graph 收益 |
| `graph` 组主要靠大范围 `rg`/`grep` 完成任务 | 标记 soft violation，人工复核是否降权 |
| 读取 golden answer、其他 agent 输出、历史 score | 直接 invalid |
| `policy_enforced=false` | 不一定 invalid，但报告必须披露 |

### 推荐结论模板

最终结论应从数字出发：

```text
本轮共执行 <N> 个 run，其中有效 <valid> 个、无效 <invalid> 个。
在 <agent> 上，graph 组平均总分 <graph_avg>，grep 组平均总分 <grep_avg>，绝对提升 <uplift_abs>，相对提升 <uplift_pct>。
提升主要来自 <metric_names>；成本变化为耗时 <elapsed_delta> ms、读取文件数 <files_delta>、工具调用数 <tool_delta>。
最能体现图谱收益的 case 是 <case_id>，因为 <跨文件调用链/动态分发/影响面分析/数据流追踪>。
收益不明显的 case 是 <case_id>，原因是 <单文件即可定位/关键词唯一/图谱索引缺失/agent 未正确使用图谱>。
```

## Alias normalization (改进 1)

为避免格式差异导致的误判，scorer 在术语匹配时支持以下 alias：

| 场景 | 规则 | 示例 |
|------|------|------|
| Python entrypoint 冒号/点号互通 | `pkg.module:func` 等价于 `pkg.module.func` | ground truth `qwenpaw.cli.main.cli` 可匹配 answer 中的 `qwenpaw.cli.main:cli` |
| Project scripts | `project.scripts.<name>` 在 answer 中出现 `project.scripts` 且 `<name> =` 时视为命中 | `project.scripts.qwenpaw` 可匹配 `qwenpaw = qwenpaw.cli.main:cli` |
| 路径分隔符 | `\\` 与 `/` 等价 | `src\\qwenpaw\\cli` 等价于 `src/qwenpaw/cli` |
| 大小写 | 不敏感（保持现有逻辑） | — |

这些规则不影响 ground truth 文件。alias 只在 scorer 内部生效。

## Graph depth bonus

自动预评分包含 `graph_depth_bonus`（上限 10 分），按信号类型去重计分，不按重复次数堆叠：

| 信号类型 | 分值 |
|---------|------|
| `used_gitnexus_context` + caller/callee 证据 | +1.5 |
| `used_gitnexus_impact` + affected/impacted 证据 | +1.5 |
| `used_gitnexus_query` + flow/process 证据 | +1.0 |
| `found_risk_level` | +1.5 |
| `found_numeric_structural_evidence` | +2.0 |

每种信号最多计一次。`score.json` 拆分三个总分：
- `coverage_total`: 原始 term coverage 分数（保持历史可比性）
- `graph_depth_bonus`: 图谱结构化证据加分
- `adjusted_total` / `total`: coverage_total + graph_depth_bonus - penalty

graph_depth_bonus 是自动预评分辅助，不替代人工 judge。


## Structural automatic score (current)

The primary automatic total is a 100-point structural score computed from `final_answer` only:

- entrypoint/symbol + file pairs: 15
- positive symbol and file coverage: 20
- expected call/data-flow edges: 25
- required behavioral facts (`must_mention`): 20
- symbol + file evidence pairs: 10
- noise resistance: 10

`must_exclude_from_impact` is negative-only and can never become a positive expected hit. Call chains are scored as adjacent edges, preferring structured `call_chains`/`data_flows` and using ordered text only as a compatibility fallback.

The legacy recursive term score remains in `legacy_score` for historical comparison. `analysis_depth_bonus` no longer changes correctness. Actual GitNexus tool use is reported separately as `graph_evidence_score`; it does not raise the answer-quality total. `final_usability` is left at zero with `final_usability_requires_judge: true` until a human or calibrated judge supplies it.


## Optional conversational adjudication

Human review is optional and agent-assisted. The user asks an agent to analyze an anomalous policy gap; the agent inspects original answers, explicit Ground Truth items, and automatic item scores without writing. Only after explicit user approval may the agent invoke the shared adjudication tool to create a sidecar.

Ground Truth items use stable explicit IDs. Automatic scores expose per-item credits and match sources. Proximity-only edge candidates receive zero automatic credit.

Allowed human credits are `0 / 0.25 / 0.4 / 0.5 / 0.8 / 1`. Version 1 permits changes only to `call_edges`, `behavior_facts`, `evidence`, and `noise`; `location` and `symbols` stay automatic. The sidecar records only changed items.

A completed, source-current sidecar supplies `adjudicated_total`; otherwise `effective_total` equals `automatic_total`. Formal reports sort and aggregate by effective score while showing both automatic and adjudicated values plus review coverage. See `docs/benchmark/adjudication/README.md`.



## Artifact quality validation（改进 3）

`validate-artifacts --run-dir <dir>` 校验 run 产物完整性和一致性：

| 检查项 | 级别 |
|--------|------|
| runner-result.json 存在 | Error（缺失则 invalid） |
| agent-result.json / score.json 存在 | Warning |
| stdout_file / stderr_file 指向存在的文件 | Warning |
| manifest 包含 run / command / policy_enforced | Warning |
| execution_mode=in-process | Warning |
| runner-result.elapsed_ms 与 agent-result.metrics.elapsed_ms 一致（>5s 差） | Warning |
| graph 组无 gitnexus MCP 调用 | Warning（Bash 包装 CLI）/ Error（完全缺失） |
| grep 组出现 gitnexus 工具调用 | Error（policy violation） |

`report` 聚合输出新增 `artifact_warning_count`、`artifact_invalid_count`、每个 row 的 `artifact_valid` / `artifact_warnings` 字段。目的是区分标准 runner 产物和手工封装结果的可信度。

如果报告无法填入上述数字，不应称为定量报告，只能称为观察记录。
