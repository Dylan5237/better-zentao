# Thin transport shim for better-zentao-release. Child of linux-server-ops invoke-with-local-credentials.ps1.
# Reads a JSON params file {action, host, user, hostKeyMd5, plinkPath, pscpPath, sshKeyPath, requiredKey, file, remoteDir};
# runs plink (action=run, LF-normalized) or pscp (action=upload). Zero hardcoded hosts or secrets.
# Auth precedence:
#   1. Dedicated PuTTY private key (-i sshKeyPath) if configured and present (recommended, avoids password args).
#   2. -pwfile <ephemeral-file> if installed PuTTY >= 0.77 supports it (avoids password in process cmdline).
#   3. -pw <env-value> fallback ONLY for legacy PuTTY < 0.77 where key auth is unavailable on the host.
param([Parameter(Mandatory)][string]$ParamsJson)
$ErrorActionPreference = 'Stop'

$p = Get-Content -LiteralPath $ParamsJson -Raw -Encoding UTF8 | ConvertFrom-Json
$plink = if ($p.plinkPath) { [string]$p.plinkPath } else { 'C:\Program Files (x86)\PuTTY\plink.exe' }
$pscp = if ($p.pscpPath) { [string]$p.pscpPath } else { 'C:\Program Files (x86)\PuTTY\pscp.exe' }
$hostKeyMd5 = [string]$p.hostKeyMd5
$targetHost = [string]$p.host
$sshUser = if ($p.user) { [string]$p.user } else { 'root' }
$sshKeyPath = if ($p.sshKeyPath) { [string]$p.sshKeyPath } else { '' }
$requiredKey = if ($p.requiredKey) { [string]$p.requiredKey } else { 'FUXI_SSH_PASSWORD' }

if ([string]::IsNullOrWhiteSpace($targetHost)) { throw 'TARGET_HOST_MISSING' }
if ([string]::IsNullOrWhiteSpace($hostKeyMd5)) { throw 'HOST_KEY_MD5_MISSING' }

$target = "${sshUser}@${targetHost}"
$pwFile = $null
$authArgs = @()

function Test-PuttySupportsPwfile([string]$exe) {
  try {
    $help = (& $exe -help 2>&1 | Out-String)
    return ($help -match '-pwfile')
  } catch { return $false }
}

try {
  if (-not [string]::IsNullOrWhiteSpace($sshKeyPath) -and (Test-Path -LiteralPath $sshKeyPath)) {
    $authArgs = @('-i', $sshKeyPath)
  } else {
    $pw = [Environment]::GetEnvironmentVariable($requiredKey, 'Process')
    if ([string]::IsNullOrWhiteSpace($pw)) {
      throw "SSH_PASSWORD_MISSING ($requiredKey): run through invoke-with-local-credentials.ps1"
    }
    $exeForCheck = if ($p.action -eq 'upload') { $pscp } else { $plink }
    if (Test-PuttySupportsPwfile $exeForCheck) {
      $pwFile = Join-Path ([IO.Path]::GetTempPath()) ("bzt-pw-" + [Guid]::NewGuid().ToString('N') + '.tmp')
      [IO.File]::WriteAllText($pwFile, $pw, (New-Object Text.UTF8Encoding($false)))
      $authArgs = @('-pwfile', $pwFile)
    } else {
      $authArgs = @('-pw', $pw)
    }
  }

  if ($p.action -eq 'run') {
    if (-not (Test-Path -LiteralPath $plink)) { throw "PLINK_NOT_FOUND: $plink" }
    if (-not (Test-Path -LiteralPath $p.file)) { throw "FILE_NOT_FOUND: $($p.file)" }
    $text = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $p.file))
    $text = $text -replace "`r`n", "`n"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("bzt-remote-" + [Guid]::NewGuid().ToString('N') + '.sh')
    [IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding($false)))
    try {
      & $plink -batch -ssh @authArgs -hostkey $hostKeyMd5 $target -m $tmp
      exit $LASTEXITCODE
    } finally {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
  } elseif ($p.action -eq 'upload') {
    if (-not (Test-Path -LiteralPath $pscp)) { throw "PSCP_NOT_FOUND: $pscp" }
    if (-not (Test-Path -LiteralPath $p.file)) { throw "FILE_NOT_FOUND: $($p.file)" }
    $rd = [string]$p.remoteDir
    if ([string]::IsNullOrWhiteSpace($rd)) { throw 'REMOTE_DIR_MISSING' }
    & $pscp -batch @authArgs -hostkey $hostKeyMd5 $p.file "${target}:$rd"
    exit $LASTEXITCODE
  } else {
    throw "UNKNOWN_ACTION: $($p.action)"
  }
} finally {
  if ($pwFile -and (Test-Path -LiteralPath $pwFile)) {
    Remove-Item -LiteralPath $pwFile -Force -ErrorAction SilentlyContinue
  }
}
