<#
  Velatura installer — Windows.

    irm https://…/install.ps1 | iex
    powershell -ExecutionPolicy Bypass -File install.ps1 -From .\velatura-app-0.1.5.zip

  It installs the program and a `velatura` command in your user folder.
  It reuses Node 20.19+ if it is already installed; otherwise it installs a
  checksum-verified portable runtime. No administrator rights needed.
#>
[CmdletBinding()]
param(
  [string] $From = '',
  [string] $Url = 'https://github.com/orfeomorello/velatura/releases/latest/download',
  [string] $Dir = '',
  [string] $Node = '',
  [switch] $NoLaunch,
  [switch] $Yes,
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$Version = '0.1.5'
$NodeVersion = 'v20.19.0'

# the program needs Node 20.19 or more
$MinNodeMajor = 20
$MinNodeMinor = 19

function Write-Step($text) { Write-Host "`n$text" -ForegroundColor White }
function Write-Info($text) { Write-Host "  $text" }
function Write-Fail($text) { Write-Host "  x $text" -ForegroundColor Red; exit 1 }

# where we install: the folder of the user, never a system folder, so that
# no administrator rights are ever needed
$Base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$InstallDir = if ($Dir) { $Dir } else { Join-Path $Base 'velatura' }
$AppDir = Join-Path $InstallDir 'app'
$BinDir = Join-Path $InstallDir 'bin'

# ------------------------------------------------------------- uninstall ----
if ($Uninstall) {
  Write-Step "Velatura $Version - removing"

  $binDir = Join-Path $InstallDir 'bin'
  $cmd = Join-Path $binDir 'velatura.cmd'

  Write-Info 'this will remove:'
  if (Test-Path $InstallDir) { Write-Info "  $InstallDir (the program, the runtime, the pictures)" }
  if (Test-Path $cmd) { Write-Info "  $cmd (the command)" }
  Write-Info '  the Velatura entry in your PATH, and the shortcuts'
  Write-Host ''
  # the subexpression: a variable followed by a colon is read as a
  # drive-qualified variable, and the text after it would disappear
  Write-Info "your models, your pictures and your history are inside $($InstallDir):"
  Write-Info 'they go away with it. Everything else on this machine stays.'

  if (-not $Yes) {
    $answer = Read-Host '  Remove them? [y/N]'
    if ($answer -notmatch '^(y|yes)$') {
      Write-Info 'nothing was removed'
      exit 0
    }
  }

  # the command
  if (Test-Path $cmd) { Remove-Item $cmd -Force }
  Write-Info 'removed the command'

  # the shortcuts
  foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    if (-not $folder) { continue }
    $shortcut = Join-Path $folder 'Velatura.lnk'
    if (Test-Path $shortcut) { Remove-Item $shortcut -Force }
  }
  Write-Info 'removed the shortcuts'

  # the folder
  if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force
    Write-Info "removed $InstallDir"
  }

  # the PATH
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath) {
    $kept = ($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $binDir.TrimEnd('\')) }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $kept, 'User')
    Write-Info 'cleaned your PATH'
  }

  Write-Step 'Done'
  Write-Info 'Velatura is not on this machine any more.'
  exit 0
}

Write-Step "Velatura $Version - installing for Windows"

# ---------------------------------------------------------------- runtime ----
Write-Step '1/4  Checking Node.js'

$arch = if ([Environment]::Is64BitOperatingSystem) {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
} else { 'x86' }

# the version of a Node, as a number: 20.19 becomes 20019
function Get-NodeVersion($exe) {
  if (-not $exe) { return 0 }
  try {
    $raw = & $exe --version 2>$null
  } catch {
    return 0
  }
  if ($raw -match 'v(\d+)\.(\d+)') {
    return ([int]$Matches[1] * 1000) + [int]$Matches[2]
  }
  return 0
}

# the Node that is already on the machine, if it is new enough
function Find-SystemNode {
  $minimum = $MinNodeMajor * 1000 + $MinNodeMinor
  $candidates = @()
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  foreach ($folder in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $folder) { continue }
    $candidates += (Join-Path $folder 'nodejs\node.exe')
    $candidates += (Join-Path $folder 'Programs\nodejs\node.exe')
  }
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    if (-not (Test-Path $candidate)) { continue }
    if ((Get-NodeVersion $candidate) -ge $minimum) { return $candidate }
  }
  return $null
}

$nodeExe = $null
$minimumNode = $MinNodeMajor * 1000 + $MinNodeMinor
if ($Node) {
  $nodeExe = $Node
  if ((Get-NodeVersion $nodeExe) -lt $minimumNode) {
    Write-Fail "the Node at $nodeExe is too old or could not be run: we need $MinNodeMajor.$MinNodeMinor or more"
  }
  Write-Info "using $nodeExe ($(& $nodeExe --version))"
} else {
  $runtimeDir = Join-Path $InstallDir 'runtime'
  $bundled = Join-Path $runtimeDir 'node.exe'
  # Prefer a compatible system Node to a private copy.
  $systemNode = Find-SystemNode
  if ($systemNode) {
    $nodeExe = $systemNode
    Write-Info "using the Node already on this machine: $nodeExe ($(& $nodeExe --version))"
    Write-Info 'nothing was downloaded'
  } elseif ((Test-Path $bundled) -and ((Get-NodeVersion $bundled) -ge $minimumNode)) {
    $nodeExe = $bundled
    Write-Info "using the private runtime already installed: $(& $nodeExe --version)"
  } else {
    if (Test-Path $bundled) {
      Write-Info 'the private Node runtime is too old; it will be replaced'
    }
    $old = Get-Command node -ErrorAction SilentlyContinue
    if ($old) {
      Write-Info "the Node on PATH is not compatible; Velatura needs $MinNodeMajor.$MinNodeMinor or more"
    }

    $archiveName = "node-$NodeVersion-win-$($arch).zip"
    $url = "https://nodejs.org/dist/$NodeVersion/$archiveName"
    $archive = Join-Path $InstallDir $archiveName
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Write-Info "downloading $archiveName"
    try {
      Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
    } catch {
      if (Test-Path $archive) { Remove-Item $archive -Force }
      Write-Fail "download failed: $url"
    }

    # The fallback runtime is not unpacked until its checksum is verified
    # against Node.js' official SHASUMS256.txt.
    try {
      $sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
    } catch {
      if (Test-Path $archive) { Remove-Item $archive -Force }
      Write-Fail 'could not download the official Node checksum list; nothing was installed'
    }
    $sumLine = $sums -split '\r?\n' | Where-Object {
      $parts = $_.Trim() -split '\s+', 2
      ($parts.Count -eq 2) -and ($parts[1] -eq $archiveName)
    } | Select-Object -First 1
    $expected = if ($sumLine) { (($sumLine.Trim()) -split '\s+')[0].ToLower() } else { '' }
    if (-not $expected) {
      Remove-Item $archive -Force -ErrorAction SilentlyContinue
      Write-Fail "the official checksum list did not contain $archiveName; nothing was installed"
    }
    try {
      $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLower()
    } catch {
      Remove-Item $archive -Force -ErrorAction SilentlyContinue
      Write-Fail 'could not calculate the Node runtime checksum; nothing was installed'
    }
    if ($expected -ne $actual) {
      Remove-Item $archive -Force -ErrorAction SilentlyContinue
      Write-Fail 'checksum mismatch for the Node runtime - download aborted'
    }
    Write-Info 'Node runtime checksum verified'

    # Node's Windows ZIP contains one top-level versioned directory.
    $unpack = Join-Path $InstallDir '.node-unpack'
    if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
    try {
      Expand-Archive -Path $archive -DestinationPath $unpack -Force
    } catch {
      Remove-Item $archive -Force -ErrorAction SilentlyContinue
      Write-Fail 'could not unpack the Node runtime'
    }
    Remove-Item $archive -Force
    $nodeFolder = Join-Path $unpack "node-$NodeVersion-win-$($arch)"
    $extractedNode = Join-Path $nodeFolder 'node.exe'
    if (-not (Test-Path $extractedNode)) {
      Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
      Write-Fail 'the Node archive did not contain its expected executable'
    }
    if ((Get-NodeVersion $extractedNode) -lt $minimumNode) {
      Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
      Write-Fail 'the downloaded Node runtime failed its version check'
    }
    if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
    try {
      Move-Item -Path $nodeFolder -Destination $runtimeDir
    } catch {
      Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
      Write-Fail 'could not install the verified Node runtime'
    }
    Remove-Item $unpack -Recurse -Force
    $nodeExe = Join-Path $runtimeDir 'node.exe'
    Write-Info "installed $(& $nodeExe --version)"
  }
}

# ------------------------------------------------------------------- app ----
Write-Step '2/4  Velatura itself'

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$archive = Join-Path $InstallDir 'velatura-app.zip'
$archiveName = "velatura-app-$($Version).zip"
if ($From) {
  if (-not (Test-Path $From)) { Write-Fail "archive not found: $From" }
  $fromPath = (Resolve-Path -LiteralPath $From).Path
  Copy-Item -LiteralPath $fromPath -Destination $archive -Force
  Write-Info "using $From"
  $checksumPath = Join-Path (Split-Path -Parent $fromPath) 'SHASUMS256.txt'
  if (-not (Test-Path $checksumPath)) {
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    Write-Fail 'local application checksum list not found; installation stopped'
  }
  try {
    $sums = Get-Content -Raw -LiteralPath $checksumPath
  } catch {
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    Write-Fail 'could not read the local application checksum list; installation stopped'
  }
} else {
  if (-not $Url) { Write-Fail 'no source: use -From <archive> or -Url <base url>' }
  Write-Info "downloading from $Url"
  # a variable followed by a dot is a property access in PowerShell, and the
  # extension would be lost: the subexpression is the safe form
  Invoke-WebRequest -Uri "$Url/$archiveName" -OutFile $archive -UseBasicParsing

  # Do not run an application archive that could not be checked.
  try {
    $sums = (Invoke-WebRequest -Uri "$Url/SHASUMS256.txt" -UseBasicParsing).Content
  } catch {
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    Write-Fail 'could not download the application checksum list; installation stopped'
  }
}
$sumLine = $sums -split '\r?\n' | Where-Object {
  $parts = $_.Trim() -split '\s+', 2
  ($parts.Count -eq 2) -and ($parts[1] -eq $archiveName)
} | Select-Object -First 1
$expected = if ($sumLine) { (($sumLine.Trim()) -split '\s+')[0].ToLower() } else { '' }
if (-not $expected) {
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  Write-Fail "the checksum list did not contain $archiveName; installation stopped"
}
try {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLower()
} catch {
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  Write-Fail 'could not calculate the application checksum; installation stopped'
}
if ($expected -ne $actual) {
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  Write-Fail 'checksum mismatch for the application archive - installation stopped'
}
Write-Info 'application checksum verified'

if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
$unpack = Join-Path $InstallDir '.unpack'
if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
Expand-Archive -Path $archive -DestinationPath $unpack -Force
Move-Item (Join-Path $unpack 'app') $AppDir
Remove-Item $unpack -Recurse -Force
Remove-Item $archive -Force
Write-Info "installed in $AppDir"

# --------------------------------------------------------------- launcher ----
Write-Step '3/4  The velatura command'

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cmd = Join-Path $BinDir 'velatura.cmd'
# a batch file with LF line endings is read badly by cmd.exe: the lines are
# written with CRLF, in ASCII, without a byte order mark
$launcher = "@echo off`r`nset `"VELATURA_CONFIG_DIR=$InstallDir`"`r`n`"$nodeExe`" `"$AppDir\dist\velatura.js`" %*`r`n"
[System.IO.File]::WriteAllText($cmd, $launcher, (New-Object System.Text.ASCIIEncoding))

# add it to the user PATH, once
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $BinDir), 'User')
  Write-Info "added $BinDir to your PATH"
} else {
  Write-Info "the command is in $BinDir"
}
$env:Path = "$env:Path;$BinDir"

# a shortcut, for the people who do not use the terminal
try {
  $shell = New-Object -ComObject WScript.Shell
  $programs = [Environment]::GetFolderPath('Programs')
  $desktop = [Environment]::GetFolderPath('Desktop')
  foreach ($folder in @($programs, $desktop)) {
    if (-not $folder) { continue }
    $shortcut = $shell.CreateShortcut((Join-Path $folder 'Velatura.lnk'))
    $shortcut.TargetPath = $cmd
    $shortcut.WorkingDirectory = $AppDir
    $shortcut.IconLocation = "$nodeExe,0"
    $shortcut.Save()
  }
  Write-Info 'a shortcut is on your desktop and in the start menu'
} catch {
  Write-Info 'the shortcut could not be created (not a problem)'
}

# ----------------------------------------------------------------- engine ----
Write-Step '4/4  SD.Next'

$driveRoot = if ($env:SystemDrive) { [System.IO.Path]::GetPathRoot($env:SystemDrive + '\') } else { 'C:\' }
$engineCandidates = @(
  (Join-Path $env:USERPROFILE 'sdnext'),
  (Join-Path $env:USERPROFILE 'SD.Next'),
  (Join-Path $env:USERPROFILE 'Documents\sdnext'),
  (Join-Path $env:USERPROFILE 'Documents\SD.Next'),
  (Join-Path $env:USERPROFILE 'Desktop\sdnext'),
  (Join-Path $env:USERPROFILE 'AI\sdnext'),
  (Join-Path $driveRoot 'sdnext'),
  (Join-Path $driveRoot 'AI\sdnext')
)
if ($env:PUBLIC) {
  $engineCandidates += (Join-Path $env:PUBLIC 'sdnext')
  $engineCandidates += (Join-Path $env:PUBLIC 'AI\sdnext')
}
$engine = $null
foreach ($candidate in ($engineCandidates | Select-Object -Unique)) {
  if ((Test-Path -LiteralPath (Join-Path $candidate 'webui.bat') -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path $candidate 'launch.py') -PathType Leaf)) {
    $engine = $candidate
    break
  }
}
if ($engine) {
  Write-Info "Found a likely SD.Next checkout at $engine (webui.bat and launch.py found)."
  Write-Info 'The setup wizard will check this folder before Velatura saves it.'
} else {
  Write-Info 'No SD.Next startup script was found in the usual Windows locations.'
  Write-Info 'The setup wizard will let you enter a folder and check it, or install SD.Next in your user folder.'
}
Write-Info 'This installer does not install SD.Next or download model weights by itself.'
Write-Info 'The setup wizard checks Git and Python, then asks you to confirm before it clones or starts SD.Next.'

# ----------------------------------------------------------------- launch ----
Write-Step 'Done'
Write-Info 'Start Velatura with:   velatura'
Write-Info 'It opens in your browser at http://127.0.0.1:7865'

if (-not $NoLaunch) {
  if ($Yes) {
    Start-Process -FilePath $cmd -ArgumentList 'serve'
  } else {
    $answer = Read-Host '  Start it now? [Y/n]'
    if ($answer -notmatch '^(n|no)$') { Start-Process -FilePath $cmd -ArgumentList 'serve' }
  }
}
exit 0
