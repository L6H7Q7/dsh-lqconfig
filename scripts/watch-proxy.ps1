[CmdletBinding()]
param(
  [int]$IntervalSec = 2,
  [int]$GraceSeconds = 8
)

$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$dataDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir '..\proxy-data'))
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }

$stopFile = Join-Path $dataDir 'watch.stop'
$logFile  = Join-Path $dataDir 'watch.log'
$pidFile  = Join-Path $dataDir 'watch.pid'
$sysProxy = Join-Path $scriptDir 'system-proxy.ps1'

function Write-Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  try { Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
  Write-Host $line
}

try { Set-Content -Path $pidFile -Value $PID -Encoding ASCII -ErrorAction SilentlyContinue } catch { }

Write-Log "[watch] started pid=$PID interval=${IntervalSec}s grace=${GraceSeconds}s"

# 内核重启（kill + 拉起）通常 2~4 秒，这个窗口不能当成「真死」，
# 否则插件自己重启内核时会被看门狗误判并关掉系统代理。
$missingSince = $null

while ($true) {
  if (Test-Path $stopFile) {
    Write-Log '[watch] stop file detected, exiting'
    break
  }
  try {
    $mihomo = Get-Process -Name 'mihomo' -ErrorAction SilentlyContinue
    if ($mihomo) {
      if ($null -ne $missingSince) {
        Write-Log '[watch] kernel came back, cancel pending shutdown'
        $missingSince = $null
      }
    } else {
      if ($null -eq $missingSince) {
        $missingSince = Get-Date
        Write-Log ("[watch] kernel missing, waiting {0}s grace before restoring" -f $GraceSeconds)
      } elseif (((Get-Date) - $missingSince).TotalSeconds -ge $GraceSeconds) {
        & $sysProxy -Action 'disable' | Out-Null
        Write-Log ("[watch] kernel gone for {0}s -> system proxy restored" -f $GraceSeconds)
        Start-Sleep -Seconds 2
        Write-Log '[watch] exiting'
        break
      }
    }
  } catch {
    Write-Log "[watch] error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $IntervalSec
}

try { Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue } catch { }
