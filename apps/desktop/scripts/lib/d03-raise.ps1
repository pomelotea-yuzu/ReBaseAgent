param(
  [int]$ProcId = 0,
  [string]$OutFile = "D:/ReBaseAgent/.workbuddy/r22-72/raise-out.txt"
)

# ASCII-only on purpose (PS 5.1 decodes BOM-less files as ANSI; Chinese breaks the param
# block -- same rule as u3-64-winops.ps1 / u3-65-input.ps1).
#
# Why a separate raiser: plain SetForegroundWindow from a non-foreground process is
# refused by Windows (foreground-lock). The documented escape hatches are (a) simulate a
# real input event first (keybd_event Alt press+release grants foreground rights), and
# (b) AttachThreadInput between the current foreground thread and the target thread.
# u3-65-input.ps1 only does BringWindowToTop + SetForegroundWindow, which is not enough
# when another app keeps stealing foreground mid-batch (observed 2026-10-21).

$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RaiseOps {
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
$cb = [RaiseOps+EnumProc]{
  param($h, $l)
  if (-not [RaiseOps]::IsWindowVisible($h)) { return $true }
  $p = [uint32]0
  [void][RaiseOps]::GetWindowThreadProcessId($h, [ref]$p)
  if ([int]$p -ne $ProcId) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][RaiseOps]::GetWindowTextW($h, $sb, 512)
  if ($sb.ToString().Length -eq 0) { return $true }
  $r = New-Object RaiseOps+RECT
  [void][RaiseOps]::GetWindowRect($h, [ref]$r)
  $area = ($r.right - $r.left) * ($r.bottom - $r.top)
  if ($area -gt $script:bestArea) { $script:bestArea = $area; $script:best = $h }
  return $true
}
[void][RaiseOps]::EnumWindows($cb, [IntPtr]::Zero)

$lines = @()
if ($script:best -eq [IntPtr]::Zero) {
  $lines += "RESULT=no-window pid=$ProcId"
} else {
  $h = $script:best
  $tgtPid = [uint32]0
  $tgtThread = [RaiseOps]::GetWindowThreadProcessId($h, [ref]$tgtPid)
  $fg = [RaiseOps]::GetForegroundWindow()
  $fgPid = [uint32]0
  $fgThread = [RaiseOps]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $me = [RaiseOps]::GetCurrentThreadId()
  $lines += ("target=hwnd=" + $h + " pid=" + [int]$tgtPid + " thread=" + [int]$tgtThread)
  $lines += ("before-foreground=hwnd=" + $fg + " pid=" + [int]$fgPid + " thread=" + [int]$fgThread)

  # (a) real input event grants foreground rights

  # (b) thread-input attachment lets SetForegroundWindow through the lock
  [void][RaiseOps]::AttachThreadInput($me, $fgThread, $true)
  [void][RaiseOps]::AttachThreadInput($me, $tgtThread, $true)
  [void][RaiseOps]::BringWindowToTop($h)
  $ok = [RaiseOps]::SetForegroundWindow($h)
  [void][RaiseOps]::AttachThreadInput($me, $tgtThread, $false)
  [void][RaiseOps]::AttachThreadInput($me, $fgThread, $false)
  Start-Sleep -Milliseconds 350

  # OS focus must land on the render-widget child, not the top-level frame:
  # keybd_event is delivered to the thread focus target, and after an external
  # SetForegroundWindow Chromium leaves focus on the frame (measured via
  # GetGUIThreadInfo: focus-hwnd == main window) => the page never sees ENTER.
  $script:rw = [IntPtr]::Zero
  $rwCb = [RaiseOps+EnumChildProc]{
    param($c, $l)
    if (-not [RaiseOps]::IsWindowVisible($c)) { return $true }
    $sb2 = New-Object System.Text.StringBuilder 256
    [void][RaiseOps]::GetClassNameW($c, $sb2, 256)
    if ($sb2.ToString() -eq 'Chrome_RenderWidgetHostHWND') { $script:rw = $c; return $false }
    return $true
  }
  [void][RaiseOps]::EnumChildWindows($h, $rwCb, [IntPtr]::Zero)
  if ($script:rw -ne [IntPtr]::Zero) { [void][RaiseOps]::SetFocus($script:rw) }
  $lines += ("render-widget=" + $script:rw + " focus-now=" + [RaiseOps]::GetFocus())
  $fg2 = [RaiseOps]::GetForegroundWindow()
  $lines += ("setforeground-return=" + $ok)
  $lines += ("after-foreground=hwnd=" + $fg2 + " same=" + ($fg2 -eq $h))
  $lines += ("RESULT=raised same=" + ($fg2 -eq $h))
}
$lines | Set-Content -Path $OutFile -Encoding UTF8
Write-Output ("lines=" + $lines.Count)
