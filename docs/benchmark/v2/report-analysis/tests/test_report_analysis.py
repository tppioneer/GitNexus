from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).resolve().parents[1] / "report_analysis.py"
SPEC = importlib.util.spec_from_file_location("v2_report_analysis", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def fixture_runs(tmp_path: Path) -> tuple[Path, Path]:
    repo_root = tmp_path / "repo"
    runs_dir = repo_root / "runs" / "v2"
    run_dir = runs_dir / "qwenpaw-model" / "claude-code" / "graph" / "case__graph__r1"
    score_path = run_dir / "score.json"
    write_json(score_path, {
        "case_id": "qwenpaw-case-u", "run_id": "case__graph__r1", "tool_policy": "graph",
        "automatic_total": 80, "effective_total": 82,
        "item_scores": [{"item_id": "edge-1", "dimension": "call_edges", "automatic_credit": 0.8}],
    })
    write_json(run_dir / "agent-result.json", {"case_id": "qwenpaw-case-u", "final_answer": {"summary": "answer"}})
    write_json(run_dir / "manifest.json", {"model": "model-x"})
    write_json(runs_dir / "qwenpaw-model" / "report.json", {
        "run_count": 1,
        "valid_run_count": 1,
        "rows": [{
            "case_id": "qwenpaw-case-u", "run_id": "case__graph__r1", "agent": "claude-code",
            "tool_policy": "graph", "total": 82, "score_file": str(score_path.relative_to(repo_root)),
        }],
    })
    write_json(runs_dir / "telecom-large-model" / "report.json", {"rows": [{"case_id": "telecom-large-case-u"}]})
    return repo_root, runs_dir


def valid_result(digest: str) -> dict[str, object]:
    return {
        "schema_version": "1.0", "source_digest": digest,
        "executive_summary": ["Graph 在该样本领先。"],
        "key_findings": [{
            "title": "领先", "direction": "graph", "analysis": "有效分较高。",
            "confidence": "low", "evidence_refs": ["case__graph__r1"],
        }],
        "case_comparisons": [], "scoring_quality": [], "cost_quality_tradeoffs": [],
        "recommendations": [], "limitations": ["只有一个 run，不能形成配对结论。"],
    }


def test_prepare_collects_scores_answers_and_excludes_telecom_large(tmp_path: Path) -> None:
    repo_root, runs_dir = fixture_runs(tmp_path)
    outcome = MODULE.prepare(runs_dir, runs_dir, repo_root)
    payload = json.loads(Path(outcome["input"]).read_text(encoding="utf-8"))
    assert [group["project"] for group in payload["groups"]] == ["qwenpaw"]
    row = payload["groups"][0]["rows"][0]
    assert row["model"] == "model-x"
    assert row["repeat"] == 1
    assert row["score"]["effective_total"] == 82
    assert row["agent_result"]["final_answer"]["summary"] == "answer"
    prompt = Path(outcome["prompt"]).read_text(encoding="utf-8")
    assert outcome["source_digest"] in prompt
    assert "{{ANALYSIS_INPUT_JSON}}" not in prompt


def test_install_validates_digest_and_writes_canonical_result(tmp_path: Path) -> None:
    repo_root, runs_dir = fixture_runs(tmp_path)
    outcome = MODULE.prepare(runs_dir, runs_dir, repo_root)
    candidate = runs_dir / "candidate.json"
    write_json(candidate, valid_result(outcome["source_digest"]))
    installed = MODULE.install(candidate, runs_dir)
    assert installed.name == "report-analysis.json"
    assert json.loads(installed.read_text(encoding="utf-8"))["schema_version"] == "1.0"


def test_install_rejects_stale_result(tmp_path: Path) -> None:
    repo_root, runs_dir = fixture_runs(tmp_path)
    MODULE.prepare(runs_dir, runs_dir, repo_root)
    candidate = runs_dir / "candidate.json"
    write_json(candidate, valid_result("sha256:" + "0" * 64))
    with pytest.raises(ValueError, match="stale"):
        MODULE.install(candidate, runs_dir)


def test_install_rejects_result_when_a_source_file_changed(tmp_path: Path) -> None:
    repo_root, runs_dir = fixture_runs(tmp_path)
    outcome = MODULE.prepare(runs_dir, runs_dir, repo_root)
    score_path = next(runs_dir.rglob("score.json"))
    write_json(score_path, {"effective_total": 99})
    candidate = runs_dir / "candidate.json"
    write_json(candidate, valid_result(outcome["source_digest"]))
    with pytest.raises(ValueError, match="source file changed"):
        MODULE.install(candidate, runs_dir)
