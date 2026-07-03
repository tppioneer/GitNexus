import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))

from agent_benchmark_runner import (
    _alias_expand,
    _alias_hit,
    _compute_analysis_depth_bonus,
    _detect_gitnexus_tools,
    build_command,
    build_prompt,
    execute_matrix,
    execute_run,
    extract_agent_result,
    expand_run_plan,
    find_run,
    aggregate_scores,
    normalize_agent_result,
    resolve_benchmark_path,
    score_run_result,
    validate_plan,
    validate_run_artifacts,
)


def write_plan(tmp_path: Path, repeats: int = 2) -> Path:
    target = tmp_path / "target"
    cases = target / "docs" / "benchmark-cases"
    golden = cases / "ground-truth"
    golden.mkdir(parents=True)

    for name in ("case-a.yaml", "case-b.yaml"):
        (cases / name).write_text("id: sample\n", encoding="utf-8")
    for name in ("case-a-ground-truth.yaml", "case-b-ground-truth.yaml"):
        (golden / name).write_text("expected: []\n", encoding="utf-8")

    plan = tmp_path / "plan.yaml"
    plan.write_text(
        f"""
version: 1
name: sample
target_project:
  path: {target.as_posix()}
  validation_commands:
    - mvn test
case_source:
  cases:
    - id: case-a
      file: docs/benchmark-cases/case-a.yaml
      golden: docs/benchmark-cases/ground-truth/case-a-ground-truth.yaml
      modification_case: false
    - id: case-b
      file: docs/benchmark-cases/case-b.yaml
      golden: docs/benchmark-cases/ground-truth/case-b-ground-truth.yaml
      modification_case: true
run_matrix:
  agents:
    - claude-code
    - opencode
  tool_policies:
    - grep
    - graph
  repeats_per_cell: {repeats}
""",
        encoding="utf-8",
    )
    (tmp_path / "agent-profiles.yaml").write_text(
        """
version: 1
tool_policies:
  grep:
    allowed_capabilities:
      - shell_rg
      - read_file
    forbidden_capabilities:
      - gitnexus_query
  graph:
    allowed_capabilities:
      - gitnexus_query
      - read_file
    forbidden_capabilities:
      - broad_rg_scan
""",
        encoding="utf-8",
    )
    return plan


def test_validate_plan_accepts_complete_metadata(tmp_path: Path):
    plan = write_plan(tmp_path)

    assert validate_plan(plan) == []


def test_expand_run_plan_multiplies_cases_agents_policies_and_repeats(tmp_path: Path):
    plan = write_plan(tmp_path, repeats=2)

    expanded = expand_run_plan(plan)

    assert expanded["run_count"] == 16
    run_ids = {run["run_id"] for run in expanded["runs"]}
    assert "case-a__claude-code__grep__r1" in run_ids
    assert "case-b__opencode__graph__r2" in run_ids


def test_validate_plan_reports_missing_golden_file(tmp_path: Path):
    plan = write_plan(tmp_path)
    missing = tmp_path / "target" / "docs" / "benchmark-cases" / "ground-truth" / "case-b-ground-truth.yaml"
    missing.unlink()

    errors = validate_plan(plan)

    assert any("case-b: golden file does not exist" in error for error in errors)


def test_resolve_benchmark_path_can_use_central_case_files(tmp_path: Path, monkeypatch):
    plan_dir = tmp_path / "plans"
    plan_dir.mkdir()
    target = tmp_path / "target"
    target.mkdir()
    central_case = tmp_path / "docs" / "benchmark-cases" / "case.yaml"
    central_case.parent.mkdir(parents=True)
    central_case.write_text("id: case\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    resolved = resolve_benchmark_path(plan_dir / "plan.yaml", target, "docs/benchmark-cases/case.yaml")

    assert resolved.resolve() == central_case.resolve()


def test_build_prompt_hides_ground_truth_and_scoring(tmp_path: Path):
    plan = write_plan(tmp_path)
    expanded = expand_run_plan(plan)
    run = find_run(expanded, "case-a__claude-code__grep__r1")

    prompt = build_prompt(plan, run)

    assert "golden_answers_are_hidden" in prompt
    assert "case-a-ground-truth.yaml" not in prompt
    assert '"tool_policy": "grep"' in prompt
    assert '"required_top_level_fields"' in prompt
    assert '"template"' in prompt
    assert "run-result.schema.json" in prompt
    assert "graph_queries" not in prompt
    assert "grep_searches" not in prompt


def test_build_prompt_adds_graph_entrypoint_guidance_only_for_graph(tmp_path: Path):
    plan = write_plan(tmp_path)
    expanded = expand_run_plan(plan)
    graph_run = find_run(expanded, "case-a__claude-code__graph__r1")
    grep_run = find_run(expanded, "case-a__claude-code__grep__r1")

    graph_prompt = build_prompt(plan, graph_run)
    grep_prompt = build_prompt(plan, grep_run)

    assert "normal code investigation enhanced by GitNexus" in graph_prompt
    assert "You MUST begin the investigation with GitNexus query/context/impact tools" in graph_prompt
    assert "/gitnexus-exploring" in graph_prompt
    assert "/gitnexus-debugging" not in graph_prompt
    assert "gitnexus-claude-plugin" in graph_prompt
    assert "rg/grep/glob/find/read are allowed as supporting tools" in graph_prompt
    assert "normal code investigation enhanced by GitNexus" not in grep_prompt
    assert "graph_queries" not in graph_prompt
    assert "case-a-ground-truth.yaml" not in graph_prompt


def test_prepare_dry_run_writes_manifest_and_result(tmp_path: Path):
    plan = write_plan(tmp_path)
    out_dir = tmp_path / "runs"

    result = execute_run(
        plan,
        "case-a__claude-code__grep__r1",
        out_dir,
        dry_run=True,
        model="claude-test-model",
    )

    run_dir = Path(result["manifest"]["prompt_file"]).parent
    assert result["status"] == "dry-run"
    assert (run_dir / "prompt.txt").exists()
    assert (run_dir / "manifest.json").exists()
    assert (run_dir / "runner-result.json").exists()


def test_opencode_command_uses_run_mode_and_prompt_attachment(tmp_path: Path):
    plan = write_plan(tmp_path)
    expanded = expand_run_plan(plan)
    run = find_run(expanded, "case-a__opencode__grep__r1")
    prompt_path = tmp_path / "prompt.txt"
    prompt_path.write_text("hello", encoding="utf-8")

    command = build_command(run, prompt_path, model="provider/model")

    assert command.command[0] in {"opencode", "opencode.cmd"}
    assert command.command[1:4] == ["run", "--format", "json"]
    assert "--dir" in command.command
    assert "-f" in command.command
    assert str(prompt_path.resolve()) in command.command
    assert command.command[command.command.index("--model") + 1] == "provider/model"
    assert command.policy_enforced is False
    assert "policy is prompt-enforced only" in command.notes[1]


def test_claude_graph_command_allows_gitnexus_mcp_tools_and_resolves_config(tmp_path: Path):
    plan = write_plan(tmp_path)
    expanded = expand_run_plan(plan)
    run = find_run(expanded, "case-a__claude-code__graph__r1")
    prompt_path = tmp_path / "prompt.txt"
    prompt_path.write_text("hello", encoding="utf-8")
    repo_root = Path(__file__).resolve().parents[4]
    mcp_config = repo_root / ".mcp.json"

    command = build_command(run, prompt_path, mcp_config=str(mcp_config))

    allowed_tools = command.command[command.command.index("--allowedTools") + 1]
    assert "mcp__gitnexus__query" in allowed_tools
    assert "mcp__gitnexus__impact" in allowed_tools
    assert "Skill" in allowed_tools
    assert command.command[command.command.index("--mcp-config") + 1] == str(mcp_config.resolve())
    assert "--strict-mcp-config" in command.command
    assert command.command[command.command.index("--plugin-dir") + 1] == str(
        (repo_root / "gitnexus-claude-plugin").resolve()
    )
    assert command.policy_enforced is True


def test_claude_graph_command_rejects_non_root_mcp_config(tmp_path: Path):
    plan = write_plan(tmp_path)
    expanded = expand_run_plan(plan)
    run = find_run(expanded, "case-a__claude-code__graph__r1")
    prompt_path = tmp_path / "prompt.txt"
    prompt_path.write_text("hello", encoding="utf-8")
    wrong_config = tmp_path / ".mcp.json"
    wrong_config.write_text('{"mcpServers": {}}', encoding="utf-8")

    with pytest.raises(ValueError, match="require root MCP config"):
        build_command(run, prompt_path, mcp_config=str(wrong_config))


def test_score_run_result_counts_ground_truth_hits(tmp_path: Path):
    run_result = tmp_path / "run-result.json"
    golden = tmp_path / "golden.yaml"
    run_result.write_text(
        """
{
  "case_id": "case-a",
  "final_answer": {
    "summary": "Flow starts at DeviceMetricIngestController.ingestMetric and writes AlarmRecord."
  },
  "violations": []
}
""",
        encoding="utf-8",
    )
    golden.write_text(
        """
expected_call_chain:
  - symbol: DeviceMetricIngestController.ingestMetric
    file: device-collector-service/.../DeviceMetricIngestController.java
  - symbol: AutoWorkOrderService.createForAlarm
    file: workorder-service/.../AutoWorkOrderService.java
""",
        encoding="utf-8",
    )

    score = score_run_result(run_result, golden)

    assert score["hit_count"] == 1
    assert "DeviceMetricIngestController.ingestMetric" in score["hits"]
    assert "AutoWorkOrderService.createForAlarm" in score["misses"]


def test_execute_matrix_dry_run_can_filter_and_limit(tmp_path: Path):
    plan = write_plan(tmp_path)
    out_dir = tmp_path / "runs"

    summary = execute_matrix(
        plan,
        out_dir,
        dry_run=True,
        agents={"claude-code"},
        tool_policies={"grep"},
        max_runs=2,
        model="claude-test-model",
    )

    assert summary["selected_run_count"] == 2
    assert summary["status_counts"] == {"dry-run": 2}
    assert (Path(summary["out_dir"]) / "matrix-result.json").exists()


def test_aggregate_scores_reports_agent_policy_average_and_uplift(tmp_path: Path):
    scores = tmp_path / "scores"
    scores.mkdir()
    samples = [
        ("claude-code", "grep", 40),
        ("claude-code", "graph", 70),
        ("opencode", "grep", 50),
        ("opencode", "graph", 55),
    ]
    for agent, policy, total in samples:
        # Create artifact files alongside the score file
        run_dir = scores / agent / policy / f"case-a__{agent}__{policy}__r1"
        run_dir.mkdir(parents=True)
        (run_dir / "runner-result.json").write_text(json.dumps({
            "run_id": f"case-a__{agent}__{policy}__r1",
            "status": "passed",
            "manifest": {"run": {"agent": agent, "tool_policy": policy},
                         "command": ["claude"], "policy_enforced": True},
        }), encoding="utf-8")
        (run_dir / "agent-result.json").write_text(json.dumps({
            "case_id": "case-a",
            "final_answer": {"summary": "ok"},
            "metrics": {"elapsed_ms": 60000},
            "tool_calls": [],
            "violations": [],
        }), encoding="utf-8")
        # Write score.json inside the run_dir
        (run_dir / "score.json").write_text(
            f"""
{{
  "case_id": "case-a",
  "run_id": "case-a__{agent}__{policy}__r1",
  "agent": "{agent}",
  "tool_policy": "{policy}",
  "run_result": "{run_dir.as_posix()}/agent-result.json",
  "score": {{"total": {total}}},
  "hit_count": 1,
  "expected_term_count": 2
}}
""",
            encoding="utf-8",
        )

    report = aggregate_scores(scores)

    assert report["score_file_count"] == 4
    assert report["graph_uplift_by_agent"] == {"claude-code": 30.0, "opencode": 5.0}
    assert report["graph_policy_observability"]["graph_run_count"] == 2
    assert report["graph_policy_observability"]["zero_graph_query_count"] == 2
    assert report["graph_policy_observability"]["text_heavy_graph_run_count"] == 0
    assert "case-a__claude-code__graph__r1" in report["graph_policy_observability"]["zero_graph_query_run_ids"]


def test_extract_agent_result_unwraps_cli_result_string(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    stdout = run_dir / "stdout.txt"
    runner_result = run_dir / "runner-result.json"
    stdout.write_text(
        json.dumps(
            {
                "type": "result",
                "result": json.dumps(
                    {
                        "case_id": "case-a",
                        "run_id": "case-a__claude-code__grep__r1",
                        "agent": "claude-code",
                        "tool_policy": "grep",
                        "policy_enforced": True,
                        "started_at": "2026-01-01T00:00:00Z",
                        "ended_at": "2026-01-01T00:01:00Z",
                        "status": "passed",
                        "final_answer": {"summary": "ok"},
                        "evidence": [],
                        "metrics": {"tool_call_count": 0, "files_read_count": 0},
                        "violations": [],
                    }
                ),
            }
        ),
        encoding="utf-8",
    )
    runner_result.write_text(
        json.dumps({"stdout_file": str(stdout)}),
        encoding="utf-8",
    )

    extracted = extract_agent_result(runner_result)

    assert extracted["case_id"] == "case-a"
    assert (run_dir / "agent-result.json").exists()


def test_extract_agent_result_unwraps_opencode_jsonl_events(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    stdout = run_dir / "stdout.txt"
    runner_result = run_dir / "runner-result.json"
    answer = {
        "case_id": "case-a",
        "run_id": "case-a__opencode__graph__r1",
                        "agent": "opencode",
                        "tool_policy": "graph",
                        "policy_enforced": True,
        "started_at": "2026-01-01T00:00:00Z",
        "ended_at": "2026-01-01T00:01:00Z",
        "status": "passed",
        "final_answer": {
            "summary": "ok",
            "entrypoints": [{"name": "cli", "kind": "function", "reason": "entry"}],
        },
        "evidence": [{"name": "cli", "kind": "function", "reason": "entry"}],
        "metrics": {"tool_call_count": 1, "files_read_count": 0},
        "violations": [],
    }
    stdout.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "type": "tool_use",
                        "part": {"state": {"output": json.dumps({"not": "the final answer"})}},
                    }
                ),
                json.dumps(
                    {
                        "type": "message",
                        "part": {
                            "type": "text",
                            "text": "```json\n" + json.dumps(answer) + "\n```",
                        },
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    runner_result.write_text(
        json.dumps(
            {
                "stdout_file": str(stdout),
                "elapsed_ms": 1234,
                "manifest": {"policy_enforced": False},
            }
        ),
        encoding="utf-8",
    )

    extracted = extract_agent_result(runner_result)

    assert extracted["case_id"] == "case-a"
    assert extracted["agent"] == "opencode"
    assert extracted["policy_enforced"] is False
    assert extracted["metrics"]["elapsed_ms"] == 1234
    assert extracted["final_answer"]["entrypoints"][0]["kind"] == "function"


# --- Improvement 1: Alias normalization ---

def test_alias_expand_colon_dot_interchange():
    variants = _alias_expand("qwenpaw.cli.main.cli")
    assert "qwenpaw.cli.main:cli" in variants
    assert "qwenpaw.cli.main.cli" in variants

    variants = _alias_expand("qwenpaw.cli.main:cli")
    assert "qwenpaw.cli.main.cli" in variants


def test_alias_hit_accepts_dot_when_expected_colon():
    answer = "entry point: qwenpaw.cli.main:cli configured in pyproject.toml"
    assert _alias_hit("qwenpaw.cli.main.cli", answer)


def test_alias_hit_accepts_colon_when_expected_dot():
    answer = "the cli function at qwenpaw.cli.main.cli is the root"
    assert _alias_hit("qwenpaw.cli.main:cli", answer)


def test_alias_hit_project_scripts_heuristic():
    answer = (
        "project.scripts section:\n"
        "qwenpaw = qwenpaw.cli.main:cli\n"
        "copaw = qwenpaw.cli.main:cli\n"
    )
    assert _alias_hit("project.scripts.qwenpaw", answer)
    assert _alias_hit("project.scripts.copaw", answer)


def test_alias_hit_project_scripts_missing_name():
    answer = "project.scripts is configured"
    assert not _alias_hit("project.scripts.qwenpaw", answer)


def test_alias_hit_path_separator_normalized():
    answer = "file: src/qwenpaw/cli/main.py"
    assert _alias_hit("src\\qwenpaw\\cli\\main.py", answer)


def test_alias_hit_case_insensitive():
    answer = "LazyGroup at src/qwenpaw/CLI/main.py"
    assert _alias_hit("src\\qwenpaw\\cli\\Main.PY", answer)


def test_score_run_result_uses_alias_for_colon_dot(tmp_path: Path):
    run_result = tmp_path / "run-result.json"
    golden = tmp_path / "golden.yaml"
    run_result.write_text(
        json.dumps({
            "case_id": "case-a",
            "final_answer": {
                "summary": "Entry point is qwenpaw.cli.main:cli"
            },
            "metrics": {},
            "violations": [],
        }),
        encoding="utf-8",
    )
    golden.write_text(
        "expected_symbols:\n  - symbol: qwenpaw.cli.main.cli\n    file: src/qwenpaw/cli/main.py\n",
        encoding="utf-8",
    )

    score = score_run_result(run_result, golden)

    assert score["hit_count"] == 1
    assert "qwenpaw.cli.main.cli" in score["hits"]


def test_score_run_result_uses_project_scripts_alias(tmp_path: Path):
    run_result = tmp_path / "run-result.json"
    golden = tmp_path / "golden.yaml"
    run_result.write_text(
        json.dumps({
            "case_id": "case-a",
            "final_answer": {
                "summary": "Configured in project.scripts: qwenpaw = qwenpaw.cli.main:cli"
            },
            "metrics": {},
            "violations": [],
        }),
        encoding="utf-8",
    )
    golden.write_text(
        "expected_entrypoints:\n  - symbol: project.scripts.qwenpaw\n    file: pyproject.toml\n",
        encoding="utf-8",
    )

    score = score_run_result(run_result, golden)

    assert "project.scripts.qwenpaw" in score["hits"]


# --- Improvement 2: Graph depth bonus ---

def test_detect_gitnexus_tools_recognizes_gitnexus_underscore_names():
    tools = _detect_gitnexus_tools([
        {"tool": "gitnexus_context", "input_summary": "context LazyGroup"},
        {"tool": "gitnexus_impact", "input_summary": "impact cli downstream"},
    ])
    assert "gitnexus_context" in tools
    assert "gitnexus_impact" in tools


def test_detect_gitnexus_tools_recognizes_mcp_names():
    tools = _detect_gitnexus_tools([
        {"tool": "mcp__gitnexus__context", "input_summary": "context"},
    ])
    assert "gitnexus_context" in tools


def test_detect_gitnexus_tools_recognizes_bash_cli():
    tools = _detect_gitnexus_tools([
        {"tool": "Bash", "input_summary": "gitnexus context LazyGroup", "purpose": "GitNexus context"},
    ])
    assert "gitnexus_context" in tools


def test_analysis_depth_bonus_zero_for_grep_only():
    agent_result = {
        "tool_calls": [
            {"tool": "Grep", "purpose": "search", "input_summary": "rg validate", "output_summary": "3 results"}
        ],
        "final_answer": {"summary": "Found 3 validate methods"},
    }
    bonus, reasons = _compute_analysis_depth_bonus(agent_result)
    assert bonus == 0.0
    assert len(reasons) == 0


def test_analysis_depth_bonus_triggers_with_context_and_callers():
    agent_result = {
        "tool_calls": [
            {
                "tool": "gitnexus_context",
                "purpose": "GitNexus context for read_last_api",
                "input_summary": "context read_last_api",
                "output_summary": "Found 8 callers across 6 modules",
            }
        ],
        "final_answer": {
            "summary": "read_last_api has 8 callers including cli(), VoiceChannel.start(), etc."
        },
        "evidence": [{"name": "read_last_api", "reason": "8 callers found"}],
    }
    bonus, reasons = _compute_analysis_depth_bonus(agent_result)
    assert bonus > 0.0
    assert any("caller" in r.lower() for r in reasons)


def test_analysis_depth_bonus_triggers_with_impact_and_critical():
    agent_result = {
        "tool_calls": [
            {
                "tool": "gitnexus_impact",
                "purpose": "impact analysis",
                "input_summary": "impact cli downstream",
                "output_summary": "CRITICAL risk, 29 affected processes",
            }
        ],
        "final_answer": {
            "summary": "cli function has CRITICAL risk with 29 affected processes",
            "impact": [
                {"name": "cli impact", "kind": "flow", "reason": "CRITICAL risk: 29 processes affected"}
            ],
        },
        "evidence": [{"name": "cli", "reason": "CRITICAL impact"}],
    }
    bonus, reasons = _compute_analysis_depth_bonus(agent_result)
    assert bonus > 0.0


def test_analysis_depth_bonus_dedup_repetition_not_inflated():
    """Repeating the same structural signal 10 times should not inflate the bonus."""
    summary = "CRITICAL risk with 29 affected processes. " * 10
    agent_result = {
        "tool_calls": [
            {"tool": "gitnexus_impact", "input_summary": "impact cli downstream"}
        ],
        "final_answer": {"summary": summary},
        "evidence": [{"name": "cli", "reason": summary}],
    }
    bonus, reasons = _compute_analysis_depth_bonus(agent_result)
    # With dedup, bonus should be capped per signal type, not scale with repetition
    assert bonus <= 5.0  # far below the old behavior of 9.0 for 25 matches


def test_coverage_total_excludes_penalty():
    """coverage_total should NOT include policy violation penalty."""
    import tempfile
    tmp = Path(tempfile.mkdtemp())
    run_result = tmp / "run-result.json"
    golden = tmp / "golden.yaml"
    run_result.write_text(json.dumps({
        "case_id": "case-a",
        "final_answer": {
            "summary": "Entry point is qwenpaw.cli.main.cli defined in src/qwenpaw/cli/main.py and project.scripts qwenpaw = ..."
        },
        "metrics": {},
        "violations": [{"type": "tool_policy", "detail": "used gitnexus"}],
    }), encoding="utf-8")
    golden.write_text(
        "expected_symbols:\n  - symbol: qwenpaw.cli.main.cli\n    file: src/qwenpaw/cli/main.py\n",
        encoding="utf-8",
    )

    score = score_run_result(run_result, golden)

    s = score["score"]
    assert s["coverage_total"] == 45.0
    assert score["legacy_score"]["total"] == 80.0
    # 1 violation: penalty = 10
    assert s["policy_violation_penalty"] == 10.0
    assert s["adjusted_total"] == 35.0
    assert s["total"] == s["adjusted_total"]


def test_analysis_depth_bonus_does_not_change_coverage_total():
    """analysis_depth_bonus should be separate from coverage_total."""
    import tempfile
    tmp = Path(tempfile.mkdtemp())
    run_result = tmp / "run-result.json"
    golden = tmp / "golden.yaml"
    run_result.write_text(json.dumps({
        "case_id": "case-a",
        "final_answer": {
            "summary": "LazyGroup in src/qwenpaw/cli/main.py handles commands. CRITICAL risk with 29 processes."
        },
        "tool_calls": [
            {"tool": "gitnexus_impact", "input_summary": "impact cli downstream",
             "output_summary": "CRITICAL risk, 29 affected processes"}
        ],
        "metrics": {},
        "violations": [],
    }), encoding="utf-8")
    golden.write_text(
        "expected_symbols:\n  - symbol: LazyGroup\n    file: src/qwenpaw/cli/main.py\n",
        encoding="utf-8",
    )

    score = score_run_result(run_result, golden)

    s = score["score"]
    # coverage_total unaffected by analysis_depth_bonus
    assert s["coverage_total"] == 45.0
    assert s["analysis_depth_bonus"] == 0.0
    assert s["graph_evidence_score"] > 0.0
    assert s["adjusted_total"] == s["coverage_total"]
    assert s["total"] == s["adjusted_total"]


def test_analysis_depth_bonus_never_exceeds_max():
    agent_result = {
        "tool_calls": [
            {"tool": "gitnexus_context", "input_summary": "context"},
            {"tool": "gitnexus_impact", "input_summary": "impact"},
            {"tool": "gitnexus_query", "input_summary": "query"},
        ],
        "final_answer": {
            "summary": "CRITICAL risk with 29 affected processes. Found 8 callers via call chain. "
                       "Execution flow traces data flow through the process. "
                       "8 callers use this function. 29 processes affected. Call chain evidence.",
            "impact": [
                {"name": "x", "reason": "CRITICAL: 29 affected processes, HIGH impact"},
            ],
        },
    }
    bonus, reasons = _compute_analysis_depth_bonus(agent_result)
    assert bonus <= 10.0


def test_analysis_depth_bonus_integrated_in_score(tmp_path: Path):
    run_result = tmp_path / "run-result.json"
    golden = tmp_path / "golden.yaml"
    run_result.write_text(
        json.dumps({
            "case_id": "case-a",
            "final_answer": {"summary": "LazyGroup handles commands"},
            "tool_calls": [
                {"tool": "gitnexus_impact", "purpose": "impact",
                 "input_summary": "impact cli --direction downstream",
                 "output_summary": "CRITICAL risk, 29 processes affected"}
            ],
            "metrics": {"graph_query_count": 4},
            "violations": [],
        }),
        encoding="utf-8",
    )
    golden.write_text(
        "expected_symbols:\n  - symbol: LazyGroup\n    file: src/qwenpaw/cli/main.py\n",
        encoding="utf-8",
    )

    score = score_run_result(run_result, golden)

    s = score["score"]
    assert "coverage_total" in s
    assert "analysis_depth_bonus" in s
    assert "adjusted_total" in s
    assert "total" in s
    assert s["total"] == s["adjusted_total"]
    assert s["analysis_depth_bonus"] == 0.0
    assert s["graph_evidence_score"] > 0.0
    assert len(s["graph_evidence_signals"]) > 0


def test_structural_score_uses_final_answer_and_keeps_exclusions_negative(tmp_path: Path):
    run_result = tmp_path / "agent-result.json"
    golden = tmp_path / "golden.yaml"
    run_result.write_text(json.dumps({
        "case_id": "case-a", "final_answer": {"summary": "Target.entry in src/target.py"},
        "tool_calls": [{"tool": "gitnexus_query", "output_summary": "Noise.symbol"}], "violations": [],
    }), encoding="utf-8")
    golden.write_text("expected_entrypoints:\n  - symbol: Target.entry\n    file: src/target.py\nmust_exclude_from_impact:\n  - symbol: Noise.symbol\n", encoding="utf-8")

    score = score_run_result(run_result, golden)

    assert "Noise.symbol" not in score["hits"]
    assert score["noise_hits"] == []
    assert score["expected_term_count"] == 2


def test_structural_score_counts_edges_and_facts_without_graph_bonus(tmp_path: Path):
    run_result = tmp_path / "agent-result.json"
    golden = tmp_path / "golden.yaml"
    run_result.write_text(json.dumps({
        "case_id": "case-a",
        "final_answer": {"summary": "A calls B. The background run continues after browser disconnect.",
                         "call_chains": [[{"symbol": "A"}, {"symbol": "B"}]]},
        "tool_calls": [{"tool": "gitnexus_context"}], "violations": [],
    }), encoding="utf-8")
    golden.write_text('expected_call_chains:\n  - route: "A -> B"\nmust_mention:\n  - The background run continues after browser disconnect.\n', encoding="utf-8")

    score = score_run_result(run_result, golden)

    assert score["edge_hit_count"] == 1
    assert score["fact_hit_count"] == 1
    assert score["score"]["analysis_depth_bonus"] == 0.0
    assert score["score"]["graph_evidence_score"] > 0.0


def test_explicit_ground_truth_emits_item_scores_and_rejects_proximity_credit(tmp_path: Path):
    run_result = tmp_path / "agent-result.json"
    golden = tmp_path / "golden.yaml"
    run_result.write_text(json.dumps({
        "case_id": "case-a",
        "final_answer": {"summary": "A is discussed before B, but no relationship is asserted."},
        "violations": [],
    }), encoding="utf-8")
    golden.write_text("""
expected_edges:
  - id: edge.a-to-b
    from: A
    to: B
    relation: calls
expected_facts:
  - id: fact.sample
    description: A sample fact that is absent.
noise_items:
  - id: noise.unrelated
    symbol: Unrelated
""", encoding="utf-8")

    score = score_run_result(run_result, golden)
    edge = next(item for item in score["item_scores"] if item["item_id"] == "edge.a-to-b")
    assert edge["match_source"] == "proximity_candidate"
    assert edge["automatic_credit"] == 0
    assert score["automatic_total"] == score["effective_total"]


def test_explicit_ground_truth_requires_unique_ids(tmp_path: Path):
    run_result = tmp_path / "agent-result.json"
    golden = tmp_path / "golden.yaml"
    run_result.write_text(json.dumps({"case_id": "case-a", "final_answer": {}, "violations": []}), encoding="utf-8")
    golden.write_text("""
expected_edges:
  - id: edge.duplicate
    from: A
    to: B
expected_facts:
  - id: edge.duplicate
    description: duplicate
""", encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate ground truth item ids"):
        score_run_result(run_result, golden)


def test_aggregate_scores_uses_completed_current_adjudication(tmp_path: Path):
    import hashlib
    run = tmp_path / "run"
    run.mkdir()
    score_path = run / "score.json"
    agent_path = run / "agent-result.json"
    golden_path = tmp_path / "golden.yaml"
    agent_path.write_text("{}", encoding="utf-8")
    golden_path.write_text("case_id: case-a\n", encoding="utf-8")
    score_path.write_text(json.dumps({
        "case_id": "case-a", "run_id": "case-a__claude-code__graph__r1",
        "agent": "claude-code", "tool_policy": "graph", "status": "passed",
        "automatic_total": 60.0, "run_result": str(run / "agent-result.json"),
        "score": {"total": 60.0}, "metrics": {}, "violation_count": 0,
        "item_scores": [{"item_id": "evidence.a", "dimension": "evidence", "max_points": 10, "automatic_credit": 0}]
    }), encoding="utf-8")
    digest = hashlib.sha256(score_path.read_bytes()).hexdigest()
    (run / "adjudication.json").write_text(json.dumps({
        "sources": {"automatic_score": {"sha256": digest},
                    "agent_result": {"sha256": hashlib.sha256(agent_path.read_bytes()).hexdigest()},
                    "ground_truth": {"path": str(golden_path), "sha256": hashlib.sha256(golden_path.read_bytes()).hexdigest()}},
        "review": {"status": "completed", "outcome": "adjusted"},
        "decisions": [{"item_id": "evidence.a", "dimension": "evidence", "adjudicated": {"credit": 1}}],
        "result": {"adjudicated_total": 70.0}
    }), encoding="utf-8")

    report = aggregate_scores(tmp_path)
    row = report["rows"][0]
    assert row["automatic_total"] == 60.0
    assert row["adjudicated_total"] == 70.0
    assert row["effective_total"] == 70.0
    assert row["total"] == 70.0
    assert row["review_status"] == "completed"





# --- Improvement 3: Artifact validation ---

def test_validate_run_artifacts_standard_no_warnings(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "runner-result.json").write_text(
        json.dumps({
            "run_id": "case__claude-code__grep__r1",
            "status": "passed",
            "stdout_file": str(run_dir / "stdout.txt"),
            "stderr_file": str(run_dir / "stderr.txt"),
            "elapsed_ms": 60000,
            "manifest": {
                "run": {"run_id": "case__claude-code__grep__r1", "agent": "claude-code", "tool_policy": "grep"},
                "command": ["claude", "--print"],
                "policy_enforced": True,
            },
        }),
        encoding="utf-8",
    )
    (run_dir / "stdout.txt").write_text("output", encoding="utf-8")
    (run_dir / "stderr.txt").write_text("", encoding="utf-8")
    (run_dir / "agent-result.json").write_text(
        json.dumps({
            "case_id": "case",
            "final_answer": {"summary": "ok"},
            "metrics": {"elapsed_ms": 60000},
            "tool_calls": [{"tool": "Grep", "input_summary": "rg test"}],
            "violations": [],
        }),
        encoding="utf-8",
    )
    (run_dir / "score.json").write_text('{"score": {"total": 50}}', encoding="utf-8")

    result = validate_run_artifacts(run_dir)

    assert result["valid"] is True
    assert len(result["warnings"]) == 0


def test_validate_run_artifacts_warns_missing_stdout_file(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "runner-result.json").write_text(
        json.dumps({
            "run_id": "case__claude-code__grep__r1",
            "status": "passed",
            "elapsed_ms": 0,
        }),
        encoding="utf-8",
    )

    result = validate_run_artifacts(run_dir)

    assert result["valid"] is True
    assert any("missing stdout_file" in w.lower() for w in result["warnings"])


def test_validate_run_artifacts_warns_in_process(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "runner-result.json").write_text(
        json.dumps({
            "run_id": "case__claude-code__graph__r1",
            "status": "completed",
            "execution_mode": "in-process",
            "elapsed_ms": 120000,
            "manifest": {
                "run": {"agent": "claude-code", "tool_policy": "graph"},
                "command": ["claude"],
                "policy_enforced": True,
            },
        }),
        encoding="utf-8",
    )
    (run_dir / "agent-result.json").write_text(
        json.dumps({
            "case_id": "case",
            "final_answer": {"summary": "ok"},
            "metrics": {"elapsed_ms": 120000},
            "tool_calls": [{"tool": "Bash", "input_summary": "gitnexus context LazyGroup"}],
            "violations": [],
        }),
        encoding="utf-8",
    )

    result = validate_run_artifacts(run_dir)

    assert any("in-process" in w.lower() for w in result["warnings"])


def test_validate_run_artifacts_warns_graph_via_cli_not_mcp(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "runner-result.json").write_text(
        json.dumps({
            "run_id": "case__claude-code__graph__r1",
            "status": "passed",
            "elapsed_ms": 60000,
            "manifest": {
                "run": {"agent": "claude-code", "tool_policy": "graph"},
                "command": ["claude"],
                "policy_enforced": True,
            },
        }),
        encoding="utf-8",
    )
    (run_dir / "agent-result.json").write_text(
        json.dumps({
            "case_id": "case",
            "final_answer": {"summary": "ok"},
            "metrics": {"elapsed_ms": 60000},
            "tool_calls": [
                {"tool": "Bash", "purpose": "GitNexus context", "input_summary": "gitnexus context LazyGroup", "output_summary": "found"}
            ],
            "violations": [],
        }),
        encoding="utf-8",
    )

    result = validate_run_artifacts(run_dir)

    assert any("graph via cli" in w.lower() for w in result["warnings"])


def test_validate_run_artifacts_errors_grep_with_gitnexus(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "runner-result.json").write_text(
        json.dumps({
            "run_id": "case__claude-code__grep__r1",
            "status": "passed",
            "elapsed_ms": 60000,
            "manifest": {
                "run": {"agent": "claude-code", "tool_policy": "grep"},
                "command": ["claude"],
                "policy_enforced": True,
            },
        }),
        encoding="utf-8",
    )
    (run_dir / "agent-result.json").write_text(
        json.dumps({
            "case_id": "case",
            "final_answer": {"summary": "ok"},
            "metrics": {"elapsed_ms": 60000},
            "tool_calls": [
                {"tool": "Bash", "purpose": "gitnexus context", "input_summary": "gitnexus context LazyGroup", "output_summary": "found"}
            ],
            "violations": [],
        }),
        encoding="utf-8",
    )

    result = validate_run_artifacts(run_dir)

    assert result["valid"] is False
    assert any("grep policy violated" in e.lower() for e in result["errors"])


def test_validate_artifacts_graph_gitnexus_query_valid_no_warning(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "runner-result.json").write_text(json.dumps({
        "run_id": "case__claude-code__graph__r1",
        "status": "passed",
        "elapsed_ms": 60000,
        "manifest": {
            "run": {"agent": "claude-code", "tool_policy": "graph"},
            "command": ["claude"],
            "policy_enforced": True,
        },
    }), encoding="utf-8")
    (run_dir / "agent-result.json").write_text(json.dumps({
        "case_id": "case",
        "final_answer": {"summary": "ok"},
        "metrics": {"elapsed_ms": 60000},
        "tool_calls": [
            {"tool": "gitnexus_query", "input_summary": "query CLI flow"},
        ],
        "violations": [],
    }), encoding="utf-8")

    result = validate_run_artifacts(run_dir)

    assert result["valid"] is True
    assert not any("no gitnexus" in w.lower() for w in result["warnings"])


def test_validate_artifacts_grep_gitnexus_query_invalid(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "runner-result.json").write_text(json.dumps({
        "run_id": "case__claude-code__grep__r1",
        "status": "passed",
        "elapsed_ms": 60000,
        "manifest": {
            "run": {"agent": "claude-code", "tool_policy": "grep"},
            "command": ["claude"],
            "policy_enforced": True,
        },
    }), encoding="utf-8")
    (run_dir / "agent-result.json").write_text(json.dumps({
        "case_id": "case",
        "final_answer": {"summary": "ok"},
        "metrics": {"elapsed_ms": 60000},
        "tool_calls": [
            {"tool": "gitnexus_query", "input_summary": "query CLI flow"},
        ],
        "violations": [],
    }), encoding="utf-8")

    result = validate_run_artifacts(run_dir)

    assert result["valid"] is False
    assert any("grep policy violated" in e.lower() for e in result["errors"])


def test_aggregate_scores_excludes_artifact_invalid_from_avg(tmp_path: Path):
    scores = tmp_path / "scores"
    scores.mkdir()
    # Valid grep run
    run_dir_grep = scores / "grep"
    run_dir_grep.mkdir(parents=True)
    (run_dir_grep / "score.json").write_text(json.dumps({
        "case_id": "case-a", "run_id": "case-a__claude-code__grep__r1",
        "agent": "claude-code", "tool_policy": "grep",
        "status": "passed", "violation_count": 0,
        "score": {"total": 90.0, "analysis_depth_bonus": 0},
        "metrics": {"tool_call_count": 5},
        "hit_count": 10, "expected_term_count": 10,
    }), encoding="utf-8")
    (run_dir_grep / "agent-result.json").write_text(json.dumps({
        "case_id": "case-a", "final_answer": {"summary": "ok"},
        "metrics": {"elapsed_ms": 60000}, "tool_calls": [],
        "violations": [],
    }), encoding="utf-8")
    (run_dir_grep / "runner-result.json").write_text(json.dumps({
        "run_id": "case-a__claude-code__grep__r1", "status": "passed",
        "manifest": {"run": {"agent": "claude-code", "tool_policy": "grep"},
                     "command": ["claude"], "policy_enforced": True},
    }), encoding="utf-8")

    # INVALID grep run (grep policy violated)
    run_dir_bad = scores / "grep-bad"
    run_dir_bad.mkdir(parents=True)
    (run_dir_bad / "score.json").write_text(json.dumps({
        "case_id": "case-a", "run_id": "case-a__claude-code__grep__r2",
        "agent": "claude-code", "tool_policy": "grep",
        "status": "passed", "violation_count": 0,
        "score": {"total": 95.0, "analysis_depth_bonus": 0},
        "metrics": {"tool_call_count": 3},
        "hit_count": 10, "expected_term_count": 10,
    }), encoding="utf-8")
    (run_dir_bad / "agent-result.json").write_text(json.dumps({
        "case_id": "case-a", "final_answer": {"summary": "ok"},
        "metrics": {"elapsed_ms": 60000},
        "tool_calls": [{"tool": "gitnexus_context", "input_summary": "context"}],
        "violations": [],
    }), encoding="utf-8")
    (run_dir_bad / "runner-result.json").write_text(json.dumps({
        "run_id": "case-a__claude-code__grep__r2", "status": "passed",
        "manifest": {"run": {"agent": "claude-code", "tool_policy": "grep"},
                     "command": ["claude"], "policy_enforced": True},
    }), encoding="utf-8")

    report = aggregate_scores(scores)

    assert report["invalid_run_count"] >= 1
    assert report["excluded_run_count"] >= 1
    grep_bucket = [b for b in report["by_agent_policy"] if b["agent"] == "claude-code" and b["tool_policy"] == "grep"]
    if grep_bucket:
        assert grep_bucket[0]["avg_total"] == 90.0  # only valid run, not 92.5


def test_normalize_agent_result_converts_file_evidence_to_paths():
    result = {
        "final_answer": {
            "files": [
                {
                    "name": "Example.java",
                    "kind": "file",
                    "file": "src/Example.java",
                    "reason": "Relevant file",
                },
                "src/Other.java",
            ]
        }
    }

    normalized = normalize_agent_result(result)

    assert normalized["final_answer"]["files"] == ["src/Example.java", "src/Other.java"]
