param(
  [ValidateSet('monitor', 'play', 'pause', 'toggle', 'verify')][string]$Action = 'monitor',
  [string]$EncodedQuery = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Wait-WinRtOperation($Operation, [type]$ResultType, [int]$Timeout = 3000) {
  $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  if (!$task.Wait($Timeout)) { throw 'Windows media operation timed out.' }
  return $task.Result
}

function Get-SpotifySessions($Manager) {
  foreach ($session in $Manager.GetSessions()) {
    if ($session.SourceAppUserModelId -match 'spotify') { $session }
  }
}

function Test-SpotifyTrack($Session, [string]$Query) {
  $propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
  $properties = Wait-WinRtOperation ($Session.TryGetMediaPropertiesAsync()) $propertiesType
  if (!$properties -or !$properties.Title) { return $false }
  return $properties.Title.Trim() -ieq $Query -or
    ($properties.Artist -and ($properties.Title.Trim() + ' by ' + $properties.Artist.Trim()) -ieq $Query)
}

function Invoke-SpotifyPlayback($Session, [string]$Requested, [string]$Query) {
  if ($Query -and !(Test-SpotifyTrack $Session $Query)) { return 'different-track' }
  $current = $Session.GetPlaybackInfo().PlaybackStatus
  $shouldPlay = $Requested -eq 'play' -or ($Requested -eq 'toggle' -and $current -ne 'Playing')
  if ($shouldPlay -and $current -eq 'Playing') { return 'playing' }
  if (!$shouldPlay -and $current -in @('Paused', 'Stopped')) { return 'paused' }

  $operation = if ($shouldPlay) { $Session.TryPlayAsync() } else { $Session.TryPauseAsync() }
  if (!(Wait-WinRtOperation $operation ([bool]))) { return 'unconfirmed' }
  for ($attempt = 0; $attempt -lt 12; $attempt++) {
    $status = $Session.GetPlaybackInfo().PlaybackStatus
    if ($shouldPlay -and $status -eq 'Playing') {
      if ($Query -and !(Test-SpotifyTrack $Session $Query)) { return 'different-track' }
      return 'playing'
    }
    if (!$shouldPlay -and $status -in @('Paused', 'Stopped')) { return 'paused' }
    Start-Sleep -Milliseconds 200
  }
  return 'unconfirmed'
}

$manager = Wait-WinRtOperation ($managerType::RequestAsync()) $managerType 5000
$query = if ($EncodedQuery) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedQuery)).Trim() } else { '' }
if ($Action -eq 'verify') {
  for ($attempt = 0; $attempt -lt 14; $attempt++) {
    foreach ($session in (Get-SpotifySessions $manager)) {
      if ($session.GetPlaybackInfo().PlaybackStatus -eq 'Playing' -and (Test-SpotifyTrack $session $query)) {
        [Console]::WriteLine('playing')
        return
      }
    }
    Start-Sleep -Milliseconds 250
  }
  [Console]::WriteLine('unconfirmed')
  return
}
if ($Action -ne 'monitor') {
  $sessions = @(Get-SpotifySessions $manager)
  if (!$sessions.Count) { [Console]::WriteLine('no-session'); return }
  $session = $sessions[0]
  if ($sessions.Count -gt 1) {
    $session = $manager.GetCurrentSession()
    if (!$session -or $session.SourceAppUserModelId -notmatch 'spotify') {
      [Console]::WriteLine('ambiguous')
      return
    }
  }
  [Console]::WriteLine((Invoke-SpotifyPlayback $session $Action $query))
  return
}

$last = $null
while ($true) {
  $playing = $false
  foreach ($session in (Get-SpotifySessions $manager)) {
    if ($session.GetPlaybackInfo().PlaybackStatus -eq 'Playing') {
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
