import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adjudication_tool import build_adjudication, inspect_case, validate_adjudication, write_adjudication


def make_run(tmp_path: Path) -> Path:
    run = tmp_path / "run"
    run.mkdir(parents=True)
    golden = tmp_path / "golden.yaml"
    golden.write_text("case_id: case-a\n", encoding="utf-8")
    (run / "agent-result.json").write_text(json.dumps({
        "case_id": "case-a", "final_answer": {"call_chains": []}, "evidence": []
    }), encoding="utf-8")
    (run / "score.json").write_text(json.dumps({
        "benchmark_version": "v3", "case_id": "case-a", "run_id": "case-a__claude-code__graph__r1",
        "agent": "claude-code", "tool_policy": "graph", "golden_answer": str(golden),
        "automatic_total": 65.0,
        "dimension_points": {"location": 15, "symbols": 20, "call_edges": 5, "behavior_facts": 10, "evidence": 5, "noise": 10},
        "item_scores": [
            {"item_id": "edge.a-to-b", "dimension": "call_edges", "max_points": 5, "automatic_credit": 0, "automatic_points": 0},
            {"item_id": "evidence.a", "dimension": "evidence", "max_points": 2, "automatic_credit": 1, "automatic_points": 2},
            {"item_id": "symbol.a", "dimension": "symbols", "max_points": 2, "automatic_credit": 0, "automatic_points": 0}
        ]
    }), encoding="utf-8")
    return run


def proposal(item_id="edge.a-to-b", credit=0.8):
    return {"item_id": item_id, "credit": credit, "reason_code": "scorer_false_negative",
            "reason_detail": "Explicit relation in the original final answer.",
            "evidence": [{"source": "agent-result.json", "json_pointer": "/final_answer/call_chains/0"}]}


def test_adjusted_adjudication_recalculates_total(tmp_path: Path):
    run = make_run(tmp_path)
    data = build_adjudication(run, [proposal()], reviewer="maintainer", approval_note="Approved in conversation", agent_name="codex")
    assert data["result"]["adjudicated_total"] == 69.0
    assert data["result"]["delta"] == 4.0
    assert data["review"]["mode"] == "human_approved_agent_assisted"
    assert validate_adjudication(run, data) == []


def test_accept_keeps_automatic_total(tmp_path: Path):
    run = make_run(tmp_path)
    data = build_adjudication(run, [], reviewer="maintainer", approval_note="Automatic score accepted", agent_name="codex", accepted=True)
    assert data["decisions"] == []
    assert data["result"]["effective_total"] == 65.0
    assert data["review"]["outcome"] == "accepted"


def test_rejects_non_fixed_credit(tmp_path: Path):
    with pytest.raises(ValueError, match="unsupported credit"):
        build_adjudication(make_run(tmp_path), [proposal(credit=0.7)], reviewer="maintainer", approval_note="x", agent_name="codex")


def test_rejects_location_and_symbol_adjustment(tmp_path: Path):
    with pytest.raises(ValueError, match="cannot be adjudicated"):
        build_adjudication(make_run(tmp_path), [proposal(item_id="symbol.a", credit=1)], reviewer="maintainer", approval_note="x", agent_name="codex")


def test_only_changed_items_are_allowed(tmp_path: Path):
    with pytest.raises(ValueError, match="does not change"):
        build_adjudication(make_run(tmp_path), [proposal(item_id="evidence.a", credit=1)], reviewer="maintainer", approval_note="x", agent_name="codex")


def test_source_change_marks_adjudication_stale(tmp_path: Path):
    run = make_run(tmp_path)
    data = build_adjudication(run, [proposal()], reviewer="maintainer", approval_note="Approved", agent_name="codex")
    write_adjudication(run, data)
    score = json.loads((run / "score.json").read_text(encoding="utf-8"))
    score["automatic_total"] = 66
    (run / "score.json").write_text(json.dumps(score), encoding="utf-8")
    assert any("stale source hash" in error for error in validate_adjudication(run))


def test_case_inspection_compares_policies_without_writing(tmp_path: Path):
    grep = make_run(tmp_path / "grep")
    graph = make_run(tmp_path / "graph")
    for run, policy, total in ((grep, "grep", 60), (graph, "graph", 72)):
        score = json.loads((run / "score.json").read_text(encoding="utf-8"))
        score["tool_policy"] = policy
        score["automatic_total"] = total
        (run / "score.json").write_text(json.dumps(score), encoding="utf-8")
    material = inspect_case(tmp_path, "case-a")
    assert material["automatic_uplift"] == 12
    assert len(material["runs"]) == 2
    assert not list(tmp_path.rglob("adjudication.json"))


def test_validation_rejects_tampered_total(tmp_path: Path):
    run = make_run(tmp_path)
    data = build_adjudication(run, [proposal()], reviewer="maintainer", approval_note="Approved", agent_name="codex")
    data["result"]["adjudicated_total"] = 99
    assert "adjudicated_total does not match decisions" in validate_adjudication(run, data)
