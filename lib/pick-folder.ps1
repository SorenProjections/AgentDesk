$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$taskPickerOwner = New-Object System.Windows.Forms.Form
$taskPickerOwner.TopMost = $true
$taskPickerOwner.ShowInTaskbar = $false
$taskPickerOwner.Opacity = 0
$taskPicker = New-Object System.Windows.Forms.FolderBrowserDialog
$taskPicker.Description = 'Choose the local project folder for Codex'
$taskPicker.ShowNewFolderButton = $true
if ($taskPicker.PSObject.Properties['UseDescriptionForTitle']) { $taskPicker.UseDescriptionForTitle = $true }
if ($env:CODEX_SCHEDULER_FOLDER -and (Test-Path -LiteralPath $env:CODEX_SCHEDULER_FOLDER -PathType Container)) {
  $taskPicker.SelectedPath = $env:CODEX_SCHEDULER_FOLDER
}
try {
  $taskPickerOwner.Show()
  if ($taskPicker.ShowDialog($taskPickerOwner) -eq [System.Windows.Forms.DialogResult]::OK) {
    @{ cwd = $taskPicker.SelectedPath; cancelled = $false } | ConvertTo-Json -Compress
  } else {
    @{ cwd = ''; cancelled = $true } | ConvertTo-Json -Compress
  }
} finally {
  $taskPicker.Dispose()
  $taskPickerOwner.Dispose()
}
