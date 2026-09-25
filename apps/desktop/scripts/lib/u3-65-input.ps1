param(
  [string]$Action = "alive",
  [int]$ProcId = 0,
  [string]$Send = "",
  [string]$Value = "",
  [string]$Set = "1",
  [string]$Raise = "1",
  [int]$GapMs = 70,
  [string]$OutFile = "D:/ReBaseAgent/.workbuddy/u3/u3-65/input-out.txt"
)

# U3 task 6.5 input channel: REAL system keystrokes (keybd_event), real clipboard paste,
# and IME state reporting for the Chinese input method composition acceptance.
#
# Pure-ASCII on purpose (same rule as u3-64-winops.ps1): Windows PowerShell 5.1 decodes
# BOM-less files as ANSI, so a single non-ASCII byte can silently break parsing.
# Anything non-ASCII (Chinese candidate text, clipboard payloads) is passed in/out via
# UTF-8 files or reported to Node, never embedded in this script.
#
# Why keybd_event and not CDP Input.dispatchKeyEvent: the acceptance target is the
# *system* input path -- OS IME (TSF) conversion, WM_PASTE / Ctrl+V through the real
# clipboard. CDP synthesizes events inside Blink and never touches either.

$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class InOps32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public uint cbSize; public uint flags; public IntPtr hwndActive; public IntPtr hwndFocus;
    public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret;
    public RECT rcCaret;
  }
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
  [DllImport("user32.dll")] public static extern IntPtr ActivateKeyboardLayout(IntPtr hkl, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr h);
  [DllImport("imm32.dll")] public static extern bool ImmReleaseContext(IntPtr h, IntPtr ctx);
  [DllImport("imm32.dll")] public static extern bool ImmGetOpenStatus(IntPtr ctx);
  [DllImport("imm32.dll")] public static extern bool ImmSetOpenStatus(IntPtr ctx, bool open);
  [DllImport("imm32.dll")] public static extern bool ImmGetConversionStatus(IntPtr ctx, out uint conv, out uint sentence);
}
"@
Add-Type -TypeDefinition $sig
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$root = $AE::RootElement

function Get-Condition($prop, $value) {
  return New-Object System.Windows.Automation.PropertyCondition($prop, $value)
}

function Get-MainWin {
  $byName = Get-Condition $AE::NameProperty "ReBaseAgent"
  if ($ProcId -gt 0) {
    $byPid = Get-Condition $AE::ProcessIdProperty $ProcId
    $c = New-Object System.Windows.Automation.AndCondition($byName, $byPid)
  } else {
    $c = $byName
  }
  # Subtree, not Children: Children enumeration returns nothing in this window station
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $c)
}

function Get-MainHwnd {
  $w = Get-MainWin
  if ($w -ne $null -and $w.Current.NativeWindowHandle -ne 0) { return [IntPtr]$w.Current.NativeWindowHandle }
  return [InOps32]::FindWindowW($null, "ReBaseAgent")
}

function Get-PidOf($h) {
  $p = 0
  [void][InOps32]::GetWindowThreadProcessId($h, [ref]$p)
  return $p
}

function Get-FocusInfo($h) {
  # The IME / composition actually happens on the render-widget child window, so report the
  # focused HWND of the target thread rather than the top-level frame.
  $pidOut = 0
  $tid = [InOps32]::GetWindowThreadProcessId($h, [ref]$pidOut)
  $info = New-Object InOps32+GUITHREADINFO
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  [void][InOps32]::GetGUIThreadInfo($tid, [ref]$info)
  $fh = $info.hwndFocus
  if ($fh -eq [IntPtr]::Zero) { $fh = $h }
  $ctx = [InOps32]::ImmGetContext($fh)
  $open = "n/a"
  $conv = "n/a"
  if ($ctx -ne [IntPtr]::Zero) {
    $open = [InOps32]::ImmGetOpenStatus($ctx)
    $a = 0; $b = 0
    [void][InOps32]::ImmGetConversionStatus($ctx, [ref]$a, [ref]$b)
    $conv = $a
    [void][InOps32]::ImmReleaseContext($fh, $ctx)
  }
  return @{
    tid = $tid
    hkl = ("0x" + ('{0:x8}' -f [int][InOps32]::GetKeyboardLayout($tid)))
    focus = $fh
    "imm-open" = $open
    "imm-conv" = $conv
  }
}

function Raise-Target {
  $h = Get-MainHwnd
  if ($h -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
  [void][InOps32]::ShowWindow($h, 9)      # SW_RESTORE: un-minimize only, never resize
  [void][InOps32]::BringWindowToTop($h)
  [void][InOps32]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 350
  return $h
}

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
    if ($ch -ge 65 -and $ch -le 90) { return $ch }   # A-Z share the VK letter codes
    if ($ch -ge 48 -and $ch -le 57) { return $ch }   # 0-9 (VK_0..VK_9)
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
  foreach ($m in $mods) { [InOps32]::keybd_event($m, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 25 }
  [InOps32]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  [InOps32]::keybd_event([byte]$vk, 0, 2, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  if ($mods.Count -gt 0) {
    $rev = @($mods); [array]::Reverse($rev)
    foreach ($m in $rev) { [InOps32]::keybd_event($m, 0, 2, [IntPtr]::Zero); Start-Sleep -Milliseconds 15 }
  }
  Start-Sleep -Milliseconds $gap
}

$lines = @()
switch ($Action) {
  "resolve" {
    $want = @()
    foreach ($p in Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue) {
      if ([string]$p.CommandLine -like "*ReBaseAgent*") { $want += [int]$p.ProcessId }
    }
    $byName = Get-Condition $AE::NameProperty "ReBaseAgent"
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, $byName)
    $owners = @()
    foreach ($w in $wins) {
      if ($w.Current.NativeWindowHandle -ne 0) { $owners += [int]$w.Current.ProcessId }
    }
    $mine = @($owners | Where-Object { $want -contains $_ } | Select-Object -Unique)
    $lines += ("candidates=" + ($want -join ","))
    $lines += ("window-owners=" + ($owners -join ","))
    $lines += ("main-pid=" + $(if ($mine.Count -eq 1) { $mine[0] } else { ($mine -join ",") }))
    $lines += ("count=" + $mine.Count)
  }
  "alive" {
    $h = Get-MainHwnd
    if ($h -eq [IntPtr]::Zero) { $lines += "window=absent" }
    else { $lines += ("window=hwnd=" + $h + " iswindow=" + [InOps32]::IsWindow($h) + " pid=" + (Get-PidOf $h)) }
    $pids = @()
    foreach ($proc in Get-Process -Name "electron" -ErrorAction SilentlyContinue) { $pids += $proc.Id }
    $lines += ("electron-pids=" + ($pids -join ","))
  }
  "fg" {
    $h = Raise-Target
    $fg = [InOps32]::GetForegroundWindow()
    $lines += ("main=hwnd=" + $h)
    $lines += ("foreground=hwnd=" + $fg + " pid=" + (Get-PidOf $fg) + " same=" + ($fg -eq $h))
    $fi = Get-FocusInfo $h
    $lines += ("target-thread=" + $fi.tid + " hkl=" + $fi.hkl + " focus-hwnd=" + $fi.focus)
    $lines += ("imm-open=" + $fi.'imm-open' + " imm-conv=" + $fi.'imm-conv')
  }
  "ime-state" {
    $h = Get-MainHwnd
    if ($h -eq [IntPtr]::Zero) { $lines += "RESULT=main-absent" }
    else {
      $fi = Get-FocusInfo $h
      $lines += ("thread=" + $fi.tid)
      $lines += ("hkl=" + $fi.hkl)
      $lines += ("focus-hwnd=" + $fi.focus)
      $lines += ("imm-open=" + $fi.'imm-open')
      $lines += ("imm-conv=" + $fi.'imm-conv')
      $lines += ("foreground-pid=" + (Get-PidOf ([InOps32]::GetForegroundWindow())))
    }
  }
  "ime-set" {
    # ImmSetOpenStatus is the legacy IMM2 lever; TSF-based IMEs may ignore it, so this is
    # reported as an observation, never as the proof that the system IME was engaged.
    $h = Raise-Target
    if ($h -eq [IntPtr]::Zero) { $lines += "RESULT=main-absent" }
    else {
      $fi = Get-FocusInfo $h
      $ctx = [InOps32]::ImmGetContext($fi.focus)
      if ($ctx -eq [IntPtr]::Zero) { $lines += "RESULT=no-imm-context focus=" + $fi.focus }
      else {
        $want = if ($Set -eq "0") { $false } else { $true }
        $ok = [InOps32]::ImmSetOpenStatus($ctx, $want)
        Start-Sleep -Milliseconds 200
        $after = [InOps32]::ImmGetOpenStatus($ctx)
        [void][InOps32]::ImmReleaseContext($fi.focus, $ctx)
        $lines += ("RESULT=set-open ok=" + $ok + " want=" + $want + " after=" + $after)
        $fi2 = Get-FocusInfo $h
        $lines += ("hkl=" + $fi2.hkl + " imm-open=" + $fi2.'imm-open' + " imm-conv=" + $fi2.'imm-conv')
      }
    }
  }
  "keys" {
    # Raise=0 keeps the current foreground untouched (the real "modal box is up" case:
    # a user cannot pull the main window forward, so keystrokes must not reach the page).
    $h = if ($Raise -eq "0") { Get-MainHwnd } else { Raise-Target }
    if ($h -eq [IntPtr]::Zero) { $lines += "RESULT=main-absent" }
    else {
      $toks = @($Send.Split(',') | Where-Object { $_ -ne "" })
      foreach ($t in $toks) { Send-Token $t $GapMs }
      $lines += ("RESULT=sent count=" + $toks.Count + " gap=" + $GapMs + " raise=" + $Raise + " tokens=" + ($toks -join "|"))
      $fg = [InOps32]::GetForegroundWindow()
      $lines += ("foreground=hwnd=" + $fg + " pid=" + (Get-PidOf $fg) + " same=" + ($fg -eq $h))
    }
  }
  "clipboard" {
    # Payload arrives as a UTF-8 file (never as a script literal) so Chinese content survives.
    $tmp = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($tmp, $Value, [System.Text.Encoding]::UTF8)
    $txt = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Set-Clipboard -Value $txt
    $back = Get-Clipboard -Raw
    $lines += ("RESULT=clip len=" + $txt.Length + " roundtrip=" + ($back.Length -eq $txt.Length))
  }
  default { $lines += "unknown-action" }
}

$lines | Set-Content -Path $OutFile -Encoding UTF8
Write-Output ("lines=" + $lines.Count)
