param(
    [string]$SourcePngPath = (Join-Path $PSScriptRoot "..\assets\source\VRCBiliRelay.original.png"),
    [string]$PngPath = (Join-Path $PSScriptRoot "..\assets\VRCBiliRelay.png"),
    [string]$IcoPath = (Join-Path $PSScriptRoot "..\assets\VRCBiliRelay.ico")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$tileInset = 52
$tileSize = 1150
# Keep the approved, restrained tile silhouette. Runtime taskbar consistency
# is handled by explicitly assigning this embedded icon to the native window.
$cornerRadius = 207
$iconSizes = @(16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256)

function Set-RoundedTileAlpha {
    param([System.Drawing.Bitmap]$Bitmap)

    if ($Bitmap.Width -ne 1254 -or $Bitmap.Height -ne 1254) {
        throw "The app icon master must remain 1254x1254 pixels."
    }

    $rectangle = New-Object System.Drawing.Rectangle 0, 0, $Bitmap.Width, $Bitmap.Height
    $data = $Bitmap.LockBits(
        $rectangle,
        [System.Drawing.Imaging.ImageLockMode]::ReadWrite,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    try {
        $stride = [Math]::Abs($data.Stride)
        $bytes = New-Object byte[] ($stride * $Bitmap.Height)
        [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)

        $near = $tileInset
        $far = $tileInset + $tileSize - 1
        $centers = @(
            [double[]]@(($near + $cornerRadius), ($near + $cornerRadius), $near, $near),
            [double[]]@(($far - $cornerRadius + 1), ($near + $cornerRadius), ($far - $cornerRadius + 1), $near),
            [double[]]@(($near + $cornerRadius), ($far - $cornerRadius + 1), $near, ($far - $cornerRadius + 1)),
            [double[]]@(($far - $cornerRadius + 1), ($far - $cornerRadius + 1), ($far - $cornerRadius + 1), ($far - $cornerRadius + 1))
        )

        foreach ($corner in $centers) {
            $centerX = [double]$corner[0]
            $centerY = [double]$corner[1]
            $startX = [int]$corner[2]
            $startY = [int]$corner[3]
            for ($y = $startY; $y -lt $startY + $cornerRadius; $y += 1) {
                $dy = ($y + 0.5) - $centerY
                for ($x = $startX; $x -lt $startX + $cornerRadius; $x += 1) {
                    $dx = ($x + 0.5) - $centerX
                    $distance = [Math]::Sqrt($dx * $dx + $dy * $dy)
                    $coverage = [Math]::Max(0.0, [Math]::Min(1.0, $cornerRadius + 0.5 - $distance))
                    $offset = $y * $stride + $x * 4 + 3
                    $maskAlpha = [byte][Math]::Round(255 * $coverage)
                    $bytes[$offset] = [byte][Math]::Min($bytes[$offset], $maskAlpha)
                }
            }
        }

        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
    }
    finally {
        $Bitmap.UnlockBits($data)
    }
}

function Convert-ToPngBytes {
    param(
        [System.Drawing.Bitmap]$Source,
        [int]$Size
    )

    $target = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($target)
        try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.DrawImage($Source, 0, 0, $Size, $Size)
        }
        finally {
            $graphics.Dispose()
        }

        $stream = New-Object IO.MemoryStream
        try {
            $target.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            return ,$stream.ToArray()
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $target.Dispose()
    }
}

$sourceBytes = [IO.File]::ReadAllBytes([IO.Path]::GetFullPath($SourcePngPath))
$sourceStream = New-Object IO.MemoryStream (,$sourceBytes)
$source = [System.Drawing.Bitmap]::FromStream($sourceStream)
try {
    $master = $source.Clone(
        (New-Object System.Drawing.Rectangle 0, 0, $source.Width, $source.Height),
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
}
finally {
    $source.Dispose()
    $sourceStream.Dispose()
}

try {
    Set-RoundedTileAlpha -Bitmap $master

    $temporaryPng = "$([IO.Path]::GetFullPath($PngPath)).tmp.png"
    try {
        $master.Save($temporaryPng, [System.Drawing.Imaging.ImageFormat]::Png)
        [IO.File]::Copy($temporaryPng, [IO.Path]::GetFullPath($PngPath), $true)
    }
    finally {
        if ([IO.File]::Exists($temporaryPng)) {
            [IO.File]::Delete($temporaryPng)
        }
    }

    $images = @($iconSizes | ForEach-Object { Convert-ToPngBytes -Source $master -Size $_ })
    $stream = New-Object IO.MemoryStream
    $writer = New-Object IO.BinaryWriter $stream
    try {
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]$images.Count)

        $offset = 6 + 16 * $images.Count
        for ($index = 0; $index -lt $images.Count; $index += 1) {
            $size = $iconSizes[$index]
            $image = $images[$index]
            $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
            $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]$image.Length)
            $writer.Write([uint32]$offset)
            $offset += $image.Length
        }
        foreach ($image in $images) {
            $writer.Write($image)
        }
        $writer.Flush()
        [IO.File]::WriteAllBytes([IO.Path]::GetFullPath($IcoPath), $stream.ToArray())
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}
finally {
    $master.Dispose()
}

Write-Output "Generated $PngPath and $IcoPath with a $cornerRadius px optical corner radius."
