# Rebuilds public/favicon.ico from the OASIS tree, replacing upstream's
# eye-of-Horus art in the browser tab. Same multi-resolution ICO writer as
# make-icon.ps1, pointed at the web favicon instead of the desktop shortcut.
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'public\oasis-icon.png'
$out  = Join-Path $root 'public\favicon.ico'
# Keep this file ASCII-only: PowerShell 5.1 reads .ps1 as ANSI, so a UTF-8
# em-dash inside a string is decoded as three bytes and breaks the parser.
if (-not (Test-Path $src)) { Write-Error "Source art missing: $src - run make-brand-assets.js first"; exit 1 }

$sizes = @(16, 32, 48, 64)
$orig  = [System.Drawing.Image]::FromFile($src)
$blobs = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($orig, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $blobs += ,@($s, $ms.ToArray())
  $bmp.Dispose(); $ms.Dispose()
}
$orig.Dispose()

$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$blobs.Count)
$offset = 6 + (16 * $blobs.Count)
foreach ($b in $blobs) {
  $dim = [Byte]$b[0]
  $bw.Write($dim); $bw.Write($dim); $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$b[1].Length); $bw.Write([UInt32]$offset)
  $offset += $b[1].Length
}
foreach ($b in $blobs) { $bw.Write($b[1]) }
$bw.Flush(); $bw.Close(); $fs.Close()
Write-Host "Wrote $out ($((Get-Item $out).Length) bytes, $($blobs.Count) resolutions)" -ForegroundColor Green
