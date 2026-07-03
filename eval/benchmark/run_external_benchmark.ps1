[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^v[1-9][0-9]*$')]
    [string]$Version,
    [string[]]$Plan = @(),
    [string]$OutRoot = "",
    [Parameter(Mandatory = $true)]
    [string]$Model,
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
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Target = Join-Path $RepoRoot "docs\benchmark\$Version\runner\run_external_benchmark.ps1"
$Admin = Join-Path $PSScriptRoot "version_admin.py"
$BundledPython = Join-Path $RepoRoot "eval\.venv\Scripts\python.exe"
$Python = if (Test-Path -LiteralPath $BundledPython) { $BundledPython } else { "python" }
if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
    throw "Benchmark runner not found for $Version`: $Target"
}

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

# Windows PowerShell 5.1 `powershell -File` can bind `-CaseId "a","b"`
# as one string (`a,b`). Normalize every list-valued CLI parameter at the
# compatibility boundary before preflight and before forwarding.
$Plan = @(Expand-MultiValueParameter $Plan)
$Agent = @(Expand-MultiValueParameter $Agent)
$ToolPolicy = @(Expand-MultiValueParameter $ToolPolicy)
$CaseId = @(Expand-MultiValueParameter $CaseId)

if (-not $DryRun) {
    $Preflight = @("preflight", "--version", $Version, "--model", $Model)
    foreach ($PlanPath in $Plan) {
        $Preflight += @("--plan", $PlanPath)
    }
    foreach ($Case in $CaseId) {
        $Preflight += @("--case-id", $Case)
    }
    & $Python $Admin @Preflight
    if ($LASTEXITCODE -ne 0) {
        throw "Benchmark preflight failed for $Version"
    }
}

$Forward = @{}
foreach ($Key in $PSBoundParameters.Keys) {
    if ($Key -ne "Version") {
        switch ($Key) {
            "Plan" { $Forward[$Key] = $Plan }
            "Agent" { $Forward[$Key] = $Agent }
            "ToolPolicy" { $Forward[$Key] = $ToolPolicy }
            "CaseId" { $Forward[$Key] = $CaseId }
            default { $Forward[$Key] = $PSBoundParameters[$Key] }
        }
    }
}

& $Target @Forward
exit $LASTEXITCODE
