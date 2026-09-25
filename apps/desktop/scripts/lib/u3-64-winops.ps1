param(
  [string]$Action = "list",
  [int]$Index = 0,
  [int]$ProcId = 0,
  [string]$OutFile = "D:/ReBaseAgent/.workbuddy/u3/u3-64/winops-out.txt"
)

# U3 task 6.4 window ops: title-bar close, Alt+F4, native confirm dialog, liveness.
# Pure-ASCII on purpose: Windows PowerShell 5.1 decodes BOM-less files as ANSI, so any
# non-ASCII byte here can silently break parsing. Chinese button labels are matched in
# Node (UTF-8) after this script reports them, never hardcoded here.
#
# Verified on this machine (2026-09-25):
#  - UIA can only resolve elements with TreeScope Subtree from the root in this window
#    station; Children enumeration returns nothing (top-level-count=0), and Win32
#    EnumWindows sees no windows either (separate window station).
#  - The Electron message box is class #32770, Name "退出 ReBaseAgent" (reported by node);
#    its buttons are ControlType.Pane with class CCPushButton (NOT ControlType.Button).
#  - Chrome_WidgetWin_1 exposes no accessible title-bar buttons (RawViewWalker shows only
#    client Panes), so "click the X" is delivered as the message the X itself produces:
#    WM_SYSCOMMAND + SC_CLOSE. Alt+F4 is additionally sent as a real keybd_event sequence.

$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinOps32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
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
  # -Pid 给定（推荐）：只认本仓库那个 electron 主进程的窗口，避免历史遗留实例串扰；
  # 未给定时退化为按 Name 匹配（本机 title 固定为 ReBaseAgent）。
  $byName = Get-Condition $AE::NameProperty "ReBaseAgent"
  if ($ProcId -gt 0) {
    $byPid = Get-Condition $AE::ProcessIdProperty $ProcId
    $c = New-Object System.Windows.Automation.AndCondition($byName, $byPid)
  } else {
    $c = $byName
  }
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $c)
}

function Get-MainHwnd {
  $w = Get-MainWin
  if ($w -ne $null -and $w.Current.NativeWindowHandle -ne 0) { return [IntPtr]$w.Current.NativeWindowHandle }
  return [WinOps32]::FindWindowW($null, "ReBaseAgent")
}

function Get-Dialogs {
  # 只取**本进程**的 #32770：别的应用（含资源管理器）也用这个对话框类名
  $byClass = Get-Condition $AE::ClassNameProperty "#32770"
  if ($ProcId -gt 0) {
    $byPid = Get-Condition $AE::ProcessIdProperty $ProcId
    $c = New-Object System.Windows.Automation.AndCondition($byClass, $byPid)
  } else {
    $c = $byClass
  }
  # ⚠️ 必须强制成数组：PowerShell 会把单元素集合摊成标量，之后 .Item(0) 静默拿不到东西
  return @($root.FindAll([System.Windows.Automation.TreeScope]::Subtree, $c))
}

function Get-Dialog {
  $all = @(Get-Dialogs)
  if ($all.Count -eq 0) { return $null }
  return $all[0]
}

function Get-DialogCount {
  return (@(Get-Dialogs)).Count
}

function Get-PushButtons($d) {
  if ($d -eq $null) { return @() }
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, "CCPushButton")
  $all = @()
  foreach ($b in $d.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)) { $all += $b }
  return $all
}

function Get-PidOf($h) {
  $p = 0
  [void][WinOps32]::GetWindowThreadProcessId($h, [ref]$p)
  return $p
}

function Get-Rect($h) {
  $r = New-Object WinOps32+RECT
  [void][WinOps32]::GetWindowRect($h, [ref]$r)
  return ("left=" + $r.left + " top=" + $r.top + " right=" + $r.right + " bottom=" + $r.bottom)
}

$lines = @()
switch ($Action) {
  "resolve" {
    # 找出「本仓库那个 electron 主进程」的 PID：命令行必须含 ReBaseAgent（绝不按映像名认定，
    # WorkBuddy 自己也是 Electron），且它拥有标题为 ReBaseAgent 的窗口。
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
  "list" {
    $h = Get-MainHwnd
    if ($h -eq [IntPtr]::Zero) { $lines += "main=absent" }
    else { $lines += ("main=hwnd=" + $h + " pid=" + (Get-PidOf $h) + " visible=" + [WinOps32]::IsWindowVisible($h)) }
    $d = Get-Dialog
    if ($d -eq $null) { $lines += "dialog=none" }
    else { $lines += ("dialog=" + $d.Current.Name) }
  }
  "styles" {
    # Proof the window really has a system caption (WS_CAPTION / WS_SYSMENU => the X exists).
    $h = Get-MainHwnd
    if ($h -eq [IntPtr]::Zero) { $lines += "main=absent" }
    else {
      $style = [WinOps32]::GetWindowLong($h, -16)
      $lines += ("style=0x" + ("{0:X8}" -f ($style -band 0xFFFFFFFF)))
      $lines += ("WS_CAPTION=" + (($style -band 0x00C00000) -ne 0))
      $lines += ("WS_SYSMENU=" + (($style -band 0x00080000) -ne 0))
      $lines += ("iconic=" + [WinOps32]::IsIconic($h) + " " + (Get-Rect $h))
    }
  }
  "restore" {
    # 只解除最小化 + 置前：**不改动窗口尺寸** —— 实测缩到 1280x820 时（DPR 2.1 ⇒ CSS ~610px）
    # 应用进入窄档布局，运行列表整列收起，DOM 里根本没有运行条目行，验收判据会假失败。
    $h = Get-MainHwnd
    if ($h -eq [IntPtr]::Zero) { $lines += "RESULT=main-absent" }
    else {
      [void][WinOps32]::ShowWindow($h, 9)
      [void][WinOps32]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 500
      $lines += ("RESULT=restored iconic=" + [WinOps32]::IsIconic($h) + " " + (Get-Rect $h))
    }
  }
  "close-titlebar" {
    $h = Get-MainHwnd
    if ($h -eq [IntPtr]::Zero) { $lines += "RESULT=main-absent" }
    else {
      [void][WinOps32]::ShowWindow($h, 9)
      [void][WinOps32]::SetForegroundWindow($h)
      $ok = [WinOps32]::PostMessage($h, 0x112, [IntPtr]0xF060, [IntPtr]::Zero)
      $lines += ("RESULT=sc-close ok=" + $ok + " hwnd=" + $h)
    }
  }
  "altf4" {
    $h = Get-MainHwnd
    if ($h -eq [IntPtr]::Zero) { $lines += "RESULT=main-absent" }
    else {
      [void][WinOps32]::ShowWindow($h, 9)
      [void][WinOps32]::BringWindowToTop($h)
      [void][WinOps32]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 400
      [WinOps32]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
      [WinOps32]::keybd_event(0x73, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 80
      [WinOps32]::keybd_event(0x73, 0, 2, [IntPtr]::Zero)
      [WinOps32]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
      $lines += ("RESULT=altf4-keyboard hwnd=" + $h)
    }
  }
  "dialog-text" {
    $d = Get-Dialog
    if ($d -eq $null) { $lines += "dialog=none" }
    else {
      $lines += ("dialog-name=" + $d.Current.Name)
      # 框句柄：跨轮次判"同一层框未关"还是"排队关闭的新轮新框"（6.7 加，多余键不影响既有解析）
      $lines += ("dialog-hwnd=" + $d.Current.NativeWindowHandle)
      $tc = New-Object System.Windows.Automation.PropertyCondition(
        $AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
      foreach ($t in $d.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tc)) {
        $v = ([string]$t.Current.Name) -replace "\r?\n", " / "
        if ($v.Length -gt 240) { $v = $v.Substring(0, 240) }
        $lines += ("text=" + $v)
      }
      $i = 0
      foreach ($b in (Get-PushButtons $d)) { $lines += ("button[" + $i + "]=" + $b.Current.Name); $i += 1 }
    }
  }
  "dialog-count" {
    $lines += ("dialogs=" + (Get-DialogCount))
  }
  "dialog-click" {
    $d = Get-Dialog
    if ($d -eq $null) { $lines += "RESULT=no-dialog" }
    else {
      $btns = @(Get-PushButtons $d)
      if ($Index -ge $btns.Count) {
        $lines += ("RESULT=index-out-of-range want=" + $Index + " have=" + $btns.Count)
      }
      else {
        $b = $btns[$Index]
        $nm = [string]$b.Current.Name
        $how = ""
        # ① LegacyIAccessible 默认动作：实测 #32770 的 CCPushButton 不支持 InvokePattern
        #   （GetCurrentPattern 抛「不支持的模式」，且 PS 默认非终止错会让脚本继续 ⇒ 假「clicked」）
        try {
          $li = $b.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
          $li.DoDefaultAction()
          $how = "legacy-do-default-action"
        } catch {
          $how = "legacy-failed"
        }
        if ($how -ne "legacy-do-default-action") {
          # ② 兜底：向按钮句柄投 BM_CLICK（等价于鼠标点这个按钮）
          $bh = [IntPtr]$b.Current.NativeWindowHandle
          if ($bh -ne [IntPtr]::Zero) {
            [void][WinOps32]::PostMessage($bh, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
            $how = "bm-click"
          } else {
            $how = "failed:no-button-hwnd"
          }
        }
        $lines += ("RESULT=clicked index=" + $Index + " name=" + $nm + " via=" + $how)
      }
    }
  }
  "alive" {
    $h = Get-MainHwnd
    if ($h -eq [IntPtr]::Zero) { $lines += "window=absent" }
    else { $lines += ("window=hwnd=" + $h + " iswindow=" + [WinOps32]::IsWindow($h) + " pid=" + (Get-PidOf $h)) }
    $lines += ("dialogs=" + (Get-DialogCount))
    $pids = @()
    foreach ($proc in Get-Process -Name "electron" -ErrorAction SilentlyContinue) { $pids += $proc.Id }
    $lines += ("electron-pids=" + ($pids -join ","))
  }
  default { $lines += "unknown-action" }
}

$lines | Set-Content -Path $OutFile -Encoding UTF8
Write-Output ("lines=" + $lines.Count)
