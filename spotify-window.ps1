param([switch]$Inspect)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class SpotifyWindowControl {
    private delegate bool EnumCallback(IntPtr window, IntPtr context);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr context);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    public static IntPtr[] Find(int[] processes) {
        var windows = new List<IntPtr>();
        EnumWindows((window, context) => {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (Array.IndexOf(processes, (int)pid) >= 0 && IsWindowVisible(window) &&
                GetWindow(window, 4) == IntPtr.Zero && GetWindowTextLength(window) > 0) windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static bool RequestClose(IntPtr window) {
        return PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
}
"@

function Find-SpotifyWindows {
    $currentSession = (Get-Process -Id $PID).SessionId
    $processes = @(Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object SessionId -eq $currentSession | ForEach-Object Id)
    if ($processes.Count -gt 0) { [SpotifyWindowControl]::Find([int[]]$processes) }
}

$windows = @(Find-SpotifyWindows)
if ($Inspect) {
    [Console]::WriteLine($windows.Count)
    return
}
if ($windows.Count -eq 0) {
    [Console]::WriteLine('not-open')
    return
}
$requested = $false
foreach ($window in $windows) {
    if ([SpotifyWindowControl]::RequestClose($window)) { $requested = $true }
}
if (!$requested) {
    [Console]::WriteLine('failed')
    return
}
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 150
    if (@(Find-SpotifyWindows).Count -eq 0) {
        [Console]::WriteLine('closed')
        return
    }
}
[Console]::WriteLine('still-open')
