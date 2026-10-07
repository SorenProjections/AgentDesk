Option Explicit
Dim shell, fs, root, node
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
node = WScript.Arguments.Item(0)
shell.Run Chr(34) & node & Chr(34) & " " & Chr(34) & root & "\launch.mjs" & Chr(34) & " --no-browser", 0, False
