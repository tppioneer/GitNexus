"""Split the pre-version benchmark runs into v1 and v2 by case identity."""

from __future__ import annotations

import argparse
import json
import shutil
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
V2_PREFIXES = (
    "qwenpaw-case-d-",
    "qwenpaw-case-e-",
    "qwenpaw-case-f-",
    "telecom-case-d-",
    "telecom-case-e-",
    "telecom-case-f-",
    "telecom-large-case-j-",
    "telecom-large-case-m-",
    "telecom-large-case-s-",
)
DERIVED_ROOT_FILES = {"report.json", "benchmark-summary.md"}


def classify(case_id: str) -> str:
    return "v2" if case_id.startswith(V2_PREFIXES) else "v1"


def load_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def case_id_for_run(run_dir: Path) -> str:
    runner_result = run_dir / "runner-result.json"
    if runner_result.is_file():
        data = load_json(runner_result)
        manifest = data.get("manifest", {})
        run = manifest.get("run", {}) if isinstance(manifest, dict) else {}
        case_id = run.get("case_id") if isinstance(run, dict) else None
        if case_id:
            return str(case_id)
        run_id = data.get("run_id")
        if run_id:
            return str(run_id).split("__", 1)[0]
    return run_dir.name.split("__", 1)[0]


def filter_matrix(data: dict, version: str) -> dict | None:
    key = "runs" if isinstance(data.get("runs"), list) else "results" if isinstance(data.get("results"), list) else None
    if key is None:
        return None
    selected = []
    for item in data[key]:
        if not isinstance(item, dict):
            continue
        case_id = str(item.get("case_id") or item.get("run_id", "")).split("__", 1)[0]
        if case_id and classify(case_id) == version:
            selected.append(item)
    if not selected:
        return None
    filtered = dict(data)
    filtered[key] = selected
    if "run_count" in filtered:
        filtered["run_count"] = len(selected)
    if "selected_run_count" in filtered:
        filtered["selected_run_count"] = len(selected)
    if key == "results" and "status_counts" in filtered:
        filtered["status_counts"] = dict(Counter(str(item.get("status", "unknown")) for item in selected))
    return filtered


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def migrate(source: Path, benchmark_root: Path) -> dict[str, dict]:
    source = source.resolve()
    benchmark_root = benchmark_root.resolve()
    destinations = {version: benchmark_root / version / "runs" for version in ("v1", "v2")}
    for version, destination in destinations.items():
        if destination.exists() and any(destination.iterdir()):
            raise FileExistsError(f"destination is not empty: {destination}")
        destination.mkdir(parents=True, exist_ok=True)

    stats = {
        version: {"run_directories": 0, "groups": defaultdict(int), "cases": Counter(), "source": str(source)}
        for version in destinations
    }

    for group in sorted(path for path in source.iterdir() if path.is_dir()):
        run_dirs = sorted({path.parent for path in group.rglob("runner-result.json")})
        for run_dir in run_dirs:
            case_id = case_id_for_run(run_dir)
            version = classify(case_id)
            relative = run_dir.relative_to(group)
            target = destinations[version] / group.name / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(run_dir, target)
            stats[version]["run_directories"] += 1
            stats[version]["groups"][group.name] += 1
            stats[version]["cases"][case_id] += 1

        for root_file in sorted(path for path in group.iterdir() if path.is_file()):
            if root_file.name in DERIVED_ROOT_FILES:
                continue
            if root_file.suffix == ".json":
                try:
                    data = load_json(root_file)
                except (OSError, json.JSONDecodeError):
                    continue
                for version, destination in destinations.items():
                    filtered = filter_matrix(data, version)
                    if filtered is not None:
                        write_json(destination / group.name / root_file.name, filtered)

    logs_dir = destinations["v1"] / "_legacy-logs"
    for root_file in sorted(path for path in source.iterdir() if path.is_file()):
        if root_file.name in {"benchmark-report.html", "qwenpaw-matrix-plan.json"}:
            continue
        logs_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root_file, logs_dir / root_file.name)

    matrix_plan = source / "qwenpaw-matrix-plan.json"
    if matrix_plan.is_file():
        data = load_json(matrix_plan)
        for version, destination in destinations.items():
            filtered = filter_matrix(data, version)
            if filtered is not None:
                write_json(destination / "qwenpaw-matrix-plan.json", filtered)

    generated_at = datetime.now(timezone.utc).isoformat()
    serializable: dict[str, dict] = {}
    for version, values in stats.items():
        serializable[version] = {
            "benchmark_version": version,
            "generated_at": generated_at,
            "source": values["source"],
            "classification": "new D/E/F and telecom-large J/M/S -> v2; all other cases -> v1",
            "run_directory_count": values["run_directories"],
            "groups": dict(sorted(values["groups"].items())),
            "cases": dict(sorted(values["cases"].items())),
        }
        write_json(destinations[version] / "migration-manifest.json", serializable[version])
    return serializable


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--benchmark-root", type=Path, default=REPO_ROOT / "docs" / "benchmark")
    args = parser.parse_args()
    print(json.dumps(migrate(args.source, args.benchmark_root), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
