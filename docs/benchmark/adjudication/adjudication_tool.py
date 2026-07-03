#!/usr/bin/env python3
"""Optional, agent-facing human adjudication tooling for benchmark runs."""
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent
SCHEMA = ROOT / "adjudication.schema.json"
CREDITS = {0, 0.25, 0.4, 0.5, 0.8, 1}
ADJUSTABLE = {"call_edges", "behavior_facts", "evidence", "noise"}


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError(f"expected JSON object: {path}")
    return data


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _source(path: Path, run_dir: Path) -> dict[str, str]:
    try:
        display = str(path.resolve().relative_to(run_dir.resolve()))
    except ValueError:
        display = str(path.resolve())
    return {"path": display, "sha256": sha256(path)}


def resolve_sources(run_dir: Path) -> tuple[Path, Path, Path, dict[str, Any]]:
    agent = run_dir / "agent-result.json"
    score = run_dir / "score.json"
    if not agent.is_file() or not score.is_file():
        raise FileNotFoundError("run directory must contain agent-result.json and score.json")
    score_data = load_json(score)
    golden = Path(str(score_data.get("golden_answer", "")))
    if not golden.is_absolute():
        golden = Path.cwd() / golden
    if not golden.is_file():
        raise FileNotFoundError(f"ground truth not found: {golden}")
    return agent, score, golden, score_data


def inspect_run(run_dir: Path) -> dict[str, Any]:
    agent_path, score_path, golden_path, score = resolve_sources(run_dir)
    agent = load_json(agent_path)
    return {
        "benchmark_version": score.get("benchmark_version"),
        "case_id": score.get("case_id"),
        "run_id": score.get("run_id"),
        "agent": score.get("agent"),
        "tool_policy": score.get("tool_policy"),
        "automatic_total": score.get("automatic_total", score.get("score", {}).get("total", 0)),
        "dimension_points": score.get("dimension_points", {}),
        "item_scores": score.get("item_scores", []),
        "final_answer": agent.get("final_answer", {}),
        "evidence": agent.get("evidence", []),
        "sources": {
            "agent_result": _source(agent_path, run_dir),
            "automatic_score": _source(score_path, run_dir),
            "ground_truth": _source(golden_path, run_dir),
        },
    }


def inspect_case(runs_dir: Path, case_id: str, policies: tuple[str, str] = ("grep", "graph")) -> dict[str, Any]:
    runs: list[dict[str, Any]] = []
    for score_path in sorted(runs_dir.rglob("score.json")):
        score = load_json(score_path)
        if str(score.get("case_id", "")) != case_id or str(score.get("tool_policy", "")) not in policies:
            continue
        runs.append(inspect_run(score_path.parent))
    summaries: dict[str, Any] = {}
    for policy in policies:
        selected = [run for run in runs if run.get("tool_policy") == policy]
        totals = [float(run.get("automatic_total", 0)) for run in selected]
        summaries[policy] = {"run_count": len(selected), "avg_automatic_total": round(statistics.mean(totals), 2) if totals else None}
    left, right = policies
    left_avg, right_avg = summaries[left]["avg_automatic_total"], summaries[right]["avg_automatic_total"]
    return {
        "case_id": case_id, "runs_dir": str(runs_dir), "policies": list(policies),
        "policy_summaries": summaries,
        "automatic_uplift": round(right_avg - left_avg, 2) if left_avg is not None and right_avg is not None else None,
        "runs": runs,
    }


def _outcome(credit: float) -> str:
    return "miss" if credit == 0 else "hit" if credit == 1 else "partial"


def build_adjudication(run_dir: Path, decisions: list[dict[str, Any]], *, reviewer: str,
                       approval_note: str, agent_name: str, model: str = "",
                       thread_id: str = "", accepted: bool = False) -> dict[str, Any]:
    material = inspect_run(run_dir)
    items = {str(item.get("item_id")): item for item in material["item_scores"]}
    normalized: list[dict[str, Any]] = []
    deltas = {name: 0.0 for name in ADJUSTABLE}
    seen: set[str] = set()
    for index, proposal in enumerate(decisions, 1):
        item_id = str(proposal.get("item_id", ""))
        if item_id in seen:
            raise ValueError(f"duplicate decision item_id: {item_id}")
        seen.add(item_id)
        item = items.get(item_id)
        if not item:
            raise ValueError(f"unknown automatic score item: {item_id}")
        dimension = str(item.get("dimension", ""))
        if dimension not in ADJUSTABLE:
            raise ValueError(f"dimension cannot be adjudicated in v1: {dimension}")
        credit = float(proposal.get("credit"))
        if credit not in CREDITS:
            raise ValueError(f"unsupported credit {credit}; allowed={sorted(CREDITS)}")
        automatic_credit = float(item.get("automatic_credit", 0))
        if credit == automatic_credit:
            raise ValueError(f"decision does not change automatic credit: {item_id}")
        max_points = float(item.get("max_points", 0))
        auto_points = round(max_points * automatic_credit, 4)
        adjudicated_points = round(max_points * credit, 4)
        deltas[dimension] += adjudicated_points - auto_points
        normalized.append({
            "decision_id": str(proposal.get("decision_id") or f"decision.{item_id}"),
            "item_id": item_id,
            "dimension": dimension,
            "automatic": {"credit": automatic_credit, "max_points": max_points, "points": auto_points, "outcome": _outcome(automatic_credit)},
            "adjudicated": {"credit": credit, "max_points": max_points, "points": adjudicated_points, "outcome": _outcome(credit)},
            "reason_code": str(proposal.get("reason_code", "human_review")),
            "reason_detail": str(proposal.get("reason_detail", "")).strip(),
            "evidence": proposal.get("evidence", []),
        })
    if accepted and normalized:
        raise ValueError("accepted adjudication cannot contain decisions")
    if not accepted and not normalized:
        raise ValueError("adjusted adjudication requires at least one changed decision")

    baseline_dimensions = {key: round(float(material["dimension_points"].get(key, 0)), 4)
                           for key in ("location", "symbols", "call_edges", "behavior_facts", "evidence", "noise")}
    result_dimensions = dict(baseline_dimensions)
    for dimension, delta in deltas.items():
        result_dimensions[dimension] = round(result_dimensions[dimension] + delta, 4)
    automatic_total = round(float(material["automatic_total"]), 4)
    total_delta = round(sum(deltas.values()), 4)
    adjudicated_total = round(max(0.0, min(100.0, automatic_total + total_delta)), 4)
    prepared = {"type": "agent", "agent": agent_name}
    if model:
        prepared["model"] = model
    if thread_id:
        prepared["thread_id"] = thread_id
    now = datetime.now(timezone.utc).isoformat()
    return {
        "schema_version": 1,
        "benchmark_version": str(material["benchmark_version"]),
        "case_id": str(material["case_id"]),
        "run_id": str(material["run_id"]),
        "agent": str(material["agent"]),
        "tool_policy": str(material["tool_policy"]),
        "sources": material["sources"],
        "review": {
            "status": "completed", "outcome": "accepted" if accepted else "adjusted",
            "mode": "human_approved_agent_assisted", "prepared_by": prepared,
            "approved_by": {"type": "human", "reviewer_id": reviewer, "approved_at": now, "approval_note": approval_note},
            "rubric_version": "human-adjudication-v1",
        },
        "baseline": {"dimensions": baseline_dimensions, "total": automatic_total},
        "decisions": normalized,
        "result": {"dimensions": result_dimensions, "automatic_total": automatic_total,
                   "adjudicated_total": adjudicated_total, "delta": total_delta,
                   "effective_total": adjudicated_total},
    }


def validate_adjudication(run_dir: Path, data: dict[str, Any] | None = None) -> list[str]:
    path = run_dir / "adjudication.json"
    data = data or load_json(path)
    schema = load_json(SCHEMA)
    errors = [error.message for error in Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(data)]
    try:
        material = inspect_run(run_dir)
        for key, current in material["sources"].items():
            if data.get("sources", {}).get(key, {}).get("sha256") != current["sha256"]:
                errors.append(f"stale source hash: {key}")
        if str(data.get("benchmark_version")) != str(material.get("benchmark_version")):
            errors.append("benchmark_version mismatch")
        if round(float(data.get("baseline", {}).get("total", -1)), 4) != round(float(material.get("automatic_total", -2)), 4):
            errors.append("baseline total no longer matches automatic score")
        for key in ("benchmark_version", "case_id", "run_id", "agent", "tool_policy"):
            if str(data.get(key)) != str(material.get(key)):
                errors.append(f"{key} mismatch")
        items = {str(item.get("item_id")): item for item in material.get("item_scores", [])}
        deltas = {name: 0.0 for name in ADJUSTABLE}
        for decision in data.get("decisions", []):
            item_id = str(decision.get("item_id", "")); item = items.get(item_id)
            if not item:
                errors.append(f"unknown automatic score item: {item_id}")
                continue
            dimension = str(item.get("dimension", ""))
            if dimension not in ADJUSTABLE or decision.get("dimension") != dimension:
                errors.append(f"invalid adjudication dimension for {item_id}")
                continue
            max_points = float(item.get("max_points", 0)); automatic_credit = float(item.get("automatic_credit", 0))
            adjudicated_credit = float(decision.get("adjudicated", {}).get("credit", -1))
            if adjudicated_credit not in CREDITS or adjudicated_credit == automatic_credit:
                errors.append(f"invalid changed credit for {item_id}")
                continue
            if round(float(decision.get("automatic", {}).get("credit", -1)), 4) != round(automatic_credit, 4):
                errors.append(f"automatic credit mismatch for {item_id}")
            if round(float(decision.get("adjudicated", {}).get("max_points", -1)), 4) != round(max_points, 4):
                errors.append(f"max_points mismatch for {item_id}")
            expected_points = round(max_points * adjudicated_credit, 4)
            if round(float(decision.get("adjudicated", {}).get("points", -1)), 4) != expected_points:
                errors.append(f"adjudicated points mismatch for {item_id}")
            deltas[dimension] += expected_points - round(max_points * automatic_credit, 4)
        expected_total = round(max(0.0, min(100.0, float(material.get("automatic_total", 0)) + sum(deltas.values()))), 4)
        result = data.get("result", {})
        if round(float(result.get("adjudicated_total", -1)), 4) != expected_total:
            errors.append("adjudicated_total does not match decisions")
        for name, baseline_value in data.get("baseline", {}).get("dimensions", {}).items():
            expected_dimension = round(float(baseline_value) + deltas.get(name, 0), 4)
            if round(float(result.get("dimensions", {}).get(name, -1)), 4) != expected_dimension:
                errors.append(f"result dimension does not match decisions: {name}")
    except Exception as exc:
        errors.append(str(exc))
    return sorted(set(errors))


def write_adjudication(run_dir: Path, data: dict[str, Any]) -> Path:
    errors = validate_adjudication(run_dir, data)
    if errors:
        raise ValueError("invalid adjudication: " + "; ".join(errors))
    out = run_dir / "adjudication.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    inspect_p = sub.add_parser("inspect")
    inspect_group = inspect_p.add_mutually_exclusive_group(required=True)
    inspect_group.add_argument("--run-dir", type=Path)
    inspect_group.add_argument("--runs-dir", type=Path)
    inspect_p.add_argument("--case-id")
    inspect_p.add_argument("--compare", nargs=2, default=("grep", "graph"), metavar=("LEFT", "RIGHT"))
    for name in ("apply", "accept"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--run-dir", type=Path, required=True)
        cmd.add_argument("--reviewer", required=True)
        cmd.add_argument("--approval-note", required=True)
        cmd.add_argument("--agent", default="codex")
        cmd.add_argument("--model", default="")
        cmd.add_argument("--thread-id", default="")
        if name == "apply":
            cmd.add_argument("--decisions", type=Path, required=True)
    validate_p = sub.add_parser("validate")
    validate_p.add_argument("--run-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "inspect":
        if args.runs_dir and not args.case_id:
            parser.error("inspect --runs-dir requires --case-id")
        material = inspect_case(args.runs_dir, args.case_id, tuple(args.compare)) if args.runs_dir else inspect_run(args.run_dir)
        print(json.dumps(material, ensure_ascii=False, indent=2))
        return 0
    if args.command == "validate":
        errors = validate_adjudication(args.run_dir)
        print("OK" if not errors else "\n".join(errors))
        return 0 if not errors else 1
    decisions = [] if args.command == "accept" else json.loads(args.decisions.read_text(encoding="utf-8"))
    if not isinstance(decisions, list):
        raise ValueError("decisions file must contain a JSON array")
    data = build_adjudication(args.run_dir, decisions, reviewer=args.reviewer,
                              approval_note=args.approval_note, agent_name=args.agent,
                              model=args.model, thread_id=args.thread_id,
                              accepted=args.command == "accept")
    print(write_adjudication(args.run_dir, data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
