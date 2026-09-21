param(
    [Parameter(Mandatory = $true)][string]$PackageDirectory,
    [Parameter(Mandatory = $true)][string]$MeasurementDirectory
)
$ErrorActionPreference = 'Stop'
# Only a clean hosted runner: never replace the user's live application here.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REF -ne 'refs/heads/main') {
    throw 'Formal publication is restricted to the main-branch GitHub Actions job.'
}
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'A stable numeric version is required.' }
$tag = "v$version"
$name = "VRC-Bili-Relay-$version-windows-x64.zip"
$archive = Join-Path $PackageDirectory $name
$checksum = "$archive.sha256"
$report = Join-Path $MeasurementDirectory 'worker-roundtrip.json'
$mediaReport = Join-Path $MeasurementDirectory 'media-pipeline.json'
$assClockReport = Join-Path $MeasurementDirectory 'ass-clock.json'
$uiStateReport = Join-Path $MeasurementDirectory 'ui-state.json'
$stateBoundaryReport = Join-Path $MeasurementDirectory 'state-boundary.json'
$toolchainReport = Join-Path $MeasurementDirectory 'ffmpeg-toolchain.json'
$notes = "docs/releases/$tag.md"
foreach ($path in @($archive, $checksum, $report, $mediaReport, $assClockReport, $uiStateReport, $stateBoundaryReport, $toolchainReport, $notes)) {
    if (-not (Test-Path $path -PathType Leaf)) { throw "Missing release input: $path" }
}
$hash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$expected = ((Get-Content $checksum -Raw).Trim() -split '\s+')[0]
if ($hash -ne $expected) { throw 'Build archive checksum does not match its manifest.' }

# Never replace a pre-existing release or tag implicitly, even on reruns.
$existing = gh release view $tag --json tagName --repo $env:GITHUB_REPOSITORY 2>$null
if ($LASTEXITCODE -eq 0) { throw "Release $tag already exists; refusing replacement." }
$tags = gh api "repos/$env:GITHUB_REPOSITORY/git/matching-refs/tags/$tag" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not check the tag namespace.' }
if (@($tags | Where-Object { $_.ref -eq "refs/tags/$tag" }).Count -gt 0) {
    throw "Tag $tag already exists; refusing an unverified tag."
}
gh release create $tag $archive $checksum $report $mediaReport $assClockReport $uiStateReport $stateBoundaryReport $toolchainReport --repo $env:GITHUB_REPOSITORY --target $env:GITHUB_SHA --draft --title "$tag - Session expiry and list state" --notes-file $notes
if ($LASTEXITCODE -ne 0) { throw 'Could not create/upload the draft release.' }

# Re-download, verify, and expand the exact uploaded bytes; never rebuild here.
New-Item release -ItemType Directory -Force | Out-Null
gh release download $tag --repo $env:GITHUB_REPOSITORY --pattern $name --dir release
if ($LASTEXITCODE -ne 0) { throw 'Could not download the uploaded release asset.' }
$downloaded = Join-Path 'release' $name
$downloadHash = (Get-FileHash $downloaded -Algorithm SHA256).Hash.ToLowerInvariant()
if ($downloadHash -ne $hash) { throw 'Uploaded asset bytes differ from the build archive.' }
$metadata = gh release view $tag --repo $env:GITHUB_REPOSITORY --json databaseId | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the draft release id.' }
$release = gh api "repos/$env:GITHUB_REPOSITORY/releases/$($metadata.databaseId)" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not read draft release metadata.' }
$asset = @($release.assets | Where-Object { $_.name -eq $name })
if ($asset.Count -ne 1 -or $asset[0].digest -ne "sha256:$hash") {
    throw 'GitHub asset digest does not match the verified archive.'
}
Expand-Archive -LiteralPath $downloaded -DestinationPath release
$verification = [ordered]@{
    schema = 1
    tag = $tag
    commit = $env:GITHUB_SHA
    asset = $name
    sha256 = $hash
    downloaded_sha256 = $downloadHash
    github_digest = $asset[0].digest
    exact_uploaded_archive_expanded = $true
    runner = $env:RUNNER_OS
    run_id = $env:GITHUB_RUN_ID
}
$verification | ConvertTo-Json | Set-Content release/RELEASE-VERIFICATION.json -Encoding utf8NoBOM
gh release upload $tag release/RELEASE-VERIFICATION.json --repo $env:GITHUB_REPOSITORY
if ($LASTEXITCODE -ne 0) { throw 'Could not attach release verification.' }
gh release edit $tag --repo $env:GITHUB_REPOSITORY --draft=false --prerelease=false --latest
if ($LASTEXITCODE -ne 0) { throw 'Verified draft could not be published.' }
Write-Output "Published $tag from $env:GITHUB_SHA; SHA-256 $hash"
