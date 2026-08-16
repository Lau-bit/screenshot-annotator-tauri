# Reports a window's TRUE physical rect and the DPI of the monitor it sits on.
#
# Must opt into per-monitor-v2 DPI awareness first: a DPI-unaware process is fed
# virtualized coordinates by Windows (GetDpiForMonitor even reports 96 for a
# 125% display), which silently invalidates any window-placement measurement.
param([Parameter(Mandatory = $true)][int]$ProcessId)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinRect {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr m, int t, out uint x, out uint y);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
'@

# -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
$null = [WinRect]::SetProcessDpiAwarenessContext([IntPtr](-4))

$proc = Get-Process -Id $ProcessId -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw "process $ProcessId has no main window" }

$rect = New-Object WinRect+RECT
$null = [WinRect]::GetWindowRect($hwnd, [ref]$rect)

$mon = [WinRect]::MonitorFromWindow($hwnd, 2)  # MONITOR_DEFAULTTONEAREST
$mi = New-Object WinRect+MONITORINFO
$mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
$null = [WinRect]::GetMonitorInfo($mon, [ref]$mi)
$dpiX = 0; $dpiY = 0
$null = [WinRect]::GetDpiForMonitor($mon, 0, [ref]$dpiX, [ref]$dpiY)

[pscustomobject]@{
  x            = $rect.Left
  y            = $rect.Top
  outerWidth   = $rect.Right - $rect.Left
  outerHeight  = $rect.Bottom - $rect.Top
  monitorX     = $mi.rcMonitor.Left
  monitorY     = $mi.rcMonitor.Top
  monitorW     = $mi.rcMonitor.Right - $mi.rcMonitor.Left
  monitorH     = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
  monitorScale = $dpiX / 96
} | ConvertTo-Json -Compress
