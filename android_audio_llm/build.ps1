[CmdletBinding()]
param(
    [string[]]$Tasks = @(':app:assembleDebug', ':app:lintDebug'),
    [string]$JdkPath = '',
    [string]$SdkPath = '',
    [string]$Proxy = '',
    [switch]$NoProxy
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$courseRoot = Split-Path -Parent $projectRoot
$toolsRoot = Join-Path $courseRoot 'tools'
$verificationRoot = Join-Path $courseRoot 'verification'
$gradleUserHome = Join-Path $toolsRoot 'gradle-user-home'

function Get-JdkMajorVersion([string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return 0 }
    $releaseFile = Join-Path $Candidate 'release'
    if (-not (Test-Path -LiteralPath $releaseFile)) { return 0 }
    $releaseText = Get-Content -LiteralPath $releaseFile -Raw
    if ($releaseText -match 'JAVA_VERSION="(\d+)(?:\.(\d+))?') {
        if ([int]$Matches[1] -eq 1) { return [int]$Matches[2] }
        return [int]$Matches[1]
    }
    return 0
}
if ([string]::IsNullOrWhiteSpace($JdkPath)) {
    $jdkCandidates = @($env:JAVA_HOME)
    $javaOnPath = Get-Command java.exe -ErrorAction SilentlyContinue
    if ($javaOnPath) { $jdkCandidates += Split-Path -Parent (Split-Path -Parent $javaOnPath.Source) }
    foreach ($jdkParent in @((Join-Path $env:ProgramFiles 'Android\openjdk'), (Join-Path $env:USERPROFILE '.jdks'), (Join-Path $env:ProgramFiles 'Java'))) {
        if (Test-Path -LiteralPath $jdkParent) {
            $jdkCandidates += Get-ChildItem -LiteralPath $jdkParent -Directory | Sort-Object Name -Descending | Select-Object -ExpandProperty FullName
        }
    }
    $jdkCandidates += Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'
    foreach ($candidate in $jdkCandidates) {
        $jdkMajor = Get-JdkMajorVersion $candidate
        if ($jdkMajor -ge 17 -and $jdkMajor -le 21 -and (Test-Path -LiteralPath (Join-Path $candidate 'bin\javac.exe'))) {
            $JdkPath = $candidate
            break
        }
    }
}
$jdkMajor = Get-JdkMajorVersion $JdkPath
if ($jdkMajor -lt 17 -or $jdkMajor -gt 21) {
    throw 'Gradle 8.7 needs a compatible JDK. Supply -JdkPath with JDK 17 through 21.'
}
if ([string]::IsNullOrWhiteSpace($SdkPath)) {
    $sdkCandidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'), (Join-Path ${env:ProgramFiles(x86)} 'Android\android-sdk'), (Join-Path $env:ProgramFiles 'Android\android-sdk'))
    foreach ($candidate in $sdkCandidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath (Join-Path $candidate 'platforms\android-35\android.jar'))) {
            $SdkPath = $candidate
            break
        }
    }
}
if ([string]::IsNullOrWhiteSpace($SdkPath)) {
    throw 'Android SDK API 35 not found. Supply -SdkPath with your Android SDK directory.'
}
$javaCommand = Join-Path $JdkPath 'bin\java.exe'
if (-not (Test-Path -LiteralPath $javaCommand)) {
    throw "JDK not found: $javaCommand. Supply -JdkPath with a JDK 17 or newer."
}
if (-not (Test-Path -LiteralPath (Join-Path $SdkPath 'platforms\android-35\android.jar'))) {
    throw "Android API 35 not found in $SdkPath. Supply -SdkPath with an existing SDK."
}
if (-not (Test-Path -LiteralPath (Join-Path $SdkPath 'build-tools\36.0.0\aapt2.exe'))) {
    throw "Android Build Tools 36.0.0 not found in $SdkPath."
}
New-Item -ItemType Directory -Path $verificationRoot,$gradleUserHome -Force | Out-Null

# Prefer the verified local distribution. The official wrapper is the portable fallback.
$gradleCommand = Join-Path $toolsRoot 'gradle-8.7\bin\gradle.bat'
if (-not (Test-Path -LiteralPath $gradleCommand)) {
    $gradleCommand = Join-Path $projectRoot 'gradlew.bat'
}
if (-not $NoProxy -and [string]::IsNullOrWhiteSpace($Proxy)) {
    $internetSettings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($internetSettings.ProxyEnable -eq 1) {
        $Proxy = [string]$internetSettings.ProxyServer
        if ($Proxy -match '(?:^|;)https=([^;]+)') { $Proxy = $Matches[1] }
        elseif ($Proxy -match '(?:^|;)http=([^;]+)') { $Proxy = $Matches[1] }
    }
}
$gradleArguments = @('--no-daemon', '--no-scan', '--console=plain', '--stacktrace', '--gradle-user-home', $gradleUserHome)
if (-not $NoProxy -and -not [string]::IsNullOrWhiteSpace($Proxy)) {
    if ($Proxy -notmatch '^https?://') { $Proxy = 'http://' + $Proxy }
    $proxyUri = [Uri]$Proxy
    if ([string]::IsNullOrWhiteSpace($proxyUri.Host)) { throw 'Invalid proxy address.' }
    $gradleArguments += @("-Dhttp.proxyHost=$($proxyUri.Host)", "-Dhttp.proxyPort=$($proxyUri.Port)", "-Dhttps.proxyHost=$($proxyUri.Host)", "-Dhttps.proxyPort=$($proxyUri.Port)")
}
$gradleArguments += $Tasks
$logPath = Join-Path $verificationRoot ('gradle-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$previousEnvironment = @{}
foreach ($environmentName in @('JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','GRADLE_USER_HOME')) {
    $previousEnvironment[$environmentName] = [Environment]::GetEnvironmentVariable($environmentName, 'Process')
}

Push-Location -LiteralPath $projectRoot
try {
    $env:JAVA_HOME = $JdkPath
    $env:ANDROID_HOME = $SdkPath
    $env:ANDROID_SDK_ROOT = $SdkPath
    $env:GRADLE_USER_HOME = $gradleUserHome
    Write-Host "Project: $projectRoot"
    Write-Host "JDK: $JdkPath"
    Write-Host "SDK: $SdkPath"
    Write-Host "Log: $logPath"
    & $gradleCommand @gradleArguments 2>&1 | Tee-Object -FilePath $logPath
    if ($LASTEXITCODE -ne 0) { throw "Gradle exited with code $LASTEXITCODE. See $logPath" }
    $apkPath = Join-Path $projectRoot 'app\build\outputs\apk\debug\app-debug.apk'
    if (Test-Path -LiteralPath $apkPath) { Write-Host ('APK: ' + $apkPath) }
}
finally {
    Pop-Location
    foreach ($environmentName in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($environmentName, $previousEnvironment[$environmentName], 'Process')
    }
}
