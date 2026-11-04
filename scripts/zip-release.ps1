param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archive = [System.IO.Compression.ZipFile]::Open($Destination, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    # An explicit allowlist keeps settings, passwords, browser data and test
    # fixtures out of the archive, even if the staging folder was used before.
    foreach ($name in @('EmulatorRemote.exe', 'README.txt', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'BUILD-INFO.json')) {
        $source = Join-Path $SourceDirectory $name
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, $name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $archive.Dispose()
}
$verification = [System.IO.Compression.ZipFile]::OpenRead($Destination)
try {
    $expected = @('EmulatorRemote.exe', 'README.txt', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'BUILD-INFO.json')
    if ($verification.Entries.Count -ne $expected.Count) { throw 'Unexpected portable ZIP contents' }
    foreach ($entry in $verification.Entries) {
        if ($expected -notcontains $entry.FullName) { throw 'Unexpected portable ZIP entry' }
    }
    $stream = $verification.GetEntry('EmulatorRemote.exe').Open()
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
        $expectedHash = (Get-FileHash -LiteralPath (Join-Path $SourceDirectory 'EmulatorRemote.exe') -Algorithm SHA256).Hash
        if ($actual -ne $expectedHash) { throw 'Archived executable checksum mismatch' }
    } finally { $stream.Dispose(); $algorithm.Dispose() }
} finally { $verification.Dispose() }
