# start.ps1 -- 启动 ZLMeetServer
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$BinDir     = Join-Path $BackendDir 'bin'
$Binary     = Join-Path $BinDir 'ZLMeetServer.exe'
$Config     = Join-Path $BinDir 'conf\config.yaml'

if (-not (Test-Path -LiteralPath $Binary)) {
    Write-Error "[错误] 未找到可执行文件: $Binary`n       请先执行: $ScriptDir\build.bat"
    exit 1
}
if (-not (Test-Path -LiteralPath $Config)) {
    Write-Error "[错误] 未找到配置文件: $Config`n       请先执行: $ScriptDir\build.bat"
    exit 1
}

Write-Host "==> 启动 ZLMeetServer"
Write-Host "    二进制:   $Binary"
Write-Host "    配置:     $Config"
Write-Host "    工作目录: $BinDir"
Write-Host ""

Set-Location -LiteralPath $BinDir
& $Binary -config 'conf\config.yaml'
exit $LASTEXITCODE
