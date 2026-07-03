[CmdletBinding()]
param(
    [string[]]$Plan = @(),
    [string]$OutRoot = "",
    [string]$Model = "deepseek-v4-pro[1m]",
    [string[]]$Agent = @("claude-code"),
    [string[]]$ToolPolicy = @("grep", "graph"),
    [string[]]$CaseId = @(),
    [int]$MaxRuns = 0,
    [int]$TimeoutSeconds = 1800,
    [string]$McpConfig = "",
    [switch]$DryRun,
    [switch]$SkipExecute,
    [switch]$KeepExisting,
    [switch]$NoPostProcess,
    [switch]$NoSummary,
    [switch]$NoReportAnalysisPrompt
)

$ErrorActionPreference = "Stop"

$VersionRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $VersionRoot "..\..\..")).Path
$Runner = Join-Path $PSScriptRoot "agent_benchmark_runner.py"
$ReportAnalysisTool = Join-Path $VersionRoot "report-analysis\report_analysis.py"
$BundledPython = Join-Path $RepoRoot "eval\.venv\Scripts\python.exe"
$Python = if (Test-Path $BundledPython) { $BundledPython } else { "python" }

function Expand-MultiValueParameter {
    param([string[]]$Value)

    $expanded = foreach ($entry in $Value) {
        foreach ($item in ($entry -split ",")) {
            $trimmed = $item.Trim()
            if ($trimmed) {
                $trimmed
            }
        }
    }
    return @($expanded)
}

# Normalize both native arrays and comma-joined values received through
# Windows PowerShell 5.1 `powershell -File` before building Python argv.
$Plan = @(Expand-MultiValueParameter $Plan)
$Agent = @(Expand-MultiValueParameter $Agent)
$ToolPolicy = @(Expand-MultiValueParameter $ToolPolicy)
$CaseId = @(Expand-MultiValueParameter $CaseId)

if ($Plan.Count -eq 0) {
    $Plan = @(
        (Join-Path $VersionRoot "telecom\plan.yaml"),
        (Join-Path $VersionRoot "qwenpaw\plan.yaml")
    )
}
if (-not $OutRoot) {
    $OutRoot = Join-Path $RepoRoot "runs\v2"
}

Set-Location $RepoRoot
$ResolvedOutRoot = if ([System.IO.Path]::IsPathRooted($OutRoot)) { $OutRoot } else { Join-Path $RepoRoot $OutRoot }
New-Item -ItemType Directory -Force -Path $ResolvedOutRoot | Out-Null

if (-not $McpConfig) {
    $DefaultMcpConfig = Join-Path $RepoRoot ".mcp.json"
    if (Test-Path $DefaultMcpConfig) {
        $McpConfig = $DefaultMcpConfig
    }
}

function ConvertTo-Slug {
    param([string]$Value)
    $slug = ($Value -replace "[^A-Za-z0-9]+", "-").Trim("-").ToLowerInvariant()
    if ($slug) { return $slug }
    return "default"
}

function Get-PlanSlug {
    param([string]$PlanPath)
    $item = Get-Item $PlanPath
    $parent = $item.Directory.Name
    if ($parent -eq "large" -and $item.Directory.Parent.Name -eq "telecom") { return "telecom-large" }
    if ($parent -in @("qwenpaw", "telecom", "gitnexus")) { return $parent }
    return (ConvertTo-Slug $parent)
}

function Invoke-Runner {
    param(
        [string[]]$Arguments,
        [switch]$AllowFailure
    )

    $output = & $Python $Runner @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in $output) {
        Write-Host $line
    }
    if (($exitCode -ne 0) -and (-not $AllowFailure)) {
        throw "agent_benchmark_runner.py failed with exit code $exitCode. Args: $($Arguments -join ' ')"
    }
    return $exitCode
}

function Read-JsonFile {
    param([string]$Path)
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )
    $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Resolve-RepoPath {
    param([string]$Path)
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return (Resolve-Path $Path).Path
    }
    return (Resolve-Path (Join-Path $RepoRoot $Path)).Path
}

function Resolve-BenchmarkPath {
    param(
        [string]$PlanPath,
        [string]$TargetRoot,
        [string]$PathValue
    )

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return (Resolve-Path $PathValue).Path
    }

    $targetCandidate = Join-Path $TargetRoot ($PathValue -replace "/", "\")
    if (Test-Path $targetCandidate) {
        return (Resolve-Path $targetCandidate).Path
    }

    $repoCandidate = Join-Path $RepoRoot ($PathValue -replace "/", "\")
    if (Test-Path $repoCandidate) {
        return (Resolve-Path $repoCandidate).Path
    }

    $planDir = Split-Path -Parent $PlanPath
    $planCandidate = Join-Path $planDir ($PathValue -replace "/", "\")
    if (Test-Path $planCandidate) {
        return (Resolve-Path $planCandidate).Path
    }

    return $targetCandidate
}

function Invoke-PostProcess {
    param(
        [string]$OutDir,
        [string]$PlanPath
    )

    $runnerResults = Get-ChildItem -LiteralPath $OutDir -Recurse -Filter "runner-result.json" -File -ErrorAction SilentlyContinue
    $extractFailures = @()
    $scoreFailures = @()
    $artifactFailures = @()
    $processed = 0

    foreach ($runnerResult in $runnerResults) {
        $runDir = $runnerResult.Directory.FullName
        $runnerData = Read-JsonFile $runnerResult.FullName

        if ($runnerData.status -eq "dry-run") {
            continue
        }

        $agentResultPath = Join-Path $runDir "agent-result.json"
        $extractCode = Invoke-Runner @("extract-result", "--runner-result", $runnerResult.FullName, "--out", $agentResultPath) -AllowFailure
        if ($extractCode -ne 0) {
            $extractFailures += $runnerResult.FullName
            continue
        }

        $manifestRun = $runnerData.manifest.run
        if (-not $manifestRun -or -not $manifestRun.golden_file) {
            $scoreFailures += "$($runnerResult.FullName): missing manifest.run.golden_file"
            continue
        }

        $goldenPath = Resolve-BenchmarkPath -PlanPath $PlanPath -TargetRoot $manifestRun.target_project -PathValue $manifestRun.golden_file
        $scorePath = Join-Path $runDir "score.json"
        $scoreCode = Invoke-Runner @("score", "--run-result", $agentResultPath, "--golden", $goldenPath, "--out", $scorePath) -AllowFailure
        if ($scoreCode -ne 0) {
            $scoreFailures += $runnerResult.FullName
            continue
        }

        $artifactPath = Join-Path $runDir "artifact-validation.json"
        $artifactOutput = & $Python $Runner "validate-artifacts" "--run-dir" $runDir 2>&1
        $artifactExit = $LASTEXITCODE
        $artifactOutput | Set-Content -LiteralPath $artifactPath -Encoding UTF8
        if ($artifactExit -ne 0) {
            $artifactFailures += $runDir
        }

        $processed += 1
    }

    return [pscustomobject]@{
        runner_result_count = $runnerResults.Count
        processed_count = $processed
        extract_failures = $extractFailures
        score_failures = $scoreFailures
        artifact_failures = $artifactFailures
    }
}

function Write-BenchmarkSummary {
    param(
        [string]$OutDir,
        [string]$PlanPath,
        [string]$ReportPath,
        [object]$PostProcessResult,
        [int]$ExecuteExitCode
    )

    $report = Read-JsonFile $ReportPath
    $summaryPath = Join-Path $OutDir "benchmark-summary.md"
    $generatedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
    $agentsText = $Agent -join ", "
    $policyText = $ToolPolicy -join ", "

    $lines = @()
    $lines += "# Benchmark Summary"
    $lines += ""
    $lines += "- Generated at: $generatedAt"
    $lines += "- Plan: $PlanPath"
    $lines += "- Agent: $agentsText"
    $lines += "- Model: $Model"
    $lines += "- Tool policies: $policyText"
    $lines += "- Execute exit code: $ExecuteExitCode"
    $lines += "- Score files: $($report.score_file_count)"
    $lines += "- Valid runs: $($report.valid_run_count)"
    $lines += "- Invalid runs: $($report.invalid_run_count)"
    $lines += "- Excluded runs: $($report.excluded_run_count)"
    $lines += "- Artifact warnings: $($report.artifact_warning_count)"
    $lines += "- Artifact invalid: $($report.artifact_invalid_count)"
    $lines += "- Post-processed runs: $($PostProcessResult.processed_count)"
    $lines += ""

    if ($report.by_agent_policy) {
        $lines += "## Agent / Policy Average Scores"
        $lines += ""
        $lines += "| Agent | Policy | Runs | Avg total | Avg coverage | Avg graph bonus |"
        $lines += "| --- | --- | ---: | ---: | ---: | ---: |"
        foreach ($row in $report.by_agent_policy) {
            $lines += "| $($row.agent) | $($row.tool_policy) | $($row.count) | $([math]::Round([double]$row.avg_total, 2)) | $([math]::Round([double]$row.avg_coverage_total, 2)) | $([math]::Round([double]$row.avg_graph_depth_bonus, 2)) |"
        }
        $lines += ""
    }

    if ($report.graph_uplift) {
        $lines += "## Graph vs Grep Uplift"
        $lines += ""
        $lines += "| Agent | Grep avg | Graph avg | Uplift |"
        $lines += "| --- | ---: | ---: | ---: |"
        foreach ($row in $report.graph_uplift) {
            $lines += "| $($row.agent) | $([math]::Round([double]$row.grep_avg, 2)) | $([math]::Round([double]$row.graph_avg, 2)) | $([math]::Round([double]$row.uplift, 2)) |"
        }
        $lines += ""
    }

    if ($report.exclusion_reasons) {
        $lines += "## Exclusion Reasons"
        $lines += ""
        foreach ($reason in $report.exclusion_reasons.PSObject.Properties) {
            $lines += "- $($reason.Name): $($reason.Value)"
        }
        $lines += ""
    }

    if (($PostProcessResult.extract_failures.Count -gt 0) -or ($PostProcessResult.score_failures.Count -gt 0) -or ($PostProcessResult.artifact_failures.Count -gt 0)) {
        $lines += "## Post-process Failures"
        $lines += ""
        $lines += "- Extract failures: $($PostProcessResult.extract_failures.Count)"
        $lines += "- Score failures: $($PostProcessResult.score_failures.Count)"
        $lines += "- Artifact validation failures: $($PostProcessResult.artifact_failures.Count)"
        $lines += ""
    }

    $lines | Set-Content -LiteralPath $summaryPath -Encoding UTF8
    return $summaryPath
}

$orchestration = @()
$scriptExitCode = 0

foreach ($planInput in $Plan) {
    $planPath = Resolve-RepoPath $planInput
    $planSlug = Get-PlanSlug $planPath
    $agentSlug = ConvertTo-Slug ($Agent -join "-")
    $modelSlug = ConvertTo-Slug $Model
    $outDir = Join-Path $ResolvedOutRoot "$planSlug-$agentSlug-$modelSlug"
    if ((-not $SkipExecute) -and (-not $KeepExisting) -and (Test-Path $outDir)) {
        $resolvedOutDir = (Resolve-Path $outDir).Path
        $resolvedOutRootPath = (Resolve-Path $ResolvedOutRoot).Path
        $outRootPrefix = $resolvedOutRootPath.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
        if ($resolvedOutDir.StartsWith($outRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedOutDir -Recurse -Force
        } else {
            throw "Refusing to clean output outside OutRoot: $resolvedOutDir"
        }
    }
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    Write-Host "==> Plan: $planPath"
    Write-Host "==> Output: $outDir"

    Invoke-Runner @("validate", "--plan", $planPath) | Out-Null

    $expandedPlanPath = Join-Path $outDir "matrix-plan.json"
    Invoke-Runner @("plan", "--plan", $planPath, "--out", $expandedPlanPath) | Out-Null

    $executeExitCode = 0
    if (-not $SkipExecute) {
        $executeArgs = @("execute-matrix", "--plan", $planPath, "--out-dir", $outDir, "--model", $Model, "--timeout-seconds", [string]$TimeoutSeconds)
        foreach ($agentName in $Agent) {
            $executeArgs += @("--agent", $agentName)
        }
        foreach ($policyName in $ToolPolicy) {
            $executeArgs += @("--tool-policy", $policyName)
        }
        foreach ($case in $CaseId) {
            $executeArgs += @("--case-id", $case)
        }
        if ($MaxRuns -gt 0) {
            $executeArgs += @("--max-runs", [string]$MaxRuns)
        }
        if ($McpConfig) {
            $executeArgs += @("--mcp-config", $McpConfig)
        }
        if ($DryRun) {
            $executeArgs += "--dry-run"
        }

        $executeExitCode = Invoke-Runner $executeArgs -AllowFailure
        if ($executeExitCode -ne 0) {
            $scriptExitCode = 1
        }
    }

    $postProcess = [pscustomobject]@{
        runner_result_count = 0
        processed_count = 0
        extract_failures = @()
        score_failures = @()
        artifact_failures = @()
    }
    $reportPath = Join-Path $outDir "report.json"
    $summaryPath = ""

    if ((-not $DryRun) -and (-not $NoPostProcess)) {
        $postProcess = Invoke-PostProcess -OutDir $outDir -PlanPath $planPath
        if (($postProcess.extract_failures.Count -gt 0) -or ($postProcess.score_failures.Count -gt 0) -or ($postProcess.artifact_failures.Count -gt 0)) {
            $scriptExitCode = 1
        }

        Invoke-Runner @("report", "--scores-dir", $outDir, "--out", $reportPath) | Out-Null
        if (-not $NoSummary) {
            $summaryPath = Write-BenchmarkSummary -OutDir $outDir -PlanPath $planPath -ReportPath $reportPath -PostProcessResult $postProcess -ExecuteExitCode $executeExitCode
            Write-Host "==> Summary: $summaryPath"
        }
    }

    $orchestration += [pscustomobject]@{
        plan = $planPath
        out_dir = $outDir
        expanded_plan = $expandedPlanPath
        report = if (Test-Path $reportPath) { $reportPath } else { $null }
        summary = if ($summaryPath) { $summaryPath } else { $null }
        execute_exit_code = $executeExitCode
        post_process = $postProcess
    }
}

$reportAnalysisHandoff = $null
if ((-not $DryRun) -and (-not $NoPostProcess) -and (-not $NoReportAnalysisPrompt)) {
    Write-Host "==> Preparing multi-report analysis prompt"
    $analysisOutput = & $Python $ReportAnalysisTool "prepare" "--runs-dir" $ResolvedOutRoot "--repo-root" $RepoRoot 2>&1
    $analysisExitCode = $LASTEXITCODE
    foreach ($line in $analysisOutput) {
        Write-Host $line
    }
    if ($analysisExitCode -ne 0) {
        $scriptExitCode = 1
        Write-Warning "Failed to prepare report analysis prompt (exit $analysisExitCode)."
    } else {
        $reportAnalysisHandoff = [pscustomobject]@{
            input = Join-Path $ResolvedOutRoot "report-analysis-input.json"
            prompt = Join-Path $ResolvedOutRoot "report-analysis-prompt.md"
            expected_result = Join-Path $ResolvedOutRoot "report-analysis.json"
            status = "awaiting-agent-analysis"
        }
        Write-Host "==> Analysis prompt: $($reportAnalysisHandoff.prompt)"
    }
}

$orchestrationPath = Join-Path $ResolvedOutRoot "orchestration-result.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $orchestrationPath) | Out-Null
Write-JsonFile -Path $orchestrationPath -Value ([pscustomobject]@{
    generated_at = (Get-Date).ToString("o")
    model = $Model
    agents = $Agent
    tool_policies = $ToolPolicy
    dry_run = [bool]$DryRun
    skip_execute = [bool]$SkipExecute
    keep_existing = [bool]$KeepExisting
    mcp_config = if ($McpConfig) { $McpConfig } else { $null }
    plans = $orchestration
    report_analysis = $reportAnalysisHandoff
})

Write-Host "==> Orchestration result: $orchestrationPath"
exit $scriptExitCode
