"""Prepare and validate the provider-neutral v3 benchmark analysis handoff."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


HERE = Path(__file__).resolve().parent
PROMPT_TEMPLATE = HERE / "prompt-template.md"
RESULT_SCHEMA = HERE / "report-analysis.schema.json"


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def infer_project(group_name: str, rows: list[dict[str, Any]]) -> str:
    lowered = group_name.lower()
    for project in ("telecom-large", "telecom", "qwenpaw", "gitnexus"):
        if lowered.startswith(project):
            return project
    case_id = str(rows[0].get("case_id", "")) if rows else ""
    return case_id.split("-case-", 1)[0] or group_name


def resolve_artifact(path_text: Any, repo_root: Path, report_dir: Path) -> Path | None:
    if not path_text:
        return None
    raw = Path(str(path_text))
    candidates = [raw] if raw.is_absolute() else [repo_root / raw, report_dir / raw]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def slim_score(score: dict[str, Any]) -> dict[str, Any]:
    keep = (
        "case_id", "run_id", "agent", "tool_policy", "status", "policy_enforced",
        "total", "automatic_total", "adjudicated_total", "effective_total",
        "review_status", "review_outcome", "dimension_points", "dimensions",
        "item_scores", "edge_candidates", "noise_hits", "violations", "metrics",
    )
    return {key: score[key] for key in keep if key in score}


def slim_agent_result(result: dict[str, Any]) -> dict[str, Any]:
    final_answer = result.get("final_answer")
    compact: dict[str, Any] = {
        key: result[key]
        for key in ("case_id", "run_id", "agent", "tool_policy", "tool_calls", "evidence", "violations")
        if key in result
    }
    if isinstance(final_answer, dict):
        answer_keys = (
            "summary", "call_edges", "behavior_facts", "facts", "risks",
            "diff_summary", "validation_summary",
        )
        compact["final_answer"] = {key: final_answer[key] for key in answer_keys if key in final_answer}
    elif final_answer is not None:
        compact["final_answer"] = final_answer
    return compact


def collect_analysis_input(runs_dir: Path, repo_root: Path) -> tuple[dict[str, Any], str]:
    sources: list[dict[str, str]] = []
    groups: list[dict[str, Any]] = []
    report_paths = sorted(path for path in runs_dir.glob("*/report.json") if path.is_file())
    if not report_paths:
        raise ValueError(f"no direct child report.json files found under {runs_dir}")

    for report_path in report_paths:
        report = load_json(report_path)
        rows = report.get("rows", []) if isinstance(report.get("rows"), list) else []
        project = infer_project(report_path.parent.name, rows)
        if project == "telecom-large":
            continue
        sources.append({"path": str(report_path.resolve()), "sha256": hashlib.sha256(report_path.read_bytes()).hexdigest()})
        group_model: Any = None
        matrix_path = report_path.parent / "matrix-result.json"
        if matrix_path.is_file():
            matrix = load_json(matrix_path)
            group_model = matrix.get("model")
            sources.append({"path": str(matrix_path.resolve()), "sha256": hashlib.sha256(matrix_path.read_bytes()).hexdigest()})
        enriched_rows: list[dict[str, Any]] = []
        for raw_row in rows:
            if not isinstance(raw_row, dict):
                continue
            row = dict(raw_row)
            score_path = resolve_artifact(row.get("score_file"), repo_root, report_path.parent)
            if score_path:
                score = load_json(score_path)
                row["score"] = slim_score(score)
                sources.append({"path": str(score_path), "sha256": hashlib.sha256(score_path.read_bytes()).hexdigest()})
                agent_path = score_path.parent / "agent-result.json"
                if agent_path.is_file():
                    row["agent_result"] = slim_agent_result(load_json(agent_path))
                    sources.append({"path": str(agent_path.resolve()), "sha256": hashlib.sha256(agent_path.read_bytes()).hexdigest()})
                manifest_path = score_path.parent / "manifest.json"
                if manifest_path.is_file():
                    manifest = load_json(manifest_path)
                    manifest_run = manifest.get("run", {}) if isinstance(manifest.get("run"), dict) else {}
                    row["model"] = manifest.get("model") or group_model
                    row["repeat"] = manifest_run.get("repeat")
                    sources.append({"path": str(manifest_path.resolve()), "sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest()})
            row.setdefault("model", group_model)
            if not row.get("repeat"):
                repeat_match = re.search(r"__r(\d+)$", str(row.get("run_id", "")))
                if repeat_match:
                    row["repeat"] = int(repeat_match.group(1))
            enriched_rows.append(row)

        aggregate_keys = (
            "benchmark_version", "git_commit", "score_file_count", "run_count",
            "valid_run_count", "invalid_run_count", "excluded_run_count", "exclusion_reasons",
            "artifact_warning_count", "artifact_invalid_count", "by_agent_policy",
            "graph_uplift_by_agent", "automatic_graph_uplift_by_agent",
            "adjudication_review_count", "adjudication_coverage_pct",
        )
        groups.append({
            "project": project,
            "group": report_path.parent.name,
            "report_path": str(report_path.resolve()),
            "aggregate": {key: report[key] for key in aggregate_keys if key in report},
            "rows": enriched_rows,
        })

    source_digest = "sha256:" + hashlib.sha256(canonical_json(sources).encode("utf-8")).hexdigest()
    payload = {
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_digest": source_digest,
        "comparison_rules": {
            "primary_score": "effective_total, falling back to total for legacy rows",
            "pairing_key": ["project", "case_id", "agent", "model", "repeat"],
            "excluded_projects": ["telecom-large"],
        },
        "source_files": sources,
        "groups": groups,
    }
    return payload, source_digest


def prepare(runs_dir: Path, out_dir: Path, repo_root: Path) -> dict[str, str]:
    payload, source_digest = collect_analysis_input(runs_dir.resolve(), repo_root.resolve())
    out_dir.mkdir(parents=True, exist_ok=True)
    input_path = out_dir / "report-analysis-input.json"
    prompt_path = out_dir / "report-analysis-prompt.md"
    input_text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    prompt = PROMPT_TEMPLATE.read_text(encoding="utf-8")
    prompt = prompt.replace("{{SOURCE_DIGEST}}", source_digest)
    prompt = prompt.replace("{{ANALYSIS_INPUT_JSON}}", input_text.rstrip())
    input_path.write_text(input_text, encoding="utf-8")
    prompt_path.write_text(prompt, encoding="utf-8")
    return {"input": str(input_path.resolve()), "prompt": str(prompt_path.resolve()), "source_digest": source_digest}


def validate_result(result_path: Path, input_path: Path) -> dict[str, Any]:
    result = load_json(result_path)
    analysis_input = load_json(input_path)
    schema = load_json(RESULT_SCHEMA)
    errors = sorted(Draft202012Validator(schema).iter_errors(result), key=lambda error: list(error.path))
    if errors:
        details = "; ".join(f"{'.'.join(map(str, error.path)) or '<root>'}: {error.message}" for error in errors)
        raise ValueError(f"invalid report analysis: {details}")
    if result["source_digest"] != analysis_input.get("source_digest"):
        raise ValueError("report analysis is stale: source_digest does not match report-analysis-input.json")
    for source in analysis_input.get("source_files", []):
        source_path = Path(str(source.get("path", "")))
        expected_hash = source.get("sha256")
        if not source_path.is_file():
            raise ValueError(f"report analysis is stale: source file is missing: {source_path}")
        actual_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
        if actual_hash != expected_hash:
            raise ValueError(f"report analysis is stale: source file changed: {source_path}")
    return result


def install(result_path: Path, runs_dir: Path) -> Path:
    input_path = runs_dir / "report-analysis-input.json"
    result = validate_result(result_path, input_path)
    destination = runs_dir / "report-analysis.json"
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return destination


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(required=True)
    prepare_parser = subparsers.add_parser("prepare", help="Collect reports and render the provider-neutral analysis prompt.")
    prepare_parser.add_argument("--runs-dir", required=True, type=Path)
    prepare_parser.add_argument("--out-dir", type=Path)
    prepare_parser.add_argument("--repo-root", type=Path, default=HERE.parents[3])
    validate_parser = subparsers.add_parser("validate", help="Validate an analysis result without installing it.")
    validate_parser.add_argument("--result", required=True, type=Path)
    validate_parser.add_argument("--input", required=True, type=Path)
    install_parser = subparsers.add_parser("install", help="Validate and install report-analysis.json into a runs directory.")
    install_parser.add_argument("--result", required=True, type=Path)
    install_parser.add_argument("--runs-dir", required=True, type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.__dict__.get("runs_dir"):
        args.runs_dir = args.runs_dir.resolve()
    if args.__dict__.get("result"):
        args.result = args.result.resolve()
    if args.__dict__.get("input"):
        args.input = args.input.resolve()
    if args.__dict__.get("out_dir"):
        args.out_dir = args.out_dir.resolve()

    if args.__dict__.get("repo_root") is not None:
        outcome: Any = prepare(args.runs_dir, args.out_dir or args.runs_dir, args.repo_root)
    elif args.__dict__.get("input") is not None:
        outcome = validate_result(args.result, args.input)
    else:
        outcome = {"installed": str(install(args.result, args.runs_dir).resolve())}
    print(json.dumps(outcome, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
