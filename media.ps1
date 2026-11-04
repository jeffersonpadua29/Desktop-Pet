$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$task = $asTask.MakeGenericMethod($managerType).Invoke($null, @($managerType::RequestAsync()))
if (!$task.Wait(5000)) { throw 'Media session manager timed out.' }
$manager = $task.Result
$last = $null
while ($true) {
  $playing = $false
  foreach ($session in $manager.GetSessions()) {
    if ($session.SourceAppUserModelId -match 'spotify' -and $session.GetPlaybackInfo().PlaybackStatus -eq 'Playing') {
      $playing = $true
      break
    }
  }
  if ($playing -ne $last -or $null -eq $last) {
    [Console]::WriteLine($playing.ToString().ToLowerInvariant())
    $last = $playing
  }
  Start-Sleep -Milliseconds 500
}
