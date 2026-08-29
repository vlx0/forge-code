$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Root "dist\ForgeCode"
$Exe = Join-Path $Src "ForgeCode.exe"
if (-not (Test-Path $Exe)) {
    throw "ForgeCode.exe not found: $Exe"
}

$Install = Join-Path $env:LOCALAPPDATA "Programs\ForgeCode"
New-Item -ItemType Directory -Force -Path $Install | Out-Null
Get-Process -Name "ForgeCode" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400
robocopy $Src $Install /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with code $LASTEXITCODE"
}

$InstalledExe = Join-Path $Install "ForgeCode.exe"
$LetterIcoSrc = Join-Path $Root "web\assets\forge-code-letters.ico"
$LetterIco = Join-Path $Install "forge-code-letters.ico"
if (Test-Path $LetterIcoSrc) {
    Copy-Item -Force $LetterIcoSrc $LetterIco
    $Icon = $LetterIco
} else {
    $Icon = $InstalledExe
}
$Desktop = [Environment]::GetFolderPath("Desktop")
$StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$shell = New-Object -ComObject WScript.Shell

function Write-Shortcut([string]$Path) {
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $InstalledExe
    $lnk.WorkingDirectory = $Install
    $lnk.WindowStyle = 1
    $lnk.Description = "Forge Code"
    $lnk.IconLocation = "$Icon,0"
    $lnk.Save()
}

Remove-Item (Join-Path $Desktop "FC.lnk") -ErrorAction SilentlyContinue
Remove-Item (Join-Path $StartMenu "FC.lnk") -ErrorAction SilentlyContinue
Write-Shortcut (Join-Path $Desktop "Forge Code.lnk")
Write-Shortcut (Join-Path $StartMenu "Forge Code.lnk")
Write-Output $InstalledExe
