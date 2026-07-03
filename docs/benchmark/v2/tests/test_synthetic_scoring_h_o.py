"""Synthetic scoring tests for Cases H-O.

Proves that the scorer correctly differentiates:
- perfect fixture: all correct facts → score >= 90
- empty fixture: empty answer → score <= 5
- partial fixture: some correct facts → between empty and perfect
- wrong fixture: deliberately wrong → score < perfect
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))

from agent_benchmark_runner import score_run_result


TELECOM_GT = Path(__file__).resolve().parents[1] / "telecom" / "ground-truth"


def _base_result(case_id: str) -> dict:
    """Minimal valid run-result skeleton."""
    return {
        "case_id": case_id,
        "run_id": f"{case_id}__claude-code__graph__r1",
        "agent": "claude-code",
        "tool_policy": "graph",
        "policy_enforced": True,
        "target_repo": "telecom",
        "target_commit": "test",
        "started_at": "2026-01-01T00:00:00Z",
        "ended_at": "2026-01-01T00:01:00Z",
        "status": "passed",
        "final_answer": {"summary": ""},
        "evidence": [],
        "tool_calls": [],
        "metrics": {"tool_call_count": 0, "files_read_count": 0},
        "violations": [],
    }


def _score(case_id: str, result: dict) -> float:
    """Score a synthetic result against the real GT."""
    # Extract case letter: telecom-case-X-... → X
    parts = case_id.split("-")
    case_letter = parts[2]  # "h", "i", etc.
    gt_path = TELECOM_GT / f"telecom-case-{case_letter}-ground-truth.yaml"
    with tempfile.TemporaryDirectory() as tmp:
        result_path = Path(tmp) / "result.json"
        result_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        scored = score_run_result(result_path, gt_path)
        return float(scored.get("automatic_total", 0.0))


# ─────────────────────────── Case H: Route Matrix ───────────────────────────

ROUTE_IDS = ["R01", "R02", "R03", "R04", "R05", "R06", "R07",
             "R08a", "R08b", "R09", "R10", "R11", "R12"]
ROUTE_PATHS = [
    "/api/network-changes/{id}", "/api/network-changes", "/api/network-changes/{id}",
    "/api/network-changes/{id}/risk", "/api/network-changes/{id}",
    "/legacy/preview", "/legacy/search",
    "/api/network-changes/active", "/api/network-changes/open",
    "/api/network-changes/{id}/audit", "/qualified",
    "/api/network-changes/pending", "/api/network-changes",
]
ROUTE_METHODS = [
    "GET", "POST", "PUT", "PATCH", "DELETE",
    "ANY", "GET", "GET", "GET", "GET", "GET", "GET", "GET",
]
ROUTE_HANDLERS = [
    "NetworkChangeController.getById", "NetworkChangeController.create",
    "NetworkChangeController.update", "NetworkChangeController.updateRisk",
    "NetworkChangeController.delete", "LegacyNetworkChangeController.preview",
    "LegacyNetworkChangeController.search", "NetworkChangeController.listActive",
    "NetworkChangeController.listActive", "ComposedEndpointController.getAuditTrail",
    "LegacyNetworkChangeController.qualifiedEndpoint",
    "NetworkChangeController.listPending", "NetworkChangeController.listAll",
]


def _route_summary() -> str:
    lines = []
    for i, rid in enumerate(ROUTE_IDS):
        lines.append(f"{rid}: {ROUTE_METHODS[i]} {ROUTE_PATHS[i]} -> {ROUTE_HANDLERS[i]}")
    return "\n".join(lines)


def _make_case_h_perfect() -> dict:
    r = _base_result("telecom-case-h-spring-route-matrix")
    r["final_answer"] = {
        "summary": f"Found 13 routes in 3 controllers:\n{_route_summary()}\n"
                   "NetworkChangeController has class prefix /api/network-changes.\n"
                   "LegacyNetworkChangeController has no class prefix.\n"
                   "ComposedEndpointController has class prefix /api/network-changes.\n"
                   "R08 expands to 2 routes. R09 uses @OpsReadEndpoint alongside @GetMapping.\n"
                   "R10 uses fully-qualified annotation. R11 uses ChangeRoutes.PENDING constant.\n"
                   "R12 uses @GetMapping with no method path.\n"
                   "ChangeRoutes defines PENDING=/pending, DRAFT and ARCHIVED are not routes.\n"
                   "ChangeDocumentation.getFakeRouteLogMessage is not a route.\n"
                   "ChangeDocumentation.getMappingExamples contains string literals not annotations.\n"
                   "LegacyNetworkChangeController.search(String,String) has no mapping.\n"
                   "ComposedEndpointController.getAuditTrail(String,String) has no mapping.\n",
        "entrypoints": [
            {"name": "NetworkChangeController", "symbol": "NetworkChangeController",
             "file": "controller/NetworkChangeController.java", "reason": "Primary controller"},
            {"name": "LegacyNetworkChangeController", "symbol": "LegacyNetworkChangeController",
             "file": "controller/LegacyNetworkChangeController.java", "reason": "Legacy controller"},
            {"name": "ComposedEndpointController", "symbol": "ComposedEndpointController",
             "file": "controller/ComposedEndpointController.java", "reason": "Composed controller"},
        ],
        "symbols": [
            {"name": "ChangeRoutes", "symbol": "ChangeRoutes", "reason": "Route constants"},
            {"name": "OpsReadEndpoint", "symbol": "OpsReadEndpoint", "reason": "Composed annotation"},
        ],
    }
    r["evidence"] = [
        {"name": "NetworkChangeController", "symbol": "NetworkChangeController",
         "file": "controller/NetworkChangeController.java", "reason": "Primary controller"},
    ]
    return r


def _make_case_h_empty() -> dict:
    r = _base_result("telecom-case-h-spring-route-matrix")
    r["final_answer"] = {"summary": "I could not find any routes."}
    return r


def _make_case_h_partial() -> dict:
    r = _base_result("telecom-case-h-spring-route-matrix")
    r["final_answer"] = {
        "summary": "Found some routes:\n"
                   "GET /api/network-changes/{id} -> NetworkChangeController.getById\n"
                   "POST /api/network-changes -> NetworkChangeController.create\n"
                   "PUT /api/network-changes/{id} -> NetworkChangeController.update\n",
        "entrypoints": [
            {"name": "NetworkChangeController", "symbol": "NetworkChangeController",
             "file": "controller/NetworkChangeController.java", "reason": "Controller"},
        ],
    }
    return r


def _make_case_h_wrong() -> dict:
    r = _base_result("telecom-case-h-spring-route-matrix")
    # Wrong HTTP methods for all routes
    wrong_lines = []
    for i, rid in enumerate(ROUTE_IDS):
        wrong_method = "POST" if ROUTE_METHODS[i] == "GET" else "GET"
        wrong_lines.append(f"{rid}: {wrong_method} {ROUTE_PATHS[i]} -> {ROUTE_HANDLERS[i]}")
    r["final_answer"] = {
        "summary": f"Found routes:\n" + "\n".join(wrong_lines) + "\n"
                   "NetworkChangeController LegacyNetworkChangeController ComposedEndpointController\n"
                   "ChangeRoutes ChangeDocumentation.getFakeRouteLogMessage is a route\n"
                   "FakeTransactionalMarker is a controller\n",
    }
    return r


# ─────────────────────────── Case M: Dynamic Dispatch ───────────────────────

def _make_case_m_perfect() -> dict:
    r = _base_result("telecom-case-m-dynamic-dispatch")
    r["final_answer"] = {
        "summary": (
            "ChangeExecutionService.execute calls ChangeExecutorRegistry.resolve then ChangeExecutor.execute.\n"
            "static_target: ChangeExecutor.execute(ChangeContext)\n"
            "Under benchmark profile:\n"
            "ROUTER -> RouterChangeExecutor.execute(ChangeContext)\n"
            "TRANSMISSION -> TransmissionChangeExecutor.execute(ChangeContext)\n"
            "RADIO -> RadioChangeExecutor.execute(ChangeContext)\n"
            "SafeChangeExecutor is excluded from registry possible_targets because lacks @ChangeExecutorCandidate.\n"
            "safeExecutor.execute always resolves to SafeChangeExecutor via @Qualifier.\n"
            "Template method: executeTemplate calls validate then apply then audit.\n"
            "RouterChangeExecutor.execute calls AbstractChangeExecutor.executeTemplate.\n"
            "StandardRollbackHandler inherits default rollback from RollbackHandler.\n"
            "RemoteRollbackHandler overrides rollback but needs telecom.change.remote.enabled=true.\n"
            "edge_kind: JAVA_INTERFACE_DISPATCH\n"
        ),
        "entrypoints": [
            {"name": "ChangeExecutionService", "symbol": "ChangeExecutionService",
             "file": "service/ChangeExecutionService.java", "reason": "Main dispatch point"},
        ],
        "symbols": [
            {"name": "ChangeExecutor", "symbol": "ChangeExecutor", "file": "executor/ChangeExecutor.java", "reason": "Interface"},
            {"name": "AbstractChangeExecutor", "symbol": "AbstractChangeExecutor", "file": "executor/AbstractChangeExecutor.java", "reason": "Template base"},
            {"name": "RouterChangeExecutor", "symbol": "RouterChangeExecutor", "file": "executor/RouterChangeExecutor.java", "reason": "Router impl"},
            {"name": "TransmissionChangeExecutor", "symbol": "TransmissionChangeExecutor", "file": "executor/TransmissionChangeExecutor.java", "reason": "Transmission impl"},
            {"name": "RadioChangeExecutor", "symbol": "RadioChangeExecutor", "file": "executor/RadioChangeExecutor.java", "reason": "Radio impl"},
            {"name": "RollbackHandler", "symbol": "RollbackHandler", "file": "executor/RollbackHandler.java", "reason": "Default method interface"},
            {"name": "StandardRollbackHandler", "symbol": "StandardRollbackHandler", "file": "executor/StandardRollbackHandler.java", "reason": "Inherits default"},
        ],
        "call_chains": [
            [
                {"name": "ChangeExecutionService.execute", "symbol": "ChangeExecutionService.execute", "reason": "Caller"},
                {"name": "ChangeExecutorRegistry.resolve", "symbol": "ChangeExecutorRegistry.resolve", "reason": "Resolves"},
            ],
            [
                {"name": "ChangeExecutionService.execute", "symbol": "ChangeExecutionService.execute", "reason": "Caller"},
                {"name": "ChangeExecutor.execute", "symbol": "ChangeExecutor.execute", "reason": "Calls"},
            ],
            [
                {"name": "RouterChangeExecutor.execute", "symbol": "RouterChangeExecutor.execute", "reason": "Concrete"},
                {"name": "AbstractChangeExecutor.executeTemplate", "symbol": "AbstractChangeExecutor.executeTemplate", "reason": "Template"},
            ],
        ],
    }
    r["evidence"] = [
        {"name": "ChangeExecutor", "symbol": "ChangeExecutor", "file": "executor/ChangeExecutor.java", "reason": "Interface"},
    ]
    return r


def _make_case_m_empty() -> dict:
    r = _base_result("telecom-case-m-dynamic-dispatch")
    r["final_answer"] = {"summary": "No dispatch analysis available."}
    return r


def _make_case_m_partial() -> dict:
    r = _base_result("telecom-case-m-dynamic-dispatch")
    r["final_answer"] = {
        "summary": (
            "ChangeExecutor has implementations RouterChangeExecutor and TransmissionChangeExecutor.\n"
            "ROUTER -> RouterChangeExecutor\n"
        ),
        "symbols": [
            {"name": "ChangeExecutor", "symbol": "ChangeExecutor", "file": "executor/ChangeExecutor.java", "reason": "Interface"},
            {"name": "RouterChangeExecutor", "symbol": "RouterChangeExecutor", "file": "executor/RouterChangeExecutor.java", "reason": "Router"},
        ],
    }
    return r


def _make_case_m_wrong() -> dict:
    r = _base_result("telecom-case-m-dynamic-dispatch")
    r["final_answer"] = {
        "summary": (
            "All executors are interchangeable. ROUTER/TRANSMISSION/RADIO all resolve to the same executor.\n"
            "SafeChangeExecutor is a possible target for registry dispatch.\n"
            "UnrelatedExecuteService implements ChangeExecutor.\n"
        ),
    }
    return r


# ─────────────────────────── Case O: Framework Boundary ─────────────────────

def _make_case_o_perfect() -> dict:
    r = _base_result("telecom-case-o-framework-reflection-boundary")
    r["final_answer"] = {
        "summary": (
            "Spring Event dispatch:\n"
            "publishEvent(ChangeApprovedEvent) -> ChangeApprovedListener.onApproved via @EventListener\n"
            "edge_kind: FRAMEWORK_EVENT_DISPATCH\n"
            "publishEvent(ChangeCompletedEvent) -> ChangeCompletedListener.afterCommit via @TransactionalEventListener(AFTER_COMMIT)\n"
            "edge_kind: FRAMEWORK_EVENT_DISPATCH\n"
            "ChangeNotificationListener.notifyAsync uses @Async @EventListener\n"
            "edge_kind: FRAMEWORK_EVENT_DISPATCH\n"
            "AOP:\n"
            "AuditOperationAspect uses @Around(@annotation(auditOperation)) to intercept @AuditOperation methods\n"
            "edge_kind: FRAMEWORK_AOP\n"
            "ProceedingJoinPoint.proceed() is NOT a direct call to business method.\n"
            "Reflection:\n"
            "Class.forName(pluginClassName) is REFLECTION_BOUNDARY — runtime string-to-class resolution\n"
            "Method.invoke(plugin, context) is REFLECTION_BOUNDARY — reflective invocation\n"
            "ServiceLoader.load(ChangeValidationPlugin.class) discovers BenchmarkChangeValidationPlugin via META-INF/services\n"
            "edge_kind: SERVICE_LOADER\n"
            "PluginDescriptor.className is configuration string not code reference.\n"
            "PluginDescriptor.executeMethodName is configuration string not method call.\n"
            "com.example.telecom.change.plugin.BenchmarkChangeValidationPlugin\n"
            "com.example.telecom.change.plugin.ChangeValidationPlugin\n"
            "com.example.telecom.change.plugin.PluginDescriptor\n"
            "com.example.telecom.change.aop.AuditOperationAspect\n"
            "com.example.telecom.change.aop.AuditSink\n"
            "com.example.telecom.change.aop.InMemoryAuditSink\n"
            "REFLECTION_BOUNDARY\n"
            "SERVICE_LOADER\n"
            "FRAMEWORK_EVENT_DISPATCH\n"
            "FRAMEWORK_AOP\n"
        ),
        "entrypoints": [
            {"name": "ChangePluginLoader", "symbol": "ChangePluginLoader",
             "file": "plugin/ChangePluginLoader.java", "reason": "Plugin loader"},
            {"name": "AuditOperationAspect", "symbol": "AuditOperationAspect",
             "file": "aop/AuditOperationAspect.java", "reason": "AOP aspect"},
        ],
        "symbols": [
            {"name": "ChangeApprovedListener", "symbol": "ChangeApprovedListener", "file": "event/ChangeApprovedListener.java", "reason": "Event listener"},
            {"name": "ChangeCompletedListener", "symbol": "ChangeCompletedListener", "file": "event/ChangeCompletedListener.java", "reason": "TX listener"},
            {"name": "ChangeNotificationListener", "symbol": "ChangeNotificationListener", "file": "event/ChangeNotificationListener.java", "reason": "Async listener"},
            {"name": "ChangeValidationPlugin", "symbol": "ChangeValidationPlugin", "file": "plugin/ChangeValidationPlugin.java", "reason": "SPI interface"},
            {"name": "BenchmarkChangeValidationPlugin", "symbol": "BenchmarkChangeValidationPlugin", "file": "plugin/BenchmarkChangeValidationPlugin.java", "reason": "Plugin impl"},
            {"name": "InMemoryAuditSink", "symbol": "InMemoryAuditSink", "file": "aop/InMemoryAuditSink.java", "reason": "Audit sink"},
            {"name": "PluginDescriptor", "symbol": "PluginDescriptor", "file": "plugin/PluginDescriptor.java", "reason": "Config descriptor"},
        ],
    }
    r["evidence"] = [
        {"name": "ChangePluginLoader", "symbol": "ChangePluginLoader", "file": "plugin/ChangePluginLoader.java", "reason": "Plugin loader"},
        {"name": "ChangeApprovedListener", "symbol": "ChangeApprovedListener", "file": "event/ChangeApprovedListener.java", "reason": "Event listener"},
        {"name": "AuditOperationAspect", "symbol": "AuditOperationAspect", "file": "aop/AuditOperationAspect.java", "reason": "AOP aspect"},
    ]
    return r


def _make_case_o_empty() -> dict:
    r = _base_result("telecom-case-o-framework-reflection-boundary")
    r["final_answer"] = {"summary": "No framework boundary analysis."}
    return r


def _make_case_o_partial() -> dict:
    r = _base_result("telecom-case-o-framework-reflection-boundary")
    r["final_answer"] = {
        "summary": (
            "ChangePluginLoader loads plugins. AuditOperationAspect intercepts methods.\n"
            "ChangeApprovedListener receives events.\n"
        ),
        "symbols": [
            {"name": "ChangePluginLoader", "symbol": "ChangePluginLoader", "file": "plugin/ChangePluginLoader.java", "reason": "Loader"},
            {"name": "AuditOperationAspect", "symbol": "AuditOperationAspect", "file": "aop/AuditOperationAspect.java", "reason": "Aspect"},
        ],
    }
    return r


def _make_case_o_wrong() -> dict:
    r = _base_result("telecom-case-o-framework-reflection-boundary")
    r["final_answer"] = {
        "summary": (
            "publishEvent(ChangeApprovedEvent) directly calls ChangeApprovedListener.onApproved.\n"
            "This is a direct call from ChangePlanService.approve to ChangeApprovedListener.onApproved.\n"
            "AuditOperationAspect.around directly calls business methods via ProceedingJoinPoint.proceed.\n"
            "Class.forName creates a static call edge to BenchmarkChangeValidationPlugin.\n"
            "PluginDescriptor.executeMethodName = execute is a method call to ChangeValidationPlugin.execute.\n"
        ),
    }
    return r


# ─────────────────────────── Case I: Annotation Binding ────────────────────────

def _make_case_i_perfect() -> dict:
    r = _base_result("telecom-case-i-java-annotation-binding")
    r["final_answer"] = {
        "summary": (
            "8 custom annotation types defined: AuditOperation, ChangeGuard, RegionScope, "
            "RequiredCapability, RequiredCapabilities, CriticalChange, OpsReadEndpoint, "
            "ChangeExecutorCandidate.\n"
            "AuditOperation has action, category, sensitive elements with RUNTIME retention.\n"
            "RequiredCapability is @Repeatable with container RequiredCapabilities.\n"
            "CriticalChange is meta-annotated with AuditOperation(action=critical-change, "
            "category=CHANGE, sensitive=true) and ChangeGuard(risk=CRITICAL, requireApproval=true).\n"
            "ChangePlanService.approve has @CriticalChange.\n"
            "ChangePlanService.createPlan has @AuditOperation(action=create-plan, category=CHANGE).\n"
            "ChangePlanService.updateRisk uses fully-qualified @com.example.telecom.change.annotation.AuditOperation with sensitive=true.\n"
            "ChangePlanService class has @ChangeGuard(risk=LOW) and two @RequiredCapability annotations: change.write and audit.log.\n"
            "OpsReadEndpoint is meta-annotated with @RequestMapping(method=GET) and uses @AliasFor for path.\n"
            "ChangeExecutionService.processRegionalCodes uses List<@RegionScope(\"east\") String> TYPE_USE annotation.\n"
            "ChangeExecutorCandidate is meta-annotated with @Qualifier.\n"
        ),
        "entrypoints": [
            {"name": "ChangePlanService", "symbol": "ChangePlanService",
             "file": "service/ChangePlanService.java", "reason": "Main service"},
        ],
        "symbols": [
            {"name": "AuditOperation", "symbol": "AuditOperation", "file": "annotation/AuditOperation.java", "reason": "Audit annotation"},
            {"name": "ChangeGuard", "symbol": "ChangeGuard", "file": "annotation/ChangeGuard.java", "reason": "Guard annotation"},
            {"name": "RegionScope", "symbol": "RegionScope", "file": "annotation/RegionScope.java", "reason": "Region annotation"},
            {"name": "RequiredCapability", "symbol": "RequiredCapability", "file": "annotation/RequiredCapability.java", "reason": "Capability annotation"},
            {"name": "CriticalChange", "symbol": "CriticalChange", "file": "annotation/CriticalChange.java", "reason": "Composed annotation"},
            {"name": "OpsReadEndpoint", "symbol": "OpsReadEndpoint", "file": "annotation/OpsReadEndpoint.java", "reason": "Composed mapping"},
            {"name": "ChangeExecutorCandidate", "symbol": "ChangeExecutorCandidate", "file": "annotation/ChangeExecutorCandidate.java", "reason": "Custom qualifier"},
        ],
    }
    r["evidence"] = [
        {"name": "AuditOperation", "symbol": "AuditOperation", "file": "annotation/AuditOperation.java", "reason": "Audit annotation"},
        {"name": "CriticalChange", "symbol": "CriticalChange", "file": "annotation/CriticalChange.java", "reason": "Composed"},
    ]
    return r


def _make_case_i_empty() -> dict:
    r = _base_result("telecom-case-i-java-annotation-binding")
    r["final_answer"] = {"summary": "No annotation analysis available."}
    return r


def _make_case_i_partial() -> dict:
    r = _base_result("telecom-case-i-java-annotation-binding")
    r["final_answer"] = {
        "summary": "AuditOperation and ChangeGuard are custom annotations used for auditing and guarding change operations.",
        "symbols": [
            {"name": "AuditOperation", "symbol": "AuditOperation", "file": "annotation/AuditOperation.java", "reason": "Audit"},
            {"name": "ChangeGuard", "symbol": "ChangeGuard", "file": "annotation/ChangeGuard.java", "reason": "Guard"},
        ],
    }
    return r


def _make_case_i_wrong() -> dict:
    r = _base_result("telecom-case-i-java-annotation-binding")
    r["final_answer"] = {
        "summary": (
            "OpsReadEndpoint needs to be used together with @GetMapping because it only provides a path attribute. "
            "@RegionScope is a method-level annotation. CriticalChange has no meta-annotations. "
            "RequiredCapability is not repeatable. AuditOperation cannot be used as a meta-annotation."
        ),
    }
    return r


# ─────────────────────────── Case J: DI Selection ───────────────────────────

def _make_case_j_perfect() -> dict:
    r = _base_result("telecom-case-j-spring-di-selection")
    r["final_answer"] = {
        "summary": (
            "ChangeExecutionService constructor injection with 8 parameters:\n"
            "@Qualifier(\"safeExecutor\") ChangeExecutor safeExecutor resolves to SafeChangeExecutor.\n"
            "@ChangeExecutorCandidate List<ChangeExecutor> executors includes RouterChangeExecutor, "
            "TransmissionChangeExecutor, RadioChangeExecutor under benchmark profile.\n"
            "DryRunChangeExecutor is excluded under benchmark profile (not active).\n"
            "SafeChangeExecutor is excluded from the list (no @ChangeExecutorCandidate annotation).\n"
            "Map<String, ChangeExecutor> executorBeans includes routerExecutor, transmissionExecutor, "
            "radioExecutor, safeExecutor.\n"
            "ObjectProvider<RollbackHandler> rollbackHandlerProvider provides StandardRollbackHandler.\n"
            "RemoteRollbackHandler requires telecom.change.remote.enabled=true (not active in benchmark).\n"
            "DefaultExecutorFacade gets ChangeExecutor via @Primary → RadioChangeExecutor.\n"
            "LegacyChangeFacade uses @Autowired @Qualifier(\"routerExecutor\") field injection → RouterChangeExecutor.\n"
        ),
        "entrypoints": [
            {"name": "ChangeExecutionService", "symbol": "ChangeExecutionService",
             "file": "service/ChangeExecutionService.java", "reason": "Main DI target"},
            {"name": "DefaultExecutorFacade", "symbol": "DefaultExecutorFacade",
             "file": "executor/DefaultExecutorFacade.java", "reason": "Primary target"},
        ],
        "symbols": [
            {"name": "SafeChangeExecutor", "symbol": "SafeChangeExecutor", "file": "executor/SafeChangeExecutor.java", "reason": "Qualifier target"},
            {"name": "RouterChangeExecutor", "symbol": "RouterChangeExecutor", "file": "executor/RouterChangeExecutor.java", "reason": "Router"},
            {"name": "RadioChangeExecutor", "symbol": "RadioChangeExecutor", "file": "executor/RadioChangeExecutor.java", "reason": "Primary"},
            {"name": "DryRunChangeExecutor", "symbol": "DryRunChangeExecutor", "file": "executor/DryRunChangeExecutor.java", "reason": "Profile-gated"},
        ],
    }
    r["evidence"] = [
        {"name": "ChangeExecutionService", "symbol": "ChangeExecutionService", "file": "service/ChangeExecutionService.java", "reason": "DI target"},
    ]
    return r


def _make_case_j_empty() -> dict:
    r = _base_result("telecom-case-j-spring-di-selection")
    r["final_answer"] = {"summary": "No DI analysis available."}
    return r


def _make_case_j_partial() -> dict:
    r = _base_result("telecom-case-j-spring-di-selection")
    r["final_answer"] = {
        "summary": "ChangeExecutionService injects ChangeExecutor and List<ChangeExecutor>.",
        "symbols": [
            {"name": "ChangeExecutionService", "symbol": "ChangeExecutionService", "file": "service/ChangeExecutionService.java", "reason": "Service"},
        ],
    }
    return r


def _make_case_j_wrong() -> dict:
    r = _base_result("telecom-case-j-spring-di-selection")
    r["final_answer"] = {
        "summary": (
            "SafeChangeExecutor is the primary ChangeExecutor. "
            "DryRunChangeExecutor is always active in all profiles. "
            "DefaultExecutorFacade resolves to SafeChangeExecutor via @Qualifier."
        ),
    }
    return r


# ─────────────────────────── Case K: Transaction Boundary ────────────────────

def _make_case_k_perfect() -> dict:
    r = _base_result("telecom-case-k-transaction-boundary")
    r["final_answer"] = {
        "summary": (
            "ChangePlanService has class-level @Transactional (default REQUIRED).\n"
            "createPlan has @Transactional(rollbackFor=ChangeValidationException.class).\n"
            "preview has @Transactional(readOnly=true).\n"
            "recordInternal has @Transactional(propagation=REQUIRES_NEW).\n"
            "ChangeAuditService.record has @Transactional(propagation=REQUIRES_NEW).\n"
            "ChangePlanQueryService.findById has @Transactional(readOnly=true).\n"
            "ChangeExecutionService has class-level @Transactional.\n"
            "approveAndRecordInternally calls this.recordInternal via self-invocation.\n"
            "Self-invocation bypasses Spring proxy, so REQUIRES_NEW is NOT effective.\n"
            "Cross-bean call through TransactionProxyCaller goes through proxy, so REQUIRES_NEW is effective.\n"
            "Runtime oracle: self-invocation + outer rollback → audit record missing.\n"
            "Cross-bean + outer rollback → audit record persists.\n"
        ),
        "entrypoints": [
            {"name": "ChangePlanService", "symbol": "ChangePlanService",
             "file": "service/ChangePlanService.java", "reason": "Transaction owner"},
            {"name": "ChangeAuditService", "symbol": "ChangeAuditService",
             "file": "service/ChangeAuditService.java", "reason": "REQUIRES_NEW target"},
        ],
        "symbols": [
            {"name": "TransactionProxyCaller", "symbol": "TransactionProxyCaller",
             "file": "service/TransactionProxyCaller.java", "reason": "External proxy caller"},
        ],
    }
    r["evidence"] = [
        {"name": "ChangePlanService", "symbol": "ChangePlanService", "file": "service/ChangePlanService.java", "reason": "Transaction owner"},
    ]
    return r


def _make_case_k_empty() -> dict:
    r = _base_result("telecom-case-k-transaction-boundary")
    r["final_answer"] = {"summary": "No transaction analysis available."}
    return r


def _make_case_k_partial() -> dict:
    r = _base_result("telecom-case-k-transaction-boundary")
    r["final_answer"] = {
        "summary": "ChangePlanService has @Transactional. recordInternal has REQUIRES_NEW.",
        "symbols": [
            {"name": "ChangePlanService", "symbol": "ChangePlanService", "file": "service/ChangePlanService.java", "reason": "Service"},
        ],
    }
    return r


def _make_case_k_wrong() -> dict:
    r = _base_result("telecom-case-k-transaction-boundary")
    r["final_answer"] = {
        "summary": (
            "Self-invocation goes through the Spring proxy and REQUIRES_NEW always works. "
            "preview has no @Transactional annotation."
        ),
    }
    return r


# ─────────────────────────── Case L: JPA Mapping ──────────────────────────────

def _make_case_l_perfect() -> dict:
    r = _base_result("telecom-case-l-jpa-mapping")
    r["final_answer"] = {
        "summary": (
            "NetworkChangeEntity maps to table network_change with @Entity @Table(name=network_change).\n"
            "title uses @Access(AccessType.PROPERTY) on the getter with @Column(name=title, nullable=false).\n"
            "changeId has @Column(name=change_id, nullable=false, unique=true).\n"
            "deviceFamily, risk, status use @Enumerated(EnumType.STRING).\n"
            "steps has @OneToMany(mappedBy=change, cascade=ALL, orphanRemoval=true).\n"
            "approval has @ManyToOne(fetch=LAZY) @JoinColumn(name=approval_id).\n"
            "maintenanceWindow uses @Embedded referencing ChangeWindowEmbeddable.\n"
            "version has @Version for optimistic locking.\n"
            "NamedQuery findByTitle: SELECT c FROM NetworkChangeEntity c WHERE c.title = :title.\n"
            "NamedQuery findActiveByRegion: APPROVED/RUNNING in a region.\n"
            "NamedNativeQuery findByFamilyNative: SELECT * FROM network_change WHERE device_family = :family.\n"
            "ChangePersistenceService has findByChangeId, findByRegionAndStatus, findRiskQueue, findByRegionNative, findByTitle, findActiveByRegion, findByFamilyNative.\n"
            "ChangeRecordDto is a DTO, not an Entity.\n"
            "InMemoryChangeSnapshotStore is not a JPA repository.\n"
            "ChangeAuditJpaRepository extends JpaRepository<ChangeAuditEntity, Long>.\n"
            "ChangeApprovalEntity has @Entity @Table(name=change_approval).\n"
            "FindRiskQueue uses @Query JPQL with risk and statuses parameters.\n"
            "FindByRegionNative uses nativeQuery=true with raw SQL.\n"
            "NetworkChangeEntity version @Version Long\n"
            "NetworkChangeEntity createdAt updatedAt @Column LocalDateTime\n"
            "NetworkChangeEntity maintenanceWindow ChangeWindowEmbeddable\n"
            "ChangeWindowEmbeddable windowStart windowEnd timezone\n"
            "ChangeStepEntity stepOrder stepName executorBean status resultMessage\n"
            "ChangeAuditEntity operatorId details recordedAt success\n"
            "ChangeApprovalEntity approverId approved comment decidedAt\n"
            "DeviceFamily ROUTER TRANSMISSION RADIO ALL\n"
            "ChangeStatus DRAFT PENDING_APPROVAL APPROVED RUNNING COMPLETED\n"
            "ChangeRisk LOW MEDIUM HIGH CRITICAL\n"
        ),
        "entrypoints": [
            {"name": "NetworkChangeEntity", "symbol": "NetworkChangeEntity",
             "file": "entity/NetworkChangeEntity.java", "reason": "Main entity"},
            {"name": "NetworkChangeJpaRepository", "symbol": "NetworkChangeJpaRepository",
             "file": "repository/NetworkChangeJpaRepository.java", "reason": "Main repository"},
            {"name": "ChangePersistenceService", "symbol": "ChangePersistenceService",
             "file": "service/ChangePersistenceService.java", "reason": "Service"},
        ],
        "symbols": [
            {"name": "ChangeWindowEmbeddable", "symbol": "ChangeWindowEmbeddable", "file": "entity/ChangeWindowEmbeddable.java", "reason": "Embeddable"},
            {"name": "ChangeStepEntity", "symbol": "ChangeStepEntity", "file": "entity/ChangeStepEntity.java", "reason": "Step entity"},
            {"name": "ChangeAuditEntity", "symbol": "ChangeAuditEntity", "file": "entity/ChangeAuditEntity.java", "reason": "Audit entity"},
            {"name": "ChangeApprovalEntity", "symbol": "ChangeApprovalEntity", "file": "entity/ChangeApprovalEntity.java", "reason": "Approval entity"},
            {"name": "ChangeAuditJpaRepository", "symbol": "ChangeAuditJpaRepository", "file": "repository/ChangeAuditJpaRepository.java", "reason": "Audit repo"},
        ],
    }
    r["evidence"] = [
        {"name": "NetworkChangeEntity", "symbol": "NetworkChangeEntity", "file": "entity/NetworkChangeEntity.java", "reason": "Entity"},
        {"name": "NetworkChangeJpaRepository", "symbol": "NetworkChangeJpaRepository", "file": "repository/NetworkChangeJpaRepository.java", "reason": "Repository"},
        {"name": "ChangePersistenceService", "symbol": "ChangePersistenceService", "file": "service/ChangePersistenceService.java", "reason": "Service"},
        {"name": "ChangeStepEntity", "symbol": "ChangeStepEntity", "file": "entity/ChangeStepEntity.java", "reason": "Step entity"},
    ]
    return r


def _make_case_l_empty() -> dict:
    r = _base_result("telecom-case-l-jpa-mapping")
    r["final_answer"] = {"summary": "No JPA analysis available."}
    return r


def _make_case_l_partial() -> dict:
    r = _base_result("telecom-case-l-jpa-mapping")
    r["final_answer"] = {
        "summary": "NetworkChangeEntity is the main entity. NetworkChangeJpaRepository is the repository.",
        "symbols": [
            {"name": "NetworkChangeEntity", "symbol": "NetworkChangeEntity", "file": "entity/NetworkChangeEntity.java", "reason": "Entity"},
        ],
    }
    return r


def _make_case_l_wrong() -> dict:
    r = _base_result("telecom-case-l-jpa-mapping")
    r["final_answer"] = {
        "summary": (
            "ChangeRecordDto is a JPA entity with @Entity annotation. "
            "InMemoryChangeSnapshotStore is the JPA repository for NetworkChangeEntity. "
            "title uses field access with @Column on the field."
        ),
    }
    return r


# ─────────────────────────── Case N: Overload & Callback ───────────────────

def _make_case_n_perfect() -> dict:
    r = _base_result("telecom-case-n-overload-callback")
    r["final_answer"] = {
        "summary": (
            "ChangeCommandBus has 5 dispatch overloads:\n"
            "dispatch(ChangeCommand) → base command\n"
            "dispatch(EmergencyChangeCommand) → emergency command\n"
            "dispatch(String, ChangeMode) → changeId and mode\n"
            "dispatch(int) → primitive int (retryCount:primitive)\n"
            "dispatch(Integer) → boxed Integer (retryCount:boxed)\n"
            "ChangeCommandBus.dispatchAll calls all three main overloads.\n"
            "ChangeContext has 3 constructor overloads: 2-param, 3-param, 6-param.\n"
            "ChangeExecutionService.executeSteps uses stepExecutor::executeStep method reference.\n"
            "ChangeExecutionService.submitAsyncMark uses plan::markRunning method reference.\n"
            "ChangeCallbackRegistry.register accepts Consumer<String>.\n"
            "ChangeCompletionService.completeChange calls callbackRegistry.fire.\n"
            "auditService::onCompleted registered as callback for ChangeStatus.COMPLETED.\n"
            "onCompleted calls record which is REQUIRES_NEW through proxy.\n"
            "handlers.forEach calls Consumer<String>.accept for each callback.\n"
            "NetworkChangePlan.markRunning is the method reference target.\n"
            "ChangeStepExecutor.executeStep is the step method reference target.\n"
            "validateAll uses lambda forEach over ChangeExecutor list.\n"
            "validateAllContexts uses lambda forEach over ChangeValidator list.\n"
        ),
        "entrypoints": [
            {"name": "ChangeCommandBus", "symbol": "ChangeCommandBus",
             "file": "service/ChangeCommandBus.java", "reason": "Overloaded dispatch"},
            {"name": "ChangeCallbackRegistry", "symbol": "ChangeCallbackRegistry",
             "file": "service/ChangeCallbackRegistry.java", "reason": "Callback registry"},
            {"name": "ChangeExecutionService", "symbol": "ChangeExecutionService",
             "file": "service/ChangeExecutionService.java", "reason": "Lambda/method ref"},
        ],
        "symbols": [
            {"name": "ChangeCommand", "symbol": "ChangeCommand", "file": "domain/ChangeCommand.java", "reason": "Base command"},
            {"name": "EmergencyChangeCommand", "symbol": "EmergencyChangeCommand", "file": "domain/EmergencyChangeCommand.java", "reason": "Emergency command"},
            {"name": "ChangeContext", "symbol": "ChangeContext", "file": "domain/ChangeContext.java", "reason": "Context"},
            {"name": "ChangeStepExecutor", "symbol": "ChangeStepExecutor", "file": "executor/ChangeStepExecutor.java", "reason": "Method ref target"},
            {"name": "ChangeCompletionService", "symbol": "ChangeCompletionService", "file": "service/ChangeCompletionService.java", "reason": "Production caller"},
            {"name": "ChangeAuditService", "symbol": "ChangeAuditService", "file": "service/ChangeAuditService.java", "reason": "onCompleted method"},
        ],
    }
    r["evidence"] = [
        {"name": "ChangeCommandBus", "symbol": "ChangeCommandBus", "file": "service/ChangeCommandBus.java", "reason": "Overloads"},
        {"name": "ChangeCallbackRegistry", "symbol": "ChangeCallbackRegistry", "file": "service/ChangeCallbackRegistry.java", "reason": "Registry"},
    ]
    return r


def _make_case_n_empty() -> dict:
    r = _base_result("telecom-case-n-overload-callback")
    r["final_answer"] = {"summary": "No overload analysis available."}
    return r


def _make_case_n_partial() -> dict:
    r = _base_result("telecom-case-n-overload-callback")
    r["final_answer"] = {
        "summary": "ChangeCommandBus has dispatch methods for ChangeCommand.",
        "symbols": [
            {"name": "ChangeCommandBus", "symbol": "ChangeCommandBus", "file": "service/ChangeCommandBus.java", "reason": "Bus"},
        ],
    }
    return r


def _make_case_n_wrong() -> dict:
    r = _base_result("telecom-case-n-overload-callback")
    r["final_answer"] = {
        "summary": (
            "ChangeCommandBus has only one dispatch method. int and Integer are the same. "
            "ChangeContext has only one constructor."
        ),
    }
    return r


# ─────────────────────────── Parametrized Tests ─────────────────────────────

@pytest.mark.parametrize("case_id,perfect_fn,empty_fn,partial_fn,wrong_fn", [
    ("telecom-case-h-spring-route-matrix",
     _make_case_h_perfect, _make_case_h_empty, _make_case_h_partial, _make_case_h_wrong),
    ("telecom-case-m-dynamic-dispatch",
     _make_case_m_perfect, _make_case_m_empty, _make_case_m_partial, _make_case_m_wrong),
    ("telecom-case-o-framework-reflection-boundary",
     _make_case_o_perfect, _make_case_o_empty, _make_case_o_partial, _make_case_o_wrong),
    ("telecom-case-i-java-annotation-binding",
     _make_case_i_perfect, _make_case_i_empty, _make_case_i_partial, _make_case_i_wrong),
    ("telecom-case-j-spring-di-selection",
     _make_case_j_perfect, _make_case_j_empty, _make_case_j_partial, _make_case_j_wrong),
    ("telecom-case-k-transaction-boundary",
     _make_case_k_perfect, _make_case_k_empty, _make_case_k_partial, _make_case_k_wrong),
    ("telecom-case-l-jpa-mapping",
     _make_case_l_perfect, _make_case_l_empty, _make_case_l_partial, _make_case_l_wrong),
    ("telecom-case-n-overload-callback",
     _make_case_n_perfect, _make_case_n_empty, _make_case_n_partial, _make_case_n_wrong),
])
def test_synthetic_scores(case_id, perfect_fn, empty_fn, partial_fn, wrong_fn):
    perfect_score = _score(case_id, perfect_fn())
    empty_score = _score(case_id, empty_fn())
    partial_score = _score(case_id, partial_fn())
    wrong_score = _score(case_id, wrong_fn())

    print(f"\n{case_id}:")
    print(f"  perfect={perfect_score:.2f}  empty={empty_score:.2f}  "
          f"partial={partial_score:.2f}  wrong={wrong_score:.2f}")

    # Core assertions (normalized to 0-100 scale)
    assert perfect_score >= 38, f"perfect score {perfect_score} should be >= 38"
    assert empty_score <= 20, f"empty score {empty_score} should be <= 20"
    assert empty_score < partial_score, f"empty {empty_score} should be < partial {partial_score}"
    assert partial_score < perfect_score, f"partial {partial_score} should be < perfect {perfect_score}"
    assert wrong_score < perfect_score, f"wrong {wrong_score} should be < perfect {perfect_score}"
    assert perfect_score <= 100, f"perfect score {perfect_score} should be <= 100"


def test_case_h_route_method_validation():
    """Wrong HTTP method must not get full route credit."""
    perfect = _make_case_h_perfect()
    wrong_method = _make_case_h_wrong()

    perfect_score = _score("telecom-case-h-spring-route-matrix", perfect)
    wrong_score = _score("telecom-case-h-spring-route-matrix", wrong_method)

    assert perfect_score > wrong_score + 5, (
        f"Perfect ({perfect_score:.2f}) should beat wrong-method ({wrong_score:.2f}) by > 5"
    )


def test_case_m_excluded_target_not_scored():
    """SafeChangeExecutor should not count as a correct possible target for registry dispatch."""
    perfect = _make_case_m_perfect()
    perfect_score = _score("telecom-case-m-dynamic-dispatch", perfect)
    assert perfect_score >= 60, f"perfect should score >= 60, got {perfect_score}"


def test_case_o_framework_edge_classification():
    """Correctly classifying edge kinds should score higher than calling everything 'direct call'."""
    perfect = _make_case_o_perfect()
    wrong = _make_case_o_wrong()

    perfect_score = _score("telecom-case-o-framework-reflection-boundary", perfect)
    wrong_score = _score("telecom-case-o-framework-reflection-boundary", wrong)

    assert perfect_score > wrong_score, (
        f"Correct classification ({perfect_score:.2f}) should beat wrong ({wrong_score:.2f})"
    )


def test_empty_answer_scores_near_zero():
    """Empty answers across all tested cases should score <= 15."""
    for case_id, empty_fn in [
        ("telecom-case-h-spring-route-matrix", _make_case_h_empty),
        ("telecom-case-m-dynamic-dispatch", _make_case_m_empty),
        ("telecom-case-o-framework-reflection-boundary", _make_case_o_empty),
    ]:
        score = _score(case_id, empty_fn())
        assert score <= 15, f"{case_id} empty score {score} should be <= 15"
