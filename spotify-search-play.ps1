param([Parameter(Mandatory)][string]$EncodedQuery, [switch]$Inspect)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$query = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedQuery)).Trim()
if (!$query) { [Console]::WriteLine('no-match'); return }

function Get-TitleMatchRank([string]$Title, [string]$Query) {
  if (!$Title -or !$Query) { return 0 }
  if ($Title -ieq $Query) { return 2 }
  if ($Query.Length -ge 3 -and $Title.StartsWith($Query, [StringComparison]::OrdinalIgnoreCase) -and
      ![char]::IsLetterOrDigit($Title[$Query.Length])) { return 1 }
  return 0
}

function Get-PlayButtonMatch([string]$Label, [string]$Query) {
  if ($Label.Trim() -notmatch '^Play\s+(.+)$') { return $null }
  $title = $Matches[1]
  $prefix = $Query + ' by '
  if ($title.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    return [pscustomobject]@{ Title = $title.Substring(0, $Query.Length); Artist = $title.Substring($prefix.Length); Rank = 2; Top = $false }
  }
  $rank = Get-TitleMatchRank $title $Query
  if ($rank) { return [pscustomobject]@{ Title = $title; Artist = ''; Rank = $rank; Top = $false } }
}

function Get-TrackCardMatch($Button, [string]$Query, $ButtonCondition, $TextCondition) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $parent = $Button
  $parts = $Query -split '\s+by\s+', 2
  for ($depth = 0; $depth -lt 5; $depth++) {
    $parent = $walker.GetParent($parent)
    if (!$parent -or $parent.Current.ControlType -in @(
      [System.Windows.Automation.ControlType]::Document, [System.Windows.Automation.ControlType]::Window
    )) { break }
    $labels = @($parent.FindAll([System.Windows.Automation.TreeScope]::Descendants, $TextCondition) |
      ForEach-Object { ([string]$_.Current.Name).Trim() } | Where-Object { $_ })
    if (!($labels -match '^(?:Explicit\s+)?Song(?:\s|$)')) { continue }
    $artist = ''
    $songLabel = $labels -match '^(?:Explicit\s+)?Song\s*[\u2022\u00B7]\s*(.+)$' | Select-Object -First 1
    if ($songLabel) { $artist = $songLabel -replace '^(?:Explicit\s+)?Song\s*[\u2022\u00B7]\s*', '' }
    $artistMatch = $parts.Count -eq 2 -and ($artist -ieq $parts[1] -or $labels -icontains $parts[1])
    $titles = @($labels | Sort-Object -Unique | ForEach-Object {
      $rank = Get-TitleMatchRank $_ $Query
      if ($artistMatch -and !$rank) { $rank = Get-TitleMatchRank $_ $parts[0] }
      if ($rank) { [pscustomobject]@{ Title = $_; Rank = $rank } }
    })
    if (!$titles.Count) { continue }
    $bestRank = ($titles | Measure-Object Rank -Maximum).Maximum
    $best = @($titles | Where-Object Rank -eq $bestRank)
    if ($best.Count -ne 1) { continue }
    $playButtons = @($parent.FindAll([System.Windows.Automation.TreeScope]::Descendants, $ButtonCondition) |
      Where-Object { $_.Current.Name -match '^Play(?:\s|$)' })
    if ($playButtons.Count -eq 1) {
      return [pscustomobject]@{
        Title = $best[0].Title
        Artist = if ($artistMatch) { $parts[1] } else { $artist }
        Rank = $bestRank
        Top = $parent.Current.Name -match '^Top result\b' -or $labels -icontains 'Top result'
      }
    }
  }
}

function Get-SpotifyPlayButtons([string]$Query) {
  $sessionId = (Get-Process -Id $PID).SessionId
  $parts = $Query -split '\s+by\s+', 2
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $textCondition = [System.Windows.Automation.OrCondition]::new([System.Windows.Automation.Condition[]]@(
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text),
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataItem),
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)
  ))
  $searchCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty, 'Search results'
  )
  foreach ($process in Get-Process -Name Spotify -ErrorAction SilentlyContinue) {
    if ($process.SessionId -ne $sessionId -or $process.MainWindowHandle -eq [IntPtr]::Zero) { continue }
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
      $search = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $searchCondition)
      if ($search) { $root = $search }
      $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
      foreach ($button in $buttons) {
        if (!$button.Current.IsEnabled -or $button.Current.IsOffscreen) { continue }
        $label = $button.Current.Name
        $match = Get-PlayButtonMatch $label $Query
        if ($match -or $label -ieq 'Play' -or ($parts.Count -eq 2 -and $label -ieq ('Play ' + $parts[0]))) {
          $card = Get-TrackCardMatch $button $Query $condition $textCondition
          if ($card) { $match = $card }
        }
        if (!$match) { continue }
        $invoke = $null
        if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
          $match | Add-Member -NotePropertyName Invoke -NotePropertyValue $invoke -PassThru
        }
      }
    } catch [System.Windows.Automation.ElementNotAvailableException] { }
  }
}

function Select-SpotifyMatch($Candidates) {
  $rank = ($Candidates | Measure-Object Rank -Maximum).Maximum
  $best = @($Candidates | Where-Object Rank -eq $rank)
  $top = @($best | Where-Object Top)
  if ($top.Count) { $best = $top }
  $titles = @($best | ForEach-Object Title | Sort-Object -Unique)
  $artists = @($best | ForEach-Object Artist | Where-Object { $_ } | Sort-Object -Unique)
  if ($titles.Count -gt 1 -or $artists.Count -gt 1) { return $null }
  if ($artists.Count) { return $best | Where-Object Artist | Select-Object -First 1 }
  return $best[0]
}

$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  $candidates = @(Get-SpotifyPlayButtons $query)
  if ($candidates.Count -gt 0) {
    $selected = Select-SpotifyMatch $candidates
    if (!$selected) { [Console]::WriteLine('ambiguous'); return }
    try {
      if (!$Inspect) { $selected.Invoke.Invoke() }
      [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ title = $selected.Title; artist = $selected.Artist }))
      return
    } catch [System.Windows.Automation.ElementNotAvailableException] { }
  }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
[Console]::WriteLine('no-match')
