# Benchmark 评测操作指南

所有命令通过 `eval/benchmark/` 兼容入口发起，用 `--version` 选择版本。当前可用版本见 [README](README.md)。

> **Agent 执行契约：** 本文档是 benchmark 任务的统一入口。当任务要求运行、重跑后处理或生成报告时，读取本文档的当前 Agent 就是执行者，也是 v2/v3 报告分析 Agent。不得在生成 `report-analysis-prompt.md` 后把工作留给一个未定义的“后续调度器”；除非用户明确只要求准备提示词，否则必须继续完成分析结果安装和 HTML 生成。

### 运行目录约定

先确定本次任务唯一的 `RUNS_DIR`，后续所有命令必须使用同一路径：

- 用户指定了已有结果目录时，使用用户给出的原路径，不移动、不复制、不按旧目录猜测。例如当前已有结果为 `runs/v2`，则 `$RunsDir = "runs/v2"`。
- 新执行且用户没有指定目录时，从所选版本的 `benchmark-version.yaml -> paths.runs` 读取默认值；统一使用 `runs/{version}`，例如 v2 为 `runs/v2`、v3 为 `runs/v3`。
- 禁止在同一任务中混用不同 runs 根目录或不同版本。生成提示词、安装分析结果和生成 HTML 都必须显式传入同一个 `RUNS_DIR`。

## 快速索引

| 我想... | 看这里 |
|---------|--------|
| 一键跑完某个版本的全部 case | [方式 A](#方式-a一键全量执行推荐) |
| 只跑某一个 case 验证效果 | [方式 C](#方式-c单-case-验证) |
| 用指定模型/策略跑指定 case | [方式 C + 常用参数](#常用参数) |
| 只看结果不重新跑 | [跳过执行只做后处理](#跳过执行重跑后处理) |
| 根据多次评分生成综合分析 | [v2/v3 完整报告闭环](#1-v2v3-完整报告闭环) |
| 为新代码仓设计 case | [新代码仓 Case Authoring](#四新代码仓-case-authoring) |
| 创建新版本 | [创建新版本](#创建新版本) |
| 生成可视化 HTML 报告 | [v2/v3 完整报告闭环](#1-v2v3-完整报告闭环) |

---

## 前置

每次正式执行前，任务发起者必须明确提供：benchmark 版本、plan、case ID、模型的真实 CLI ID、agent、工具策略、重复次数和目标仓库路径。不要从旧日志或目录名猜模型。

```powershell
# 确认 gitnexus CLI 可用
gitnexus --version

# 确认 .mcp.json 存在（graph 策略需要）
cat .mcp.json

# 校验版本元数据、plan、case 和模型信息；版本文件由 Git 管理
python eval\benchmark\version_admin.py preflight `
  --version v2 `
  --plan docs\benchmark\v2\qwenpaw\plan.yaml `
  --case-id qwenpaw-case-d-agent-reload-blast-radius `
  --model "qwen3.7-plus"
```

新会话触发正式运行时可以直接使用下面的检查提示词：

```text
在执行任何 benchmark run 前，先读取 docs/benchmark/quick-start.md，并要求我明确提供：
version、plan、case_id、model CLI ID、agent、tool policies、repeat 范围和目标仓库。
随后运行 version_admin.py preflight。只有版本元数据存在、plan 有效、case 属于
所选 plan、model 非空时才能执行。任何检查失败都停止，不得忽略失败 plan。
版本变更通过 Git commit、branch 或 tag 追踪；执行结果应记录所使用的 commit。
```

---

## 一、发起评测

### 方式 A：一键全量执行（推荐）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File eval\benchmark\run_external_benchmark.ps1 `
  -Version v2 `
  -Model "qwen3.7-plus"
```

默认执行 telecom 和 qwenpaw，claude-code agent，grep + graph 两策略，每 cell 重复 3 次。输出到 `runs/v2/`。

### 方式 B：分步执行

```powershell
# 1. 校验 plan
python eval\benchmark\agent_benchmark_runner.py --version v2 validate --plan docs\benchmark\v2\telecom\plan.yaml

# 2. 展开运行矩阵
python eval\benchmark\agent_benchmark_runner.py --version v2 plan --plan docs\benchmark\v2\telecom\plan.yaml

# 3. Dry-run 验证
python eval\benchmark\agent_benchmark_runner.py --version v2 execute-matrix --plan docs\benchmark\v2\telecom\plan.yaml --dry-run --mcp-config .mcp.json

# 4. 正式执行
python eval\benchmark\agent_benchmark_runner.py --version v2 execute-matrix --plan docs\benchmark\v2\telecom\plan.yaml --model "qwen3.7-plus" --mcp-config .mcp.json
```

### 方式 C：单 case 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File eval\benchmark\run_external_benchmark.ps1 `
  -Version v2 `
  -Plan docs\benchmark\v2\qwenpaw\plan.yaml `
  -CaseId qwenpaw-case-d-agent-reload-blast-radius `
  -Model "qwen3.7-plus"
```

以上命令会运行该 case 的全部 agent/policy/repeat cell。只有做烟雾测试时才添加 `-MaxRuns 1`；它不能用于正式 Graph/Grep 对照结论。

### 常用参数

| 参数 | 用途 |
|------|------|
| `-Version v2` | **必选**，指定 benchmark 版本 |
| `-Model "qwen3.7-plus"` | 指定模型 |
| `-CaseId case-a,case-b` | 只跑指定 case |
| `-ToolPolicy grep` | 只跑 grep 组 |
| `-ToolPolicy graph` | 只跑 graph 组 |
| `-Agent claude-code` | 指定 agent |
| `-MaxRuns N` | 限制总 run 数 |
| `-DryRun` | 只展开矩阵，不调用 AI |
| `-TimeoutSeconds 1800` | 单 run 超时（秒） |
| `-KeepExisting` | 保留已有结果（增量追加） |
| `-NoReportAnalysisPrompt` | v2/v3 明确只做评分后处理、不生成综合分析提示词 |

多个 case 可以继续通过统一 PowerShell 入口传入；wrapper 会将数组或 Windows PowerShell 5.1 形成的逗号连接值规范化为多个独立的 `--case-id`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File eval\benchmark\run_external_benchmark.ps1 `
  -Version v2 `
  -Plan docs\benchmark\v2\qwenpaw\plan.yaml `
  -Model "qwen3.7-plus" `
  -CaseId "qwenpaw-case-w-token-usage-data-flow","qwenpaw-case-x-weixin-wechat-migration-data-flow" `
  -DryRun
```

该示例应得到 `selected_run_count: 12`（2 case × 2 policy × 3 repeat）。不再需要为了多 case 绕过 wrapper 直接调用 Python runner。

---

## 二、后处理

执行完成后自动进行 extract（结果抽取）→ score（自动评分）→ report（聚合报告）。产物结构：

```
runs/v2/
├── {project}-{agent}-{model}/
│   ├── claude-code/
│   │   ├── graph/{case}__agent__graph__r1/
│   │   │   ├── runner-result.json      # 执行结果
│   │   │   ├── agent-result.json       # agent 回答
│   │   │   ├── score.json              # 自动评分
│   │   │   └── stdout.txt / stderr.txt
│   │   └── grep/
│   └── report.json                     # 项目聚合报告
└── benchmark-report.html               # 可视化报告
```

### 跳过执行重跑后处理

本命令只适用于仍保持 runner 原始 `{project}-{agent}-{model}` 目录结构、且 `$RunsDir` 与首次执行时 `-OutRoot` 完全一致的结果：

```powershell
$RunsDir = "runs/v2" # 必须与首次执行的 -OutRoot 一致
powershell -NoProfile -ExecutionPolicy Bypass `
  -File eval\benchmark\run_external_benchmark.ps1 `
  -Version v2 `
  -Model "qwen3.7-plus" `
  -OutRoot $RunsDir `
  -SkipExecute -KeepExisting
```

该命令会重做 extract/score/report，并在 `$RunsDir` 下生成最新的 `report-analysis-input.json` 与 `report-analysis-prompt.md`。这只是 v2/v3 报告闭环的中间状态；当前任务 Agent 必须继续执行下一节，不能把 `awaiting-agent-analysis` 当作任务完成。

如果用户人工调整过目录结构，例如当前 `runs/v2/{project}-{model}/{agent}/...`，并且各分组已经存在 `report.json`，不要运行上述 wrapper；直接将 `runs/v2` 作为下一节的 `$RunsDir` 执行 `prepare`。需要重新评分时，应先在现有分组内显式执行对应的 extract/score/report，不能让 runner 依据默认命名另建目录。

---

## 三、分析结果

### 1. v2/v3 完整报告闭环

当版本为 v2 或 v3，且任务要求生成或更新综合报告时，当前 Agent 必须按顺序完成以下步骤：

1. 确认所有目标项目的 `report.json` 已生成，且 telecom-large 等已声明作废的数据不参与输入。
2. 执行 `prepare`。即使 runner 已自动准备，也应确认产物存在且属于同一个 `$RunsDir`。
3. 完整读取 `report-analysis-prompt.md`。该文件已经包含提示词模板、多个评分结果、逐项评分和可用原始答复；不得改用自拟的简化提示词。
4. 当前 Agent 按该提示词完成分析，只生成符合 `report-analysis.schema.json` 的单个 JSON 对象，并保存为 `report-analysis.candidate.json`。
5. 执行 `install`。Schema、`source_digest` 或源文件校验失败时，修正或重新分析；不得绕过校验、直接复制为 `report-analysis.json`。
6. 安装成功后生成 HTML，并确认报告中的分析状态为 `ready`。

先按任务选择唯一版本与 runs 目录。下面以 v3 为例；处理当前已有的 v2 数据时改为 `$Version = "v2"`、`$RunsDir = "runs/v2"`：

```powershell
$Version = "v3"
$RunsDir = "runs/v3"
$AnalysisTool = "docs/benchmark/$Version/report-analysis/report_analysis.py"

python $AnalysisTool prepare `
  --runs-dir $RunsDir

# 当前 Agent 在这里完整读取：
#   $RunsDir/report-analysis-prompt.md
# 并严格按其要求生成：
#   $RunsDir/report-analysis.candidate.json

python $AnalysisTool install `
  --runs-dir $RunsDir `
  --result "$RunsDir/report-analysis.candidate.json"

node eval/benchmark/report-viz/generate-report.js `
  --version $Version `
  --runs-dir $RunsDir `
  --out "$RunsDir/benchmark-report.html"
```

正常终态必须同时存在：

```text
$RUNS_DIR/report-analysis-input.json
$RUNS_DIR/report-analysis-prompt.md
$RUNS_DIR/report-analysis.json
$RUNS_DIR/benchmark-report.html
```

其中 `report-analysis.candidate.json` 是可保留的中间审计产物，不是 HTML 读取的正式结果。如果用户明确要求“只准备提示词”或使用 `-NoReportAnalysisPrompt`，才允许跳过上述分析闭环。

### 2. 仅重新生成可视化 HTML

只有 `$RunsDir/report-analysis.json` 已安装且未过期时，才能单独执行：

```bash
node eval/benchmark/report-viz/generate-report.js --version v3 --runs-dir runs/v3 --out runs/v3/benchmark-report.html
```

完整输出契约见 [v2 report analysis](v2/report-analysis/README.md) 和 [v3 report analysis](v3/report-analysis/README.md)。若总结尚未生成、校验失败或评分源变化导致过期，HTML 会显示 `missing`、`invalid` 或 `stale`，不会回退到硬编码归因；这些状态也意味着完整报告任务尚未完成。

### 3. 阅读 JSON 聚合报告

```bash
python eval\benchmark\agent_benchmark_runner.py --version v2 report --scores-dir runs\v2\{project}-{agent}-{model}
```

关键字段：

| 字段 | 含义 |
|------|------|
| `by_agent_policy` | 各组平均分、通过率、工具调用量 |
| `graph_uplift_by_agent` | graph 相对 grep 的分数提升 |
| `avg_total` | 自动评分总分（0-100），基于 term coverage |
| `graph_depth_bonus` | 图谱深度加分（0-10） |
| `search_query_count` | rg/grep/glob 文本搜索次数 |
| `graph_query_count` | GitNexus 图谱查询次数 |

---

## 四、新代码仓 Case Authoring

新代码仓应放入新版本；如果希望从零设计 case，使用 `--case-mode empty`：

```powershell
python eval\benchmark\version_admin.py create --from v2 --to v3 --case-mode empty
Copy-Item docs\benchmark\v3\templates\project docs\benchmark\v3\my-project -Recurse
```

然后完成以下步骤：

1. 将 `REPLACE_*` 全部替换为真实值，设置目标仓库绝对路径和验证命令。
2. 阅读目标代码仓，选择跨文件、多态分发、反向影响面或高同名噪声 case；不要为了图谱而编造不真实的链路。
3. 每个 case 同时创建公开 case YAML 和隐藏 ground truth YAML。
4. ground truth 必须由源码阅读、全仓文本检索和调用关系核验共同确认。
5. 使用完整仓库相对路径，禁止用 `...` 缩写需要参与自动评分的 `file` 字段。
6. 明确列出同名但无关的 false positives、边界条件和推荐测试。
7. 将 plan 加入的每个 case 跑 `validate`、`plan` 和 `--dry-run`。
8. 正式执行前，将 case 中的 `status: draft-ground-truth` 改为 reviewed/verified，并通过 `validate`。

新会话可以直接使用下面的任务提示词：

```text
请基于 docs/benchmark/<draft-version>/shared/scoring-rubric.md，为代码仓
<absolute-repo-path> 构建一组 Graph 与 Grep 对照评测 case。

输入信息：
- benchmark draft 版本：<vN>
- 项目 slug：<project-slug>
- 目标仓库及固定 commit：<path + commit>
- 语言/构建工具/验证命令：<details>
- 期望 case 数量和任务类型：<details>

必须先阅读 docs/benchmark/quick-start.md 和
docs/benchmark/<vN>/templates/README.md，再检查现有 case、ground truth、
runner 的 public_case_payload 与 collect_expected_terms 约束。逐个 case 给出：
选择理由、Graph 预期优势、公开任务、完整 ground truth、排除项、验证命令。
不得把新规则写回旧版本，不得读取历史答案来生成新答案，不得使用省略路径。
完成后运行 version_admin validate，并报告所有阻止正式执行的问题。
```

如果新增项目需要进入 HTML 项目概览，还要同步扩展该 draft 版本的 `report-viz/generate-report.js` 项目发现逻辑，并为它增加测试。

---

## 五、创建新版本

```powershell
# 复制旧 case；适合只修改评分或 prompt
python eval\benchmark\version_admin.py create --from v2 --to v3 --case-mode copy

# 不复制旧项目/case；只复制 runner、规则、报告、测试和通用模板
python eval\benchmark\version_admin.py create --from v2 --to v3 --case-mode empty

# 修改评分细节后做完整校验；create 已自动登记 registry.yaml
python eval\benchmark\version_admin.py validate --version v3

# 用 Git 保存版本定义；需要固定复现实验时可再打 tag
git add docs\benchmark\v3 docs\benchmark\registry.yaml
git commit -m "benchmark: add v3"
# 可选：git tag benchmark-v3-<revision>

# 列出所有版本
python eval\benchmark\version_admin.py list
```

修改评分时必须同步检查以下位置，不能只改说明文档：

- `v3/runner/agent_benchmark_runner.py` 中的 expected-term、coverage、bonus、penalty 和聚合公式；
- `v3/shared/scoring-rubric.md`；
- `v3/tests/` 中对应评分和有效样本测试；
- `v3/report-viz/` 中展示的指标名称和口径；
- `benchmark-version.yaml` 中的 primary comparison 与兼容性声明。

版本号替换由 `create` 自动完成，包括 `docs/benchmark/v2`、`runs/v2`、脚本默认输出和文档命令。发现任何未替换的父版本引用时，`validate` 会失败。

不再生成或校验 benchmark lock。版本定义以 Git 提交为准：同一次正式评测应使用同一 commit；评分规则或 Case 发生实质变化时创建新版本目录并提交，不要覆盖旧版本。重跑只增加运行结果，不需要更新版本元数据。

---

## 六、相关文档

| 文档 | 说明 |
|------|------|
| [README](README.md) | 版本注册表 |
| [shared/scoring-rubric.md](v2/shared/scoring-rubric.md) | 评分细则 |
| [shared/README.md](v2/shared/README.md) | Runner 设计文档 |
| [v2 report analysis](v2/report-analysis/README.md) | v2 多评分分析交接与结果安装 |
| [v3 report analysis](v3/report-analysis/README.md) | v3 多评分分析交接与结果安装 |
| [templates/README.md](templates/README.md) | 新项目 plan/case/ground-truth 模板 |
| `eval/benchmark/version_admin.py` | 版本管理工具代码 |
| `docs/benchmark/<v>/runner/agent_benchmark_runner.py` | Runner 实现 |
# Optional conversational score review

Human adjudication is optional and initiated through an Agent conversation, not by manually editing JSON. Ask the Agent to analyze an anomalous Graph/Grep gap. The Agent uses the read-only `docs/benchmark/adjudication/adjudication_tool.py inspect` command and proposes item-level changes. It may create `adjudication.json` only after the user explicitly approves all or selected changes. See `docs/benchmark/adjudication/README.md` for the fixed credit scale, authorization boundary, and report behavior.
