"""Create and validate Git-managed benchmark versions."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
BENCHMARK_ROOT = REPO_ROOT / "docs" / "benchmark"
TEMPLATES_ROOT = BENCHMARK_ROOT / "templates"
REGISTRY_PATH = BENCHMARK_ROOT / "registry.yaml"
VERSION_PATTERN = re.compile(r"v[1-9][0-9]*")
TEXT_SUFFIXES = {".json", ".js", ".md", ".ps1", ".py", ".yaml", ".yml"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def version_root(version: str) -> Path:
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError(f"invalid benchmark version: {version!r}")
    path = (BENCHMARK_ROOT / version).resolve()
    if path.parent != BENCHMARK_ROOT.resolve():
        raise ValueError(f"unsafe benchmark version path: {path}")
    return path


def load_yaml(path: Path) -> dict[str, Any]:
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a YAML object")
    return value


def write_yaml(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(value, allow_unicode=True, sort_keys=False), encoding="utf-8")


def load_metadata(version: str) -> dict[str, Any]:
    path = version_root(version) / "benchmark-version.yaml"
    if not path.is_file():
        raise FileNotFoundError(path)
    return load_yaml(path)


def _copy_version_contents(source_root: Path, target_root: Path, case_mode: str) -> None:
    ignored = shutil.ignore_patterns("runs", "__pycache__", "*.pyc")
    if case_mode == "copy":
        shutil.copytree(source_root, target_root, ignore=ignored)
        return

    target_root.mkdir(parents=True)
    for name in ("runner", "report-viz", "shared", "tests"):
        source = source_root / name
        if source.is_dir():
            shutil.copytree(source, target_root / name, ignore=ignored)
    for name in ("quick-start.md",):
        source = source_root / name
        if source.is_file():
            shutil.copy2(source, target_root / name)


def _rewrite_version_references(root: Path, source: str, target: str) -> None:
    token = re.compile(rf"(?<![A-Za-z0-9]){re.escape(source)}(?![A-Za-z0-9])")
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        updated = token.sub(target, text)
        if updated != text:
            path.write_text(updated, encoding="utf-8")


def _version_metadata(source: str, target: str, case_mode: str) -> dict[str, Any]:
    source_metadata = load_metadata(source)
    paths = dict(source_metadata.get("paths", {}))
    paths["runs"] = f"runs/{target}"
    result_policy = dict(source_metadata.get("result_policy", {}))
    result_policy["overwrite_existing_experiment"] = "forbidden"
    return {
        "format_version": 1,
        "benchmark_version": target,
        "status": "git-managed",
        "created_at": now_iso(),
        "parent_version": source,
        "creation": {
            "case_mode": case_mode,
        },
        "compatibility": {
            "score_comparable_with": [target],
            "cross_version_aggregation": "forbidden",
        },
        "paths": paths,
        "result_policy": result_policy,
    }


def create_version(source: str, target: str, case_mode: str = "copy") -> Path:
    source_root = version_root(source)
    target_root = version_root(target)
    if not source_root.is_dir():
        raise FileNotFoundError(source_root)
    if target_root.exists():
        raise FileExistsError(target_root)
    _copy_version_contents(source_root, target_root, case_mode)
    if TEMPLATES_ROOT.is_dir():
        shutil.copytree(TEMPLATES_ROOT, target_root / "templates", dirs_exist_ok=True)
    _rewrite_version_references(target_root, source, target)
    metadata = _version_metadata(source, target, case_mode)
    write_yaml(target_root / "benchmark-version.yaml", metadata)
    _register_version(target, metadata)
    return target_root


def discover_plans(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("plan.yaml") if "templates" not in path.parts)


def _residual_parent_references(root: Path, parent: str) -> list[str]:
    findings: list[str] = []
    token = re.compile(rf"(?<![A-Za-z0-9]){re.escape(parent)}(?![A-Za-z0-9])")
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if path.name == "benchmark-version.yaml" or "templates" in path.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if token.search(text):
            findings.append(f"stale parent-version reference: {path.relative_to(root)}")
    return findings


def validate_version(version: str, *, run_tests: bool = True) -> list[str]:
    root = version_root(version)
    metadata = load_metadata(version)
    errors: list[str] = []
    if metadata.get("benchmark_version") != version:
        errors.append("benchmark-version.yaml does not match directory version")
    expected_runs = f"runs/{version}"
    configured_runs = metadata.get("paths", {}).get("runs") if isinstance(metadata.get("paths"), dict) else None
    if configured_runs != expected_runs:
        errors.append(f"benchmark-version.yaml paths.runs must be {expected_runs!r}")

    for path in sorted((*root.rglob("*.yaml"), *root.rglob("*.yml"))):
        try:
            value = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001 - author needs the YAML parser detail.
            errors.append(f"invalid YAML: {path.relative_to(root)}: {exc}")
            continue
        if (
            isinstance(value, dict)
            and str(value.get("status", "")).startswith("draft")
            and "templates" not in path.parts
            and path.name != "benchmark-version.yaml"
        ):
            errors.append(f"draft artifact is not execution-ready: {path.relative_to(root)}")

    runner = root / "runner" / "agent_benchmark_runner.py"
    if not runner.is_file():
        errors.append(f"missing runner: {runner}")
    plans = discover_plans(root)
    if not plans:
        errors.append("version has no project plan.yaml")
    elif runner.is_file():
        for plan in plans:
            result = subprocess.run(
                [sys.executable, str(runner), "validate", "--plan", str(plan)],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            if result.returncode:
                detail = (result.stdout + result.stderr).strip().replace("\n", " | ")
                errors.append(f"plan validation failed: {plan.relative_to(root)}: {detail}")

    parent = metadata.get("parent_version")
    if isinstance(parent, str) and VERSION_PATTERN.fullmatch(parent):
        errors.extend(_residual_parent_references(root, parent))

    if run_tests and (root / "tests").is_dir():
        result = subprocess.run(
            [sys.executable, "-m", "pytest", str(root / "tests"), "-q"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode:
            detail = (result.stdout + result.stderr).strip().replace("\n", " | ")
            errors.append(f"version tests failed: {detail}")
    return errors


def _register_version(version: str, metadata: dict[str, Any]) -> None:
    registry = load_yaml(REGISTRY_PATH) if REGISTRY_PATH.is_file() else {"format_version": 1, "versions": []}
    versions = registry.setdefault("versions", [])
    if not isinstance(versions, list):
        raise ValueError("registry.yaml versions must be a list")
    entry = {
        "id": version,
        "path": f"docs/benchmark/{version}",
        "status": "git-managed",
        "source": "derived-version",
        "parent_version": metadata.get("parent_version"),
    }
    versions[:] = [item for item in versions if not isinstance(item, dict) or item.get("id") != version]
    versions.append(entry)
    versions.sort(key=lambda item: int(str(item.get("id", "v0"))[1:]))
    registry.setdefault("cross_version_aggregation", "forbidden")
    registry.setdefault("implicit_latest", "forbidden")
    write_yaml(REGISTRY_PATH, registry)


def preflight_version(
    version: str,
    *,
    plans: list[Path] | None = None,
    case_ids: list[str] | None = None,
    model: str | None = None,
) -> list[str]:
    root = version_root(version)
    errors: list[str] = []
    load_metadata(version)
    selected_plans = [path.resolve() for path in plans] if plans else discover_plans(root)
    runner = root / "runner" / "agent_benchmark_runner.py"
    known_cases: set[str] = set()
    for plan in selected_plans:
        if not plan.is_file():
            errors.append(f"plan not found: {plan}")
            continue
        try:
            plan.relative_to(root)
        except ValueError:
            errors.append(f"plan is outside benchmark version {version}: {plan}")
            continue
        result = subprocess.run(
            [sys.executable, str(runner), "validate", "--plan", str(plan)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode:
            detail = (result.stdout + result.stderr).strip().replace("\n", " | ")
            errors.append(f"plan validation failed: {plan}: {detail}")
            continue
        data = load_yaml(plan)
        for item in data.get("case_source", {}).get("cases", []):
            if isinstance(item, dict) and item.get("id"):
                known_cases.add(str(item["id"]))
    for case_id in case_ids or []:
        if case_id not in known_cases:
            errors.append(f"case_id not found in selected plans: {case_id}")
    if model is not None and not model.strip():
        errors.append("model identifier must not be empty")
    return errors


def _raise_or_print(errors: list[str]) -> int:
    if errors:
        print("\n".join(errors))
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list")
    validate = subparsers.add_parser("validate")
    validate.add_argument("--version", required=True)
    create = subparsers.add_parser("create")
    create.add_argument("--from", dest="source", required=True)
    create.add_argument("--to", dest="target", required=True)
    create.add_argument("--case-mode", choices=("copy", "empty"), default="copy")
    preflight = subparsers.add_parser("preflight")
    preflight.add_argument("--version", required=True)
    preflight.add_argument("--plan", action="append", type=Path)
    preflight.add_argument("--case-id", action="append")
    preflight.add_argument("--model")
    args = parser.parse_args()

    if args.command == "list":
        for path in sorted(BENCHMARK_ROOT.iterdir()):
            if path.is_dir() and VERSION_PATTERN.fullmatch(path.name):
                print(path.name)
        return 0
    if args.command == "validate":
        errors = validate_version(args.version)
        if not errors:
            print(f"OK: {args.version}")
        return _raise_or_print(errors)
    if args.command == "preflight":
        errors = preflight_version(
            args.version,
            plans=args.plan,
            case_ids=args.case_id,
            model=args.model,
        )
        if not errors:
            print(f"OK: {args.version}")
        return _raise_or_print(errors)
    print(create_version(args.source, args.target, args.case_mode))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
