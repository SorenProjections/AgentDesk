param([string]$Destination = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Destination -PathType Container)) { throw 'Shortcut destination must exist.' }
$taskLocal = [Environment]::GetFolderPath('LocalApplicationData')
$taskClients = @(
    @{ Name = 'WorkBuddy (AgentDesk)'; Port = 9337; Paths = @($env:WORKBUDDY_DESKTOP_BINARY, 'E:\workbuddy\WorkBuddy.exe', (Join-Path $taskLocal 'Programs\WorkBuddy\WorkBuddy.exe')) },
    @{ Name = 'Doubao (AgentDesk)'; Port = 9338; Paths = @($env:DOUBAO_DESKTOP_BINARY, (Join-Path $taskLocal 'Doubao\application\app\Doubao.exe'), (Join-Path $taskLocal 'Doubao\application\Doubao.exe')) }
)
$taskShell = New-Object -ComObject WScript.Shell
foreach ($taskClient in $taskClients) {
    $taskBinary = $taskClient.Paths | Where-Object { $_ -and [IO.Path]::IsPathRooted($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
    if (-not $taskBinary) { throw ('Client not found: ' + $taskClient.Name) }
    $taskPath = Join-Path $Destination ($taskClient.Name + '.lnk')
    $taskLink = $taskShell.CreateShortcut($taskPath)
    if ((Test-Path -LiteralPath $taskPath) -and $taskLink.TargetPath -ne $taskBinary) { throw ('A different shortcut already exists: ' + $taskPath) }
    $taskArgs = '--remote-debugging-port=' + $taskClient.Port + ' --remote-debugging-address=127.0.0.1'
    $taskLink.TargetPath = $taskBinary
    $taskLink.Arguments = $taskArgs
    $taskLink.WorkingDirectory = Split-Path -Parent $taskBinary
    $taskLink.IconLocation = $taskBinary + ',0'
    $taskLink.Description = 'Open client with a local AgentDesk connection'
    $taskLink.Save()
    $taskReadback = $taskShell.CreateShortcut($taskPath)
    if ($taskReadback.TargetPath -ne $taskBinary -or $taskReadback.Arguments -ne $taskArgs) { throw ('Shortcut verification failed: ' + $taskPath) }
    Write-Output ('Created and verified: ' + $taskPath)
}
