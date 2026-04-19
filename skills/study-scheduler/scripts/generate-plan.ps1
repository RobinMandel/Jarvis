param(
  [Parameter(Mandatory=$true)][datetime]$ExamDate,
  [int]$WeekdayHours = 2,
  [int]$WeekendHours = 4,
  [string[]]$HighYieldTopics = @(),
  [string[]]$MediumTopics = @(),
  [string]$OutputPath = "study-plan.md"
)

$today = (Get-Date).Date
$daysLeft = ($ExamDate.Date - $today).Days
if ($daysLeft -lt 1) { throw "ExamDate muss in der Zukunft liegen." }

$allTopics = @()
$allTopics += $HighYieldTopics | ForEach-Object { [pscustomobject]@{Topic=$_; Priority='High'; Weight=3; Reviews=0} }
$allTopics += $MediumTopics    | ForEach-Object { [pscustomobject]@{Topic=$_; Priority='Medium'; Weight=1; Reviews=0} }
if ($allTopics.Count -eq 0) {
  $allTopics += [pscustomobject]@{Topic='ACLS/ERC Kernalgorithmen'; Priority='High'; Weight=3; Reviews=0}
  $allTopics += [pscustomobject]@{Topic='OSCE Standardabläufe'; Priority='High'; Weight=3; Reviews=0}
  $allTopics += [pscustomobject]@{Topic='Pharmakologie Notfallmedikamente'; Priority='Medium'; Weight=1; Reviews=0}
}

$reviewOffsets = @(1,3,7,14)
$days = @()
for($i=0;$i -le $daysLeft;$i++) {
  $d = $today.AddDays($i)
  $isWeekend = ($d.DayOfWeek -eq 'Saturday' -or $d.DayOfWeek -eq 'Sunday')
  $hours = if($isWeekend){$WeekendHours}else{$WeekdayHours}
  $focusBlocks = [Math]::Max([int][Math]::Floor($hours),1)

  # greedy: high-weight with least reviews first
  $pick = $allTopics | Sort-Object -Property @{Expression='Reviews';Ascending=$true}, @{Expression='Weight';Descending=$true} | Select-Object -First $focusBlocks
  foreach($p in $pick){ $p.Reviews += 1 }

  $tasks = @()
  foreach($p in $pick){
    $tasks += "45-60min Fokus: $($p.Topic)"
  }
  $tasks += "10min Pause zwischen Blöcken"
  $tasks += "20-30min Tagesreview (aktive Wiederholung)"

  # spaced repetition reminders
  $rev = @()
  foreach($offset in $reviewOffsets){
    $target = $d.AddDays($offset)
    if($target -le $ExamDate){ $rev += "Review-Slot für heute gelernte Inhalte in $offset Tagen ($($target.ToString('dd.MM')))" }
  }

  $days += [pscustomobject]@{
    Date = $d
    IsWeekend = $isWeekend
    Hours = $hours
    Tasks = $tasks
    Reviews = $rev
  }
}

$weekly = $days | Group-Object { "KW " + [System.Globalization.CultureInfo]::GetCultureInfo('de-DE').Calendar.GetWeekOfYear($_.Date,[System.Globalization.CalendarWeekRule]::FirstFourDayWeek,[DayOfWeek]::Monday) }

$lines = @()
$lines += "# Lernplan bis $($ExamDate.ToString('dd.MM.yyyy'))"
$lines += ""
$lines += "- Start: $($today.ToString('dd.MM.yyyy'))"
$lines += "- Verbleibende Tage: $daysLeft"
$lines += "- Budget: Werktag $WeekdayHours h | Wochenende $WeekendHours h"
$lines += ""
$lines += "## Top Next Actions"
$lines += "1. Heute High-Yield Block starten"
$lines += "2. Tägliches 20-30min Active Recall fix einplanen"
$lines += "3. Alle 3 Tage Mini-Selbsttest (MC/OSCE)"
$lines += ""

foreach($w in $weekly){
  $lines += "## $($w.Name)"
  foreach($day in $w.Group){
    $lines += "### $($day.Date.ToString('ddd, dd.MM')) ($($day.Hours)h)"
    foreach($t in $day.Tasks){ $lines += "- $t" }
    if($day.Reviews.Count -gt 0){
      $lines += "- Wiederholungen planen:"
      foreach($r in $day.Reviews){ $lines += "  - $r" }
    }
    $lines += ""
  }
}

$lines | Set-Content -Path $OutputPath -Encoding UTF8
Write-Host "Plan erstellt: $OutputPath"
