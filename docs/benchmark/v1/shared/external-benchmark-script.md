# External Benchmark Execution Script

本文档记录 `telecom-ops-platform` 和 `QwenPaw` 两个外部代码仓 benchmark 的脚本入口。

脚本位置:

```text
docs/benchmark/v1/runner/run_external_benchmark.ps1
```

默认行为:

- 执行 `docs/benchmark/v1/telecom/plan.yaml`
- 执行 `docs/benchmark/v1/qwenpaw/plan.yaml`
- 默认 agent: `claude-code`
- 默认 model: `deepseek-v4-pro[1m]`
- 默认 tool policy: `grep`, `graph`
- 默认输出目录: `runs/`
- 默认在执行前清理本次输出目录, 避免旧数据污染
- 自动生成 `agent-result.json`, `score.json`, `artifact-validation.json`, `report.json`, `benchmark-summary.md`

## Full Run

全量执行 telecom 和 QwenPaw 两组 case:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1
```

典型输出目录:

```text
runs/
  telecom-claude-code-deepseek-v4-pro-1m/
    matrix-plan.json
    report.json
    benchmark-summary.md
    claude-code/
      grep/
      graph/
  qwenpaw-claude-code-deepseek-v4-pro-1m/
    matrix-plan.json
    report.json
    benchmark-summary.md
    claude-code/
      grep/
      graph/
  orchestration-result.json
```

## Dry Run

只展开矩阵并生成 prompt/manifest, 不调用 Claude Code 或 OpenCode:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -DryRun
```

适合在正式执行前检查:

- plan 是否能通过校验
- case/golden 文件是否存在
- 目标项目路径是否正确
- agent 命令是否符合预期
- grep 组是否没有注入 GitNexus MCP 参数
- graph 组是否会使用 `.mcp.json`

## Single Case Smoke Test

只跑 QwenPaw 的一个 case:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 `
  -Plan docs\benchmark\v1\qwenpaw\plan.yaml `
  -CaseId qwenpaw-case-a-cli-lazy-command-flow `
  -MaxRuns 1
```

只 dry-run 一个 case:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 `
  -Plan docs\benchmark\v1\qwenpaw\plan.yaml `
  -CaseId qwenpaw-case-a-cli-lazy-command-flow `
  -MaxRuns 1 `
  -DryRun
```

## Restrict Tool Policy

只跑 grep 组:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -ToolPolicy grep
```

只跑 graph 组:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -ToolPolicy graph
```

## Agent Selection

默认只跑 `claude-code`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -Agent claude-code
```

同时跑 `claude-code` 和 `opencode`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -Agent claude-code,opencode
```

只跑 `opencode`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -Agent opencode
```

注意: OpenCode 当前无法像 Claude Code 一样通过 CLI 精确声明 allowed/disallowed tools, 因此工具策略主要依赖 prompt 约束和后续 artifact validation 审计。

## Model Selection

指定模型:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -Model "deepseek-v4-pro[1m]"
```

建议固定使用具名模型, 不要使用 `latest` 或 `auto`, 否则后续结果不可复现。

## Reuse Existing Runs

默认脚本会清理本次输出目录后重新执行。若只想基于已有 run 重新抽取、评分、汇总:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -SkipExecute -KeepExisting
```

若想执行新 run 但保留同目录旧数据, 可以使用:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -KeepExisting
```

一般不建议正式 benchmark 使用 `-KeepExisting`, 除非明确知道目录中没有旧 score/report 会污染结果。

## Custom Output Root

输出到独立目录:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -OutRoot runs\experiment-001
```

## MCP Config

默认脚本会使用仓库根目录的 `.mcp.json` 作为 graph 组的 Claude Code MCP 配置。

显式指定 MCP 配置:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -McpConfig C:\qinliuwei\code\GitNexus\.mcp.json
```

runner 只会在 `graph` 或 `mixed` 策略下把 MCP config 传给 Claude Code。`grep` 组不会通过该参数加载 GitNexus MCP。

## Recommended Workflow

第一次执行建议按下面顺序:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 -DryRun
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1 `
  -Plan docs\benchmark\v1\qwenpaw\plan.yaml `
  -CaseId qwenpaw-case-a-cli-lazy-command-flow `
  -MaxRuns 1
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\benchmark\v1\runner\run_external_benchmark.ps1
```

执行完成后优先阅读:

```text
runs/orchestration-result.json
runs/telecom-claude-code-deepseek-v4-pro-1m/benchmark-summary.md
runs/telecom-claude-code-deepseek-v4-pro-1m/report.json
runs/qwenpaw-claude-code-deepseek-v4-pro-1m/benchmark-summary.md
runs/qwenpaw-claude-code-deepseek-v4-pro-1m/report.json
```

若发现异常, 继续检查具体 run 目录下的:

```text
runner-result.json
stdout.txt
stderr.txt
agent-result.json
score.json
artifact-validation.json
```

