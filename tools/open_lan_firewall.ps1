# Allows phones on the same local network to reach Audio Insight (TCP 8000-8010).
# The rule only accepts the local subnet, not the internet. Adding it needs administrator rights,
# so the script asks for elevation once; later runs find the existing rule and do nothing.
param([switch]$Elevated)
$ErrorActionPreference = 'Stop'
$ruleName = 'Audio Insight LAN (TCP 8000-8010)'

if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
    Write-Host 'Firewall rule for phone access is ready.'
    exit 0
}

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if ($Elevated) { Write-Host 'Administrator rights were not granted.' -ForegroundColor Yellow; exit 1 }
    Write-Host 'Requesting administrator permission to allow phone access through Windows Firewall...'
    try {
        $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Elevated')
        exit $process.ExitCode
    } catch {
        Write-Host 'Firewall permission was cancelled. The phone may not be able to connect.' -ForegroundColor Yellow
        exit 1
    }
}

New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort 8000-8010 -RemoteAddress LocalSubnet -Profile Any | Out-Null
Write-Host 'Firewall rule added: local-network devices may connect to TCP 8000-8010.' -ForegroundColor Green
exit 0
