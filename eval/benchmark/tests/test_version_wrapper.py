from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agent_benchmark_runner as wrapper


def test_dry_run_is_available_for_draft_authoring(monkeypatch):
    monkeypatch.setattr(wrapper, "preflight_version", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError()))
    wrapper._preflight("v3", ["execute-matrix", "--dry-run", "--plan", "draft-plan.yaml"])


def test_formal_execution_requires_explicit_model():
    with pytest.raises(SystemExit, match="explicit --model"):
        wrapper._preflight("v2", ["execute-matrix", "--plan", "plan.yaml"])


def test_formal_execution_forwards_plan_case_and_model(monkeypatch):
    captured = {}

    def fake_preflight(version, **kwargs):
        captured["version"] = version
        captured.update(kwargs)
        return []

    monkeypatch.setattr(wrapper, "preflight_version", fake_preflight)
    wrapper._preflight(
        "v2",
        [
            "execute-matrix",
            "--plan",
            "docs/benchmark/v2/qwenpaw/plan.yaml",
            "--case-id",
            "qwenpaw-case-d-agent-reload-blast-radius",
            "--model",
            "new-model",
        ],
    )
    assert captured == {
        "version": "v2",
        "plans": [Path("docs/benchmark/v2/qwenpaw/plan.yaml")],
        "case_ids": ["qwenpaw-case-d-agent-reload-blast-radius"],
        "model": "new-model",
    }


def test_default_out_dir_uses_version_runs_prefix_and_project_model(monkeypatch):
    monkeypatch.setattr(wrapper, "load_metadata", lambda version: {"paths": {"runs": f"runs/{version}"}})

    forwarded = wrapper._with_default_out_dir(
        "v2",
        [
            "execute-matrix",
            "--plan",
            "docs/benchmark/v2/qwenpaw/plan.yaml",
            "--model",
            "qwen3.7-plus",
        ],
    )

    assert wrapper._option_values(forwarded, "--out-dir") == [str(Path("runs/v2/qwenpaw-qwen3.7-plus"))]


def test_explicit_out_dir_is_preserved(monkeypatch):
    monkeypatch.setattr(
        wrapper,
        "load_metadata",
        lambda version: (_ for _ in ()).throw(AssertionError("metadata should not be loaded")),
    )
    argv = ["execute-matrix", "--out-dir", "custom/results", "--plan", "plan.yaml"]

    assert wrapper._with_default_out_dir("v3", argv) == argv
