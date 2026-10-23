param(
  [int]$ProcId = 0,
  [string]$Send = "",
  [int]$GapMs = 90,
  [int]$PreSleepMs = 0,
  [string]$OutFile = "D:/ReBaseAgent/.workbuddy/r22-72/keys-out.txt"
)

# ASCII-only (PS 5.1 reads BOM-less files as ANSI -- same rule as u3-64/u3-65 helpers).
#
# Why this exists instead of u3-65-input.ps1's "keys" action: raising the window and
# sending the keystrokes must happen in the SAME process. Windows' foreground lock means
# a SetForegroundWindow from one process is often handed back the moment that process
# exits, so a second process's keybd_event lands on whatever took foreground again
# (measured 2026-10-21: focus was on the ReBaseAgent window per CDP, ENTER produced
# nothing). This script does: strong raise (input-rights trick + AttachThreadInput)
# -> optional pre-sleep -> keybd_event sequence, all before exiting.

$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KeysOps {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  public delegate bool EnumChildProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetFocus();
}
"@
Add-Type -TypeDefinition $sig

$script:best = [IntPtr]::Zero
$script:bestArea = -1
$cb = [KeysOps+EnumProc]{
  param($h, $l)
  if (-not [KeysOps]::IsWindowVisible($h)) { return $true }
  $p = [uint32]0
  [void][KeysOps]::GetWindowThreadProcessId($h, [ref]$p)
  if ([int]$p -ne $ProcId) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][KeysOps]::GetWindowTextW($h, $sb, 512)
  if ($sb.ToString().Length -eq 0) { return $true }
  $r = New-Object KeysOps+RECT
  [void][KeysOps]::GetWindowRect($h, [ref]$r)
  $area = ($r.right - $r.left) * ($r.bottom - $r.top)
  if ($area -gt $script:bestArea) { $script:bestArea = $area; $script:best = $h }
  return $true
}
[void][KeysOps]::EnumWindows($cb, [IntPtr]::Zero)

function Get-Vk($tok) {
  $t = $tok.ToUpperInvariant()
  switch ($t) {
    "SPACE" { return 0x20 }
    "ENTER" { return 0x0D }
    "ESC" { return 0x1B }
    "BACKSPACE" { return 0x08 }
    "DEL" { return 0x2E }
    "TAB" { return 0x09 }
    "CTRL" { return 0x11 }
    "ALT" { return 0x12 }
    "SHIFT" { return 0x10 }
  }
  if ($t.Length -eq 1) {
    $ch = [int][char]$t[0]
    if ($ch -ge 65 -and $ch -le 90) { return $ch }
    if ($ch -ge 48 -and $ch -le 57) { return $ch }
  }
  return -1
}

function Send-Token($tok, $gap) {
  $parts = $tok.Split('+')
  $mods = @()
  $main = $parts[$parts.Count - 1]
  if ($parts.Count -gt 1) {
    foreach ($m in $parts[0..($parts.Count - 2)]) {
      $mv = Get-Vk $m
      if ($mv -lt 0) { throw "unknown modifier in token: $tok" }
      $mods += [byte]$mv
    }
  }
  $vk = Get-Vk $main
  if ($vk -lt 0) { throw "unknown key token: $tok" }
  foreach ($m in $mods) { [KeysOps]::keybd_event($m, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 25 }
  [KeysOps]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  [KeysOps]::keybd_event([byte]$vk, 0, 2, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  if ($mods.Count -gt 0) {
    $rev = @($mods); [array]::Reverse($rev)
    foreach ($m in $rev) { [KeysOps]::keybd_event($m, 0, 2, [IntPtr]::Zero); Start-Sleep -Milliseconds 15 }
  }
  Start-Sleep -Milliseconds $gap
}

$lines = @()
if ($script:best -eq [IntPtr]::Zero) {
  $lines += "RESULT=no-window pid=$ProcId"
} else {
  $h = $script:best
  $tgtPid = [uint32]0
  $tgtThread = [KeysOps]::GetWindowThreadProcessId($h, [ref]$tgtPid)
  $fg = [KeysOps]::GetForegroundWindow()
  $fgPid = [uint32]0
  $fgThread = [KeysOps]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $me = [KeysOps]::GetCurrentThreadId()
  $lines += ("target=hwnd=" + $h + " pid=" + [int]$tgtPid)
  $lines += ("before-foreground=hwnd=" + $fg + " pid=" + [int]$fgPid)


  [void][KeysOps]::AttachThreadInput($me, $fgThread, $true)
  [void][KeysOps]::AttachThreadInput($me, $tgtThread, $true)
  [void][KeysOps]::BringWindowToTop($h)
  $ok = [KeysOps]::SetForegroundWindow($h)
  [void][KeysOps]::AttachThreadInput($me, $tgtThread, $false)
  [void][KeysOps]::AttachThreadInput($me, $fgThread, $false)
  Start-Sleep -Milliseconds 250

  # OS focus must land on the render-widget child, not the top-level frame:
  # keybd_event is delivered to the thread focus target, and after an external
  # SetForegroundWindow Chromium leaves focus on the frame (measured via
  # GetGUIThreadInfo: focus-hwnd == main window) => the page never sees ENTER.
  $script:rw = [IntPtr]::Zero
  $rwCb = [KeysOps+EnumChildProc]{
    param($c, $l)
    if (-not [KeysOps]::IsWindowVisible($c)) { return $true }
    $sb2 = New-Object System.Text.StringBuilder 256
    [void][KeysOps]::GetClassNameW($c, $sb2, 256)
    if ($sb2.ToString() -eq 'Chrome_RenderWidgetHostHWND') { $script:rw = $c; return $false }
    return $true
  }
  [void][KeysOps]::EnumChildWindows($h, $rwCb, [IntPtr]::Zero)
  if ($script:rw -ne [IntPtr]::Zero) { [void][KeysOps]::SetFocus($script:rw) }
  $lines += ("render-widget=" + $script:rw + " focus-now=" + [KeysOps]::GetFocus())
  $fgNow = [KeysOps]::GetForegroundWindow()
  $lines += ("setforeground-return=" + $ok + " foreground-now=hwnd=" + $fgNow + " same=" + ($fgNow -eq $h))

  if ($PreSleepMs -gt 0) { Start-Sleep -Milliseconds $PreSleepMs }
  $toks = @($Send.Split(',') | Where-Object { $_ -ne "" })
  foreach ($t in $toks) { Send-Token $t $GapMs }
  $lines += ("RESULT=sent count=" + $toks.Count + " gap=" + $GapMs + " presleep=" + $PreSleepMs + " tokens=" + ($toks -join "|"))

  $fgAfter = [KeysOps]::GetForegroundWindow()
  $lines += ("foreground-after=hwnd=" + $fgAfter + " same=" + ($fgAfter -eq $h))
}
$lines | Set-Content -Path $OutFile -Encoding UTF8
Write-Output ("lines=" + $lines.Count)
