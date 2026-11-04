param(
    [string]$Destination = [Environment]::GetFolderPath('Desktop'),
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskLauncher = Join-Path $taskRoot 'desktop.vbs'
$taskIcon = Join-Path $taskRoot 'web\agentdesk.ico'
if (-not (Test-Path -LiteralPath $taskIcon -PathType Leaf)) { throw 'Missing web\agentdesk.ico.' }
if (-not (Test-Path -LiteralPath $Destination -PathType Container)) { throw 'Shortcut destination must be an existing directory.' }
$taskNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($taskNodeCommand) { $taskNode = $taskNodeCommand.Source }
else { $taskNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $taskNode -PathType Leaf)) { throw 'Install Node.js 22.13 or newer before creating the shortcut.' }
$taskLinkPath = Join-Path $Destination 'AgentDesk.lnk'
$taskShell = New-Object -ComObject WScript.Shell
$taskLink = $taskShell.CreateShortcut($taskLinkPath)
$taskArguments = '"' + $taskLauncher + '" "' + $taskNode + '"'
if ((Test-Path -LiteralPath $taskLinkPath) -and -not $Force) {
    if ($taskLink.Arguments -ne $taskArguments) { throw 'An AgentDesk shortcut from another location already exists. Use -Force to replace it.' }
}
$taskLink.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$taskLink.Arguments = $taskArguments
$taskLink.WorkingDirectory = $taskRoot
$taskLink.IconLocation = $taskIcon + ',0'
$taskLink.Description = 'AgentDesk - local AI agent task scheduler'
$taskLink.WindowStyle = 7
$taskLink.Save()
$taskReadback = $taskShell.CreateShortcut($taskLinkPath)
if ($taskReadback.Arguments -ne $taskArguments -or $taskReadback.IconLocation -ne ($taskIcon + ',0')) { throw 'Shortcut verification failed.' }
Write-Output ('Created shortcut: ' + $taskLinkPath)
