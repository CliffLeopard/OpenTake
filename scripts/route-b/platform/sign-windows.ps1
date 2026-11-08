# Sign Route B Windows native addons with Authenticode.
#
# Requires a Windows runner with the Windows SDK (signtool) and the certificate
# supplied as environment secrets:
#   WINDOWS_CERTIFICATE_PFX_BASE64   .pfx file, base64-encoded
#   WINDOWS_CERTIFICATE_PASSWORD     .pfx password
# Optional:
#   WINDOWS_TIMESTAMP_URL            default https://timestamp.digicert.com
#
# Without the secrets this prints SKIP and exits 0 (unsigned CI artifact); with
# -Require it exits 78. This file is a template: it cannot be executed on the
# macOS development host and has not been locally validated.
param(
    [switch]$Require
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$PluginDir = Join-Path $RepoRoot 'plugins\opentake-studio-route-b'

$pfxBase64 = $env:WINDOWS_CERTIFICATE_PFX_BASE64
$pfxPassword = $env:WINDOWS_CERTIFICATE_PASSWORD

if (-not $pfxBase64 -or -not $pfxPassword) {
    if ($Require) {
        Write-Error 'WINDOWS_CERTIFICATE_PFX_BASE64 / WINDOWS_CERTIFICATE_PASSWORD are required but unset'
        exit 78
    }
    Write-Host 'sign-windows: SKIP (no WINDOWS_CERTIFICATE_PFX_BASE64; unsigned artifacts)'
    exit 0
}

function Resolve-SignTool {
    $command = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $kits = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "$env:ProgramFiles\Windows Kits\10\bin"
    ) | Where-Object { $_ -and (Test-Path $_) }
    foreach ($kit in $kits) {
        $candidate = Get-ChildItem -Path $kit -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    return $null
}

$signtool = Resolve-SignTool
if (-not $signtool) {
    if ($Require) {
        Write-Error 'signtool.exe not found (install the Windows SDK)'
        exit 78
    }
    Write-Host 'sign-windows: SKIP (signtool.exe not found; unsigned artifacts)'
    exit 0
}

$timestamp = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("route-b-sign-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
$pfxPath = Join-Path $tempDir 'certificate.pfx'

try {
    [System.IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($pfxBase64))

    $binaries = Get-ChildItem -Path (Join-Path $PluginDir 'native') -Recurse -Filter '*.node' -File
    if (-not $binaries) {
        throw "no native/*/*.node binaries under $PluginDir"
    }
    foreach ($binary in $binaries) {
        & $signtool sign /fd SHA256 /tr $timestamp /td SHA256 /f $pfxPath /p $pfxPassword $binary.FullName
        if ($LASTEXITCODE -ne 0) { throw "signtool sign failed for $($binary.FullName)" }
        & $signtool verify /pa /v $binary.FullName
        if ($LASTEXITCODE -ne 0) { throw "signtool verify failed for $($binary.FullName)" }
        Write-Host "sign-windows: signed $($binary.FullName)"
    }
    Write-Host 'sign-windows: OK'
}
finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}
