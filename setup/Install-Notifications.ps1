param([switch]$CheckBundle)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$title = 'Pet Pocket Notifications'
$bundle = Join-Path $PSScriptRoot 'PetPocket-Notifications-x64.zip'
$metadata = Join-Path $PSScriptRoot 'notification-bundle.json'
$packageName = 'PetPocket.NotificationListener'
$stage = $null

function Open-Companion($package) {
    Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$($package.PackageFamilyName)!App"
}

try {
    if (!$CheckBundle) {
        $installed = Get-AppxPackage -Name $packageName
        if ($installed -and $installed.Status -eq 'Ok') {
            Open-Companion $installed
            return
        }
    }

    $expected = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash -ne $expected.sha256) {
        throw 'The setup bundle did not match its published checksum. Get a fresh copy from the project repository.'
    }

    $stage = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('pet-pocket-install-' + [guid]::NewGuid()))).FullName
    Expand-Archive -LiteralPath $bundle -DestinationPath $stage
    $packagePath = Join-Path $stage 'PetPocket.Notifications.msix'
    $publicCert = Join-Path $stage 'PetPocket.cer'
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($publicCert)
    if ($cert.Subject -ne 'CN=PetPocket' -or $cert.Thumbprint -ne $expected.thumbprint) {
        throw 'The bundled certificate does not match the Pet Pocket development certificate.'
    }
    if ($cert.NotBefore -gt (Get-Date) -or $cert.NotAfter -le (Get-Date)) {
        throw 'The Pet Pocket development certificate is expired or not yet valid. Ask the project maintainer for a fresh bundle.'
    }
    $deps = @(Get-ChildItem -LiteralPath (Join-Path $stage 'Dependencies') -File -Filter '*.appx' | Select-Object -ExpandProperty FullName)
    if (!(Test-Path -LiteralPath $packagePath) -or $deps.Count -ne 3) {
        throw 'The notification package or one of its Microsoft runtime dependencies is missing.'
    }
    if ($CheckBundle) {
        Write-Output "Bundle checksum, public certificate, and $($deps.Count) dependencies verified."
        return
    }

    $trust = "Cert:\LocalMachine\TrustedPeople\$($cert.Thumbprint)"
    if (!(Test-Path -LiteralPath $trust)) {
        $prompt = @"
Install Pet Pocket Notifications?

Windows needs to trust this local development signing certificate for all accounts on this PC. Only continue if you trust the repository you got this bundle from. Windows will ask for administrator approval.

Publisher: $($cert.Subject)
Thumbprint: $($cert.Thumbprint)
Expires: $($cert.NotAfter.ToString('yyyy-MM-dd'))
"@
        $answer = [System.Windows.Forms.MessageBox]::Show($prompt, $title, 'YesNo', 'Question', 'Button2')
        if ($answer -ne 'Yes') { return }
        $import = Start-Process -FilePath "$env:SystemRoot\System32\certutil.exe" -ArgumentList @('-addstore', 'TrustedPeople', ('"' + $publicCert + '"')) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        if ($import.ExitCode -ne 0 -or !(Test-Path -LiteralPath $trust)) {
            throw 'Windows did not add the Pet Pocket certificate to Trusted People.'
        }
    }

    Add-AppxPackage -Path $packagePath -DependencyPath $deps
    $installed = Get-AppxPackage -Name $packageName
    if (!$installed -or $installed.Status -ne 'Ok') { throw 'Windows did not confirm the companion installation.' }
    Open-Companion $installed
}
catch {
    if ($CheckBundle) { throw }
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, $title, 'OK', 'Error')
    exit 1
}
finally {
    if ($stage) {
        $resolved = [System.IO.Path]::GetFullPath($stage)
        $tempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolved.StartsWith($tempPrefix + 'pet-pocket-install-', [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
