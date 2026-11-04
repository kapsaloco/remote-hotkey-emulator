param([Parameter(Mandatory = $true)][string]$Archive, [Parameter(Mandatory = $true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$values = @()
foreach ($relative in @('config/server.local.json', '.tauri-dev-data/config/server.local.json', 'release/EmulatorRemote-data/config/server.local.json')) {
    $file = Join-Path $ProjectRoot $relative
    if (Test-Path -LiteralPath $file) {
        $config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        foreach ($value in @($config.token, $config.password.hash)) {
            if ($value -is [string] -and $value.Length -ge 24) { $values += $value }
        }
    }
}
$provider = '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b(AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b'
$allowed = @('EmulatorRemote.exe','README.txt','LICENSE','THIRD-PARTY-NOTICES.txt','BUILD-INFO.json')
$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
    if ($zip.Entries.Count -ne $allowed.Count) { throw 'Unexpected ZIP entries' }
    foreach ($entry in $zip.Entries) {
        if ($allowed -notcontains $entry.FullName) { throw 'Unexpected ZIP entry' }
        $stream = $entry.Open()
        $memory = New-Object System.IO.MemoryStream
        try { $stream.CopyTo($memory); $text = [Text.Encoding]::UTF8.GetString($memory.ToArray()) }
        finally { $stream.Dispose(); $memory.Dispose() }
        if ([regex]::IsMatch($text, $provider)) { throw "Credential pattern in ZIP entry: $($entry.FullName)" }
        if ([regex]::IsMatch($text, '\b(https?|postgres(ql)?|mysql|mongodb(\+srv)?):\/\/[^\s/:]+:[^\s@]+@')) { throw "Credential URL in ZIP entry: $($entry.FullName)" }
        foreach ($value in $values) { if ($text.Contains($value)) { throw "Local credential value in ZIP entry: $($entry.FullName)" } }
        foreach ($prefix in @($env:USERPROFILE, $env:USERPROFILE.Replace('\','/'))) {
            if ($text.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "Local home path in ZIP entry: $($entry.FullName)" }
        }
    }
} finally { $zip.Dispose() }
Write-Output 'ZIP allowlist and credential/home-path checks passed.'
