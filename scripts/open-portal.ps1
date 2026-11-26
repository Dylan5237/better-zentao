$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$port = 17329
$origin = "http://127.0.0.1:$port"
$profileDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
$handoff = Join-Path $profileDir ".better-zentao\portal-launch\$port.html"

function Get-PortalInstance {
    $request = [System.Net.WebRequest]::Create("$origin/api/startup")
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 1200
    try {
        $response = $request.GetResponse()
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { $_.Exception.Response.Dispose() }
        return
    }
    try {
        $instance = $response.Headers['X-Bzt-Portal-Instance']
        if ($response.StatusCode -eq 200 -and $instance -cmatch '^[a-f0-9]{32}$') {
            return $instance
        }
    } finally {
        $response.Dispose()
    }
}

function Open-Portal([string] $instance) {
    $identity = '<meta name="bzt-portal-instance" content="' + $instance + '">'
    # The listen socket can become ready shortly before the handoff is published.
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $page = [System.IO.File]::ReadAllText($handoff)
            if ($page.Contains($identity)) {
                Start-Process -FilePath $handoff
                return
            }
        } catch [System.IO.IOException] {
        } catch [System.UnauthorizedAccessException] {
        }
        Start-Sleep -Milliseconds 100
    }
    Start-Process -FilePath $origin
}

function Test-PortInUse {
    $probe = [System.Net.Sockets.TcpClient]::new()
    try {
        $probe.Connect('127.0.0.1', $port)
        return $true
    } catch [System.Net.Sockets.SocketException] {
        return $false
    } finally {
        $probe.Dispose()
    }
}

function Invoke-Pnpm([string[]] $arguments) {
    if ($pnpm) {
        & $pnpm.Source @arguments
    } else {
        & $corepack.Source pnpm @arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw '准备门户依赖或构建失败，请检查上方信息。'
    }
}

function Test-DependenciesCurrent {
    if (!(Test-Path -LiteralPath 'node_modules/.bin/tsc.cmd' -PathType Leaf)) {
        return $false
    }
    $expected = Join-Path $repository 'pnpm-lock.yaml'
    $installed = Join-Path $repository 'node_modules/.pnpm/lock.yaml'
    if (![System.IO.File]::Exists($installed)) { return $false }
    return [System.IO.File]::ReadAllText($expected).Replace("`r`n", "`n") -ceq
        [System.IO.File]::ReadAllText($installed).Replace("`r`n", "`n")
}

function Test-BuildCurrent {
    $sourceRoot = Join-Path $repository 'src'
    $distRoot = Join-Path $repository 'dist'
    $entry = Join-Path $distRoot 'adapters/cli/bzt.js'
    if (![System.IO.File]::Exists($entry)) { return $false }
    $builtAt = [System.IO.File]::GetLastWriteTimeUtc($entry)
    $settings = Get-Item -LiteralPath 'tsconfig.json', 'tsconfig.build.json', 'package.json', 'pnpm-lock.yaml'
    foreach ($file in $settings) {
        if ($file.LastWriteTimeUtc -gt $builtAt) { return $false }
    }
    foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Filter '*.ts' -File -Recurse) {
        if ($file.Name.EndsWith('.d.ts')) {
            if ($file.LastWriteTimeUtc -gt $builtAt) { return $false }
            continue
        }
        $relative = $file.FullName.Substring($sourceRoot.Length + 1)
        $compiled = Join-Path $distRoot ([System.IO.Path]::ChangeExtension($relative, '.js'))
        if (![System.IO.File]::Exists($compiled) -or
            $file.LastWriteTimeUtc -gt [System.IO.File]::GetLastWriteTimeUtc($compiled)) {
            return $false
        }
    }
    return $true
}

$mutex = [System.Threading.Mutex]::new($false, "Local\better-zentao-portal-$port")
$locked = $false
try {
    try {
        $locked = $mutex.WaitOne(30000)
    } catch [System.Threading.AbandonedMutexException] {
        $locked = $true
    }
    if (!$locked) { throw '另一个启动窗口正在准备禅道工作台，请稍后重试。' }

    $instance = Get-PortalInstance
    if ($instance) {
        Open-Portal $instance
        exit 0
    }
    if (Test-PortInUse) { throw "端口 $port 已被其他程序占用。" }

    Set-Location -LiteralPath $repository
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if (!$node) { throw '需要安装 Node.js 24.11 或更高的 24.x 版本。' }
    $version = & $node.Source -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^24\.(\d+)\.' -or [int]$Matches[1] -lt 11) {
        throw '需要安装 Node.js 24.11 或更高的 24.x 版本。'
    }
    $mustInstall = !(Test-DependenciesCurrent)
    $mustBuild = $mustInstall -or !(Test-BuildCurrent)
    if ($mustBuild) {
        $pnpm = Get-Command pnpm.cmd -CommandType Application -ErrorAction SilentlyContinue
        $corepack = Get-Command corepack.cmd -CommandType Application -ErrorAction SilentlyContinue
        if (!$pnpm -and !$corepack) { throw '找不到 pnpm 或 Corepack，请安装其中一个后重试。' }
    }
    if ($mustInstall) {
        Write-Host '正在安装禅道工作台依赖…'
        Invoke-Pnpm @('install', '--frozen-lockfile')
    }
    if ($mustBuild) {
        Write-Host '正在构建禅道工作台…'
        Invoke-Pnpm @('run', 'build')
    }
    Write-Host '正在启动禅道工作台…'
    $service = Start-Process -FilePath $node.Source -ArgumentList @('--env-file-if-exists=.env', 'dist/adapters/cli/bzt.js', 'web') -WorkingDirectory $repository -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $instance = Get-PortalInstance
        if ($instance) {
            Open-Portal $instance
            exit 0
        }
        if ($service.HasExited) { break }
        Start-Sleep -Milliseconds 200
    }
    throw '门户启动失败，请在仓库目录执行 bzt web 或 corepack pnpm web 查看详情。'
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
