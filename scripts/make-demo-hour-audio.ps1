param(
  [string]$OutDir = "C:\dev\reeasy-luma-platform\uploads\fixtures",
  [int]$TargetSeconds = 3600,
  [string]$FfmpegPath = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$work = Join-Path $OutDir "_work_demo_audio"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force -Path $work | Out-Null

if (-not $FfmpegPath) {
  $fromTools = "C:\dev\tools\ffmpeg\ffmpeg-8.0-essentials_build\bin\ffmpeg.exe"
  if (Test-Path $fromTools) { $FfmpegPath = $fromTools }
}
if (-not $FfmpegPath -or -not (Test-Path $FfmpegPath)) {
  throw "ffmpeg not found"
}

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ja = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq "ja-JP" } | Select-Object -First 1
if ($ja) { $synth.SelectVoice($ja.VoiceInfo.Name) }
$synth.Rate = 0
$synth.Volume = 100

$scriptLines = @(
  "本日はお時間をいただきありがとうございます。株式会社ルーマの営業担当です。",
  "本日の議題は、採用向け会社紹介動画のリニューアルについてです。",
  "御社では現在、新卒採用の応募数が伸び悩んでいると伺っています。",
  "課題としては、既存動画の情報が古く、現場の雰囲気が伝わりにくい点が挙げられます。",
  "提案としては、十五秒の短尺と二分の本編をセットにしたプランです。",
  "予算感は八十万円から百二十万円、納期は八週間を想定しています。",
  "決裁者は人事部長の方で、来月の役員会までに比較資料が必要とのことです。",
  "ネクストアクションは、四十八時間以内に構成案と見積概算をお送りすることです。",
  "競合他社も提案中とのことなので、投資対効果を一枚にまとめてご説明します。",
  "以上が本日の要点です。ご質問があればお申し付けください。"
)

Write-Host "Generating speech clips..."
$clipPaths = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $scriptLines.Count; $i++) {
  $wav = Join-Path $work ("clip_{0:D2}.wav" -f $i)
  $synth.SetOutputToWaveFile($wav)
  $synth.Speak($scriptLines[$i])
  $synth.SetOutputToNull()
  $clipPaths.Add($wav) | Out-Null
}
$synth.Dispose()

$listFile = Join-Path $work "concat_clips.txt"
$clipPaths | ForEach-Object { "file '" + ($_ -replace "\\", "/") + "'" } | Set-Content -Encoding ASCII $listFile
$unitWav = Join-Path $work "unit.wav"
& $FfmpegPath -hide_banner -loglevel error -y -f concat -safe 0 -i $listFile -c copy $unitWav
if (-not (Test-Path $unitWav)) { throw "failed to create unit.wav" }

$unitSec = 40.0
try {
  $probe = cmd /c "`"$FfmpegPath`" -hide_banner -i `"$unitWav`" 2>&1"
  if ($probe -match "Duration:\s*(\d+):(\d+):(\d+\.\d+)") {
    $unitSec = [int]$Matches[1] * 3600 + [int]$Matches[2] * 60 + [double]$Matches[3]
  }
} catch {}
if ($unitSec -lt 1) { $unitSec = 40.0 }
$loops = [int][Math]::Ceiling($TargetSeconds / $unitSec) + 1
Write-Host ("Unit duration: {0:N1}s, loops: {1}" -f $unitSec, $loops)

$loopList = Join-Path $work "concat_loop.txt"
1..$loops | ForEach-Object { "file '" + ($unitWav -replace "\\", "/") + "'" } | Set-Content -Encoding ASCII $loopList

$rawHour = Join-Path $work "hour_raw.wav"
& $FfmpegPath -hide_banner -loglevel error -y -f concat -safe 0 -i $loopList -t $TargetSeconds -c copy $rawHour

$out14 = Join-Path $OutDir "demo_meeting_60min_approx14mb.mp3"
& $FfmpegPath -hide_banner -loglevel error -y -i $rawHour -ac 1 -ar 22050 -b:a 32k $out14

$out22 = Join-Path $OutDir "demo_meeting_60min_over18mb.mp3"
& $FfmpegPath -hide_banner -loglevel error -y -i $rawHour -ac 1 -ar 44100 -b:a 48k $out22

foreach ($p in @($out14, $out22)) {
  if (Test-Path $p) {
    $mb = (Get-Item $p).Length / 1MB
    Write-Host ("OK {0}  {1:N1} MB" -f (Split-Path $p -Leaf), $mb)
  } else {
    Write-Host ("MISSING {0}" -f $p)
  }
}
Write-Host "Done."
