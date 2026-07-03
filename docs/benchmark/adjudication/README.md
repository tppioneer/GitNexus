# Optional human-approved, agent-assisted adjudication

Human review is an optional conversation-driven stage between automatic scoring and the formal report. Users do not edit `adjudication.json` by hand.

1. The user asks an agent to analyze an unexpected Graph/Grep score difference.
2. The agent runs `adjudication_tool.py inspect` and compares `agent-result.json`, explicit Ground Truth items, and `score.json.item_scores` without writing files.
3. The agent presents item-by-item proposed credit changes and their effect on policy uplift.
4. Only after the user explicitly approves all or selected changes may the agent run `apply` or `accept`.
5. The tool validates fixed credits, immutable dimensions, source hashes, and totals before writing `adjudication.json`.

Allowed credits are `0`, `0.25`, `0.4`, `0.5`, `0.8`, and `1`. Only `call_edges`, `behavior_facts`, `evidence`, and `noise` may be adjusted in v1. `location` and `symbols` remain automatic.

Analysis language such as “why is the gap large?” is read-only. Approval language such as “I accept these changes; apply them” authorizes the sidecar write. The agent must never add credit for facts or relationships that require the reviewer to infer content absent from the original answer.

Commands used by the agent:

```powershell
python docs/benchmark/adjudication/adjudication_tool.py inspect --run-dir <run-dir>
python docs/benchmark/adjudication/adjudication_tool.py inspect --runs-dir <model-runs-dir> --case-id <case-id> --compare grep graph
python docs/benchmark/adjudication/adjudication_tool.py apply --run-dir <run-dir> --decisions <approved.json> --reviewer maintainer --approval-note "Approved in conversation"
python docs/benchmark/adjudication/adjudication_tool.py accept --run-dir <run-dir> --reviewer maintainer --approval-note "Automatic score accepted"
python docs/benchmark/adjudication/adjudication_tool.py validate --run-dir <run-dir>
```

Reports use `adjudicated_total` only for a completed, hash-current sidecar. Otherwise `effective_total` equals `automatic_total`. Reports must disclose review coverage.
