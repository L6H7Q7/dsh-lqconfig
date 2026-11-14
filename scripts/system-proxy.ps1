[CmdletBinding()]
param(
  [ValidateSet('enable','disable','status')]
  [string]$Action = 'status',
  [int]$Port = 7910
)

$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$dataDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\proxy-data'))
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
$backup = Join-Path $dataDir 'system-proxy-backup.json'

function Send-WinINetRefresh {
  try {
    $sig = @'
[DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@
    $t = Add-Type -Namespace LqSysProxy -Name WinInet -MemberDefinition $sig -PassThru
    [void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
    [void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
  } catch { }
}

function Read-Backup {
  if (-not (Test-Path $backup)) { return $null }
  try { return (Get-Content $backup -Raw | ConvertFrom-Json) } catch { return $null }
}

switch ($Action) {
  'status' {
    $cur = Get-ItemProperty -Path $key
    $snap = [ordered]@{
      ProxyEnable   = [int]$cur.ProxyEnable
      ProxyServer   = [string]$cur.ProxyServer
      ProxyOverride = [string]$cur.ProxyOverride
      hasBackup     = (Test-Path $backup)
    }
    $snap | ConvertTo-Json -Compress
  }
  'enable' {
    if (-not (Test-Path $backup)) {
      $cur = Get-ItemProperty -Path $key
      $snap = [ordered]@{
        ProxyEnable   = [int]$cur.ProxyEnable
        ProxyServer   = [string]$cur.ProxyServer
        ProxyOverride = [string]$cur.ProxyOverride
        AutoConfigURL = [string]$cur.AutoConfigURL
        SavedAt       = (Get-Date).ToString('o')
      }
      ($snap | ConvertTo-Json) | Set-Content -Path $backup -Encoding UTF8
    }
    Set-ItemProperty -Path $key -Name 'ProxyServer' -Value ('127.0.0.1:' + $Port)
    Set-ItemProperty -Path $key -Name 'ProxyEnable' -Value 1
    Send-WinINetRefresh
    'enabled'
  }
  'disable' {
    $b = Read-Backup
    if ($null -ne $b) {
      Set-ItemProperty -Path $key -Name 'ProxyServer'   -Value ([string]$b.ProxyServer)
      Set-ItemProperty -Path $key -Name 'ProxyOverride' -Value ([string]$b.ProxyOverride)
      if ([string]::IsNullOrEmpty([string]$b.AutoConfigURL)) {
        Remove-ItemProperty -Path $key -Name 'AutoConfigURL' -ErrorAction SilentlyContinue
      } else {
        Set-ItemProperty -Path $key -Name 'AutoConfigURL' -Value ([string]$b.AutoConfigURL)
      }
      Set-ItemProperty -Path $key -Name 'ProxyEnable' -Value ([int]$b.ProxyEnable)
    } else {
      Set-ItemProperty -Path $key -Name 'ProxyEnable' -Value 0
    }
    Send-WinINetRefresh
    'disabled'
  }
}
