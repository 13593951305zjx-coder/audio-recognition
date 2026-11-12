param([string]$Serial = '', [switch]$ConnectionOnly, [switch]$Watch)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backend = Join-Path $project 'audio_llm_backend'
$apk = Join-Path $project 'android_audio_llm\release\AudioInsight-debug.apk'

function Find-Adb {
    $candidates = @()
    if ($env:ANDROID_HOME) { $candidates += (Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe') }
    if ($env:ANDROID_SDK_ROOT) { $candidates += (Join-Path $env:ANDROID_SDK_ROOT 'platform-tools\adb.exe') }
    $candidates += (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe')
    $candidates += 'C:\Program Files (x86)\Android\android-sdk\platform-tools\adb.exe'
    $command = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate } }
    throw 'ADB not found. Install Android SDK Platform-Tools or set ANDROID_HOME.'
}
function Get-AudioService {
    foreach ($port in 8000..8010) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3
            if ($health.ok -and $health.service -eq 'audio-insight' -and $health.mode -eq 'local') { return $port }
        } catch { }
    }
    return 0
}
function Run-Adb([string[]]$Arguments) {
    & $script:adb @Arguments
    if ($LASTEXITCODE -ne 0) { throw "ADB command failed ($LASTEXITCODE). Reconnect USB and allow USB debugging on the phone." }
}
try {
    $adb = Find-Adb
    $devices = @(& $adb devices)
    if ($LASTEXITCODE -ne 0) { throw 'Could not start ADB. Check the Android USB driver.' }
    $ready = @($devices | ForEach-Object { if ($_ -match '^(\S+)\s+device\s*$') { $Matches[1] } })
    if ($devices -match '\s+unauthorized\s*$') {
        Write-Host 'Unlock the phone and accept the USB debugging fingerprint shown on the phone.' -ForegroundColor Yellow
    }
    if ($Serial) {
        if ($ready -notcontains $Serial) { throw 'The selected device is not ready. Run adb devices and authorize USB debugging.' }
    } elseif ($ready.Count -eq 1) { $Serial = $ready[0] }
    elseif ($ready.Count -eq 0) { throw 'No authorized Android device. Connect a data-capable USB cable, enable USB debugging, and accept the authorization prompt.' }
    else { throw ('Multiple devices detected. Run connect_android.cmd -Serial DEVICE_ID. Available: ' + ($ready -join ', ')) }

    if (-not $ConnectionOnly -and -not (Test-Path -LiteralPath $apk -PathType Leaf)) {
        throw "APK not found: $apk. Build android_audio_llm first."
    }
    $port = Get-AudioService
    if (-not $port) {
        $python = Join-Path $backend '.venv\Scripts\python.exe'
        $launcher = Join-Path $backend 'launch_web.py'
        if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Project Python environment not found. Run start.cmd once first.' }
        if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Local backend is missing from this project folder.' }
        $logs = Join-Path $project 'logs'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Start-Process -FilePath $python -ArgumentList @('-B',('"' + $launcher + '"'),'--mode','local','--no-browser') -WorkingDirectory $backend -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "android-$stamp.log") -RedirectStandardError (Join-Path $logs "android-$stamp-error.log") | Out-Null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Seconds 1
            $port = Get-AudioService
            if ($port) { break }
        }
        if (-not $port) { throw 'The local service did not become ready. Check the newest logs\android-*.log or run start.cmd.' }
    }
    Run-Adb -Arguments @('-s',$Serial,'reverse','tcp:8000',"tcp:$port")
    if (-not $ConnectionOnly) {
        Run-Adb -Arguments @('-s',$Serial,'install','-r',$apk)
        Run-Adb -Arguments @('-s',$Serial,'shell','am','start','-n','com.example.audioinsight/.ui.SplashActivity')
    }
    Write-Host ''
    Write-Host "Ready. Device: $Serial" -ForegroundColor Green
    Write-Host "Phone service address: http://127.0.0.1:8000"
    Write-Host "USB forwarding -> computer port $port. Keep this USB cable connected for AI recognition."
    Write-Host 'Recording, playback and saved local history work without the computer service.'
    if ($Watch) {
        Write-Host 'Watching USB connection and auto-restoring tcp:8000 forwarding if USB resets (Ctrl+C to stop)...' -ForegroundColor Cyan
        while ($true) {
            Start-Sleep -Seconds 2
            $list = @(& $adb -s $Serial reverse --list 2>$null)
            if (-not ($list -match 'tcp:8000')) {
                & $adb -s $Serial reverse tcp:8000 "tcp:$port" 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Write-Host ("[{0}] Restored USB forwarding tcp:8000 -> tcp:{1}" -f (Get-Date -Format 'HH:mm:ss'), $port) -ForegroundColor Yellow
                }
            }
        }
    }
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
