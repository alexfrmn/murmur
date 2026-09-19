<#
.SYNOPSIS
Одна команда установки Murmur на Windows.

.DESCRIPTION
Делает то, что сегодня человек делает руками: проверяет Node и git, создаёт каталог
данных, записывает личность агента, ставит службу, регистрирует значок на вход в
систему и проверяет, что всё это работает.

Правило, ради которого она написана: команда, вернувшая ноль, означает работающую
систему. Не «я сделала вызовы», а «я проверила результат». Любой шаг, который не
удалось подтвердить, останавливает установку, называет причину и говорит, что делать.

Права администратора спрашиваются один раз и только ради одного: служба Windows
регистрируется в диспетчере служб, а это операция уровня системы. Всё остальное —
каталог данных, конфиг, автозапуск значка — делается в профиле пользователя.

.EXAMPLE
.\Install-Murmur.ps1 -AgentId misha -NatsUrl nats://nats.example.org:4222 -NatsToken '<токен>'
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AgentId,
    [Parameter(Mandatory = $true)][string]$NatsUrl,
    [Parameter(Mandatory = $true)][string]$NatsToken,
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$ServiceName = 'MurmurDaemon',
    [switch]$SkipTray
)

$ErrorActionPreference = 'Stop'
$script:StepNumber = 0

function Step([string]$title) {
    $script:StepNumber++
    Write-Host ""
    Write-Host ("[{0}] {1}" -f $script:StepNumber, $title)
}

function Ok([string]$text) { Write-Host ("    готово: {0}" -f $text) }
function Info([string]$text) { Write-Host ("    {0}" -f $text) }

# Stop — единственный способ выйти из этого скрипта с ненулевым кодом. Отказ обязан
# назвать причину и следующее действие: «не удалось» без «что делать» перекладывает
# работу обратно на человека, который и пришёл сюда за тем, чтобы её не делать.
function Stop([string]$reason, [string]$whatToDo) {
    Write-Host ""
    Write-Host ("НЕ УДАЛОСЬ: {0}" -f $reason) -ForegroundColor Red
    if ($whatToDo) { Write-Host ("Что делать: {0}" -f $whatToDo) -ForegroundColor Yellow }
    Write-Host "Система осталась в том состоянии, в котором была до этого шага."
    exit 1
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

Write-Host "Установка Murmur для агента '$AgentId'."
Write-Host "Репозиторий: $RepoRoot"

# --- 1. Права ---------------------------------------------------------------
Step "Права администратора"
if (-not (Test-Admin)) {
    Stop "окно запущено без прав администратора" @"
Служба Windows регистрируется в диспетчере служб, и без прав это сделать нельзя.
Откройте PowerShell через «Запуск от имени администратора» и повторите ту же команду.
Права нужны один раз, только для установки службы.
"@
}
Ok "есть, спрашиваются один раз и только для регистрации службы"

# --- 2. Node ----------------------------------------------------------------
Step "Node.js"
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    Stop "node не найден в PATH" "Поставьте Node.js 22.13.0 или новее с nodejs.org и откройте новое окно PowerShell."
}
$nodeVersion = (& node --version).TrimStart('v')
$parts = $nodeVersion.Split('.')
$major = [int]$parts[0]; $minor = [int]$parts[1]
# 22.13, а не 22.5: в 22.5 появился флаг --experimental-sqlite, а сам модуль без флага
# доступен с 22.13. Человек с версией между ними проходил проверку и получал падение
# демона на импорте — с сообщением, которое уводит куда угодно, кроме версии Node.
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 13)) {
    Stop "установлен Node $nodeVersion" "Нужен 22.13.0 или новее: демон хранит сообщения через встроенный модуль node:sqlite, а без флага он доступен только с 22.13.0."
}
# Число устареет при следующем изменении в Node, а попытка импорта — нет. Поэтому
# проверяется не только версия, но и сама возможность.
# Вызов обёрнут двумя вещами, и обе обязательны. --no-warnings: node печатает про
# экспериментальность SQLite в stderr. $ErrorActionPreference Continue: PowerShell 5.1
# превращает stderr нативной программы в ошибку, и при Stop скрипт падал бы на
# успешной проверке.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& node --no-warnings -e "require('node:sqlite')" *> $null
$sqliteOk = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevEAP
if (-not $sqliteOk) {
    Stop "этот Node не отдаёт модуль node:sqlite" "Версия $nodeVersion прошла проверку по числу, но модуль недоступен. Поставьте Node 22.13.0 или новее с nodejs.org."
}
Ok "$nodeVersion по пути $($node.Source)"

# --- 3. git -----------------------------------------------------------------
Step "git"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Stop "git не найден в PATH" "Поставьте Git for Windows с git-scm.com и откройте новое окно PowerShell."
}
Ok "на месте"

# --- 4. Файлы репозитория ---------------------------------------------------
Step "Файлы Murmur"
$entry = Join-Path $RepoRoot 'scripts\murmur-daemon.mjs'
$initScript = Join-Path $RepoRoot 'scripts\agent-config-init.mjs'
foreach ($p in @($entry, $initScript)) {
    if (-not (Test-Path $p)) {
        Stop "не найден файл $p" "Проверьте, что параметр -RepoRoot указывает на каталог с исходниками Murmur."
    }
}
$svcExe = Join-Path $RepoRoot 'spikes\windows-service-go\murmur-svc.exe'
$trayExe = Join-Path $RepoRoot 'spikes\windows-tray-go\murmur-tray.exe'
if (-not (Test-Path $svcExe)) {
    Stop "не найден адаптер службы $svcExe" "Соберите его: cd spikes\windows-service-go; go build -o murmur-svc.exe ."
}
Ok "точка входа демона и адаптер службы на месте"

# --- 5. Личность агента -----------------------------------------------------
Step "Личность агента и конфиг"
$dataDir = Join-Path $RepoRoot '.data'
# Каталог данных задаётся явно и один раз, до первой команды, которая его использует.
# Иначе каждый потребитель решает сам: init и демон берут .data от текущего рабочего
# каталога, а строка подключения клиента прописывает путь жёстко. Человек, запустивший
# демон не из клона, получает два профиля — демон пишет в один, клиент читает другой,
# ошибки при этом нет, есть тишина и пустой список пиров.
$env:DATA_DIR = $dataDir
$env:MURMUR_DATA_DIR = $dataDir
$configPath = Join-Path $dataDir 'agent-config.json'
if (Test-Path $configPath) {
    Info "конфиг уже существует, оставляю как есть: $configPath"
} else {
    # Переменные среды задаются так, как это делается в PowerShell. Префикс перед
    # командой — синтаксис bash, в PowerShell его нет вовсе, и именно на нём человек
    # спотыкается, идя по README дословно.
    $env:AGENT_ID = $AgentId
    $env:NATS_URL = $NatsUrl
    $env:NATS_TOKEN = $NatsToken
    Push-Location $RepoRoot
    try { & node $initScript | Out-Null } finally { Pop-Location }
    if (-not (Test-Path $configPath)) {
        Stop "конфиг не создан ($configPath)" "Запустите вручную и прочитайте вывод: `$env:AGENT_ID='$AgentId'; node scripts\agent-config-init.mjs"
    }
}
$cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($cfg.agentId -ne $AgentId) {
    Info "внимание: в конфиге записан агент '$($cfg.agentId)', а не '$AgentId'"
}
Ok "агент '$($cfg.agentId)', конфиг $configPath"

# --- 6. Служба --------------------------------------------------------------
Step "Служба Windows"
$env:MURMUR_SERVICE_NAME = $ServiceName
$env:MURMUR_NODE = $node.Source
$env:MURMUR_ENTRY = $entry
$env:MURMUR_WORKDIR = $RepoRoot

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Stop "служба $ServiceName уже установлена" "Если это прошлая установка — снимите её: `"$svcExe`" uninstall, затем повторите."
}
$task = Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
if ($task) {
    Stop "на машине уже есть задача Планировщика с именем $ServiceName" @"
Демон уже запускается ею. Две сущности на одном хранилище работать не должны.
Сначала снимите задачу: Unregister-ScheduledTask -TaskName $ServiceName
Потом повторите установку.
"@
}

# Адаптер сам проверяет, что служба поднялась и демон прожил несколько секунд, и сам
# откатывается, если это не подтвердилось.
& $svcExe install
if ($LASTEXITCODE -ne 0) {
    Stop "установка службы не подтвердилась" "Причина напечатана выше. Журнал: $env:ProgramData\Murmur\logs\$ServiceName"
}
Ok "служба $ServiceName установлена, запущена и подтверждена"

# --- 7. Значок --------------------------------------------------------------
if ($SkipTray) {
    Step "Значок"
    Info "пропущен по ключу -SkipTray"
} else {
    Step "Значок в трее"
    if (-not (Test-Path $trayExe)) {
        Stop "не найден значок $trayExe" "Соберите его: cd spikes\windows-tray-go; go build -ldflags `"-H windowsgui`" -o murmur-tray.exe ."
    }
    # Значок живёт в сессии пользователя: трея без сессии не существует, поэтому он
    # запускается при входе в систему, а не службой.
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    New-ItemProperty -Path $runKey -Name 'MurmurTray' -Value ('"{0}"' -f $trayExe) -PropertyType String -Force | Out-Null
    Ok "запуск при входе в систему зарегистрирован"

    Get-Process -Name 'murmur-tray' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Process -FilePath $trayExe | Out-Null
    Start-Sleep -Seconds 3
    if (-not (Get-Process -Name 'murmur-tray' -ErrorAction SilentlyContinue)) {
        Stop "значок запустился и сразу закрылся" "Запустите его из окна консоли и прочитайте вывод: `"$trayExe`""
    }
    Ok "значок запущен"
}

# --- 8. Проверка результата -------------------------------------------------
Step "Проверка того, что получилось"
$statusJson = & $svcExe status | Out-String
$status = $statusJson | ConvertFrom-Json
if ($status.state -ne 'running') {
    Stop "служба в состоянии '$($status.state)' через несколько секунд после установки" "Журнал: $env:ProgramData\Murmur\logs\$ServiceName"
}
Info "служба: $($status.state), pid $($status.pid), подъёмов за час: $($status.restartsLastHour)"
if (-not $SkipTray) {
    Info "значок: запущен, состояние показывает цветом"
}

Write-Host ""
Write-Host "Готово. Демон работает и поднимется сам после перезагрузки." -ForegroundColor Green
Write-Host "Что дальше: обменяйтесь приглашением со вторым участником."
Write-Host "  node scripts\murmur-invite.mjs        — напечатает блоб приглашения"
Write-Host ""
Write-Host "Подключение клиента — тем же каталогом данных, иначе он заведёт пустой:"
Write-Host "  claude mcp add murmur -e DATA_DIR=`"$dataDir`" -- node `"$(Join-Path $RepoRoot 'packages\mcp-server\dist\src\index.js')`""
Write-Host "  node scripts\murmur-join.mjs '<блоб>' — на стороне второго участника"
Write-Host "  node scripts\murmur-add-peer.mjs '<ответный блоб>'"
Write-Host ""
Write-Host "Пока пиров нет, значок будет жёлтым: обмен ещё не настроен, и это не поломка."
exit 0
