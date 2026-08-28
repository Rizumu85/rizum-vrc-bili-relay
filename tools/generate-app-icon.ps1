param(
    [string]$SourcePngPath = (Join-Path $PSScriptRoot "..\assets\source\VRCBiliRelay.original.png"),
    [string]$PngPath = (Join-Path $PSScriptRoot "..\assets\VRCBiliRelay.png"),
    [string]$IcoPath = (Join-Path $PSScriptRoot "..\assets\VRCBiliRelay.ico")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$tileInset = 52
$tileSize = 1150
# Fluent app icons use a 2 px exterior curve on the 48x48 construction grid.
# 52.25 px is the exact equivalent on this 1254 px source canvas.
$cornerRadius = 52.25
# 18px and 27px cover this product's 112.5% Windows environment without
# asking the shell to resample the 16/20px and 24/30px neighbours.
$iconSizes = @(16, 18, 20, 24, 27, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256)

function Set-RoundedTileAlpha {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [int]$SamplesPerAxis = 1
    )

    if ($Bitmap.Width -ne $Bitmap.Height) {
        throw "App icon layers must remain square."
    }

    $scale = $Bitmap.Width / 1254.0
    $scaledInset = [int][Math]::Round($tileInset * $scale)
    $scaledTileSize = [int][Math]::Round($tileSize * $scale)
    $scaledRadius = [Math]::Max(0.5, $cornerRadius * $scale)
    $cornerExtent = [int][Math]::Ceiling($scaledRadius)

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

        $near = $scaledInset
        $far = $scaledInset + $scaledTileSize - 1
        $centers = @(
            [double[]]@(($near + $scaledRadius), ($near + $scaledRadius), $near, $near),
            [double[]]@(($far - $scaledRadius + 1), ($near + $scaledRadius), ($far - $cornerExtent + 1), $near),
            [double[]]@(($near + $scaledRadius), ($far - $scaledRadius + 1), $near, ($far - $cornerExtent + 1)),
            [double[]]@(($far - $scaledRadius + 1), ($far - $scaledRadius + 1), ($far - $cornerExtent + 1), ($far - $cornerExtent + 1))
        )

        foreach ($corner in $centers) {
            $centerX = [double]$corner[0]
            $centerY = [double]$corner[1]
            $startX = [int]$corner[2]
            $startY = [int]$corner[3]
            for ($y = $startY; $y -lt $startY + $cornerExtent; $y += 1) {
                for ($x = $startX; $x -lt $startX + $cornerExtent; $x += 1) {
                    if ($SamplesPerAxis -le 1) {
                        $dx = ($x + 0.5) - $centerX
                        $dy = ($y + 0.5) - $centerY
                        $distance = [Math]::Sqrt($dx * $dx + $dy * $dy)
                        $coverage = [Math]::Max(0.0, [Math]::Min(1.0, $scaledRadius + 0.5 - $distance))
                    }
                    else {
                        $inside = 0
                        for ($sampleY = 0; $sampleY -lt $SamplesPerAxis; $sampleY += 1) {
                            $samplePositionY = $y + (($sampleY + 0.5) / $SamplesPerAxis)
                            $dy = $samplePositionY - $centerY
                            for ($sampleX = 0; $sampleX -lt $SamplesPerAxis; $sampleX += 1) {
                                $samplePositionX = $x + (($sampleX + 0.5) / $SamplesPerAxis)
                                $dx = $samplePositionX - $centerX
                                if (($dx * $dx + $dy * $dy) -le ($scaledRadius * $scaledRadius)) {
                                    $inside += 1
                                }
                            }
                        }
                        $coverage = $inside / [double]($SamplesPerAxis * $SamplesPerAxis)
                    }
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

function Set-SmallLayerSharpness {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [double]$Amount
    )

    if ($Amount -le 0) {
        return
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
        $result = [byte[]]$bytes.Clone()

        for ($y = 1; $y -lt $Bitmap.Height - 1; $y += 1) {
            for ($x = 1; $x -lt $Bitmap.Width - 1; $x += 1) {
                $offset = $y * $stride + $x * 4
                if ($bytes[$offset + 3] -lt 224) {
                    continue
                }

                $neighbors = @(($offset - 4), ($offset + 4), ($offset - $stride), ($offset + $stride))
                if (
                    $bytes[$neighbors[0] + 3] -lt 224 -or
                    $bytes[$neighbors[1] + 3] -lt 224 -or
                    $bytes[$neighbors[2] + 3] -lt 224 -or
                    $bytes[$neighbors[3] + 3] -lt 224
                ) {
                    continue
                }

                for ($channel = 0; $channel -lt 3; $channel += 1) {
                    $average = 0.0
                    foreach ($neighbor in $neighbors) {
                        $average += $bytes[$neighbor + $channel]
                    }
                    $average /= $neighbors.Count
                    $value = $bytes[$offset + $channel] + $Amount * ($bytes[$offset + $channel] - $average)
                    $result[$offset + $channel] = [byte][Math]::Round([Math]::Max(0, [Math]::Min(255, $value)))
                }
            }
        }

        [Runtime.InteropServices.Marshal]::Copy($result, 0, $data.Scan0, $result.Length)
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

        # Explorer requests discrete 16-96 px icon layers. Rasterize the mask on
        # each target grid instead of shrinking the antialiased 1254 px edge.
        Set-RoundedTileAlpha -Bitmap $target -SamplesPerAxis 8
        $sharpness = if ($Size -le 40) { 0.5 } elseif ($Size -le 64) { 0.25 } else { 0.0 }
        Set-SmallLayerSharpness -Bitmap $target -Amount $sharpness

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
if ($source.Width -ne 1254 -or $source.Height -ne 1254) {
    $source.Dispose()
    $sourceStream.Dispose()
    throw "The app icon master must remain 1254x1254 pixels."
}
$original = $source.Clone(
    (New-Object System.Drawing.Rectangle 0, 0, $source.Width, $source.Height),
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
)
$master = $source.Clone(
    (New-Object System.Drawing.Rectangle 0, 0, $source.Width, $source.Height),
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
)

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

    $images = @($iconSizes | ForEach-Object { Convert-ToPngBytes -Source $original -Size $_ })
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
    $original.Dispose()
    $source.Dispose()
    $sourceStream.Dispose()
}

Write-Output "Generated $PngPath and target-rasterized $IcoPath with a $cornerRadius px optical corner radius."
