<#
  proxy-url.ps1 —— 输出 dsh-lqconfig 当前代理地址（动态，不写死端口）。

  地址来源：dsh-lqconfig 宿主侧写出的状态文件
    %USERPROFILE%\.dsh\lqconfig-proxy.json（存在 $env:DSH_HOME 时在它下面）
  内容形如 { "proxy": "http://127.0.0.1:xxxx", "running": true, ... }。
  端口只是文件里的一个值：代理改端口、重启、换节点后本脚本自动跟随，
  调用方不需要知道具体端口。

  用法：
    pwsh -NoProfile -File proxy-url.ps1                    # 输出 http://127.0.0.1:<port>
    pwsh -NoProfile -File proxy-url.ps1 -Scheme socks5h    # 输出 socks5h://127.0.0.1:<port>
    pwsh -NoProfile -File proxy-url.ps1 -Check             # 只输出 true / false
    pwsh -NoProfile -File proxy-url.ps1 -EndpointPath <路径>  # 指定状态文件（排错用）

  取不到、代理未运行或端口不通时：stdout 为空，退出码 1，
  调用方据此回退直连，绝不在此脚本内猜端口。
#>
[CmdletBinding()]
param(
  [string]$EndpointPath = '',
  [ValidateSet('http', 'socks5h')][string]$Scheme = 'http',
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

function Write-Result([bool]$ok, [string]$url) {
  if ($Check) {
    Write-Output ($(if ($ok) { 'true' } else { 'false' }))
  } elseif ($ok) {
    Write-Output $url
  }
  if (-not $ok) { exit 1 }
  exit 0
}

try {
  if ([string]::IsNullOrWhiteSpace($EndpointPath)) {
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $EndpointPath = Join-Path $dshHome 'lqconfig-proxy.json'
  }
  if (-not (Test-Path -LiteralPath $EndpointPath)) { Write-Result $false '' }

  $record = Get-Content -LiteralPath $EndpointPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $raw = [string]$record.proxy
  if ([string]::IsNullOrWhiteSpace($raw)) { Write-Result $false '' }

  $uri = [System.Uri]$raw
  $proxyHost = $uri.Host
  $proxyPort = $uri.Port

  # 端口探测：文件可能是上次运行留下的，代理已经退出时不能把死地址交给调用方
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($proxyHost, $proxyPort)
    if (-not $task.Wait(800)) { Write-Result $false '' }
    if (-not $client.Connected) { Write-Result $false '' }
  } finally {
    try { $client.Close() } catch { }
  }

  $url = if ($Scheme -eq 'socks5h') { "socks5h://${proxyHost}:${proxyPort}" } else { "http://${proxyHost}:${proxyPort}" }
  Write-Result $true $url
} catch {
  Write-Result $false ''
}
