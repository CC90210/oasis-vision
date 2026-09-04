# Builds a multi-resolution .ico (16-256px, PNG-compressed entries) from the 1024px
# OASIS AI art, so the desktop / taskbar / Start Menu icon stays crisp at every size.
Add-Type -AssemblyName System.Drawing
$src = Join-Path (Split-Path -Parent $PSScriptRoot) 'public\oasis-icon.png'
$out = Join-Path $PSScriptRoot 'oasis-vision.ico'
if (-not (Test-Path $src)) { Write-Error "Source art missing: $src"; exit 1 }

$sizes = @(16, 32, 48, 64, 128, 256)
$orig  = [System.Drawing.Image]::FromFile($src)
$blobs = @()

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
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
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$blobs.Count)   # ICONDIR
$offset = 6 + (16 * $blobs.Count)
foreach ($b in $blobs) {
  $s = $b[0]; $data = $b[1]
  $dim = [Byte]$(if ($s -ge 256) { 0 } else { $s })   # 0 encodes 256 in the ICO spec
  $bw.Write($dim); $bw.Write($dim)
  $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($b in $blobs) { $bw.Write($b[1]) }
$bw.Flush(); $bw.Close(); $fs.Close()

Write-Host "Wrote $out ($((Get-Item $out).Length) bytes, $($blobs.Count) resolutions)" -ForegroundColor Green
