<#
  balance.ps1 —— 读取 DeepSeek 平台账号余额，输出一行「¥xx.xx CNY」。

  数据源与 DSH 账号服务、dsh-pet 气泡完全一致（依据 app.asar 内
  @deepseek-ai/dsh-deepseek-account-platform 的 README）：
    凭证  : $DSH_HOME\.credentials.yaml 里 deepseek-account-platform/default 的 payload.token
    接口  : GET https://platform.deepseek.com/api/v0/users/get_user_summary
    请求头: x-dsh-auth-token
    出口  : 优先直连（-NoProxy，绕开可能指向死端口的系统代理）；直连失败再用 lqconfig
            当前代理重试，地址读 $DSH_HOME\lqconfig-proxy.json（动态端口，不写死）。

  注意：token 是 base64，可能含 + / = ，必须整行取用，禁止用字符白名单正则截断。
  （2026-10-08 实测：截断到 61 位时平台返回 40003 Authorization Failed。）

  档位（-Tier）：按北京时间判定 DeepSeek 峰谷计价档，口径与 dsh-pet 完全一致
  （对应 dsh-pet/src/host/balance/deepseek-common.ts 的 deepseekPricingTier）：
    工作日 9:00–12:00、14:00–18:00  -> peak（峰，🔴，标准价）
    其余时段以及周六/周日全天        -> idle（谷，🟢，官方低谷价为高峰价的一半）

  用法：
    pwsh -NoProfile -File balance.ps1            # 只输出余额行（原样）
    pwsh -NoProfile -File balance.ps1 -Tier      # 余额行追加「🟢谷 / 🔴峰」
    pwsh -NoProfile -File balance.ps1 -Detail    # 追加赠送钱包、pet 口径合计、档位说明
    pwsh -NoProfile -File balance.ps1 -Json      # 输出一行 JSON（宿主/插件用；优先于 -Detail）
  失败：输出「取数失败」并返回退出码 1，绝不伪造 0 余额。
  -Json 失败时输出 {"ok":false,"error":"..."}，退出码仍为 1。
#>
[CmdletBinding()]
param(
  [string]$CredentialsPath = (Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'),
  [switch]$Detail,
  [switch]$Tier,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
# 被 Node spawn 捕获时，stdout 默认按系统 ANSI 代码页（中文 Windows 为 936）编码，
# 调用方按 UTF-8 解码会把「¥」和档位 emoji 变成 U+FFFD。这里强制 UTF-8 输出。
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
$invariant = [System.Globalization.CultureInfo]::InvariantCulture

function Get-MoneyText([double]$amount, [string]$currency) {
  return [string]::Format($invariant, '¥{0:F2} {1}', $amount, $currency)
}

# 北京时间当前时刻（与 dsh-pet 的口径来源一致：Asia/Shanghai）
function Get-BeijingNow {
  foreach ($tzId in @('China Standard Time', 'Asia/Shanghai')) {
    try { return [System.TimeZoneInfo]::ConvertTimeFromUtc([System.DateTime]::UtcNow, [System.TimeZoneInfo]::FindSystemTimeZoneById($tzId)) } catch { }
  }
  return [System.DateTime]::Now
}

# 峰谷档位：工作日 9:00–12:00、14:00–18:00 为 peak；其余（含周六/周日全天）为 idle
function Get-PricingTier([System.DateTime]$BeijingNow) {
  if ($BeijingNow.DayOfWeek -eq [System.DayOfWeek]::Saturday -or $BeijingNow.DayOfWeek -eq [System.DayOfWeek]::Sunday) { return 'idle' }
  $h = $BeijingNow.Hour
  if (($h -ge 9 -and $h -lt 12) -or ($h -ge 14 -and $h -lt 18)) { return 'peak' }
  return 'idle'
}

function Get-TierText([string]$tier) {
  if ($tier -eq 'peak') { return '🔴峰' }
  return '🟢谷'
}

# lqconfig 当前代理地址：读宿主写出的状态文件并探测端口，不写死端口。
# 返回 'http://127.0.0.1:<port>'；文件缺失、代理关闭或端口不通时返回空串（调用方直连）。
# 状态文件由 dsh-lqconfig 在代理预热/启动/改端口/停止时刷新，见 scripts/proxy-url.ps1 同源逻辑。
function Get-LqProxyUrl {
  try {
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $endpoint = Join-Path $dshHome 'lqconfig-proxy.json'
    if (-not (Test-Path -LiteralPath $endpoint)) { return '' }
    $record = Get-Content -LiteralPath $endpoint -Raw -Encoding UTF8 | ConvertFrom-Json
    $raw = [string]$record.proxy
    if ([string]::IsNullOrWhiteSpace($raw)) { return '' }
    $uri = [System.Uri]$raw
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $task = $client.ConnectAsync($uri.Host, $uri.Port)
      if (-not $task.Wait(800)) { return '' }
      if (-not $client.Connected) { return '' }
    } finally {
      try { $client.Close() } catch { }
    }
    return 'http://' + $uri.Host + ':' + $uri.Port
  } catch { return '' }
}

function Stop-WithFailure([string]$reason) {
  if ($Json) {
    $fail = [ordered]@{ ok = $false; error = [string]$reason }
    Write-Output ($fail | ConvertTo-Json -Compress)
  } else {
    Write-Output '取数失败'
    if ($Detail -and $reason) { Write-Output $reason }
  }
  exit 1
}

try {
  if (-not (Test-Path -LiteralPath $CredentialsPath)) { Stop-WithFailure "凭证文件不存在：$CredentialsPath" }

  $lines = @(Get-Content -LiteralPath $CredentialsPath -Encoding UTF8)
  $keyIndex = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*deepseek-account-platform/default\s*:') { $keyIndex = $i; break }
  }
  if ($keyIndex -lt 0) { Stop-WithFailure '凭据里找不到 deepseek-account-platform/default 记录' }

  $token = ''
  for ($i = $keyIndex; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*token\s*:\s*(.+?)\s*$') { $token = $Matches[1].Trim([char]39, [char]34); break }
  }
  if ([string]::IsNullOrWhiteSpace($token)) { Stop-WithFailure '凭据里找不到 token 字段' }

  # 出口顺序：优先直连（本机实测平台直连可用且更快），直连失败再用 lqconfig 当前代理重试；
  # 代理地址来自宿主写出的状态文件（动态端口，不写死）。
  # 两段超时必须分别压短：宿主侧总超时 20 秒，直连 8 秒 + 代理 10 秒仍在预算内。
  $uri = 'https://platform.deepseek.com/api/v0/users/get_user_summary'
  $headers = @{ 'x-dsh-auth-token' = $token }
  $response = $null
  $directError = $null
  try {
    $response = Invoke-RestMethod -Method Get -TimeoutSec 8 -Uri $uri -Headers $headers -NoProxy
  } catch {
    $directError = $_.Exception.Message
  }
  if ($null -eq $response) {
    $proxyUrl = Get-LqProxyUrl
    if (-not $proxyUrl) {
      Stop-WithFailure ('直连失败：{0}；lqconfig 代理未运行或地址不可用，未做代理重试' -f $directError)
    }
    try {
      $response = Invoke-RestMethod -Method Get -TimeoutSec 10 -Uri $uri -Headers $headers -Proxy $proxyUrl
    } catch {
      Stop-WithFailure ('直连失败：{0}；代理 {1} 也失败：{2}' -f $directError, $proxyUrl, $_.Exception.Message)
    }
  }

  if ($response.code -ne 0) {
    $msg = if ($response.msg) { [string]$response.msg } else { '未知业务错误' }
    Stop-WithFailure ('平台返回 code={0}: {1}' -f $response.code, $msg)
  }

  $biz = $response.data.biz_data
  $normal = @($biz.normal_wallets)
  if ($normal.Count -eq 0) { Stop-WithFailure '账号没有可展示的充值钱包余额' }

  $normalSum = 0.0
  foreach ($wallet in $normal) { $normalSum += [double]$wallet.balance }
  $currency = if ($normal[0].currency) { [string]$normal[0].currency } else { 'CNY' }

  $beijingNow = Get-BeijingNow
  $tierKey = Get-PricingTier $beijingNow
  $tierText = Get-TierText $tierKey

  $balanceLine = Get-MoneyText $normalSum $currency
  if ($Json) {
    $payload = [ordered]@{
      ok        = $true
      balance   = [string]::Format($invariant, '{0:F2}', $normalSum)
      currency  = $currency
      text      = $balanceLine
      tier      = $tierKey
      tierText  = $tierText
      checkedAt = (Get-BeijingNow).ToString('yyyy-MM-dd HH:mm:ss')
    }
    Write-Output ($payload | ConvertTo-Json -Compress)
    return
  }
  if ($Tier) { $balanceLine = $balanceLine + ' ' + $tierText }
  Write-Output $balanceLine

  if ($Detail) {
    $bonusSum = 0.0
    foreach ($wallet in @($biz.bonus_wallets)) { $bonusSum += [double]$wallet.balance }
    Write-Output ('赠送钱包：' + (Get-MoneyText $bonusSum $currency))
    Write-Output ('pet 口径合计（赠送+充值）：' + (Get-MoneyText ($normalSum + $bonusSum) $currency))
    $tierDesc = if ($tierKey -eq 'peak') { '高峰，按标准价计费' } else { '低谷，官方低谷价为高峰价的一半' }
    Write-Output ('计价档位：' + $tierText + '（' + $tierDesc + '）')
    Write-Output ('判定时刻（北京时间）：' + $beijingNow.ToString('yyyy-MM-dd HH:mm dddd') + '；工作日 9:00–12:00、14:00–18:00 为峰，其余时段及周末全天为谷')
  }
} catch {
  Stop-WithFailure $_.Exception.Message
}
