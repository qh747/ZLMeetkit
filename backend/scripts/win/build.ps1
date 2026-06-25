# build.ps1 -- ZLMeetkit Windows 构建脚本
# 用法：直接由 build.bat 调用，或手动执行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ---- 路径定位 ----
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir  = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$SrcDir      = Join-Path $BackendDir 'src'
$BinDir      = Join-Path $BackendDir 'bin'
$ConfDir     = Join-Path $BinDir 'conf'
$CertDir     = Join-Path $BinDir 'cert'
$Binary      = Join-Path $BinDir 'ZLMeetServer.exe'
$ConfigExample = Join-Path $BackendDir 'conf\config-example.yaml'
$ConfigDst   = Join-Path $ConfDir 'config.yaml'

Write-Host "==> 后端源码目录: $SrcDir"
Write-Host "==> 输出目录:     $BinDir"

# ---- 检查 Go ----
$go = Get-Command go -ErrorAction SilentlyContinue
if (-not $go) {
    Write-Error "[错误] 未找到 go 命令，请先安装 Go 1.21+ 并把 go.exe 加入 PATH"
    exit 1
}
$goVerLine = (& go version) -join ''
Write-Host "==> Go 版本: $goVerLine"
if ($goVerLine -match 'go(\d+)\.(\d+)') {
    $maj = [int]$Matches[1]; $min = [int]$Matches[2]
    if ($maj -lt 1 -or ($maj -eq 1 -and $min -lt 21)) {
        Write-Error "[错误] 需要 Go 1.21+，当前: $goVerLine"
        exit 1
    }
} else {
    Write-Warning "[警告] 无法解析 Go 版本字符串，跳过版本校验"
}

# ---- 创建目录 ----
foreach ($d in @($BinDir, $ConfDir, $CertDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Write-Host "==> 目录已就绪: bin\  bin\conf\  bin\cert\"

# ---- 生成运行时配置 ----
if (-not (Test-Path -LiteralPath $ConfigDst)) {
    if (-not (Test-Path -LiteralPath $ConfigExample)) {
        Write-Error "[错误] 找不到配置模板: $ConfigExample"
        exit 1
    }
    Copy-Item -LiteralPath $ConfigExample -Destination $ConfigDst -Force

    $text = Get-Content -LiteralPath $ConfigDst -Raw -Encoding UTF8
    $text = [regex]::Replace($text, '(?m)^\s*static_dir:.*$', 'static_dir: "../../frontend"')
    $text = [regex]::Replace($text, '(?m)^\s*tls_cert:.*$',  'tls_cert: "cert/cert.pem"')
    $text = [regex]::Replace($text, '(?m)^\s*tls_key:.*$',   'tls_key:  "cert/key.pem"')
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ConfigDst, $text, $utf8NoBom)

    Write-Host "==> 已生成配置文件: $ConfigDst"
    Write-Host "    请按需修改 zlm.api_base 和 zlm.secret"
} else {
    Write-Host "==> 配置文件已存在，跳过生成: $ConfigDst"
}

# ---- 拉取依赖 ----
Write-Host "==> 正在执行 go mod tidy ..."
Push-Location $SrcDir
try {
    & go mod tidy
    if ($LASTEXITCODE -ne 0) { Write-Error "[错误] go mod tidy 失败"; exit 1 }
} finally { Pop-Location }

# ---- 编译 ----
Write-Host "==> 正在编译 ..."
Push-Location $SrcDir
try {
    & go build -trimpath -ldflags "-s -w" -o $Binary .\cmd
    if ($LASTEXITCODE -ne 0) { Write-Error "[错误] 编译失败"; exit 1 }
} finally { Pop-Location }

Write-Host ""
Write-Host "[OK] 编译完成: $Binary"
Write-Host ""
Write-Host "后续步骤："
Write-Host "  1. 编辑配置:  notepad `"$ConfigDst`""
Write-Host "  2. 如需 HTTPS，将证书放入: $CertDir\"
Write-Host "     文件名: cert.pem  key.pem"
Write-Host "  3. 启动服务:  $ScriptDir\start.bat"
exit 0
