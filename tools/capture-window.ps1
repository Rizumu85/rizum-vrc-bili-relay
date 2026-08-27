param(
    [string]$OutputPath = "artifacts\live-window.png",
    [ValidateSet("light", "dark")]
    [string]$Theme = "light",
    [ValidateSet("ready-vod", "settings", "danmaku")]
    [string]$Scene = "ready-vod",
    [switch]$GenerateAddress,
    [switch]$OpenLogin
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputPath))
$outputDirectory = Split-Path -Parent $resolvedOutput

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class GpuixWindowCapture
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$bunShim = (Get-Command bun).Source
$startInfo.FileName = Join-Path (Split-Path -Parent $bunShim) "node_modules\bun\bin\bun.exe"
$startInfo.Arguments = "--hot src/main.tsx"
$startInfo.WorkingDirectory = $repositoryRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.EnvironmentVariables["VRC_BILI_RELAY_THEME"] = $Theme
$startInfo.EnvironmentVariables["VRC_BILI_RELAY_SCENE"] = $Scene

$process = [System.Diagnostics.Process]::Start($startInfo)
try {
    $windowHandle = [IntPtr]::Zero
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (($null -eq $windowHandle -or $windowHandle -eq [IntPtr]::Zero) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
        $process.Refresh()
        if ($process.HasExited) {
            throw "The GPUIX development process exited before creating a window."
        }
        $windowHandle = $process.MainWindowHandle
    }

    if ($null -eq $windowHandle -or $windowHandle -eq [IntPtr]::Zero) {
        throw "The GPUIX process did not expose a main window."
    }

    [GpuixWindowCapture]::ShowWindow($windowHandle, 1) | Out-Null
    [GpuixWindowCapture]::SetForegroundWindow($windowHandle) | Out-Null
    # Keep the product surface unobscured while CopyFromScreen reads its pixels.
    [GpuixWindowCapture]::SetWindowPos($windowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0013) | Out-Null
    Start-Sleep -Seconds 1
    $rectangle = New-Object GpuixWindowCapture+RECT
    [GpuixWindowCapture]::GetWindowRect($windowHandle, [ref]$rectangle) | Out-Null
    $width = $rectangle.Right - $rectangle.Left
    $height = $rectangle.Bottom - $rectangle.Top
    if ($width -le 0 -or $height -le 0) {
        throw "The GPUIX window reported an invalid size."
    }

    if ($GenerateAddress) {
        # The capture window is fixed-size. Click the centre of the Generate button,
        # then allow the Rust worker and Bilibili request to complete before capture.
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + 93, $rectangle.Top + 226) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Seconds 7
    }

    if ($OpenLogin) {
        # Open the account side of the settings segmented control and allow the
        # worker to request the QR payload before capture.
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int]($width * 0.86), $rectangle.Top + [int]($height * 0.35)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Seconds 4
    }

    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($rectangle.Left, $rectangle.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
        $bitmap.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }

    Write-Output "Saved $resolvedOutput (${width}x${height})"
}
finally {
    if (-not $process.HasExited) {
        $process.Kill()
        $process.WaitForExit()
    }
}
