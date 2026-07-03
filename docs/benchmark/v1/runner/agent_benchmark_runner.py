"""Plan and execute Claude Code / OpenCode AI coding benchmark runs.

The runner validates benchmark metadata, expands the agent x tool-policy x repeat
matrix, builds per-run prompts, and can execute individual runs through a small
adapter layer.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import yaml
from jsonschema import Draft202012Validator


VERSION_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class RunSpec:
    run_id: str
    case_id: str
    case_file: str
    golden_file: str
    agent: str
    tool_policy: str
    repeat: int
    target_project: str
    modification_case: bool


@dataclass(frozen=True)
class CommandSpec:
    command: list[str]
    cwd: str
    policy_enforced: bool
    notes: list[str]
    stdin_file: str | None = None


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a YAML object")
    return data


def resolve_against_target(target_root: Path, relative_path: str) -> Path:
    return target_root / relative_path.replace("/", "\\")


def resolve_benchmark_path(plan_path: Path, target_root: Path, path_value: str) -> Path:
    """Resolve case/golden paths from either the target repo or this benchmark repo."""

    raw_path = Path(path_value)
    if raw_path.is_absolute():
        return raw_path

    target_path = resolve_against_target(target_root, path_value)
    if target_path.exists():
        return target_path

    repo_path = Path(path_value.replace("/", "\\"))
    if repo_path.exists():
        return repo_path

    plan_relative_path = plan_path.parent / path_value.replace("/", "\\")
    if plan_relative_path.exists():
        return plan_relative_path

    return target_path


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def benchmark_identity() -> dict[str, str | None]:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=VERSION_ROOT.parents[2],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return {"benchmark_version": VERSION_ROOT.name, "git_commit": None}
    git_commit = result.stdout.strip() if result.returncode == 0 else None
    return {"benchmark_version": VERSION_ROOT.name, "git_commit": git_commit}


def validate_plan(plan_path: Path) -> list[str]:
    plan = load_yaml(plan_path)
    errors: list[str] = []

    target = plan.get("target_project", {})
    target_root = Path(str(target.get("path", "")))
    if not target_root.exists():
        errors.append(f"target_project.path does not exist: {target_root}")

    validation_commands = target.get("validation_commands", [])
    if not validation_commands:
        errors.append("target_project.validation_commands must not be empty")

    case_source = plan.get("case_source", {})
    cases = case_source.get("cases", [])
    if not cases:
        errors.append("case_source.cases must not be empty")

    for case in cases:
        case_id = case.get("id", "<missing id>")
        case_file = resolve_benchmark_path(plan_path, target_root, str(case.get("file", "")))
        golden_file = resolve_benchmark_path(plan_path, target_root, str(case.get("golden", "")))
        if not case_file.exists():
            errors.append(f"{case_id}: case file does not exist: {case_file}")
        else:
            try:
                load_yaml(case_file)
            except Exception as exc:  # noqa: BLE001 - report parser details to benchmark author.
                errors.append(f"{case_id}: case file is not valid YAML: {exc}")
        if not golden_file.exists():
            errors.append(f"{case_id}: golden file does not exist: {golden_file}")
        else:
            try:
                load_yaml(golden_file)
            except Exception as exc:  # noqa: BLE001 - report parser details to benchmark author.
                errors.append(f"{case_id}: golden file is not valid YAML: {exc}")

    matrix = plan.get("run_matrix", {})
    agents = matrix.get("agents", [])
    policies = matrix.get("tool_policies", [])
    repeats = matrix.get("repeats_per_cell")
    if not agents:
        errors.append("run_matrix.agents must not be empty")
    if not policies:
        errors.append("run_matrix.tool_policies must not be empty")
    if not isinstance(repeats, int) or repeats <= 0:
        errors.append("run_matrix.repeats_per_cell must be a positive integer")

    return errors


def expand_run_plan(plan_path: Path) -> dict[str, Any]:
    plan = load_yaml(plan_path)
    errors = validate_plan(plan_path)
    if errors:
        raise ValueError("Invalid benchmark plan:\n" + "\n".join(f"- {error}" for error in errors))

    target = plan["target_project"]
    matrix = plan["run_matrix"]
    runs: list[RunSpec] = []

    for case in plan["case_source"]["cases"]:
        for agent in matrix["agents"]:
            for policy in matrix["tool_policies"]:
                for repeat in range(1, matrix["repeats_per_cell"] + 1):
                    run_id = f"{case['id']}__{agent}__{policy}__r{repeat}"
                    runs.append(
                        RunSpec(
                            run_id=run_id,
                            case_id=case["id"],
                            case_file=case["file"],
                            golden_file=case["golden"],
                            agent=agent,
                            tool_policy=policy,
                            repeat=repeat,
                            target_project=target["path"],
                            modification_case=bool(case.get("modification_case", False)),
                        )
                    )

    return {
        "name": plan.get("name"),
        "target_project": target,
        "run_count": len(runs),
        "runs": [asdict(run) for run in runs],
    }


def find_run(expanded: dict[str, Any], run_id: str) -> dict[str, Any]:
    for run in expanded["runs"]:
        if run["run_id"] == run_id:
            return run
    raise ValueError(f"run_id not found: {run_id}")


def public_case_payload(case_data: dict[str, Any]) -> dict[str, Any]:
    """Return only fields allowed to be shown to the evaluated agent."""

    allowed = {
        "case",
        "id",
        "name",
        "level",
        "title",
        "description",
        "task",
        "prompt",
    }
    return {key: value for key, value in case_data.items() if key in allowed}


def load_tool_policy(plan_path: Path, tool_policy: str) -> dict[str, Any]:
    profiles_path = plan_path.parent / "agent-profiles.yaml"
    if not profiles_path.exists():
        profiles_path = VERSION_ROOT / "shared" / "agent-profiles.yaml"
    profiles = load_yaml(profiles_path)
    policies = profiles.get("tool_policies", {})
    if tool_policy not in policies:
        raise ValueError(f"tool policy not found in {profiles_path}: {tool_policy}")
    return policies[tool_policy]


def result_schema_contract() -> dict[str, Any]:
    """Return the compact output shape agents must produce."""

    return {
        "required_top_level_fields": [
            "case_id",
            "run_id",
            "agent",
            "tool_policy",
            "policy_enforced",
            "started_at",
            "ended_at",
            "status",
            "final_answer",
            "evidence",
            "metrics",
            "violations",
        ],
        "status_enum": ["passed", "failed", "partial", "invalid", "error"],
        "evidence_ref": {
            "required": ["name", "reason"],
            "optional": ["kind", "file", "symbol", "line"],
            "kind_enum": ["file", "class", "interface", "function", "method", "field", "endpoint", "flow", "test", "risk", "other"],
        },
        "metrics_required": ["tool_call_count", "files_read_count"],
        "violation_type_enum": ["tool_policy", "context_leak", "dirty_worktree", "schema", "other"],
    }


def result_json_template(run: dict[str, Any]) -> dict[str, Any]:
    evidence_ref = {
        "name": "SymbolOrFileName",
        "kind": "method",
        "file": "path/to/File.java",
        "symbol": "ClassName.methodName",
        "line": 1,
        "reason": "Why this item is relevant evidence for the answer.",
    }
    return {
        "case_id": run["case_id"],
        "run_id": run["run_id"],
        "agent": run["agent"],
        "agent_model": "",
        "tool_policy": run["tool_policy"],
        "policy_enforced": True,
        "target_repo": run["target_project"],
        "target_commit": "",
        "gitnexus_index": {
            "repo": "",
            "indexed_at": "",
            "symbols": 0,
            "relationships": 0,
            "execution_flows": 0,
            "status": "",
        },
        "started_at": "",
        "ended_at": "",
        "status": "passed",
        "final_answer": {
            "summary": "",
            "entrypoints": [evidence_ref],
            "symbols": [evidence_ref],
            "files": [],
            "call_chains": [[evidence_ref]],
            "data_flows": [[evidence_ref]],
            "impact": [evidence_ref],
            "risks": ["Risk summary as plain string."],
            "recommended_tests": ["Validation command or test scenario as plain string."],
            "diff_summary": "",
            "validation_summary": "",
        },
        "evidence": [evidence_ref],
        "tool_calls": [
            {
                "tool": "Bash",
                "purpose": "Why the tool was used.",
                "input_summary": "Short input summary.",
                "output_summary": "Short output summary.",
                "allowed_by_policy": True,
            }
        ],
        "validation": [
            {
                "command": "mvn test",
                "exit_code": 0,
                "stdout_summary": "",
                "stderr_summary": "",
            }
        ],
        "metrics": {
            "tool_call_count": 0,
            "files_read_count": 0,
            "search_query_count": 0,
            "graph_query_count": 0,
            "elapsed_ms": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "approx_context_chars": 0,
            "changed_files_count": 0,
        },
        "violations": [],
    }


def graph_policy_guidance(tool_policy: str) -> dict[str, Any] | None:
    if tool_policy != "graph":
        return None
    return {
        "summary": (
            "This graph-policy run evaluates normal code investigation enhanced by GitNexus, "
            "not GitNexus as a full replacement for text search."
        ),
        "entrypoint_rule": (
            "GitNexus MCP tools should participate in the main discovery path. Begin or "
            "early-stage the investigation with GitNexus query/context/impact tools before "
            "building the final answer."
        ),
        "text_search_role": (
            "rg/grep/glob/find/read are allowed as supporting tools for local confirmation, "
            "implementation details, and fallback exploration after graph discovery or when "
            "graph results are weak."
        ),
        "not_allowed": [
            "Treating GitNexus as optional decoration with zero graph retrieval calls.",
            "Building the final answer entirely from text search or manual file browsing.",
        ],
        "reporting_requirements": [
            "Record GitNexus tool calls in tool_calls with concrete gitnexus_* tool names.",
            "Set metrics.graph_query_count to the number of GitNexus graph retrieval calls.",
            "Set metrics.search_query_count and metrics.files_read_count for text/file work.",
            "In evidence reasons, distinguish graph-derived evidence from text/file confirmation when possible.",
        ],
    }


def build_prompt(plan_path: Path, run: dict[str, Any]) -> str:
    plan = load_yaml(plan_path)
    target_root = Path(run["target_project"])
    case_data = load_yaml(resolve_benchmark_path(plan_path, target_root, run["case_file"]))
    policy = load_tool_policy(plan_path, run["tool_policy"])
    public_case = public_case_payload(case_data)
    schema_path = plan_path.parent / "run-result.schema.json"
    if not schema_path.exists():
        schema_path = VERSION_ROOT / "shared" / "schemas" / "run-result.schema.json"
    schema_path = schema_path.resolve()

    prompt_payload = {
        "benchmark_run": {
            "case_id": run["case_id"],
            "run_id": run["run_id"],
            "agent": run["agent"],
            "tool_policy": run["tool_policy"],
            "target_project": run["target_project"],
            "modification_case": run["modification_case"],
        },
        "case": public_case,
        "tool_policy": policy,
        "output_contract": {
            "schema": str(schema_path),
            "format": "Return only one JSON object matching the run-result schema. Do not include Markdown, prose, or fenced code blocks.",
            "golden_answers_are_hidden": True,
            "strict_rules": [
                "Do not add properties that are not present in the template or schema.",
                "Every entrypoint, symbol, impact item, and evidence item must be an evidenceRef object with at least name and reason.",
                "call_chains and data_flows must be arrays of arrays of evidenceRef objects, not custom step objects.",
                "risks and recommended_tests must be arrays of plain strings.",
                "tool_calls may contain only tool, purpose, input_summary, output_summary, and allowed_by_policy.",
            ],
            "contract": result_schema_contract(),
            "template": result_json_template(run),
        },
        "validation_commands": plan["target_project"].get("validation_commands", []),
    }
    guidance = graph_policy_guidance(run["tool_policy"])
    if guidance:
        prompt_payload["tool_policy_guidance"] = guidance

    return (
        "你正在执行一个 AI Coding benchmark run。\n"
        "必须遵守工具策略；如果无法遵守，请在 violations 中说明。\n"
        "不要读取 ground-truth、golden answer、历史 run 输出或评分说明。\n"
        "只输出符合 run-result.schema.json 的 JSON。\n\n"
        + json.dumps(prompt_payload, ensure_ascii=False, indent=2)
    )


def build_command(
    run: dict[str, Any],
    prompt_path: Path,
    *,
    model: str | None = None,
    mcp_config: str | None = None,
) -> CommandSpec:
    notes: list[str] = []
    cwd = run["target_project"]

    if run["agent"] == "claude-code":
        command = [
            "claude.cmd" if os.name == "nt" else "claude",
            "--print",
            "--output-format",
            "json",
            "--permission-mode",
            "dontAsk",
            "--no-session-persistence",
        ]
        if model:
            command.extend(["--model", model])

        allowed_tools_list = ["Bash", "Read"]
        if run["modification_case"]:
            allowed_tools_list.append("Edit")

        if run["tool_policy"] in {"graph", "mixed"}:
            allowed_tools_list.extend(
                [
                    "mcp__gitnexus__query",
                    "mcp__gitnexus__context",
                    "mcp__gitnexus__impact",
                    "mcp__gitnexus__detect_changes",
                    "mcp__gitnexus__explain",
                    "mcp__gitnexus__list_repos",
                ]
            )

        command.extend(["--allowedTools", ",".join(allowed_tools_list)])

        policy_enforced = True
        if run["tool_policy"] in {"graph", "mixed"}:
            if mcp_config:
                command.extend(["--mcp-config", str(Path(mcp_config).resolve())])
            else:
                policy_enforced = False
                notes.append(f"{run['tool_policy']} policy requested but no MCP config was provided")

        notes.append("Prompt is passed through stdin to avoid command-line length limits.")
        return CommandSpec(
            command=command,
            cwd=cwd,
            policy_enforced=policy_enforced,
            notes=notes,
            stdin_file=str(prompt_path),
        )

    if run["agent"] == "opencode":
        command = [
            "opencode.cmd" if os.name == "nt" else "opencode",
            "run",
            "--format",
            "json",
            "--auto",
            "--dir",
            cwd,
        ]
        if model:
            command.extend(["--model", model])
        command.append("Read the attached benchmark prompt file and execute it exactly. Return only the requested JSON.")
        command.extend(["-f", str(prompt_path.resolve())])

        notes.append("OpenCode prompt is attached with -f because `opencode run` accepts message args rather than stdin.")
        notes.append("OpenCode CLI help does not expose allowed-tools enforcement; policy is prompt-enforced only.")
        return CommandSpec(
            command=command,
            cwd=cwd,
            policy_enforced=False,
            notes=notes,
            stdin_file=None,
        )

    raise ValueError(f"unsupported agent: {run['agent']}")


def write_run_scaffold(
    plan_path: Path,
    run_id: str,
    out_dir: Path,
    *,
    model: str | None = None,
    mcp_config: str | None = None,
) -> dict[str, Any]:
    expanded = expand_run_plan(plan_path)
    run = find_run(expanded, run_id)
    run_dir = out_dir / run["agent"] / run["tool_policy"] / run["run_id"]
    run_dir.mkdir(parents=True, exist_ok=True)

    prompt_path = run_dir / "prompt.txt"
    prompt_path.write_text(build_prompt(plan_path, run), encoding="utf-8")
    command_spec = build_command(run, prompt_path, model=model, mcp_config=mcp_config)

    manifest = {
        "benchmark": benchmark_identity(),
        "run": run,
        "prompt_file": str(prompt_path),
        "command": command_spec.command,
        "cwd": command_spec.cwd,
        "policy_enforced": command_spec.policy_enforced,
        "notes": command_spec.notes,
        "stdin_file": command_spec.stdin_file,
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def execute_run(
    plan_path: Path,
    run_id: str,
    out_dir: Path,
    *,
    dry_run: bool,
    model: str | None = None,
    mcp_config: str | None = None,
    timeout_seconds: int = 1800,
) -> dict[str, Any]:
    manifest = write_run_scaffold(plan_path, run_id, out_dir, model=model, mcp_config=mcp_config)
    run_dir = Path(manifest["prompt_file"]).parent
    started = now_iso()
    started_monotonic = time.monotonic()

    if dry_run:
        result = {
            "run_id": run_id,
            "status": "dry-run",
            "started_at": started,
            "ended_at": now_iso(),
            "elapsed_ms": 0,
            "manifest": manifest,
        }
        (run_dir / "runner-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return result

    if not manifest["command"]:
        result = {
            "run_id": run_id,
            "status": "error",
            "started_at": started,
            "ended_at": now_iso(),
            "elapsed_ms": int((time.monotonic() - started_monotonic) * 1000),
            "error": "No executable command was produced for this run.",
            "manifest": manifest,
        }
        (run_dir / "runner-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return result

    stdin_text = None
    if manifest.get("stdin_file"):
        stdin_text = Path(manifest["stdin_file"]).read_text(encoding="utf-8")

    completed = subprocess.run(
        manifest["command"],
        cwd=manifest["cwd"],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        input=stdin_text,
        timeout=timeout_seconds,
        check=False,
    )
    ended = now_iso()
    result = {
        "run_id": run_id,
        "status": "passed" if completed.returncode == 0 else "failed",
        "started_at": started,
        "ended_at": ended,
        "elapsed_ms": int((time.monotonic() - started_monotonic) * 1000),
        "exit_code": completed.returncode,
        "stdout_file": str(run_dir / "stdout.txt"),
        "stderr_file": str(run_dir / "stderr.txt"),
        "manifest": manifest,
    }
    (run_dir / "stdout.txt").write_text(completed.stdout or "", encoding="utf-8")
    (run_dir / "stderr.txt").write_text(completed.stderr or "", encoding="utf-8")
    (run_dir / "runner-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def execute_matrix(
    plan_path: Path,
    out_dir: Path,
    *,
    dry_run: bool,
    agents: set[str] | None = None,
    tool_policies: set[str] | None = None,
    case_ids: set[str] | None = None,
    max_runs: int | None = None,
    offset: int | None = None,
    model: str | None = None,
    mcp_config: str | None = None,
    timeout_seconds: int = 1800,
) -> dict[str, Any]:
    expanded = expand_run_plan(plan_path)
    selected_runs = []
    for run in expanded["runs"]:
        if agents and run["agent"] not in agents:
            continue
        if tool_policies and run["tool_policy"] not in tool_policies:
            continue
        if case_ids and run["case_id"] not in case_ids:
            continue
        selected_runs.append(run)

    if offset is not None:
        selected_runs = selected_runs[offset:]
    if max_runs is not None:
        selected_runs = selected_runs[:max_runs]

    results = []
    for run in selected_runs:
        results.append(
            execute_run(
                plan_path,
                run["run_id"],
                out_dir,
                dry_run=dry_run,
                model=model,
                mcp_config=mcp_config,
                timeout_seconds=timeout_seconds,
            )
        )

    summary = {
        "plan": str(plan_path),
        "out_dir": str(out_dir),
        "dry_run": dry_run,
        "selected_run_count": len(selected_runs),
        "status_counts": count_by(results, "status"),
        "results": results,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "matrix-result.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def _normalize_for_matching(text: str) -> str:
    return text.replace("\\", "/").strip()


def _alias_expand(term: str) -> list[str]:
    """Generate alias variants for a ground-truth term so semantic equivalents match.

    - ``pkg.module:func`` and ``pkg.module.func`` are interchangeable (Python entrypoint).
    - ``project.scripts.<name>`` matches when the answer body contains ``project.scripts``
      near ``<name> =`` in the expected-scripts context.
    - Path separators are already normalized to ``/`` before comparison.
    """
    variants: list[str] = [term]

    # Python entrypoint: colon <-> dot
    if ":" in term and not term.startswith(":"):
        variants.append(term.replace(":", "."))
    if "." in term and ":" not in term:
        # Only add the colon variant when the dot-path looks like a module reference
        parts = term.split(".")
        if len(parts) >= 3 and all(
            part.isidentifier() for part in parts
        ):
            # pkg.module.func -> pkg.module:func (last segment is the callable)
            module_path = ".".join(parts[:-1])
            callable_name = parts[-1]
            variants.append(f"{module_path}:{callable_name}")

    return list(set(variants))


def _alias_hit(term: str, answer_text: str) -> bool:
    """Check whether *term* is considered present in *answer_text*, including aliases."""
    norm_term = _normalize_for_matching(term).lower()
    norm_answer = answer_text.lower()
    variants = _alias_expand(norm_term)
    for variant in variants:
        if variant in norm_answer:
            return True

    # project.scripts.<name> heuristic: answer mentions project.scripts and <name> = ...
    if norm_term.startswith("project.scripts."):
        name = norm_term[len("project.scripts."):]
        project_scripts_mentioned = "project.scripts" in norm_answer
        name_assign_mentioned = f"{name} =" in norm_answer or f"{name}=" in norm_answer
        if project_scripts_mentioned and name_assign_mentioned:
            return True

    return False


def collect_text(value: Any) -> str:
    if isinstance(value, dict):
        return "\n".join(collect_text(item) for item in value.values())
    if isinstance(value, list):
        return "\n".join(collect_text(item) for item in value)
    if value is None:
        return ""
    return str(value)


def collect_expected_terms(value: Any, key: str | None = None) -> list[str]:
    terms: list[str] = []
    important_keys = {
        "symbol",
        "file",
        "field",
        "class",
        "interface",
        "method",
        "controller",
        "route",
        "current_name",
        "new_name",
    }
    if isinstance(value, dict):
        for child_key, child_value in value.items():
            terms.extend(collect_expected_terms(child_value, child_key))
    elif isinstance(value, list):
        for item in value:
            terms.extend(collect_expected_terms(item, key))
    elif isinstance(value, str) and key in important_keys:
        term = value.strip()
        if term:
            terms.append(term)
    return terms


ANALYSIS_DEPTH_SIGNAL_SPEC = {
    "used_gitnexus_context": {
        "pattern": r"\b(callers?|callee|incoming|outgoing|call chain|imports?|has_method)\b",
        "points": 1.5,
        "label": "GitNexus context used with caller/callee evidence",
    },
    "used_gitnexus_impact": {
        "pattern": r"\b(affected|impacted|blast radius)\b",
        "points": 1.5,
        "label": "GitNexus impact used with affected/impacted evidence",
    },
    "used_gitnexus_query": {
        "pattern": r"\b(execution\s*flow|flow\s*tracing|data\s*flow)\b",
        "points": 1.0,
        "label": "GitNexus query used with flow/process evidence",
    },
    "found_risk_level": {
        "points": 1.5,
        "label": "Risk level mentioned (CRITICAL/HIGH/MEDIUM/LOW)",
    },
    "found_numeric_structural_evidence": {
        "pattern": r"(\d+)\s*(callers?|affected\s*process(es)?|modules?|impacted|steps)",
        "points": 2.0,
        "label": "Numeric structural evidence (N callers/processes/modules)",
    },
}

ANALYSIS_DEPTH_BONUS_MAX = 10.0
GITNEXUS_TOOLS = {"gitnexus_context", "gitnexus_impact", "gitnexus_query",
                  "gitnexus_detect_changes", "gitnexus_pdg_query"}


def _detect_gitnexus_tools(tool_calls: list[dict]) -> set[str]:
    """Detect which GitNexus capabilities were used, supporting 3 tool-name forms."""
    used: set[str] = set()
    for tc in tool_calls:
        if not isinstance(tc, dict):
            continue
        tool_name = str(tc.get("tool", "")).lower()
        input_summary = str(tc.get("input_summary", "")).lower()
        output_summary = str(tc.get("output_summary", "")).lower()
        purpose = str(tc.get("purpose", "")).lower()
        combined = f"{tool_name} {input_summary} {output_summary} {purpose}"

        # 1. Direct MCP: tool name contains mcp__gitnexus
        # 2. Normalized benchmark name: tool name starts with gitnexus_
        if "mcp__gitnexus" in tool_name or tool_name.startswith("gitnexus_"):
            # Normalize mcp__gitnexus__context → gitnexus_context
            normalized = tool_name
            if normalized.startswith("mcp__"):
                normalized = normalized[len("mcp__"):]
            # Some MCP wrappers use double underscores: mcp__gitnexus__context
            normalized_flat = normalized.replace("__", "_")
            for gt in GITNEXUS_TOOLS:
                if gt in normalized or gt in normalized_flat:
                    used.add(gt)
        # 3. CLI wrapper: Bash/Shell with gitnexus commands
        elif "gitnexus" in combined and tool_name in ("bash", "shell"):
            for gt in GITNEXUS_TOOLS:
                cli_form = gt.replace("_", " ")
                if cli_form in combined:
                    used.add(gt)

    return used


def _compute_analysis_depth_bonus(agent_result: dict[str, Any]) -> tuple[float, list[str]]:
    """Return (bonus, deduped_signal_labels) based on structural evidence.

    Each signal type is counted at most once (dedup by signal category),
    preventing repetitive text from inflating the bonus.
    """
    tool_calls = agent_result.get("tool_calls", [])
    if not isinstance(tool_calls, list):
        tool_calls = []

    tools_used = _detect_gitnexus_tools(tool_calls)
    if not tools_used:
        return 0.0, []

    answer_text = collect_text(agent_result).lower()
    bonuses: dict[str, tuple[float, str]] = {}

    # Check context/impact/query signals: each tool type + keyword category at most once
    context_spec = ANALYSIS_DEPTH_SIGNAL_SPEC["used_gitnexus_context"]
    if "gitnexus_context" in tools_used and re.search(context_spec["pattern"], answer_text, re.IGNORECASE):
        bonuses["used_gitnexus_context"] = (context_spec["points"], context_spec["label"])

    impact_spec = ANALYSIS_DEPTH_SIGNAL_SPEC["used_gitnexus_impact"]
    if "gitnexus_impact" in tools_used and re.search(impact_spec["pattern"], answer_text, re.IGNORECASE):
        bonuses["used_gitnexus_impact"] = (impact_spec["points"], impact_spec["label"])

    query_spec = ANALYSIS_DEPTH_SIGNAL_SPEC["used_gitnexus_query"]
    if "gitnexus_query" in tools_used and re.search(query_spec["pattern"], answer_text, re.IGNORECASE):
        bonuses["used_gitnexus_query"] = (query_spec["points"], query_spec["label"])

    # Risk level: check impact section and overall answer
    risk_level_pattern = re.compile(r"\b(CRITICAL|HIGH|MEDIUM|LOW)\b", re.IGNORECASE)
    final_answer = agent_result.get("final_answer", {})
    impact_items = final_answer.get("impact", []) if isinstance(final_answer, dict) else []
    if not isinstance(impact_items, list):
        impact_items = []
    risk_found = False
    for item in impact_items:
        if isinstance(item, dict) and risk_level_pattern.search(str(item.get("reason", ""))):
            risk_found = True
            break
    if not risk_found:
        risk_found = bool(risk_level_pattern.search(answer_text))
    if risk_found:
        rs = ANALYSIS_DEPTH_SIGNAL_SPEC["found_risk_level"]
        bonuses["found_risk_level"] = (rs["points"], rs["label"])

    # Numeric structural evidence
    numeric_spec = ANALYSIS_DEPTH_SIGNAL_SPEC["found_numeric_structural_evidence"]
    if "pattern" in numeric_spec and re.search(numeric_spec["pattern"], answer_text, re.IGNORECASE):
        bonuses["found_numeric_structural_evidence"] = (numeric_spec["points"], numeric_spec["label"])

    bonus = min(ANALYSIS_DEPTH_BONUS_MAX, round(sum(p for p, _ in bonuses.values()), 2))
    reasons = [label for _, label in sorted(bonuses.values())]
    return bonus, reasons


def score_run_result(run_result_path: Path, golden_path: Path) -> dict[str, Any]:
    run_result = load_json(run_result_path)
    golden = load_yaml(golden_path)

    expected_terms = sorted(set(collect_expected_terms(golden)))
    answer_text = collect_text(run_result).lower()
    hits = [term for term in expected_terms if _alias_hit(term, answer_text)]
    misses = [term for term in expected_terms if not _alias_hit(term, answer_text)]

    coverage = (len(hits) / len(expected_terms)) if expected_terms else 0.0
    violations = run_result.get("violations", [])
    if not isinstance(violations, list):
        violations = []
    metrics = run_result.get("metrics", {})
    if not isinstance(metrics, dict):
        metrics = {}

    analysis_bonus, analysis_bonus_reasons = _compute_analysis_depth_bonus(run_result)

    penalty = float(len(violations) * 10)
    coverage_total = round(coverage * 70 + (10 if hits else 0), 2)
    adjusted_total = max(0.0, round(coverage_total + analysis_bonus - penalty, 2))
    score = {
        **benchmark_identity(),
        "case_id": run_result.get("case_id") or run_result.get("run_id", "").split("__")[0],
        "run_id": run_result.get("run_id"),
        "agent": run_result.get("agent"),
        "tool_policy": run_result.get("tool_policy"),
        "status": run_result.get("status"),
        "policy_enforced": bool(run_result.get("policy_enforced", False)),
        "run_result": str(run_result_path),
        "golden_answer": str(golden_path),
        "score": {
            "location_accuracy": round(coverage * 10, 2),
            "coverage_completeness": round(coverage * 10, 2),
            "evidence_quality": 5.0 if hits else 0.0,
            "noise_resistance": 5.0,
            "final_usability": 5.0 if hits else 0.0,
            "coverage_total": coverage_total,
            "analysis_depth_bonus": analysis_bonus,
            "analysis_depth_signals": analysis_bonus_reasons,
            "adjusted_total": adjusted_total,
            "total": adjusted_total,
            "policy_violation_penalty": penalty,
        },
        "metrics": {
            "tool_call_count": int(metrics.get("tool_call_count", 0) or 0),
            "files_read_count": int(metrics.get("files_read_count", 0) or 0),
            "search_query_count": int(metrics.get("search_query_count", 0) or 0),
            "graph_query_count": int(metrics.get("graph_query_count", 0) or 0),
            "elapsed_ms": int(metrics.get("elapsed_ms", 0) or 0),
            "changed_files_count": int(metrics.get("changed_files_count", 0) or 0),
        },
        "violation_count": len(violations),
        "expected_term_count": len(expected_terms),
        "hit_count": len(hits),
        "hits": hits,
        "misses": misses,
        "judge_notes": [
            "This is an automatic coverage pre-score. Use the scoring rubric for final adjudication.",
            "Terms are extracted from important ground-truth keys such as symbol, file, field, class, and route.",
        ],
    }
    return score


def count_by(items: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        value = str(item.get(key, "<missing>"))
        counts[value] = counts.get(value, 0) + 1
    return counts


def discover_score_files(scores_dir: Path) -> list[Path]:
    if scores_dir.is_file():
        return [scores_dir]
    score_files = sorted(scores_dir.rglob("score.json"))
    if score_files:
        return score_files
    return sorted(scores_dir.rglob("*.json"))


def percentile(values: list[float], percentile_value: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 2)
    rank = (len(ordered) - 1) * percentile_value
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    weight = rank - lower
    return round(ordered[lower] * (1 - weight) + ordered[upper] * weight, 2)


def aggregate_scores(scores_dir: Path) -> dict[str, Any]:
    score_files = discover_score_files(scores_dir)
    rows: list[dict[str, Any]] = []
    for path in score_files:
        data = load_json(path)
        score = data.get("score", {})
        metrics = data.get("metrics", {})
        if not isinstance(metrics, dict):
            metrics = {}
        run_result = str(data.get("run_result", ""))
        run_name = Path(run_result).stem
        run_id = data.get("run_id") or run_name
        parts = str(run_id).split("__")
        rows.append(
            {
                "score_file": str(path),
                "case_id": data.get("case_id") or (parts[0] if parts else ""),
                "run_id": run_id,
                "agent": data.get("agent") or (parts[1] if len(parts) > 1 else ""),
                "tool_policy": data.get("tool_policy") or (parts[2] if len(parts) > 2 else ""),
                "status": data.get("status", ""),
                "policy_enforced": bool(data.get("policy_enforced", False)),
                "total": float(score.get("total", 0.0)),
                "location_accuracy": float(score.get("location_accuracy", 0.0)),
                "coverage_completeness": float(score.get("coverage_completeness", 0.0)),
                "evidence_quality": float(score.get("evidence_quality", 0.0)),
                "final_usability": float(score.get("final_usability", 0.0)),
                "hit_count": int(data.get("hit_count", 0)),
                "expected_term_count": int(data.get("expected_term_count", 0)),
                "violation_count": int(data.get("violation_count", 0)),
                "analysis_depth_bonus": float(score.get("analysis_depth_bonus", score.get("graph_depth_bonus", 0.0))),
                "tool_call_count": int(metrics.get("tool_call_count", 0) or 0),
                "files_read_count": int(metrics.get("files_read_count", 0) or 0),
                "search_query_count": int(metrics.get("search_query_count", 0) or 0),
                "graph_query_count": int(metrics.get("graph_query_count", 0) or 0),
                "elapsed_ms": int(metrics.get("elapsed_ms", 0) or 0),
                "changed_files_count": int(metrics.get("changed_files_count", 0) or 0),
            }
        )

    # Attach artifact quality info to each row
    artifact_warning_count = 0
    artifact_invalid_count = 0
    exclusion_reasons: list[str] = []
    for row in rows:
        score_file = Path(row["score_file"])
        run_dir = score_file.parent
        artifact = validate_run_artifacts(run_dir)
        row["artifact_valid"] = artifact["valid"]
        row["artifact_warnings"] = artifact["warnings"]
        if not artifact["valid"]:
            artifact_invalid_count += 1
            exclusion_reasons.append(f"{row['run_id']}: artifact invalid ({'; '.join(artifact['errors'][:2])})")
        if artifact["warnings"]:
            artifact_warning_count += 1

    # Determine valid rows for aggregate computation
    def _is_valid_row(row: dict[str, Any]) -> bool:
        return (
            row.get("status") not in ("invalid",)
            and row.get("violation_count", 0) == 0
            and row.get("artifact_valid", True)
        )

    valid_rows = [row for row in rows if _is_valid_row(row)]
    invalid_rows = [row for row in rows if not _is_valid_row(row)]

    graph_rows = [row for row in rows if row.get("tool_policy") == "graph"]
    graph_zero_query_rows = [row for row in graph_rows if int(row.get("graph_query_count", 0) or 0) == 0]
    graph_text_heavy_rows = [
        row
        for row in graph_rows
        if int(row.get("search_query_count", 0) or 0) > int(row.get("graph_query_count", 0) or 0)
        and int(row.get("search_query_count", 0) or 0) > 0
    ]
    graph_policy_observability = {
        "graph_run_count": len(graph_rows),
        "zero_graph_query_count": len(graph_zero_query_rows),
        "text_heavy_graph_run_count": len(graph_text_heavy_rows),
        "zero_graph_query_run_ids": [str(row.get("run_id", "")) for row in graph_zero_query_rows],
        "text_heavy_graph_run_ids": [str(row.get("run_id", "")) for row in graph_text_heavy_rows],
        "note": (
            "These are report-level hints only. They do not change artifact_valid, "
            "valid_run_count, or graph uplift aggregation."
        ),
    }

    by_agent_policy: dict[str, dict[str, Any]] = {}
    for row in valid_rows:
        key = f"{row['agent']}::{row['tool_policy']}"
        bucket = by_agent_policy.setdefault(
            key,
            {
                "agent": row["agent"],
                "tool_policy": row["tool_policy"],
                "count": 0,
                "passed_count": 0,
                "avg_total": 0.0,
                "avg_tool_call_count": 0.0,
                "avg_files_read_count": 0.0,
                "avg_search_query_count": 0.0,
                "avg_graph_query_count": 0.0,
                "avg_elapsed_ms": 0.0,
                "_totals": [],
            },
        )
        bucket["count"] += 1
        if row["status"] in ("", "passed"):
            bucket["passed_count"] += 1
        bucket["avg_total"] += row["total"]
        bucket["avg_tool_call_count"] += row["tool_call_count"]
        bucket["avg_files_read_count"] += row["files_read_count"]
        bucket["avg_search_query_count"] += row["search_query_count"]
        bucket["avg_graph_query_count"] += row["graph_query_count"]
        bucket["avg_elapsed_ms"] += row["elapsed_ms"]
        bucket["_totals"].append(row["total"])
    for bucket in by_agent_policy.values():
        if bucket["count"]:
            bucket["avg_total"] = round(bucket["avg_total"] / bucket["count"], 2)
            bucket["pass_rate"] = round(bucket["passed_count"] / bucket["count"], 4)
            bucket["p50_total"] = percentile(bucket["_totals"], 0.5)
            bucket["p90_total"] = percentile(bucket["_totals"], 0.9)
            bucket["avg_tool_call_count"] = round(bucket["avg_tool_call_count"] / bucket["count"], 2)
            bucket["avg_files_read_count"] = round(bucket["avg_files_read_count"] / bucket["count"], 2)
            bucket["avg_search_query_count"] = round(bucket["avg_search_query_count"] / bucket["count"], 2)
            bucket["avg_graph_query_count"] = round(bucket["avg_graph_query_count"] / bucket["count"], 2)
            bucket["avg_elapsed_ms"] = round(bucket["avg_elapsed_ms"] / bucket["count"], 2)
        del bucket["_totals"]

    graph_uplift: dict[str, float] = {}
    by_agent: dict[str, dict[str, float]] = {}
    for bucket in by_agent_policy.values():
        by_agent.setdefault(bucket["agent"], {})[bucket["tool_policy"]] = bucket["avg_total"]
    for agent, policies in by_agent.items():
        if "graph" in policies and "grep" in policies:
            graph_uplift[agent] = round(policies["graph"] - policies["grep"], 2)

    return {
        **benchmark_identity(),
        "score_file_count": len(score_files),
        "run_count": len(rows),
        "valid_run_count": len(valid_rows),
        "invalid_run_count": len(invalid_rows),
        "excluded_run_count": len(rows) - len(valid_rows),
        "exclusion_reasons": exclusion_reasons,
        "artifact_warning_count": artifact_warning_count,
        "artifact_invalid_count": artifact_invalid_count,
        "graph_policy_observability": graph_policy_observability,
        "by_agent_policy": sorted(by_agent_policy.values(), key=lambda item: (item["agent"], item["tool_policy"])),
        "graph_uplift_by_agent": graph_uplift,
        "rows": rows,
    }


def _find_valid_json_prefix(text: str) -> dict[str, Any] | None:
    """Find the longest valid JSON object prefix in text.

    Tracks string/escape state and a stack of open structures. At each position where
    depth returns to 0, attempts to parse the complete prefix. Also attempts to truncate
    at every comma (any depth) and close all open structures, which handles JSON with
    syntax errors deep inside nested objects/arrays.
    """
    in_str = False
    escaped = False
    first_brace = -1
    stack: list[str] = []
    best: dict[str, Any] | None = None
    best_len = 0
    candidates: list[tuple[int, str]] = []

    for i, ch in enumerate(text):
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == '"':
            in_str = not in_str
        elif not in_str:
            if ch == "{":
                if not stack:
                    first_brace = i
                stack.append("{")
            elif ch == "}":
                if stack and stack[-1] == "{":
                    stack.pop()
                    if not stack and first_brace >= 0:
                        candidates.append((i + 1, ""))
            elif ch == "[":
                stack.append("[")
            elif ch == "]":
                if stack and stack[-1] == "[":
                    stack.pop()
            elif ch == "," and stack and first_brace >= 0:
                close_suffix = "".join("}" if s == "{" else "]" for s in reversed(stack))
                candidates.append((i, close_suffix))

    if not candidates:
        return None

    for end_pos, suffix in reversed(candidates):
        if first_brace < 0:
            break
        candidate = text[first_brace:end_pos] + suffix
        if len(candidate) <= best_len:
            continue
        try:
            data = json.loads(candidate)
            if isinstance(data, dict):
                best = data
                best_len = len(candidate)
        except json.JSONDecodeError:
            pass

    return best


def parse_json_maybe(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    if not stripped:
        return None
    try:
        data = json.loads(stripped)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        pass

    # Try first { to last }
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(stripped[start : end + 1])
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass

    # Try all { positions from left to right with last }
    best: dict[str, Any] | None = None
    if start >= 0 and end > start:
        search_from = 0
        while search_from < len(stripped):
            brace_pos = stripped.find("{", search_from)
            if brace_pos < 0 or brace_pos >= end:
                break
            try:
                data = json.loads(stripped[brace_pos : end + 1])
                if isinstance(data, dict):
                    if "case_id" in data and "final_answer" in data:
                        return data
                    if best is None or len(stripped[brace_pos : end + 1]) > len(json.dumps(best, ensure_ascii=False)):
                        best = data
            except json.JSONDecodeError:
                pass
            search_from = brace_pos + 1

    # Try finding longest valid JSON prefix (handles syntax errors mid-JSON)
    result = _find_valid_json_prefix(stripped)
    if result is not None:
        if "case_id" in result and "final_answer" in result:
            return result
        if best is None or len(json.dumps(result, ensure_ascii=False)) > len(json.dumps(best, ensure_ascii=False)):
            best = result

    return best


def parse_jsonl_maybe(text: str) -> list[dict[str, Any]] | None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return None

    events: list[dict[str, Any]] = []
    for line in lines:
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            return None
        if not isinstance(data, dict):
            return None
        events.append(data)
    return events


def iter_strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from iter_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_strings(child)


def unwrap_agent_json(data: dict[str, Any]) -> dict[str, Any]:
    """Unwrap common CLI response envelopes into the agent's JSON answer."""

    if "case_id" in data and "final_answer" in data:
        return data

    for key in ("result", "text", "content"):
        value = data.get(key)
        if isinstance(value, str):
            parsed = parse_json_maybe(value)
            if parsed:
                return unwrap_agent_json(parsed)
        if isinstance(value, list):
            joined = "\n".join(str(item.get("text", item)) if isinstance(item, dict) else str(item) for item in value)
            parsed = parse_json_maybe(joined)
            if parsed:
                return unwrap_agent_json(parsed)

    return data


def unwrap_agent_jsonl_events(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Find the final agent JSON answer inside newline-delimited CLI events."""

    for event in reversed(events):
        strings = list(iter_strings(event))
        for value in reversed(strings):
            if "case_id" not in value or "final_answer" not in value:
                continue
            parsed = parse_json_maybe(value)
            if parsed:
                result = unwrap_agent_json(parsed)
                if "case_id" in result and "final_answer" in result:
                    return result
    return None


def validate_agent_result_shape(agent_result: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    required_fields = result_schema_contract()["required_top_level_fields"]
    for field in required_fields:
        if field not in agent_result:
            errors.append(f"missing required field: {field}")

    final_answer = agent_result.get("final_answer")
    if isinstance(final_answer, dict):
        if "summary" not in final_answer:
            errors.append("missing required field: final_answer.summary")
    elif "final_answer" in agent_result:
        errors.append("final_answer must be an object")

    metrics = agent_result.get("metrics")
    if isinstance(metrics, dict):
        for field in result_schema_contract()["metrics_required"]:
            if field not in metrics:
                errors.append(f"missing required field: metrics.{field}")
    elif "metrics" in agent_result:
        errors.append("metrics must be an object")

    violations = agent_result.get("violations")
    if "violations" in agent_result and not isinstance(violations, list):
        errors.append("violations must be an array")

    evidence = agent_result.get("evidence")
    if "evidence" in agent_result and not isinstance(evidence, list):
        errors.append("evidence must be an array")

    return errors


def validate_agent_result_schema(agent_result: dict[str, Any], schema_path: Path) -> list[str]:
    schema = load_json(schema_path)
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(agent_result), key=lambda error: list(error.path))
    messages: list[str] = []
    for error in errors:
        location = ".".join(str(part) for part in error.path) or "<root>"
        messages.append(f"{location}: {error.message}")
    return messages


def normalize_agent_result(agent_result: dict[str, Any]) -> dict[str, Any]:
    # Fill in defaults for missing required top-level fields
    agent_result.setdefault("violations", [])
    if not isinstance(agent_result.get("violations"), list):
        agent_result["violations"] = []

    agent_result.setdefault("evidence", [])
    if not isinstance(agent_result.get("evidence"), list):
        agent_result["evidence"] = []

    metrics = agent_result.setdefault("metrics", {})
    if isinstance(metrics, dict):
        metrics.setdefault("tool_call_count", 0)
        metrics.setdefault("files_read_count", 0)
    else:
        agent_result["metrics"] = {"tool_call_count": 0, "files_read_count": 0}

    final_answer = agent_result.get("final_answer")
    if not isinstance(final_answer, dict):
        return agent_result

    files = final_answer.get("files")
    if isinstance(files, list):
        normalized_files = []
        changed = False
        for item in files:
            if isinstance(item, str):
                normalized_files.append(item)
            elif isinstance(item, dict):
                file_val = item.get("file")
                if isinstance(file_val, str):
                    normalized_files.append(file_val)
                    changed = True
                elif isinstance(item.get("name"), str):
                    normalized_files.append(item["name"])
                    changed = True
                else:
                    normalized_files.append(item)
            else:
                normalized_files.append(item)
        if changed:
            final_answer["files"] = normalized_files

    # Normalize unknown kind values to "other" in all evidenceRef objects
    allowed_kinds = {"file", "class", "interface", "function", "method", "field", "endpoint", "flow", "test", "risk", "other"}

    # Allowed fields per schema (additionalProperties: false on all object types)
    evidence_ref_fields = {"name", "kind", "file", "symbol", "line", "reason"}
    tool_call_fields = {"tool", "purpose", "input_summary", "output_summary", "allowed_by_policy"}
    validation_fields = {"command", "exit_code", "stdout_summary", "stderr_summary"}
    root_fields = {
        "case_id", "run_id", "agent", "agent_model", "tool_policy", "policy_enforced",
        "target_repo", "target_commit", "gitnexus_index", "started_at", "ended_at",
        "status", "final_answer", "evidence", "tool_calls", "validation", "metrics", "violations",
    }

    def _strip_unknown_fields(obj: dict[str, Any], allowed: set[str]) -> None:
        for key in list(obj.keys()):
            if key not in allowed:
                del obj[key]

    def _normalize_evidence_ref(obj: dict[str, Any]) -> dict[str, Any]:
        if isinstance(obj, dict):
            # Map unknown kind to "other"
            if "kind" in obj:
                kind = obj.get("kind")
                if isinstance(kind, str) and kind not in allowed_kinds:
                    obj["kind"] = "other"
            # Remove null values for optional fields (models output null instead of omitting)
            for opt_field in ("kind", "file", "symbol", "line"):
                if obj.get(opt_field) is None:
                    obj.pop(opt_field, None)
            # Strip fields not allowed by schema (additionalProperties: false)
            _strip_unknown_fields(obj, evidence_ref_fields)
        return obj

    def _walk_evidence_refs(obj: Any) -> None:
        if isinstance(obj, list):
            for item in obj:
                _walk_evidence_refs(item)
        elif isinstance(obj, dict):
            if "name" in obj and "reason" in obj:
                _normalize_evidence_ref(obj)
            for value in obj.values():
                _walk_evidence_refs(value)

    _walk_evidence_refs(final_answer)

    # Normalize string items in call_chains and data_flows into evidenceRef objects
    for field in ("call_chains", "data_flows"):
        chains = final_answer.get(field)
        if isinstance(chains, list):
            normalized_chains: list[list] = []
            changed = False
            for chain in chains:
                if isinstance(chain, dict):
                    normalized_chains.append([chain])
                    changed = True
                elif isinstance(chain, list):
                    def _flatten(items: list) -> list:
                        result = []
                        for item in items:
                            if isinstance(item, list):
                                result.extend(_flatten(item))
                            else:
                                result.append(item)
                        return result
                    flat = _flatten(chain)
                    chain.clear()
                    chain.extend(flat)
                    for idx, item in enumerate(chain):
                        if isinstance(item, str):
                            chain[idx] = {"name": item, "reason": "data flow step"}
                    normalized_chains.append(chain)
                else:
                    normalized_chains.append(chain)
            if changed:
                final_answer[field] = normalized_chains

    evidence = agent_result.get("evidence")
    if isinstance(evidence, list):
        _walk_evidence_refs(evidence)

    # Strip unknown fields from tool_calls items
    tool_calls = agent_result.get("tool_calls")
    if isinstance(tool_calls, list):
        for tc in tool_calls:
            if isinstance(tc, dict):
                if "tool" not in tc and "name" in tc:
                    tc["tool"] = tc.pop("name")
                _strip_unknown_fields(tc, tool_call_fields)

    # Strip unknown fields from validation items
    validation = agent_result.get("validation")
    if isinstance(validation, list):
        for v in validation:
            if isinstance(v, dict):
                _strip_unknown_fields(v, validation_fields)

    # Fix and strip unknown fields from violations items
    violation_fields = {"type", "description"}
    violations = agent_result.get("violations")
    if isinstance(violations, list):
        for v in violations:
            if isinstance(v, dict):
                if "reason" in v and "description" not in v:
                    v["description"] = v.pop("reason")
                _strip_unknown_fields(v, violation_fields)

    # Fix validation items: normalize null exit_code to 0
    validation = agent_result.get("validation")
    if isinstance(validation, list):
        for v in validation:
            if isinstance(v, dict):
                if v.get("exit_code") is None:
                    v["exit_code"] = 0
                _strip_unknown_fields(v, validation_fields)

    # Strip unknown root-level fields
    _strip_unknown_fields(agent_result, root_fields)

    return agent_result


def apply_runner_metadata(agent_result: dict[str, Any], runner_result: dict[str, Any]) -> dict[str, Any]:
    manifest = runner_result.get("manifest")
    if isinstance(manifest, dict):
        run = manifest.get("run")
        if isinstance(run, dict):
            for key, target_key in (
                ("run_id", "run_id"),
                ("case_id", "case_id"),
                ("agent", "agent"),
                ("tool_policy", "tool_policy"),
                ("target_project", "target_repo"),
            ):
                if run.get(key):
                    agent_result[target_key] = run[key]
        if "policy_enforced" in manifest:
            agent_result["policy_enforced"] = bool(manifest["policy_enforced"])

    for key in ("started_at", "ended_at", "status"):
        if runner_result.get(key):
            agent_result[key] = runner_result[key]

    metrics = agent_result.setdefault("metrics", {})
    if isinstance(metrics, dict) and runner_result.get("elapsed_ms") is not None:
        metrics["elapsed_ms"] = int(runner_result["elapsed_ms"])

    return agent_result


def extract_agent_result(runner_result_path: Path, out_path: Path | None = None) -> dict[str, Any]:
    runner_result = load_json(runner_result_path)
    stdout_file = runner_result.get("stdout_file")
    if not stdout_file:
        raise ValueError(f"{runner_result_path} does not contain stdout_file")

    stdout_path = Path(str(stdout_file))
    raw = stdout_path.read_text(encoding="utf-8")
    parsed = parse_json_maybe(raw)
    if parsed is None:
        events = parse_jsonl_maybe(raw)
        parsed = unwrap_agent_jsonl_events(events) if events else None
    if parsed is None:
        raise ValueError(f"Could not parse JSON from {stdout_path}")

    agent_result = apply_runner_metadata(normalize_agent_result(unwrap_agent_json(parsed)), runner_result)
    shape_errors = validate_agent_result_shape(agent_result)
    if shape_errors:
        raise ValueError("Agent result does not match run-result schema shape:\n" + "\n".join(f"- {error}" for error in shape_errors))
    schema_path = VERSION_ROOT / "shared" / "schemas" / "run-result.schema.json"
    schema_errors = validate_agent_result_schema(agent_result, schema_path)
    if schema_errors:
        shown_errors = schema_errors[:20]
        suffix = "" if len(schema_errors) <= len(shown_errors) else f"\n... {len(schema_errors) - len(shown_errors)} more schema errors"
        raise ValueError(
            "Agent result does not match run-result schema:\n"
            + "\n".join(f"- {error}" for error in shown_errors)
            + suffix
        )
    if out_path is None:
        out_path = runner_result_path.parent / "agent-result.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(agent_result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return agent_result


def validate_run_artifacts(run_dir: Path) -> dict[str, Any]:
    """Validate a run directory's artifact completeness and consistency.

    Returns a dict with keys:
    - ``valid`` (bool): whether the artifacts pass minimal structural checks.
    - ``warnings`` (list[str]): non-fatal quality concerns.
    - ``errors`` (list[str]): fatal issues that should invalidate the run.
    """
    warnings: list[str] = []
    errors: list[str] = []

    runner_result_path = run_dir / "runner-result.json"
    if not runner_result_path.exists():
        errors.append(f"missing runner-result.json in {run_dir}")
        return {"valid": False, "warnings": warnings, "errors": errors}

    try:
        runner_result = load_json(runner_result_path)
    except Exception as exc:
        errors.append(f"runner-result.json unreadable: {exc}")
        return {"valid": False, "warnings": warnings, "errors": errors}

    # Check for stdout_file / stderr_file
    stdout_file = runner_result.get("stdout_file")
    if stdout_file and not Path(str(stdout_file)).exists():
        warnings.append(f"stdout_file referenced but missing: {stdout_file}")
    elif not stdout_file:
        warnings.append("runner-result.json missing stdout_file - likely in-process or hand-crafted")

    stderr_file = runner_result.get("stderr_file")
    if stderr_file and not Path(str(stderr_file)).exists():
        warnings.append(f"stderr_file referenced but missing: {stderr_file}")

    # Check manifest
    manifest = runner_result.get("manifest")
    if isinstance(manifest, dict):
        manifest_run = manifest.get("run")
        if isinstance(manifest_run, dict):
            for key in ("run_id", "agent", "tool_policy"):
                if key not in manifest_run:
                    warnings.append(f"manifest.run missing key: {key}")
        else:
            warnings.append("manifest.run is missing or not an object")
        if "command" not in manifest:
            warnings.append("manifest missing command")
        if "policy_enforced" not in manifest:
            warnings.append("manifest missing policy_enforced")
    else:
        warnings.append("runner-result.json missing manifest - likely hand-crafted")

    # execution_mode detection
    exec_mode = runner_result.get("execution_mode")
    if exec_mode == "in-process":
        warnings.append("execution_mode=in-process - not produced by standard CLI runner")

    # Check agent-result.json exists
    agent_result_path = run_dir / "agent-result.json"
    if not agent_result_path.exists():
        warnings.append("agent-result.json missing")
    else:
        try:
            agent_result = load_json(agent_result_path)
        except Exception:
            warnings.append("agent-result.json unreadable")
            agent_result = {}

        # Elapsed time consistency
        runner_elapsed = runner_result.get("elapsed_ms", 0)
        agent_metrics = agent_result.get("metrics", {})
        if isinstance(agent_metrics, dict):
            agent_elapsed = agent_metrics.get("elapsed_ms", 0)
            if runner_elapsed and agent_elapsed and abs(runner_elapsed - agent_elapsed) > 5000:
                warnings.append(
                    f"elapsed_ms mismatch: runner={runner_elapsed}, agent={agent_elapsed}"
                )

        # Tool policy compliance checks
        tool_policy = ""
        if isinstance(manifest, dict):
            manifest_run = manifest.get("run", {})
            if isinstance(manifest_run, dict):
                tool_policy = str(manifest_run.get("tool_policy", ""))
        if not tool_policy:
            tool_policy = str(agent_result.get("tool_policy", ""))

        tool_calls = agent_result.get("tool_calls", [])
        if not isinstance(tool_calls, list):
            tool_calls = []

        has_gitnexus_mcp = False
        has_gitnexus_cli = False
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            tool_name = str(tc.get("tool", "")).lower()
            input_summary = str(tc.get("input_summary", "")).lower()
            output_summary = str(tc.get("output_summary", "")).lower()
            purpose = str(tc.get("purpose", "")).lower()
            combined = f"{tool_name} {input_summary} {output_summary} {purpose}"

            # Three-tier detection:
            # 1. Direct MCP: tool name contains mcp__gitnexus
            # 2. Normalized benchmark name: tool name starts with gitnexus_
            # 3. CLI wrapper: Bash/Shell with gitnexus in description
            if "mcp__gitnexus" in tool_name or tool_name.startswith("gitnexus_"):
                has_gitnexus_mcp = True
            elif "gitnexus" in combined and tool_name in ("bash", "shell"):
                has_gitnexus_cli = True

        if tool_policy == "grep" and (has_gitnexus_mcp or has_gitnexus_cli):
            errors.append("grep policy violated: GitNexus tool call detected")
        if tool_policy == "graph" and not has_gitnexus_mcp:
            if has_gitnexus_cli:
                warnings.append("graph via CLI (not direct MCP) - Bash wrapping gitnexus commands")
            else:
                warnings.append("graph policy but no gitnexus_* tool calls found in agent-result")

    # Check score.json exists
    score_path = run_dir / "score.json"
    if not score_path.exists():
        warnings.append("score.json missing")

    valid = len(errors) == 0
    return {"valid": valid, "warnings": warnings, "errors": errors}


def command_validate(args: argparse.Namespace) -> int:
    errors = validate_plan(Path(args.plan))
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print(f"OK: {args.plan}")
    return 0


def command_plan(args: argparse.Namespace) -> int:
    expanded = expand_run_plan(Path(args.plan))
    output = json.dumps(expanded, ensure_ascii=False, indent=2)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output + "\n", encoding="utf-8")
        print(f"Wrote {expanded['run_count']} runs to {out_path}")
    else:
        print(output)
    return 0


def command_prompt(args: argparse.Namespace) -> int:
    expanded = expand_run_plan(Path(args.plan))
    run = find_run(expanded, args.run_id)
    print(build_prompt(Path(args.plan), run))
    return 0


def command_prepare_run(args: argparse.Namespace) -> int:
    manifest = write_run_scaffold(
        Path(args.plan),
        args.run_id,
        Path(args.out_dir),
        model=args.model,
        mcp_config=args.mcp_config,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


def command_execute(args: argparse.Namespace) -> int:
    result = execute_run(
        Path(args.plan),
        args.run_id,
        Path(args.out_dir),
        dry_run=args.dry_run,
        model=args.model,
        mcp_config=args.mcp_config,
        timeout_seconds=args.timeout_seconds,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] in {"passed", "dry-run"} else 1


def parse_optional_set(values: list[str] | None) -> set[str] | None:
    if not values:
        return None
    return set(values)


def command_execute_matrix(args: argparse.Namespace) -> int:
    summary = execute_matrix(
        Path(args.plan),
        Path(args.out_dir),
        dry_run=args.dry_run,
        agents=parse_optional_set(args.agent),
        tool_policies=parse_optional_set(args.tool_policy),
        case_ids=parse_optional_set(args.case_id),
        max_runs=args.max_runs,
        offset=args.offset,
        model=args.model,
        mcp_config=args.mcp_config,
        timeout_seconds=args.timeout_seconds,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if set(summary["status_counts"]).issubset({"passed", "dry-run"}) else 1


def command_score(args: argparse.Namespace) -> int:
    score = score_run_result(Path(args.run_result), Path(args.golden))
    output = json.dumps(score, ensure_ascii=False, indent=2)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output + "\n", encoding="utf-8")
        print(f"Wrote score to {out_path}")
    else:
        print(output)
    return 0


def command_report(args: argparse.Namespace) -> int:
    report = aggregate_scores(Path(args.scores_dir))
    output = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output + "\n", encoding="utf-8")
        print(f"Wrote report to {out_path}")
    else:
        print(output)
    return 0


def command_validate_artifacts(args: argparse.Namespace) -> int:
    result = validate_run_artifacts(Path(args.run_dir))
    output = json.dumps(result, ensure_ascii=False, indent=2)
    print(output)
    return 0 if result["valid"] else 1


def command_extract_result(args: argparse.Namespace) -> int:
    result = extract_agent_result(Path(args.runner_result), Path(args.out) if args.out else None)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Plan AI coding benchmark runs.")
    subparsers = parser.add_subparsers(required=True)

    validate = subparsers.add_parser("validate", help="Validate a benchmark evaluation plan.")
    validate.add_argument("--plan", required=True, help="Path to telecom-evaluation-plan.yaml.")
    validate.set_defaults(func=command_validate)

    plan = subparsers.add_parser("plan", help="Expand the run matrix into JSON.")
    plan.add_argument("--plan", required=True, help="Path to telecom-evaluation-plan.yaml.")
    plan.add_argument("--out", help="Optional output JSON file.")
    plan.set_defaults(func=command_plan)

    prompt = subparsers.add_parser("prompt", help="Render the agent prompt for one run.")
    prompt.add_argument("--plan", required=True, help="Path to telecom-evaluation-plan.yaml.")
    prompt.add_argument("--run-id", required=True, help="Run id produced by the plan command.")
    prompt.set_defaults(func=command_prompt)

    prepare = subparsers.add_parser("prepare-run", help="Create prompt and manifest files for one run.")
    prepare.add_argument("--plan", required=True, help="Path to telecom-evaluation-plan.yaml.")
    prepare.add_argument("--run-id", required=True, help="Run id produced by the plan command.")
    prepare.add_argument("--out-dir", required=True, help="Directory where run artifacts are written.")
    prepare.add_argument("--model", help="Optional fixed model name for Claude Code.")
    prepare.add_argument("--mcp-config", help="Optional Claude MCP config for graph-policy runs.")
    prepare.set_defaults(func=command_prepare_run)

    execute = subparsers.add_parser("execute", help="Execute or dry-run one benchmark run.")
    execute.add_argument("--plan", required=True, help="Path to telecom-evaluation-plan.yaml.")
    execute.add_argument("--run-id", required=True, help="Run id produced by the plan command.")
    execute.add_argument("--out-dir", required=True, help="Directory where run artifacts are written.")
    execute.add_argument("--model", help="Optional fixed model name for Claude Code.")
    execute.add_argument("--mcp-config", help="Optional Claude MCP config for graph-policy runs.")
    execute.add_argument("--dry-run", action="store_true", help="Write prompt/manifest without invoking the agent.")
    execute.add_argument("--timeout-seconds", type=int, default=1800)
    execute.set_defaults(func=command_execute)

    execute_matrix_parser = subparsers.add_parser("execute-matrix", help="Execute or dry-run multiple benchmark runs.")
    execute_matrix_parser.add_argument("--plan", required=True, help="Path to telecom-evaluation-plan.yaml.")
    execute_matrix_parser.add_argument("--out-dir", required=True, help="Directory where run artifacts are written.")
    execute_matrix_parser.add_argument("--agent", action="append", help="Filter to one or more agents.")
    execute_matrix_parser.add_argument("--tool-policy", action="append", help="Filter to one or more tool policies.")
    execute_matrix_parser.add_argument("--case-id", action="append", help="Filter to one or more case ids.")
    execute_matrix_parser.add_argument("--max-runs", type=int, help="Limit number of selected runs.")
    execute_matrix_parser.add_argument("--offset", type=int, default=None, help="Skip first N selected runs (for batch execution).")
    execute_matrix_parser.add_argument("--model", help="Optional fixed model name for Claude Code.")
    execute_matrix_parser.add_argument("--mcp-config", help="Optional Claude MCP config for graph-policy runs.")
    execute_matrix_parser.add_argument("--dry-run", action="store_true", help="Write prompts/manifests without invoking agents.")
    execute_matrix_parser.add_argument("--timeout-seconds", type=int, default=1800)
    execute_matrix_parser.set_defaults(func=command_execute_matrix)

    score = subparsers.add_parser("score", help="Pre-score one run result against a golden YAML file.")
    score.add_argument("--run-result", required=True, help="Path to a run-result JSON file.")
    score.add_argument("--golden", required=True, help="Path to a golden-answer YAML file.")
    score.add_argument("--out", help="Optional output score JSON path.")
    score.set_defaults(func=command_score)

    extract = subparsers.add_parser("extract-result", help="Extract agent-result JSON from a runner-result stdout file.")
    extract.add_argument("--runner-result", required=True, help="Path to runner-result.json.")
    extract.add_argument("--out", help="Optional output agent-result JSON path.")
    extract.set_defaults(func=command_extract_result)

    report = subparsers.add_parser("report", help="Aggregate score JSON files into an agent/policy report.")
    report.add_argument("--scores-dir", required=True, help="Directory or file containing score JSON files.")
    report.add_argument("--out", help="Optional output report JSON path.")
    report.set_defaults(func=command_report)

    validate_artifacts = subparsers.add_parser("validate-artifacts", help="Validate a run directory for benchmark artifact quality.")
    validate_artifacts.add_argument("--run-dir", required=True, help="Path to a run directory containing runner-result.json and agent-result.json.")
    validate_artifacts.set_defaults(func=command_validate_artifacts)

    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
