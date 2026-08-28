param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath,
    [Parameter(Mandatory = $true)]
    [int]$PanelLeft,
    [Parameter(Mandatory = $true)]
    [int]$PanelTop,
    [Parameter(Mandatory = $true)]
    [int]$PanelWidth,
    [ValidateRange(4, 64)]
    [int]$CornerSize = 10
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$resolvedImage = [System.IO.Path]::GetFullPath($ImagePath)
$bitmap = [System.Drawing.Bitmap]::FromFile($resolvedImage)
try {
    if ($PanelLeft -lt 2 -or $PanelTop -lt 0 -or $PanelWidth -le ($CornerSize * 2)) {
        throw "The supplied popup geometry cannot contain the requested corner samples."
    }
    if (($PanelLeft + $PanelWidth) -gt $bitmap.Width -or ($PanelTop + $CornerSize) -ge $bitmap.Height) {
        throw "The supplied popup geometry extends beyond the image."
    }

    # The outside and inside samples establish the two colours that legitimate
    # antialiasing may blend. A neutral transition darker than both is a popup
    # compositing fringe, not an ordinary white-on-grey rounded edge.
    $outside = $bitmap.GetPixel($PanelLeft - 2, $PanelTop + $CornerSize)
    $inside = $bitmap.GetPixel($PanelLeft + $CornerSize, $PanelTop + $CornerSize)
    $outsideLuma = ($outside.R + $outside.G + $outside.B) / 3.0
    $insideLuma = ($inside.R + $inside.G + $inside.B) / 3.0
    $expectedFloor = [Math]::Min($outsideLuma, $insideLuma) - 3.0

    $anomalousLuma = [System.Collections.Generic.List[double]]::new()
    $cornerStarts = @(
        $PanelLeft
        ($PanelLeft + $PanelWidth - 1 - $CornerSize)
    )
    foreach ($cornerLeft in $cornerStarts) {
        foreach ($x in $cornerLeft..($cornerLeft + $CornerSize)) {
            foreach ($y in $PanelTop..($PanelTop + $CornerSize)) {
                $pixel = $bitmap.GetPixel($x, $y)
                $maximum = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
                $minimum = [Math]::Min($pixel.R, [Math]::Min($pixel.G, $pixel.B))
                $luma = ($pixel.R + $pixel.G + $pixel.B) / 3.0
                if (($maximum - $minimum) -le 4 -and $luma -lt $expectedFloor) {
                    $anomalousLuma.Add($luma)
                }
            }
        }
    }

    $darkest = if ($anomalousLuma.Count -gt 0) {
        ($anomalousLuma | Measure-Object -Minimum).Minimum
    }
    else {
        $null
    }
    $mean = if ($anomalousLuma.Count -gt 0) {
        ($anomalousLuma | Measure-Object -Average).Average
    }
    else {
        $null
    }
    $maximumDarkening = if ($null -eq $darkest) {
        0
    }
    else {
        [Math]::Round($expectedFloor - $darkest, 3)
    }

    [ordered]@{
        metric = "native-popup-neutral-corner-fringe"
        image = $resolvedImage
        geometry = [ordered]@{
            left = $PanelLeft
            top = $PanelTop
            width = $PanelWidth
            cornerSize = $CornerSize
        }
        samples = [ordered]@{
            outside = ('#{0:X2}{1:X2}{2:X2}' -f $outside.R, $outside.G, $outside.B)
            inside = ('#{0:X2}{1:X2}{2:X2}' -f $inside.R, $inside.G, $inside.B)
            expectedLumaFloor = [Math]::Round($expectedFloor, 3)
        }
        measurements = [ordered]@{
            anomalousPixelCount = $anomalousLuma.Count
            darkestLuma = if ($null -eq $darkest) { $null } else { [Math]::Round($darkest, 3) }
            meanAnomalousLuma = if ($null -eq $mean) { $null } else { [Math]::Round($mean, 3) }
            maximumDarkeningBelowExpected = $maximumDarkening
        }
        signal = if ($anomalousLuma.Count -gt 0) { "red" } else { "green" }
    } | ConvertTo-Json -Depth 4
}
finally {
    $bitmap.Dispose()
}
