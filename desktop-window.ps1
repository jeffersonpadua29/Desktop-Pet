param(
    [Parameter(Mandatory)][ValidateSet('list', 'focus', 'minimize', 'maximize', 'restore')][string]$Action,
    [int]$OwnerProcess,
    [string]$EncodedTarget
)

$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DesktopWindows {
    public sealed class Window {
        public IntPtr Handle;
        public int ProcessId;
        public string Title;
    }

    private delegate bool EnumCallback(IntPtr window, IntPtr context);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr context);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr window);

    public static Window[] Find(int ownerProcess) {
        var windows = new List<Window>();
        EnumWindows((handle, context) => {
            uint process;
            GetWindowThreadProcessId(handle, out process);
            if (process == ownerProcess || !IsWindowVisible(handle) || GetWindow(handle, 4) != IntPtr.Zero) return true;
            int cloaked;
            if (DwmGetWindowAttribute(handle, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            var title = new StringBuilder(256);
            if (GetWindowText(handle, title, title.Capacity) > 0) {
                windows.Add(new Window { Handle = handle, ProcessId = (int)process, Title = title.ToString() });
            }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static void Request(Window window, string action) {
        uint process;
        GetWindowThreadProcessId(window.Handle, out process);
        if (process != window.ProcessId) return;
        switch (action) {
            case "focus":
                if (IsIconic(window.Handle)) ShowWindowAsync(window.Handle, 9);
                SetForegroundWindow(window.Handle);
                break;
            case "minimize": ShowWindowAsync(window.Handle, 6); break;
            case "maximize": ShowWindowAsync(window.Handle, 3); break;
            case "restore": ShowWindowAsync(window.Handle, 1); break;
        }
    }

    public static bool Reached(Window window, string action) {
        uint process;
        GetWindowThreadProcessId(window.Handle, out process);
        if (process != window.ProcessId) return false;
        switch (action) {
            case "focus": return GetForegroundWindow() == window.Handle && !IsIconic(window.Handle);
            case "minimize": return IsIconic(window.Handle);
            case "maximize": return IsZoomed(window.Handle) && !IsIconic(window.Handle);
            case "restore": return !IsIconic(window.Handle) && !IsZoomed(window.Handle);
            default: return false;
        }
    }
}
"@

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$windows = @(
    foreach ($window in [DesktopWindows]::Find($OwnerProcess)) {
        $process = Get-Process -Id $window.ProcessId -ErrorAction SilentlyContinue
        if (!$process -or $process.ProcessName -in @('TextInputHost', 'SearchHost', 'StartMenuExperienceHost', 'ShellExperienceHost')) { continue }
        if ($process.ProcessName -eq 'explorer' -and $window.Title -eq 'Program Manager') { continue }
        [pscustomobject]@{
            Native = $window
            Title = ($window.Title -replace '[\p{Cc}\p{Cf}]', ' ').Trim()
            ProcessName = $process.ProcessName
        }
    }
)

function Write-Result([string]$Status, [string[]]$Titles = @(), [bool]$More = $false) {
    [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ status = $Status; titles = $Titles; more = $More }))
}

if ($Action -eq 'list') {
    Write-Result 'listed' @($windows | Select-Object -First 10 -ExpandProperty Title) ($windows.Count -gt 10)
    return
}

$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedTarget)).Trim()
if (!$target) { Write-Result 'missing'; return }
$aliases = @{ 'google chrome' = 'chrome'; 'microsoft edge' = 'msedge'; 'edge' = 'msedge'; 'file explorer' = 'explorer'; 'vs code' = 'code'; 'visual studio code' = 'code' }
$processName = if ($aliases.ContainsKey($target)) { $aliases[$target] } else { $target }
$matches = @($windows | Where-Object Title -eq $target)
if ($matches.Count -eq 0) { $matches = @($windows | Where-Object ProcessName -eq $processName) }
if ($matches.Count -eq 0) {
    $matches = @($windows | Where-Object { $_.Title.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}
if ($matches.Count -eq 0) { Write-Result 'missing'; return }
if ($matches.Count -gt 1) {
    Write-Result 'ambiguous' @($matches | Select-Object -First 5 -ExpandProperty Title) ($matches.Count -gt 5)
    return
}

$selected = $matches[0]
if (![DesktopWindows]::Reached($selected.Native, $Action)) {
    [DesktopWindows]::Request($selected.Native, $Action)
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        Start-Sleep -Milliseconds 80
        if ([DesktopWindows]::Reached($selected.Native, $Action)) { break }
    }
}
$status = if ([DesktopWindows]::Reached($selected.Native, $Action)) { 'done' } else { 'unconfirmed' }
Write-Result $status @($selected.Title)
