param(
    [string]$Source = (Join-Path (Split-Path -Parent $PSScriptRoot) 'web\agentdesk.png'),
    [string]$Output = (Join-Path (Split-Path -Parent $PSScriptRoot) 'web\agentdesk.ico')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskImage = [Drawing.Image]::FromFile($Source)
$taskFrames = @()
try {
    foreach ($taskSize in @(16, 24, 32, 48, 64, 128, 256)) {
        $taskBitmap = New-Object Drawing.Bitmap($taskSize, $taskSize, ([Drawing.Imaging.PixelFormat]::Format32bppArgb))
        $taskGraphics = [Drawing.Graphics]::FromImage($taskBitmap)
        $taskStream = New-Object IO.MemoryStream
        try {
            $taskGraphics.Clear([Drawing.Color]::Transparent)
            $taskGraphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
            $taskGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $taskGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $taskScale = [Math]::Min($taskSize / $taskImage.Width, $taskSize / $taskImage.Height)
            $taskWidth = [int][Math]::Round($taskImage.Width * $taskScale)
            $taskHeight = [int][Math]::Round($taskImage.Height * $taskScale)
            $taskLeft = [int][Math]::Floor(($taskSize - $taskWidth) / 2)
            $taskTop = [int][Math]::Floor(($taskSize - $taskHeight) / 2)
            $taskGraphics.DrawImage($taskImage, $taskLeft, $taskTop, $taskWidth, $taskHeight)
            $taskBitmap.Save($taskStream, [Drawing.Imaging.ImageFormat]::Png)
            $taskFrames += ,@{ Size = $taskSize; Bytes = $taskStream.ToArray() }
        } finally { $taskStream.Dispose(); $taskGraphics.Dispose(); $taskBitmap.Dispose() }
    }
} finally { $taskImage.Dispose() }
$taskFile = [IO.File]::Open($Output, [IO.FileMode]::Create)
$taskWriter = New-Object IO.BinaryWriter($taskFile)
try {
    $taskWriter.Write([uint16]0); $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]$taskFrames.Count)
    $taskOffset = 6 + 16 * $taskFrames.Count
    foreach ($taskFrame in $taskFrames) {
        $taskDimension = if ($taskFrame.Size -eq 256) { 0 } else { $taskFrame.Size }
        $taskWriter.Write([byte]$taskDimension); $taskWriter.Write([byte]$taskDimension)
        $taskWriter.Write([byte]0); $taskWriter.Write([byte]0)
        $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]32)
        $taskWriter.Write([uint32]$taskFrame.Bytes.Length); $taskWriter.Write([uint32]$taskOffset)
        $taskOffset += $taskFrame.Bytes.Length
    }
    foreach ($taskFrame in $taskFrames) { $taskWriter.Write([byte[]]$taskFrame.Bytes) }
} finally { $taskWriter.Dispose() }
Write-Output ('Built 7 transparent icon sizes: ' + $Output)
