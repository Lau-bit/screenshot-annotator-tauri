# Move a window to an exact physical desktop position without touching the mouse.
# SetWindowPos is a window-level call; the pointer is never moved or synthesized.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [int]$Width = 0,
  [int]$Height = 0
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinMove {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(
    IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$null = [WinMove]::SetProcessDpiAwarenessContext([IntPtr](-4))
$proc = Get-Process -Id $ProcessId -ErrorAction Stop
$hwnd = $proc.MainWindowHandle

$rect = New-Object WinMove+RECT
$null = [WinMove]::GetWindowRect($hwnd, [ref]$rect)
if ($Width -le 0) { $Width = $rect.Right - $rect.Left }
if ($Height -le 0) { $Height = $rect.Bottom - $rect.Top }

# SWP_NOZORDER (0x4) | SWP_NOACTIVATE (0x10) — move without stealing focus.
$null = [WinMove]::SetWindowPos($hwnd, [IntPtr]::Zero, $X, $Y, $Width, $Height, 0x14)
Start-Sleep -Milliseconds 600
$null = [WinMove]::GetWindowRect($hwnd, [ref]$rect)
"moved to $($rect.Left),$($rect.Top) size $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top)"
