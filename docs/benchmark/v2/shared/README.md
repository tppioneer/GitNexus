# AI Coding Agent Benchmark Runner 设计

本文档定义如何把 Claude Code 和 OpenCode 同时作为被评测 AI Coding 工具，运行同一批 GitNexus 检索能力 benchmark。目标不是评测某个模型谁更聪明，而是评测在不同工具能力下，AI Coding Agent 获得正确代码上下文、影响面和修改结果的稳定性。默认 agent 选择优先考虑企业内网环境的可用性。

## 1. 评测矩阵

每个 case 至少运行下面 4 个组合：

| agent | tool_policy | 目的 |
| --- | --- | --- |
| `claude-code` | `grep` | Claude Code 在传统文本检索条件下的表现 |
| `claude-code` | `graph` | Claude Code 接入 GitNexus 后的表现 |
| `opencode` | `grep` | OpenCode 在传统文本检索条件下的表现 |
| `opencode` | `graph` | OpenCode 接入 GitNexus 后的表现 |

可选增加 `mixed` 组，用于模拟真实用户同时使用文本搜索和图谱工具的产品体验。`mixed` 组不能替代 `grep` vs `graph` 的纯对照。

## 2. 目录约定

建议在目标项目或独立评测仓库中使用以下结构：

```text
benchmark/
  cases/                    # 从 docs/benchmark/v2/{project}/cases 复制或生成的 case yaml
  golden/                   # 人工确认后的标准答案
  runner/
    agent-profiles.yaml     # 本目录提供的 agent 配置模板
    run-result.schema.json  # 单次运行结果 schema
  runs/
    claude-code/
      grep/
      graph/
    opencode/
      grep/
      graph/
  reports/
```

`docs/benchmark/v2/{project}/cases/*.yaml` 是 case 设计来源；真正执行时可以复制到目标项目的 `benchmark/cases/`，避免让 agent 读取设计讨论文档。

## 3. 单次 Run 生命周期

1. Runner 读取 case YAML。
2. Runner 根据 `agent` 和 `tool_policy` 选择 agent profile。
3. Runner 创建隔离工作目录或确认当前 worktree 干净。
4. Runner 生成任务 prompt，包含 case prompt、工具策略、输出 JSON schema、禁止读取 golden answer 的约束。
5. Runner 调用 Claude Code 或 OpenCode 的非交互 CLI。
6. Runner 保存原始 stdout/stderr、结构化 final answer、工具调用摘要、耗时、退出码。
7. Runner 对修改类 case 执行 validation commands。
8. Scorer 使用 golden answer 与 run result 计算分数。
9. Reporter 聚合 agent 维度、tool_policy 维度和 case 维度。

## 4. Prompt 包装规范

Runner 不能直接把全部 benchmark 设计文档塞给 agent。每次 run 只允许暴露：

- 当前 case 的 `id`、`prompt`、`task_type`、`level`。
- 当前 `tool_policy` 的 allowed / forbidden 规则。
- 输出 JSON 结构要求。
- 目标项目路径和必要的构建命令。

禁止暴露：

- `expected`、`scoring`、`golden`、人工点评。
- 同一 case 其他 agent 或其他 tool_policy 的历史输出。
- 任何对目标答案有提示作用的报告。

建议包装 prompt：

```text
你正在执行一个 AI Coding benchmark run。

Case: {case_id}
Agent: {agent_id}
Tool policy: {tool_policy}

任务:
{case.prompt}

工具规则:
- 允许: {allowed_tools}
- 禁止: {forbidden_tools}
- 如违反工具规则，请在 final JSON 的 violations 中说明。

输出要求:
只输出符合 run-result.schema.json 的 JSON，不要输出 Markdown。
```

## 5. Agent Adapter 要求

Runner 需要为每个 agent 实现一个 adapter。adapter 的职责是把统一的 benchmark run request 转成对应 CLI 命令。

### Claude Code Adapter

当前本机 `claude --help` 已确认支持非交互输出，可优先使用：

```powershell
claude --print `
  --output-format json `
  --permission-mode dontAsk `
  --allowedTools "Bash,Read" `
  --disallowedTools "Edit" `
  --model "<fixed-model-name>" `
  "<wrapped prompt>"
```

修改类 case 可按策略加入 `Edit`，并用独立 worktree 执行。graph 组需要额外加载 GitNexus MCP 配置或在环境中启用 GitNexus 工具。

### OpenCode Adapter

OpenCode adapter 使用 `opencode run --format json` 非交互执行，当前机器已验证 `opencode --help` 和 `opencode run --help` 可用。OpenCode CLI 支持 `--dir` 指定目标项目、`--model` 指定模型、`-f` 附加 prompt 文件。

adapter 最低要求：

- 支持非交互执行。
- 支持指定工作目录。
- 支持固定模型或固定配置文件。
- 能保存 stdout/stderr 和退出码。
- 能通过配置或 prompt 约束工具策略。
- 当前已验证 CLI 未暴露 Claude Code 风格的 `--allowedTools` 精确限制，因此 OpenCode run 默认标记为 `policy_enforced: false`，除非后续项目级 OpenCode 配置能够强制同等策略。

## 6. 工具策略执行

`grep` 组：

- 允许文本搜索、文件读取、测试命令。
- 禁止 GitNexus `query`、`context`、`impact`、`detect_changes`。

`graph` 组：

- 允许 GitNexus 图谱工具、读取图谱命中的小范围文件、测试命令。
- 禁止用大范围 `rg` 扫描替代图谱查询。

`mixed` 组：

- 允许全部能力。
- 只用于产品体验评估，不用于证明图谱相对 grep 的纯收益。

## 7. 评分与报告

每次 run 输出必须符合 `run-result.schema.json`。Scorer 至少计算：

- `score_total`
- `location_accuracy`
- `coverage_completeness`
- `evidence_quality`
- `noise_resistance`
- `final_usability`
- `policy_violation`
- `validation_passed`

报告必须按三个维度聚合：

| 维度 | 说明 |
| --- | --- |
| agent uplift | 同一 tool_policy 下 Claude Code vs OpenCode 的差异 |
| graph uplift | 同一 agent 下 graph vs grep 的差异 |
| case sensitivity | 哪些 case 最能体现图谱优势，哪些 case grep 已足够 |

最终结论不能只写“GitNexus 更好”。必须说明：在哪类任务、哪个 agent、哪个指标上收益最大。

## 8. 第一阶段落地范围

第一阶段建议只跑 3 个 case：

- `telecom-case-a-cross-service-flow`
- `telecom-case-b-rule-evaluator-dispatch`
- `telecom-case-c-field-propagation`

如果 telecom 项目尚未生成对应 YAML，可先用现有 pilot：

- `pilot-a-scope-resolver-impact`
- `pilot-b-analyze-api-flow`
- `pilot-d-skip-skills-alias`

每个组合跑 3 次，共 `3 cases * 2 agents * 2 policies * 3 repeats = 36 runs`。这个规模足够发现工具策略差异，也不会过早陷入大规模自动化成本。

## 9. 当前可执行入口

已提供一个最小 runner 规划脚本：

```powershell
python docs\benchmark\v2\runner\agent_benchmark_runner.py validate --plan docs\benchmark\v2\gitnexus\plan.yaml
python docs\benchmark\v2\runner\agent_benchmark_runner.py plan --plan docs\benchmark\v2\gitnexus\plan.yaml
python docs\benchmark\v2\runner\agent_benchmark_runner.py execute-matrix --plan docs\benchmark\v2\gitnexus\plan.yaml --out-dir runs\gitnexus-pilot --dry-run --max-runs 4 --model "<fixed-model-name>" --mcp-config .mcp.json

python docs\benchmark\v2\runner\agent_benchmark_runner.py validate --plan docs\benchmark\v2\telecom\plan.yaml
python docs\benchmark\v2\runner\agent_benchmark_runner.py plan --plan docs\benchmark\v2\telecom\plan.yaml
python docs\benchmark\v2\runner\agent_benchmark_runner.py execute --plan docs\benchmark\v2\telecom\plan.yaml --run-id telecom-case-a-metric-to-workorder-flow__claude-code__grep__r1 --out-dir runs --dry-run --model "<fixed-model-name>"
python docs\benchmark\v2\runner\agent_benchmark_runner.py execute-matrix --plan docs\benchmark\v2\telecom\plan.yaml --out-dir runs --dry-run --max-runs 4 --model "<fixed-model-name>" --mcp-config .mcp.json

python docs\benchmark\v2\runner\agent_benchmark_runner.py validate --plan docs\benchmark\v2\qwenpaw\plan.yaml
python docs\benchmark\v2\runner\agent_benchmark_runner.py plan --plan docs\benchmark\v2\qwenpaw\plan.yaml
python docs\benchmark\v2\runner\agent_benchmark_runner.py execute-matrix --plan docs\benchmark\v2\qwenpaw\plan.yaml --out-dir runs\qwenpaw --dry-run --max-runs 4 --model "<fixed-model-name>" --mcp-config .mcp.json
```

`docs/benchmark/v2/gitnexus/plan.yaml` 使用本仓库内的 Pilot A/B/D 和 ground truth，适合在没有外部项目依赖的机器上验证 runner 链路。`docs/benchmark/v2/telecom/plan.yaml` 面向独立的 telecom case project，运行前必须确认 `target_project.path` 下的 case YAML 和 ground truth 文件存在。
`docs/benchmark/v2/qwenpaw/plan.yaml` 面向 `C:/qinliuwei/code/QwenPaw`，覆盖 Python 后端 CLI/插件链路和 TypeScript 前端下载页数据流；case 和 ground truth 集中保存在本仓库 `docs/benchmark/v2/qwenpaw/` 下。

当前脚本只负责：

- 校验目标项目、case 文件和 ground truth 文件是否存在。
- 展开 `case * agent * tool_policy * repeat` 运行矩阵。
- 为单个 run 生成 prompt、manifest 和命令计划。
- 支持 `execute --dry-run` 验证运行目录和命令。
- 支持 `execute-matrix --dry-run` 批量生成运行目录和命令。
- 支持非 dry-run 调用已配置的 agent adapter。
- 支持 `extract-result` 从 agent stdout 中抽取 `agent-result.json`。
- 支持用 `score` 对单个 run result 做 ground truth 覆盖率预评分。
- 支持用 `report` 聚合 score JSON，输出 agent/tool_policy 平均分和 graph uplift。

Claude Code adapter 使用 `claude --print --output-format json`，prompt 通过 stdin 传入，避免 Windows 命令行长度限制。

OpenCode adapter 使用 `opencode run --format json --auto --dir <target> -f <prompt-file>`。由于当前 CLI 未提供精确工具白名单参数，OpenCode 的工具策略主要由 prompt 约束和后续日志审计保证，默认 `policy_enforced: false`。

预评分示例：

```powershell
python docs\benchmark\v2\runner\agent_benchmark_runner.py extract-result `
  --runner-result runs\claude-code\grep\<run-id>\runner-result.json

python docs\benchmark\v2\runner\agent_benchmark_runner.py score `
  --run-result runs\claude-code\grep\<run-id>\agent-result.json `
  --golden F:\develop\codes\Gitnexus-case-project\docs\benchmark-cases\ground-truth\telecom-case-a-ground-truth.yaml `
  --out scores\claude-code-grep-case-a-r1.json

python docs\benchmark\v2\runner\agent_benchmark_runner.py report --scores-dir scores --out reports\summary.json
```

## 8. GitNexus tool-call detection

The runner now recognizes GitNexus tool usage in three forms:

| Form | Example Tool Name | Detection |
|------|------------------|-----------|
| Direct MCP | `mcp__gitnexus__context` | Normalized by stripping `mcp__` prefix and collapsing `__` to `_` |
| Normalized benchmark name | `gitnexus_context`, `gitnexus_query` | Matched by `gitnexus_` prefix |
| Bash/CLI wrapper | `Bash` with `gitnexus context` in input_summary | Detected via CLI command text |

Graph policy runs with `gitnexus_*` tool names are not falsely warned as "no gitnexus tool calls". Grep policy runs with any GitNexus tool form are flagged as policy violation / artifact invalid.

## 9. Alias normalization

Scorer now supports semantic alias matching to reduce false misses from format differences:

- **Python entrypoint**: `pkg.module:func` and `pkg.module.func` are treated as equivalent。
- **Project scripts**: When ground truth has `project.scripts.<name>`, answer containing both `project.scripts` and `<name> =` is considered a hit。
- **Path separators**: `\\` and `/` are normalized before comparison。
- **Case-insensitive**: Matching remains case-insensitive as before。

These aliases do not modify ground truth files; they only affect how the scorer checks for term presence in the agent answer。

## 10. Graph depth bonus

A lightweight heuristic `graph_depth_bonus` (capped at 10 points) based on structural evidence signal types:

| Signal type | Points | Detected when |
|-------------|--------|---------------|
| `used_gitnexus_context` | 1.5 | `gitnexus_context` tool + caller/callee keywords in answer |
| `used_gitnexus_impact` | 1.5 | `gitnexus_impact` tool + affected/impacted keywords |
| `used_gitnexus_query` | 1.0 | `gitnexus_query` tool + flow/process keywords |
| `found_risk_level` | 1.5 | CRITICAL/HIGH/MEDIUM/LOW in impact section or answer |
| `found_numeric_structural_evidence` | 2.0 | "N callers", "N affected processes", etc. |

Each signal type is counted at most once (dedup by category), preventing repetitive text from inflating the bonus. Signal labels are output in `score.graph_depth_signals` for auditability.

### Scoring output

`score.json` now includes three score totals:

| Field | Meaning |
|-------|---------|
| `coverage_total` | Original term-coverage score (keeps historical comparability) |
| `graph_depth_bonus` | Structural evidence bonus (0-10, 0 for pure grep runs) |
| `adjusted_total` | `coverage_total + graph_depth_bonus - penalty` |
| `total` | Same as `adjusted_total` (backward-compatible) |

## 11. Artifact quality validation

`validate-artifacts --run-dir <dir>` checks run directory completeness:

| Check | Severity |
|-------|----------|
| runner-result.json exists | Error |
| agent-result.json / score.json exist | Warning |
| stdout_file/stderr_file present | Warning |
| manifest with run/command/policy_enforced | Warning |
| `execution_mode=in-process` | Warning |
| elapsed_ms consistency | Warning (>5s diff) |
| graph policy without GitNexus calls | Error / Warning (CLI form) |
| grep policy with GitNexus calls | Error (policy violation) |

### Artifact validity in aggregate reports

Runs with `artifact_valid=false` are **excluded** from `by_agent_policy` averages and `graph_uplift_by_agent`. They are counted in `invalid_run_count` and `excluded_run_count` with reasons in `exclusion_reasons`. Raw rows are preserved for audit.

`score` 只是自动覆盖率预筛，最终结论仍应按 `docs/benchmark/v2/shared/scoring-rubric.md` 做人工或 LLM judge 复核。

人工复核是可选的对话式环节：Agent 只读分析评分差异，用户明确批准后才由共享工具生成 `adjudication.json`。用户无需手填 JSON。协议、固定 credit 档位和命令见 `docs/benchmark/adjudication/README.md`。

## 10. 交给其他 AI Coding 工具执行时的输出约束

如果测试过程不是由本 runner 直接调用，而是交给 Claude Code、OpenCode、Cursor、Gemini CLI、Copilot CLI 或其他 AI Coding 工具手动执行，仍然必须把输出约束成同一组机器可读文件。核心原则是：**定性叙述可以有，但必须由结构化中间数据支撑；没有结构化数据的 run 不进入对比报告。**

每个 run 必须落盘到独立目录：

```text
runs/<agent>/<tool_policy>/<run_id>/
  prompt.txt              # 实际交给 agent 的 prompt
  manifest.json           # runner 或人工执行者生成的运行元数据
  stdout.txt              # agent 原始 stdout
  stderr.txt              # agent 原始 stderr
  runner-result.json      # CLI 执行结果：命令、退出码、耗时、stdout/stderr 路径
  agent-result.json       # 从 stdout 抽取后的标准 run-result JSON
  score.json              # agent-result 与 ground truth 的自动预评分
  validation.log          # 修改类 case 的测试/typecheck 输出，可为空
```

外部工具的最终回答必须只输出 `run-result.schema.json` 兼容 JSON。若工具天然会输出事件流、Markdown 或富文本，执行者必须保留原始 `stdout.txt`，再用 `extract-result` 或等价脚本抽取 `agent-result.json`。不能只提交自然语言总结。

最小强制字段如下：

| 字段 | 用途 | 缺失处理 |
| --- | --- | --- |
| `case_id` / `run_id` / `agent` / `tool_policy` | 定位 run 所属矩阵单元 | run 无效 |
| `policy_enforced` | 区分 CLI 硬限制和 prompt 软约束 | 缺失则视为 `false` |
| `target_repo` / `target_commit` | 保证同一代码版本可复现 | run 不进入横向对比 |
| `gitnexus_index` | 记录图谱索引状态、符号数、关系数、执行流数 | graph 组缺失则 run 无效 |
| `final_answer` | agent 的最终结论 | 缺失则 run 无效 |
| `evidence` | 支撑结论的文件、符号、行号、原因 | 缺失则证据质量记 0 |
| `tool_calls` | 工具调用摘要，包括 GitNexus、read、grep、test 等 | 缺失则过程效率和策略合规无法评分 |
| `validation` | 测试、typecheck、lint 或手工验证结果 | 修改类 case 缺失则验证分为 0 |
| `metrics` | 定量指标：工具次数、读文件数、搜索次数、图谱次数、耗时等 | 缺失核心指标则 run 无效 |
| `violations` | 工具策略违规、越权读取、读取 golden 等 | 非空时进入 penalty |

建议给外部 AI Coding 工具的约束 prompt 增加以下硬性段落：

```text
你正在执行 benchmark run。请保留足够中间证据，让评测方可以量化评分。

输出只能是一个 JSON 对象，必须符合 run-result.schema.json。
不要输出 Markdown、解释性段落或代码块。

你必须在 JSON 中记录：
1. 你读取过的关键文件和符号，写入 final_answer.files / evidence。
2. 你调用过的工具，写入 tool_calls；每次工具调用必须包含 tool、purpose、input_summary、output_summary、allowed_by_policy。
3. 你使用 GitNexus MCP 时，必须记录 gitnexus_query / gitnexus_context / gitnexus_impact / gitnexus_detect_changes 等具体工具名。
4. 你使用传统搜索时，必须记录 rg/grep/glob/find 等具体工具名和搜索意图。
5. metrics 至少包含 tool_call_count、files_read_count、search_query_count、graph_query_count、elapsed_ms、changed_files_count。
6. 如果违反 tool_policy，必须在 violations 中如实记录。
7. 不要读取 golden answer、历史 score、其他 agent 的输出或 benchmark 设计说明。
```

对不能强制工具白名单的 agent，例如当前 OpenCode CLI，需要把 `policy_enforced` 标为 `false`，并在报告中单独披露“策略依赖 prompt + 日志审计”。这类 run 仍可用于观察能力，但不能和硬白名单 run 混为同等可信度。

## 11. 从定性报告升级为定量报告

最终报告不应只写“graph 组更快/更准/上下文更完整”。每个结论必须回连到 `score.json`、`agent-result.json` 和原始日志，并至少包含以下表格。

### 11.1 Run 级明细表

| run_id | agent | policy | case | status | total | location | coverage | evidence | usability | violations | graph_calls | search_calls | files_read | elapsed_ms |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |

字段来源：

- `total/location/coverage/evidence/usability` 来自 `score.json.score`。
- `graph_calls/search_calls/files_read/elapsed_ms` 来自 `agent-result.json.metrics`。
- `violations` 来自 `agent-result.json.violations.length`。

### 11.2 矩阵聚合表

| agent | policy | run_count | pass_rate | avg_total | p50_total | p90_total | avg_graph_calls | avg_search_calls | avg_files_read | avg_elapsed_ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |

建议公式：

- `pass_rate = passed_runs / valid_runs`
- `avg_total = mean(score.total)`
- `p50_total / p90_total = percentile(score.total)`
- `avg_graph_calls = mean(metrics.graph_query_count)`
- `avg_search_calls = mean(metrics.search_query_count)`

### 11.3 Graph uplift 表

| agent | case | grep_total | graph_total | uplift_abs | uplift_pct | graph_extra_cost_ms | graph_extra_calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |

建议公式：

- `uplift_abs = graph_total - grep_total`
- `uplift_pct = uplift_abs / max(grep_total, 1)`
- `graph_extra_cost_ms = graph_elapsed_ms - grep_elapsed_ms`
- `graph_extra_calls = graph_tool_call_count - grep_tool_call_count`

报告中应明确区分三类收益：

- **准确率收益**：`location_accuracy`、`coverage_completeness` 提升。
- **证据收益**：`evidence_quality` 提升，且证据能落到文件/符号/行号。
- **效率收益**：在同等或更高分数下，`files_read_count`、`search_query_count`、`elapsed_ms` 下降。

### 11.4 策略合规表

| run_id | policy | policy_enforced | forbidden_tool_used | violation_count | invalid_reason |
| --- | --- | --- | --- | ---: | --- |

判定规则：

- `grep` 组出现 `gitnexus_` 工具调用，标记 forbidden tool。
- `graph` 组完全没有 `gitnexus_` 工具调用，标记 graph not used。
- `graph` 组大量 `rg`/`grep` 替代图谱查询，应记录为 soft violation，由人工 judge 决定是否降权。
- 读取 golden answer、其他 agent 输出、历史 score，直接判 invalid。

### 11.5 结论写法

定量报告的结论建议采用固定句式：

```text
在 <case group> 的 <N> 个有效 run 中，<agent> 的 graph 组相对 grep 组平均总分提升 <x> 分（<y>%）。
提升主要来自 <location/coverage/evidence/usability>，代价是平均耗时增加 <z> ms、工具调用增加 <k> 次。
其中 <case_id> uplift 最大，原因是 <需要跨文件调用链/动态分发/影响面分析>；<case_id> uplift 最小，原因是 <grep 已足够/ground truth 集中在单文件/图谱索引缺失>。
```

如果某个 agent 的 `policy_enforced=false`，结论必须加限定：

```text
该 agent 的工具策略由 prompt 约束和日志审计保证，不能视为与硬工具白名单完全等价；其分数可用于能力观察，但不应用作严格隔离实验的唯一依据。
```
