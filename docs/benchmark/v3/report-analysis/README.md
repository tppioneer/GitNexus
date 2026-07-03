# v3 报告分析提示词

`benchmark-report.html` 不再用前端硬编码规则解释“综合”和“提升幅度”。后处理任务先收集多个 `report.json`、逐 run `score.json` 以及可用的原始答复，生成一个 provider-neutral 提示词，再由执行后处理任务的 Agent 完成总结。

当任务以 `docs/benchmark/quick-start.md` 为入口时，读取入口文档的当前 Agent 就是这里所说的分析 Agent。除非用户明确只要求准备提示词，否则生成 prompt 后必须继续完成分析、`install` 和 HTML 重建，不能停在 `awaiting-agent-analysis`。

```powershell
python docs/benchmark/v3/report-analysis/report_analysis.py prepare --runs-dir runs/v3
```

该命令只生成：

- `report-analysis-input.json`：可审计的多评分输入及源文件摘要；
- `report-analysis-prompt.md`：当前任务 Agent 必须完整读取并执行的分析提示词。

Agent 必须完整读取生成的 `report-analysis-prompt.md`，并仅生成符合 `report-analysis.schema.json` 的 JSON。当前任务将返回值保存为候选文件，再安装：

```powershell
python docs/benchmark/v3/report-analysis/report_analysis.py install `
  --runs-dir runs/v3 `
  --result runs/v3/report-analysis.candidate.json

node docs/benchmark/v3/report-viz/generate-report.js --runs-dir runs/v3
```

`install` 会校验 JSON Schema 和 `source_digest`。评分源发生变化后，旧总结会被判定为 stale；重新执行 `prepare` 和分析任务即可。没有有效总结时，HTML 会显示待分析提示，不会回退到未经证据支持的自动归因。

推荐的调度顺序是：执行 benchmark → extract/score/artifact validation → 为各项目生成 `report.json` → `prepare` → Agent 总结 → `install` → 生成 HTML。总结阶段不修改自动评分或人工审核结果。
