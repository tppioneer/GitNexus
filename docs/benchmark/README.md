# Versioned benchmark registry

> **新手入门？** 直接看 [quick-start.md](quick-start.md)，所有操作的统一入口。

Benchmark definitions, executable runners, scoring logic, schemas, reports, and
historical runs are isolated by version.  Official commands must always select
an explicit version; there is no implicit `latest` version.

| Version | Source snapshot | Run scope | Status |
| --- | --- | --- | --- |
| `v1` | committed benchmark state at `fe4640d` | baseline/previous cases | Git-managed |
| `v2` | benchmark-related working-tree snapshot | newly added D/E/F cases | Git-managed |

Use the compatibility entrypoints under `eval/benchmark/`:

```powershell
python eval/benchmark/agent_benchmark_runner.py --version v1 validate --plan docs/benchmark/v1/qwenpaw/plan.yaml
python eval/benchmark/agent_benchmark_runner.py --version v2 validate --plan docs/benchmark/v2/qwenpaw/plan.yaml
node eval/benchmark/report-viz/generate-report.js --version v1
```

Version history and reproducibility are managed by Git commits or tags. Do not
rewrite an old version after its results have been recorded; create a new version
with `eval/benchmark/version_admin.py` instead. Generated runs belong only to the
explicit benchmark version used to produce them.
