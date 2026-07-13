<#
.SYNOPSIS
  Maps the local subdomain-SSO development hosts to 127.0.0.1 in the Windows
  hosts file (idempotent), so the four-app satellite rig can run on true
  subdomains — see docs/integration-satellite-apps.md §6.6.

.DESCRIPTION
  Adds (or with -Remove, deletes) a clearly-marked block to
  C:\Windows\System32\drivers\etc\hosts:

    devresponse.local        — the primary DevResponseKit app  (:3000)
    app1.devresponse.local   — app-standalone / Option A       (:3001)
    app2.devresponse.local   — app-handoff    / Option B       (:3002)
    app3.devresponse.local   — app-shared     / Option C       (:3003)

  The block is managed as a unit between marker comments, so re-running the
  script never duplicates entries and -Remove takes out exactly what it added.
  Requires elevation; the script self-elevates with a UAC prompt if needed.

.PARAMETER Remove
  Remove the managed block instead of adding it.

.EXAMPLE
  # From an elevated (or normal — it will prompt) PowerShell:
  ./scripts/setup-local-subdomains.ps1

.EXAMPLE
  ./scripts/setup-local-subdomains.ps1 -Remove
#>
param([switch]$Remove)

$ErrorActionPreference = "Stop"

$HostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$BeginMarker = "# BEGIN devresponsekit local subdomain SSO (managed by scripts/setup-local-subdomains.ps1)"
$EndMarker = "# END devresponsekit local subdomain SSO"
$Hosts = @(
  "devresponse.local",
  "app1.devresponse.local",
  "app2.devresponse.local",
  "app3.devresponse.local"
)

# Self-elevate: the hosts file is writable only by administrators.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Elevation required to edit $HostsPath — requesting UAC…"
  $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
  if ($Remove) { $args += "-Remove" }
  $p = Start-Process -FilePath "powershell.exe" -ArgumentList $args -Verb RunAs -Wait -PassThru
  exit $p.ExitCode
}

# Read, strip any existing managed block, and (unless -Remove) append a fresh one.
$lines = @(Get-Content -Path $HostsPath -Encoding ASCII)
$result = New-Object System.Collections.Generic.List[string]
$inBlock = $false
foreach ($line in $lines) {
  if ($line -eq $BeginMarker) { $inBlock = $true; continue }
  if ($line -eq $EndMarker) { $inBlock = $false; continue }
  if (-not $inBlock) { $result.Add($line) }
}

if ($Remove) {
  Write-Host "Removing the managed devresponse.local block…"
} else {
  # Trim trailing blank lines so the block lands tidily at the end.
  while ($result.Count -gt 0 -and $result[$result.Count - 1].Trim() -eq "") {
    $result.RemoveAt($result.Count - 1)
  }
  $result.Add("")
  $result.Add($BeginMarker)
  foreach ($h in $Hosts) { $result.Add("127.0.0.1`t$h") }
  $result.Add($EndMarker)
  Write-Host "Writing the managed devresponse.local block…"
}

Set-Content -Path $HostsPath -Value $result -Encoding ASCII
ipconfig /flushdns | Out-Null

# Verify.
$failed = @()
foreach ($h in $Hosts) {
  try {
    $resolved = [System.Net.Dns]::GetHostAddresses($h) | ForEach-Object IPAddressToString
    $ok = $resolved -contains "127.0.0.1"
  } catch { $ok = $false }
  if ($Remove) {
    if ($ok) { $failed += $h }
  } elseif (-not $ok) { $failed += $h }
}

if ($failed.Count -gt 0) {
  $verb = if ($Remove) { "still resolve" } else { "do not resolve to 127.0.0.1" }
  Write-Warning ("These hosts {0}: {1}. A VPN/DNS agent may be interfering; `*.localtest.me` (public DNS) is the no-hosts-file fallback." -f $verb, ($failed -join ", "))
  exit 1
}

if ($Remove) {
  Write-Host "Done — entries removed."
} else {
  Write-Host "Done — all four hosts resolve to 127.0.0.1:"
  foreach ($h in $Hosts) { Write-Host "  $h" }
}
