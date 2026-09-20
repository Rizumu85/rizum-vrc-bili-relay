$ErrorActionPreference = 'Stop'
# Hosted CI only; this toolchain is not shipped or installed into user settings.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This setup script is intended for hosted measurements.' }
$root = Join-Path $env:RUNNER_TEMP 'media-observation-ffmpeg'
New-Item $root -ItemType Directory -Force | Out-Null
$url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$archive = Join-Path $root 'ffmpeg.zip'
$expected = ((Invoke-WebRequest "$url.sha256").Content -split '\s+')[0].Trim().ToLowerInvariant()
if ($expected -notmatch '^[0-9a-f]{64}$') { throw 'Malformed publisher checksum.' }
Invoke-WebRequest $url -OutFile $archive
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'FFmpeg archive differs from its publisher checksum.' }
Expand-Archive -LiteralPath $archive -DestinationPath $root
$binary = @(Get-ChildItem $root -Recurse -Filter ffmpeg.exe)
if ($binary.Count -ne 1) { throw 'Expected exactly one FFmpeg executable.' }
$probe = Join-Path $binary[0].DirectoryName 'ffprobe.exe'
if (-not (Test-Path $probe)) { throw 'The verified toolchain has no FFprobe.' }
"VRC_BILI_RELAY_BENCH_FFMPEG=$($binary[0].FullName)" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
"VRC_BILI_RELAY_BENCH_FFPROBE=$probe" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
New-Item artifacts/benchmarks -ItemType Directory -Force | Out-Null
[ordered]@{source=$url; sha256=$actual; publisher_sha256=$expected; version=(& $binary[0].FullName -version | Select-Object -First 1)} | ConvertTo-Json | Set-Content artifacts/benchmarks/ffmpeg-toolchain.json -Encoding utf8NoBOM
