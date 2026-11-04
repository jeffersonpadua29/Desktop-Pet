# Pet Pocket setup for Windows

Pet Pocket has two parts. The desktop pet runs through Electron. The optional Pet Pocket Notifications companion reads Windows alerts after you grant it access. You can run and develop the pet without installing the companion.

## 1. Run the desktop pet

Use Windows 10 version 2004 or newer or Windows 11. Install [Node.js LTS](https://nodejs.org/en/download) with npm included. Node.js 24 was used for development. Install [Git for Windows](https://git-scm.com/install/windows) if you plan to clone from the command line. Open a new PowerShell window after installation and check both commands:

```powershell
node --version
npm --version
```

Once the repository is on GitHub, clone it and enter the project folder. If you already downloaded or cloned the files, open PowerShell in the folder that contains `package.json` and skip the clone commands.

```powershell
$repoUrl = Read-Host 'Paste the GitHub repository URL'
git clone $repoUrl pet-pocket
Set-Location pet-pocket
```

The project is already initialized. **`package.json`** declares the dependencies and **`package-lock.json`** records their versions. `npm init` creates a manifest for a new project. Here, **`npm ci` creates `node_modules` and installs the locked dependencies**. Commit both JSON files so collaborators can run the same install.

```powershell
npm ci
Test-Path node_modules
npm start
```

`Test-Path` should print `True` after a successful install. If npm says it cannot find `package.json`, check that you are in the project folder. If it says the lockfile is missing, make sure `package-lock.json` was included in the checkout.


The first install and launch need internet access for dependencies and the Electron runtime. Click the pet to open the controls. To restart after a code change, right-click the Pet Pocket tray icon, choose **Quit Anino**, and run `npm start` again. The tray icon may be in the overflow menu.

Use `npm run build` to check TypeScript without launching the app. The checked-in PNGs are ready to use. If you edit the sprite generator, run `python art/draw_sprites.py` from the repository root to rebuild the sheets.

## Live notifications from a clone

The repository includes an x64 development bundle at `setup/PetPocket-Notifications-x64.zip`. Keep that ZIP, `setup/notification-bundle.json`, and `setup/Install-Notifications.ps1` together when you push to GitHub. The ZIP includes the signed companion, its public certificate, and its Microsoft runtime dependencies.

1. Run `npm ci` and `npm start`. On the first launch, choose **Set up live alerts**. If you choose **Later**, you can start setup from **Desk → Set up live alerts** or by running `npm run setup:notifications`.
2. Read the certificate prompt and choose **Yes** if you trust the source. Approve the Windows administrator prompt. Setup installs the companion and opens it.
3. In **Pet Pocket Notifications**, click **Connect notifications → Allow**. Turn on **Include message previews** if you want message text.
4. Send a new Windows notification while the pet is visible and Quiet Mode is off.

Collaborators using the bundle can skip the build and signing sections below. The bundled development certificate expires **December 3, 2026 UTC**. After that, a maintainer needs to rebuild and sign a fresh bundle. For a public release, use a trusted signing process. [Microsoft guidance on MSIX package signing](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing)

## Maintainer setup and rebuild

## 2. Install the optional Windows build tools

The companion setup below builds an x64 development package. Install **Visual Studio 2022 Build Tools**, the **WinUI application development build tools** workload, and **Windows 10 SDK 10.0.19041.0**. If you already have Visual Studio 2022, add its **WinUI application development** workload, **Universal Windows Platform tools**, and the same SDK using Visual Studio Installer. [Microsoft workload and component IDs](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools?view=vs-2022)

For a fresh Build Tools install with WinGet, run:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget --override '--passive --wait --norestart --add Microsoft.VisualStudio.Workload.UniversalBuildTools --add Microsoft.VisualStudio.Component.Windows10SDK.19041'
```

Wait for setup to finish before building. It can take a while to download and install the SDK.

## 3. Build the notification companion

Open **Developer PowerShell for VS 2022**, change into the repository root, and run:

```powershell
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msbuild = & $vswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.Component.MSBuild -find 'MSBuild\Current\Bin\amd64\MSBuild.exe' |
  Select-Object -First 1
if (!$msbuild) { throw 'Visual Studio 2022 x64 MSBuild was not found.' }
& $msbuild windows-listener/PocketListener.csproj /restore /p:Configuration=Debug /p:Platform=x64 /p:GenerateAppxPackageOnBuild=true /p:AppxBundle=Never /p:UapAppxPackageBuildMode=SideloadOnly
if ($LASTEXITCODE -ne 0) { throw 'The notification companion build failed.' }
```

The package is created under `windows-listener/AppPackages` alongside its Microsoft runtime dependencies.

## 4. Sign your local development package

Each collaborator can generate their own short-lived certificate. Use the manifest publisher `CN=PetPocket` so it matches the package. These commands create a non-exportable private key in your Windows account and export only the public certificate. [Microsoft MSIX signing certificate guide](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing)

Run from the repository root in PowerShell:

```powershell
$built = Get-ChildItem windows-listener/AppPackages -Recurse -Filter 'PocketListener*_x64_Debug.msix' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$built) { throw 'Build the notification companion first.' }

$local = Join-Path $env:LOCALAPPDATA 'PetPocket\DevSigning'
New-Item -ItemType Directory -Path $local -Force | Out-Null
$package = Join-Path $local 'PetPocket.Notifications.msix'
Copy-Item -LiteralPath $built.FullName -Destination $package -Force

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object {
    $_.Subject -eq 'CN=PetPocket' -and
    $_.FriendlyName -eq 'Pet Pocket local package signing' -and
    $_.NotAfter -gt (Get-Date).AddDays(1) -and $_.HasPrivateKey
  } | Sort-Object NotAfter -Descending | Select-Object -First 1
if (!$cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=PetPocket' `
    -FriendlyName 'Pet Pocket local package signing' -CertStoreLocation Cert:\CurrentUser\My `
    -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddDays(30)
}
$publicCert = Join-Path $local 'PetPocket.cer'
Export-Certificate -Cert $cert -FilePath $publicCert | Out-Null
$signTool = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\10.0.19041.0\x64\signtool.exe'
& $signTool sign /fd SHA256 /sha1 $cert.Thumbprint $package
if ($LASTEXITCODE -ne 0) { throw 'Signing failed.' }
$cert | Select-Object Subject, Thumbprint, NotAfter
```

On your own development PC, open **PowerShell as Administrator** and import the exact public certificate you just created. Check that its thumbprint matches the one printed above. This adds trust for that signing certificate for all Windows accounts on the PC. Use the **Trusted People** store.

```powershell
$publicCert = Join-Path $env:LOCALAPPDATA 'PetPocket\DevSigning\PetPocket.cer'
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($publicCert)
$cert | Select-Object Subject, Thumbprint, NotAfter
Import-Certificate -FilePath $publicCert -CertStoreLocation Cert:\LocalMachine\TrustedPeople
```

If you elevated with a different Windows account, use the full path to the public certificate from the account that built the package. On a managed PC, follow your organization’s signing policy.

## 5. Install and connect

Back in PowerShell under the Windows account that will run Pet Pocket, from the repository root:

```powershell
$built = Get-ChildItem windows-listener/AppPackages -Recurse -Filter 'PocketListener*_x64_Debug.msix' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$built) { throw 'Build the notification companion first.' }
$deps = @(Get-ChildItem (Join-Path $built.DirectoryName 'Dependencies\x64') -Filter '*.appx' |
  Select-Object -ExpandProperty FullName)
$package = Join-Path $env:LOCALAPPDATA 'PetPocket\DevSigning\PetPocket.Notifications.msix'
Add-AppxPackage -Path $package -DependencyPath $deps
Get-AppxPackage -Name PetPocket.NotificationListener | Select-Object Name, Status
```

1. Open **Pet Pocket Notifications** from Start.
2. Click **Connect notifications**, then **Allow** in the Windows prompt.
3. Optionally enable **Include message previews**. Otherwise, the pet shows the app name.
4. Start Pet Pocket with `npm start`. Select a pet and turn off Quiet Mode for the test.
5. Trigger a new Windows toast, such as a calendar reminder. Your pet should show a **Boss** bubble. Open **Alerts** to reread it.

**Desk → Preview pet alert** checks the bubble only. A real toast checks the companion and Windows permissions. The listener receives Windows app notifications, including browser alerts that the browser forwards to Windows. [Windows notification access](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| MSBuild cannot find Windows XAML targets | Confirm the UWP build tools and SDK finished installing. Use x64 MSBuild from the command above. |
| Install reports `0x800B0109` | Verify the matching public certificate is in **Local Computer → Trusted People** and is still valid. |
| Install reports a missing framework | Use the `Dependencies\x64` files generated with the package. |
| Preview works but real alerts are missing | Open the companion, check Windows notification access, then send a fresh Windows toast with Quiet Mode off. |
| Bubble shows the app name only | Turn on **Include message previews** in the companion. The originating app also needs to include text in the Windows alert. |

## What to put on GitHub

Commit the application source, `package-lock.json`, sprite PNGs, and the `windows-listener` project, manifest, and assets. The repository already contains the inputs needed to rebuild both parts. Collaborators use the installer links above to get the tools and generate their local signing certificate.

Keep generated builds, loose certificate files, private keys, pet saves, and notification history local. The checked-in development ZIP is the exception for collaborators. It contains the public certificate and signed package. The private key stays in the Windows account used to sign it. The development certificate is for local testing. For a shared installer, publish a release signed through a trusted code-signing process or the Microsoft Store. [Microsoft guidance on signing MSIX packages](https://learn.microsoft.com/en-us/windows/msix/package/sign-msix-package-guide)


