param(
    [string]$OutputPath = "artifacts\live-window.png",
    [string]$ExecutablePath,
    [string]$Source,
    [string]$SettingsPath,
    [ValidateSet("light", "dark")]
    [string]$Theme = "light",
    [ValidateSet("idle", "loading", "error", "ready-vod", "settings", "danmaku")]
    [string]$Scene = "ready-vod",
    [switch]$GenerateAddress,
    [switch]$OpenSettings,
    [switch]$ReturnFromSubview,
    [switch]$OpenLogin,
    [switch]$TypeSampleStreamKey,
    [switch]$RevealSampleStreamKey,
    [switch]$SaveSettings,
    [switch]$OpenDanmakuFont,
    [switch]$OpenPartSelect,
    [switch]$IncludePopup,
    [switch]$CyclePlaybackEndBehavior,
    [switch]$FocusSource,
    [switch]$DragSelectSourceInside,
    [switch]$DragSelectSourceOutside,
    [switch]$DragSelectStaticText,
    [switch]$ScrollContent,
    [ValidateRange(250, 10000)]
    [int]$SettleMilliseconds = 1000
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputPath))
$outputDirectory = Split-Path -Parent $resolvedOutput

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class GpuixWindowCapture
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

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

    public static RECT GetVisibleProcessBounds(uint targetProcessId)
    {
        RECT union = new RECT { Left = int.MaxValue, Top = int.MaxValue, Right = int.MinValue, Bottom = int.MinValue };
        EnumWindows((window, _) =>
        {
            uint processId;
            RECT rectangle;
            if (IsWindowVisible(window)
                && GetWindowThreadProcessId(window, out processId) != 0
                && processId == targetProcessId
                && GetWindowRect(window, out rectangle)
                && rectangle.Right > rectangle.Left
                && rectangle.Bottom > rectangle.Top)
            {
                union.Left = Math.Min(union.Left, rectangle.Left);
                union.Top = Math.Min(union.Top, rectangle.Top);
                union.Right = Math.Max(union.Right, rectangle.Right);
                union.Bottom = Math.Max(union.Bottom, rectangle.Bottom);
            }
            return true;
        }, IntPtr.Zero);
        return union;
    }
}
"@

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
if ($ExecutablePath) {
    $startInfo.FileName = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $ExecutablePath))
    $startInfo.Arguments = ""
}
else {
    $bunShim = (Get-Command bun).Source
    $startInfo.FileName = Join-Path (Split-Path -Parent $bunShim) "node_modules\bun\bin\bun.exe"
    $startInfo.Arguments = "--hot src/main.tsx"
}
$startInfo.WorkingDirectory = $repositoryRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.EnvironmentVariables["VRC_BILI_RELAY_THEME"] = $Theme
$startInfo.EnvironmentVariables["VRC_BILI_RELAY_SCENE"] = $Scene
if ($Source) {
    $startInfo.EnvironmentVariables["VRC_BILI_RELAY_SOURCE"] = $Source
}
if ($SettingsPath) {
    $startInfo.EnvironmentVariables["VRC_BILI_RELAY_SETTINGS"] = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $SettingsPath))
}

# Start reference captures with the pointer outside the future window bounds so
# the first painted frame does not inherit a caption-button hover state.
[GpuixWindowCapture]::SetCursorPos(0, 0) | Out-Null
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
    $captureZOrder = if ($IncludePopup) { [IntPtr]::Zero } else { [IntPtr](-1) }
    [GpuixWindowCapture]::SetWindowPos($windowHandle, $captureZOrder, 96, 96, 0, 0, 0x0013) | Out-Null
    Start-Sleep -Milliseconds $SettleMilliseconds
    $rectangle = New-Object GpuixWindowCapture+RECT
    [GpuixWindowCapture]::GetWindowRect($windowHandle, [ref]$rectangle) | Out-Null
    $width = $rectangle.Right - $rectangle.Left
    $height = $rectangle.Bottom - $rectangle.Top
    $logicalWidth = if ($Scene -eq "settings") { 528 } elseif ($Scene -eq "danmaku") { 484 } else { 472 }
    if ($width -le 0 -or $height -le 0) {
        throw "The GPUIX window reported an invalid size."
    }

    if ($GenerateAddress) {
        # The capture window is fixed-size. Click the centre of the Generate button,
        # then allow the Rust worker and Bilibili request to complete before capture.
        $scale = $width / $logicalWidth
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](93 * $scale), $rectangle.Top + [int](136 * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Seconds 7
    }

    if ($FocusSource -or $DragSelectSourceInside -or $DragSelectSourceOutside) {
        if ($Scene -ne "idle" -and $Scene -ne "ready-vod") {
            throw "Source input probes require -Scene idle or -Scene ready-vod."
        }
        $scale = $width / $logicalWidth
        $sourceY = $rectangle.Top + [int](100 * $scale)
        $sourceX = $rectangle.Left + [int](64 * $scale)
        [GpuixWindowCapture]::SetCursorPos($sourceX, $sourceY) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        if ($DragSelectSourceInside -or $DragSelectSourceOutside) {
            Start-Sleep -Milliseconds 35
            $selectionTargetX = if ($DragSelectSourceOutside) {
                $rectangle.Right + [int](120 * $scale)
            } else {
                $rectangle.Left + [int](330 * $scale)
            }
            [GpuixWindowCapture]::SetCursorPos($selectionTargetX, $sourceY) | Out-Null
            Start-Sleep -Milliseconds 220
        }
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds $(if ($DragSelectSourceInside -or $DragSelectSourceOutside) { 350 } else { 50 })
    }

    if ($OpenSettings) {
        $scale = $width / $logicalWidth
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](296 * $scale), $rectangle.Top + [int](21 * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Seconds 2
        [GpuixWindowCapture]::GetWindowRect($windowHandle, [ref]$rectangle) | Out-Null
        $width = $rectangle.Right - $rectangle.Left
        $height = $rectangle.Bottom - $rectangle.Top
        $logicalWidth = 528
    }

    if ($OpenLogin) {
        # Open the account side of the settings segmented control and allow the
        # worker to request the QR payload before capture.
        $scale = $width / $logicalWidth
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](447 * $scale), $rectangle.Top + [int](114 * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Seconds 4
    }

    if ($TypeSampleStreamKey) {
        $scale = $width / $logicalWidth
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](208 * $scale), $rectangle.Top + [int](114 * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 150
        [System.Windows.Forms.SendKeys]::SendWait("vrcdn_sample_stream_key_123456")
        Start-Sleep -Milliseconds 350

    }

    if ($SaveSettings) {
        $scale = $width / $logicalWidth
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](174 * $scale), $rectangle.Top + [int](303 * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Seconds 1
    }

    if ($RevealSampleStreamKey) {
        $scale = $width / $logicalWidth
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](274 * $scale), $rectangle.Top + [int](116 * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 500
    }

    if ($ReturnFromSubview) {
        $scale = $width / $logicalWidth
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](21 * $scale), $rectangle.Top + [int](21 * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Seconds 2
    }

    if ($OpenDanmakuFont) {
        if ($Scene -ne "danmaku") {
            throw "OpenDanmakuFont requires -Scene danmaku."
        }
        $scale = $width / $logicalWidth
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](279 * $scale), $rectangle.Top + [int](398 * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 500
    }

    if ($OpenPartSelect) {
        if ($Scene -ne "ready-vod") {
            throw "OpenPartSelect requires -Scene ready-vod."
        }
        $scale = $width / $logicalWidth
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](276 * $scale), $rectangle.Top + [int](262 * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 500
    }

    if ($CyclePlaybackEndBehavior) {
        if ($Scene -ne "ready-vod") {
            throw "CyclePlaybackEndBehavior requires -Scene ready-vod."
        }
        $scale = $width / $logicalWidth
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](385 * $scale), $rectangle.Top + [int](330 * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 500
    }

    if ($DragSelectStaticText) {
        if ($Scene -ne "settings") {
            throw "DragSelectStaticText currently targets the settings surface."
        }
        $scale = $width / $logicalWidth
        $selectionY = $rectangle.Top + [int](277 * $scale)
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](39 * $scale), $selectionY) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](296 * $scale), $selectionY) | Out-Null
        Start-Sleep -Milliseconds 120
        [GpuixWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 250
    }

    if ($ScrollContent) {
        $scale = $width / $logicalWidth
        $scrollY = if ($OpenPartSelect) { 400 } else { 230 }
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left + [int](240 * $scale), $rectangle.Top + [int]($scrollY * $scale)) | Out-Null
        [GpuixWindowCapture]::mouse_event(0x0800, 0, 0, [uint32]4294966576, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 300
    }

    [GpuixWindowCapture]::GetWindowRect($windowHandle, [ref]$rectangle) | Out-Null
    # Keep hover-only fills out of reference captures unless a probe explicitly
    # needs them. The pointer can otherwise remain over a caption button after
    # an earlier interaction and make the shared title-bar band look unbalanced.
    if (-not $IncludePopup) {
        [GpuixWindowCapture]::SetCursorPos($rectangle.Left - 16, $rectangle.Bottom + 16) | Out-Null
        Start-Sleep -Milliseconds 250
    }
    else {
        Start-Sleep -Milliseconds 60
    }

    $captureRectangle = if ($IncludePopup) {
        [GpuixWindowCapture]::GetVisibleProcessBounds([uint32]$process.Id)
    } else {
        $rectangle
    }
    $width = $captureRectangle.Right - $captureRectangle.Left
    $height = $captureRectangle.Bottom - $captureRectangle.Top

    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($captureRectangle.Left, $captureRectangle.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
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
