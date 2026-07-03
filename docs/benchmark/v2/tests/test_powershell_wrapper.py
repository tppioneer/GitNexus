from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[4]


@pytest.mark.skipif(os.name != "nt" or shutil.which("powershell") is None, reason="requires Windows PowerShell")
def test_wrapper_expands_comma_joined_case_ids_for_dry_run(tmp_path: Path) -> None:
    case_ids = (
        "qwenpaw-case-w-token-usage-data-flow",
        "qwenpaw-case-x-weixin-wechat-migration-data-flow",
    )
    completed = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(REPO_ROOT / "docs" / "benchmark" / "v2" / "runner" / "run_external_benchmark.ps1"),
            "-Plan",
            str(REPO_ROOT / "docs" / "benchmark" / "v2" / "qwenpaw" / "plan.yaml"),
            "-Model",
            "qwen3.7-plus",
            "-CaseId",
            ",".join(case_ids),
            "-OutRoot",
            str(tmp_path),
            "-DryRun",
            "-NoReportAnalysisPrompt",
        ],
        cwd=REPO_ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
        timeout=120,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    matrix_results = list(tmp_path.rglob("matrix-result.json"))
    assert len(matrix_results) == 1
    result = json.loads(matrix_results[0].read_text(encoding="utf-8"))
    assert result["selected_run_count"] == 12
    assert {
        run["manifest"]["run"]["case_id"]
        for run in result["results"]
    } == set(case_ids)


@pytest.mark.skipif(os.name != "nt" or shutil.which("powershell") is None, reason="requires Windows PowerShell")
def test_compatibility_wrapper_expands_case_ids_before_preflight(tmp_path: Path) -> None:
    case_ids = (
        "qwenpaw-case-w-token-usage-data-flow",
        "qwenpaw-case-x-weixin-wechat-migration-data-flow",
    )
    completed = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(REPO_ROOT / "eval" / "benchmark" / "run_external_benchmark.ps1"),
            "-Version",
            "v2",
            "-Plan",
            str(REPO_ROOT / "docs" / "benchmark" / "v2" / "qwenpaw" / "plan.yaml"),
            "-Model",
            "qwen3.7-plus",
            "-CaseId",
            ",".join(case_ids),
            "-OutRoot",
            str(tmp_path),
            "-SkipExecute",
            "-NoPostProcess",
            "-NoReportAnalysisPrompt",
        ],
        cwd=REPO_ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
        timeout=120,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "case_id not found in selected plans" not in completed.stdout + completed.stderr
