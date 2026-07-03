from pathlib import Path
import sys

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import version_admin as admin


def write_yaml(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(value, sort_keys=False), encoding="utf-8")


def prepare_source(tmp_path: Path, monkeypatch) -> Path:
    repo = tmp_path / "repo"
    benchmark = repo / "docs" / "benchmark"
    templates = benchmark / "templates" / "project"
    templates.mkdir(parents=True)
    (templates / "plan.yaml").write_text("version: 1\n", encoding="utf-8")
    registry = benchmark / "registry.yaml"
    write_yaml(registry, {"format_version": 1, "versions": []})
    monkeypatch.setattr(admin, "REPO_ROOT", repo)
    monkeypatch.setattr(admin, "BENCHMARK_ROOT", benchmark)
    monkeypatch.setattr(admin, "TEMPLATES_ROOT", benchmark / "templates")
    monkeypatch.setattr(admin, "REGISTRY_PATH", registry)

    source = benchmark / "v2"
    (source / "runner").mkdir(parents=True)
    (source / "report-viz").mkdir()
    (source / "shared").mkdir()
    runner = source / "runner" / "agent_benchmark_runner.py"
    runner.write_text("import sys\nraise SystemExit(0)\n", encoding="utf-8")
    (source / "runner" / "run_external_benchmark.ps1").write_text(
        '$OutRoot = "runs\\v2"\n', encoding="utf-8"
    )
    (source / "report-viz" / "generate-report.js").write_text(
        "const version = 'v2';\n", encoding="utf-8"
    )
    (source / "shared" / "scoring-rubric.md").write_text("v2 scoring\n", encoding="utf-8")
    project = source / "sample"
    write_yaml(
        project / "plan.yaml",
        {
            "version": 1,
            "target_project": {"path": str(repo), "validation_commands": ["echo ok"]},
            "case_source": {
                "directory": "docs/benchmark/v2/sample/cases",
                "cases": [{"id": "sample-case"}],
            },
            "run_matrix": {"agents": ["claude-code"], "tool_policies": ["grep", "graph"], "repeats_per_cell": 1},
        },
    )
    write_yaml(
        source / "benchmark-version.yaml",
        {
            "format_version": 1,
            "benchmark_version": "v2",
            "status": "git-managed",
            "paths": {"runner": "runner/agent_benchmark_runner.py", "runs": "runs/v2"},
            "result_policy": {"primary_comparison": "paired-case-repeat"},
        },
    )
    return source


def test_create_copy_rewrites_version_and_preserves_project(tmp_path, monkeypatch):
    prepare_source(tmp_path, monkeypatch)
    target = admin.create_version("v2", "v3", "copy")
    assert (target / "sample" / "plan.yaml").is_file()
    assert "v3" in (target / "runner" / "run_external_benchmark.ps1").read_text(encoding="utf-8")
    assert "v2" not in (target / "report-viz" / "generate-report.js").read_text(encoding="utf-8")
    assert "docs/benchmark/v3" in (target / "sample" / "plan.yaml").read_text(encoding="utf-8")
    metadata = admin.load_metadata("v3")
    assert metadata["status"] == "git-managed"
    assert metadata["parent_version"] == "v2"
    assert metadata["creation"]["case_mode"] == "copy"
    assert metadata["paths"]["runs"] == "runs/v3"
    registry = admin.load_yaml(admin.REGISTRY_PATH)
    assert any(item["id"] == "v3" and item["status"] == "git-managed" for item in registry["versions"])


def test_create_empty_copies_infrastructure_and_templates_only(tmp_path, monkeypatch):
    prepare_source(tmp_path, monkeypatch)
    target = admin.create_version("v2", "v3", "empty")
    assert (target / "runner" / "agent_benchmark_runner.py").is_file()
    assert (target / "templates" / "project" / "plan.yaml").is_file()
    assert not (target / "sample").exists()


def test_validate_rejects_non_versioned_runs_directory(tmp_path, monkeypatch):
    prepare_source(tmp_path, monkeypatch)
    admin.create_version("v2", "v3", "copy")
    metadata = admin.load_metadata("v3")
    metadata["paths"]["runs"] = "runs/benchmark/v3"
    write_yaml(admin.version_root("v3") / "benchmark-version.yaml", metadata)

    assert "benchmark-version.yaml paths.runs must be 'runs/v3'" in admin.validate_version("v3", run_tests=False)


def test_preflight_checks_case_and_model_without_lock(tmp_path, monkeypatch):
    prepare_source(tmp_path, monkeypatch)
    admin.create_version("v2", "v3", "copy")
    plan = admin.version_root("v3") / "sample" / "plan.yaml"
    assert admin.preflight_version("v3", plans=[plan], case_ids=["sample-case"], model="new-model") == []
    assert admin.preflight_version("v3", plans=[plan], case_ids=["missing"], model="new-model")
