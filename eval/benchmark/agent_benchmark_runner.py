"""Compatibility entrypoint for versioned benchmark runners."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from version_admin import load_metadata, preflight_version


REPO_ROOT = Path(__file__).resolve().parents[2]
VERSION_PATTERN = re.compile(r"v[1-9][0-9]*")
PREFLIGHT_COMMANDS = {"execute", "execute-matrix", "extract-result", "prepare", "report", "score"}
OUTPUT_DIR_COMMANDS = {"execute", "execute-matrix", "prepare"}


def _extract_version(argv: list[str]) -> tuple[str, list[str]]:
    remaining = list(argv)
    version: str | None = None
    for index, value in enumerate(list(remaining)):
        if value == "--version" and index + 1 < len(remaining):
            version = remaining[index + 1]
            del remaining[index : index + 2]
            break
        if value.startswith("--version="):
            version = value.split("=", 1)[1]
            del remaining[index]
            break
    if not version:
        raise SystemExit("Missing required --version (for example: --version v1).")
    if not VERSION_PATTERN.fullmatch(version):
        raise SystemExit(f"Invalid benchmark version: {version!r}; expected v1, v2, ...")
    return version, remaining


def _option_values(argv: list[str], option: str) -> list[str]:
    values: list[str] = []
    for index, value in enumerate(argv):
        if value == option and index + 1 < len(argv):
            values.append(argv[index + 1])
        elif value.startswith(option + "="):
            values.append(value.split("=", 1)[1])
    return values


def _preflight(version: str, argv: list[str]) -> None:
    if not argv or argv[0] not in PREFLIGHT_COMMANDS:
        return
    if "--dry-run" in argv:
        return
    command = argv[0]
    model_values = _option_values(argv, "--model")
    if command in {"execute", "execute-matrix"} and not model_values:
        raise SystemExit("Formal execution requires an explicit --model supplied by the task initiator.")
    errors = preflight_version(
        version,
        plans=[Path(value) for value in _option_values(argv, "--plan")] or None,
        case_ids=_option_values(argv, "--case-id") or None,
        model=model_values[-1] if model_values else None,
    )
    if errors:
        raise SystemExit("Benchmark preflight failed:\n" + "\n".join(f"- {error}" for error in errors))


def _with_default_out_dir(version: str, argv: list[str]) -> list[str]:
    """Inject the versioned runs directory for commands that omit --out-dir."""
    forwarded = list(argv)
    if not forwarded or forwarded[0] not in OUTPUT_DIR_COMMANDS:
        return forwarded
    if _option_values(forwarded, "--out-dir"):
        return forwarded

    metadata = load_metadata(version)
    paths = metadata.get("paths", {})
    runs_root = Path(str(paths.get("runs") or f"runs/{version}"))
    plan_values = _option_values(forwarded, "--plan")
    model_values = _option_values(forwarded, "--model")

    if plan_values:
        project = Path(plan_values[-1]).parent.name
        group_name = project
        if model_values:
            group_name = f"{project}-{model_values[-1]}"
        runs_root /= group_name

    return [forwarded[0], "--out-dir", str(runs_root), *forwarded[1:]]


def main(argv: list[str] | None = None) -> int:
    version, forwarded = _extract_version(list(sys.argv[1:] if argv is None else argv))
    runner = REPO_ROOT / "docs" / "benchmark" / version / "runner" / "agent_benchmark_runner.py"
    if not runner.is_file():
        raise SystemExit(f"Benchmark runner not found for {version}: {runner}")
    _preflight(version, forwarded)
    forwarded = _with_default_out_dir(version, forwarded)
    return subprocess.call([sys.executable, str(runner), *forwarded], cwd=REPO_ROOT)


if __name__ == "__main__":
    raise SystemExit(main())
