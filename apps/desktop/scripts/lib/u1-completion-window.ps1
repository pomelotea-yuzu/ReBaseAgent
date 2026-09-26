param([int]$Width, [int]$Height)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class U1Window {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int height, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][U1Window]::SetProcessDPIAware()
$script:u1Handle = [IntPtr]::Zero
$callback = [U1Window+Callback]{
  param($handle, $parameter)
  $title = New-Object System.Text.StringBuilder 512
  [void][U1Window]::GetWindowTextW($handle, $title, 512)
  if ([U1Window]::IsWindowVisible($handle) -and $title.ToString() -eq 'ReBaseAgent') {
    $script:u1Handle = $handle
  }
  return $true
}
[void][U1Window]::EnumWindows($callback, [IntPtr]::Zero)
if ($script:u1Handle -eq [IntPtr]::Zero) { throw 'ReBaseAgent window not found' }
[void][U1Window]::ShowWindow($script:u1Handle, 9)
if (-not [U1Window]::MoveWindow($script:u1Handle, 0, 0, $Width, $Height, $true)) { throw 'MoveWindow failed' }
Write-Output "Window resized: $Width x $Height physical pixels"
