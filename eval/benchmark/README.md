# Benchmark compatibility entrypoints

All executable benchmark semantics live under `docs/benchmark/vN/`.  The files
in this directory are thin dispatchers and version-management utilities only.
Every execution must provide an explicit version; there is intentionally no
`latest` or implicit default.

```powershell
python eval/benchmark/agent_benchmark_runner.py --version v1 validate --plan docs/benchmark/v1/qwenpaw/plan.yaml
powershell -File eval/benchmark/run_external_benchmark.ps1 -Version v2 -Model qwen3.7-plus -CaseId qwenpaw-case-d-agent-reload-blast-radius
node eval/benchmark/report-viz/generate-report.js --version v2
```

Execution, scoring, post-processing, and report rendering perform a metadata,
plan, and case preflight. The model identifier must be supplied by the task
initiator for every formal execution. Version history is managed by Git without
a separate immutable-bundle mechanism.

Create a version with either inherited or empty cases:

```powershell
python eval/benchmark/version_admin.py create --from v2 --to v3 --case-mode copy
python eval/benchmark/version_admin.py create --from v2 --to v3 --case-mode empty
python eval/benchmark/version_admin.py validate --version v3
```

Commit the version definition before an official run and record that Git commit
with the experiment. Material scoring or case changes belong in a new version
directory; rerunning an unchanged version does not require metadata changes.
