<#
  focus-explorer.ps1 - reuse an already open File Explorer window instead of
  spawning a duplicate one.

  Read-only probe by default; the window is only raised when a matching window
  exists. Nothing is opened here: the caller keeps its own explorer.exe launch
  path (and its own failure reporting) for the miss case.

  Usage:
    powershell -NoProfile -File focus-explorer.ps1 -Target "D:\dir" -Mode directory
    powershell -NoProfile -File focus-explorer.ps1 -Target "D:\dir\a.txt" -Mode file -Select
    powershell -NoProfile -File focus-explorer.ps1 -Target "D:\dir" -Mode directory -Check

  Exit code 0 for a normal answer (found or not found), 1 when the probe itself
  failed. stdout carries exactly one compact JSON line.
#>
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [ValidateSet('directory', 'file')][string]$Mode = 'directory',
  [switch]$Select,
  [switch]$Check,
  [int]$Attempts = 3
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Emit([hashtable]$data, [int]$code) {
  [Console]::Out.Write(($data | ConvertTo-Json -Compress -Depth 4))
  exit $code
}

# Explorer shows the real filesystem path, not the launch argument: strip the
# trailing separator and keep drive roots intact so both sides compare equal.
function Normalize-Path([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  $full = [System.IO.Path]::GetFullPath($value)
  if ($full -match '^[A-Za-z]:[\\/]$') { return $full.Substring(0, 2) + '\' }
  return $full.TrimEnd('\', '/')
}

Add-Type -Namespace LqFocus -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, int e);
'@

try {
  $full = [System.IO.Path]::GetFullPath($Target)
  $selecting = $Mode -eq 'file'
  $want = if ($selecting) { Normalize-Path ([System.IO.Path]::GetDirectoryName($full)) } else { Normalize-Path $full }
  $leaf = if ($selecting) { [System.IO.Path]::GetFileName($full) } else { '' }
  if ([string]::IsNullOrEmpty($want)) { Emit @{ ok = $false; found = $false; error = 'invalid-path' } 1 }

  $shell = New-Object -ComObject Shell.Application
  $hit = $null
  $hitPath = ''
  foreach ($w in @($shell.Windows())) {
    try {
      $p = [string]$w.Document.Folder.Self.Path
      if ([string]::IsNullOrEmpty($p)) { continue }
      if ((Normalize-Path $p) -ieq $want) { $hit = $w; $hitPath = $p; break }
    } catch { continue }
  }

  if ($null -eq $hit) { Emit @{ ok = $true; found = $false; mode = 'missing'; want = $want } 0 }
  if ($Check) { Emit @{ ok = $true; found = $true; mode = 'check'; want = $want; window = $hitPath } 0 }

  $h = [IntPtr]([int64]$hit.HWND)
  # Win11 tabs: an inactive tab reports its own hidden HWND, so always raise the
  # top-level ancestor rather than the raw handle.
  $root = [LqFocus.Native]::GetAncestor($h, 2)
  if ($root.ToInt64() -eq 0) { $root = $h }

  # An inactive tab must become active before its window can take the foreground.
  try { $hit.Visible = $true } catch { }

  # Windows 11 refuses SetForegroundWindow from a background process. Synthesize
  # an Alt tap to clear the foreground lock, then borrow the foreground thread's
  # input queue while raising the window.
  $forced = $false
  for ($i = 0; $i -lt $Attempts; $i++) {
    $fg = [LqFocus.Native]::GetForegroundWindow()
    $fp = [uint32]0
    $fgTid = [LqFocus.Native]::GetWindowThreadProcessId($fg, [ref]$fp)
    $curTid = [LqFocus.Native]::GetCurrentThreadId()
    [LqFocus.Native]::keybd_event(0x12, 0, 0, 0)
    [LqFocus.Native]::keybd_event(0x12, 0, 2, 0)
    if ($fgTid -ne 0) { [void][LqFocus.Native]::AttachThreadInput($curTid, $fgTid, $true) }
    [void][LqFocus.Native]::ShowWindow($root, 9)
    [void][LqFocus.Native]::BringWindowToTop($root)
    [void][LqFocus.Native]::SetForegroundWindow($root)
    if ($fgTid -ne 0) { [void][LqFocus.Native]::AttachThreadInput($curTid, $fgTid, $false) }
    Start-Sleep -Milliseconds 120
    $now = [LqFocus.Native]::GetForegroundWindow()
    if (($now.ToInt64() -eq $root.ToInt64()) -or
        ([LqFocus.Native]::GetAncestor($now, 2).ToInt64() -eq $root.ToInt64())) { $forced = $true; break }
  }

  # Select the file only after the window is in front: the shell view refuses to
  # scroll while it is in the background, and UI Automation needs it rendered.
  $selected = $false
  $scrolled = $false
  if ($selecting -and $Select) {
    try {
      $folder = $shell.Namespace((Split-Path -Parent $full))
      if ($null -ne $folder) {
        $item = $folder.ParseName($leaf)
        if ($null -ne $item) {
          # SVSI_SELECT | SVSI_DESELECTOTHERS | SVSI_ENSUREVISIBLE | SVSI_FOCUSED
          $hit.Document.SelectItem($item, 0x1D)
          $sel = $hit.Document.SelectedItems()
          $selected = ($null -ne $sel -and $sel.Count -ge 1)
        }
      }
    } catch { $selected = $false }

    # The Win11 detail view ignores SVSI_ENSUREVISIBLE, so scroll it explicitly.
    if ($selected) {
      try {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $uia = [System.Windows.Automation.AutomationElement]::FromHandle($root)
        $byName = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NameProperty, $leaf)
        $byType = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
        $both = New-Object System.Windows.Automation.AndCondition($byName, $byType)
        $el = $uia.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $both)
        if ($null -eq $el) { $el = $uia.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $byName) }
        if ($null -ne $el) {
          $el.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView()
          $scrolled = $true
        }
      } catch { $scrolled = $false }
    }
  }

  Emit @{
    ok = $true; found = $true; mode = 'focused'; want = $want; window = $hitPath
    hwnd = $root.ToInt64(); foreground = $forced
    visible = [LqFocus.Native]::IsWindowVisible($root); selected = $selected; scrolled = $scrolled
  } 0
} catch {
  Emit @{ ok = $false; found = $false; error = 'probe-failed'; detail = [string]$_.Exception.Message } 1
}
