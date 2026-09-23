# Windows companion bundle

Keep `Open-Murmur.cmd`, `Open-Murmur.ps1`, `murmur-tray.exe`, `murmur.ico` and `runtime/` together.
The runtime is the prebuilt portable engine; Windows adds its matching native
`runtime/bin/murmur-svc.exe`. Node.js 22.13.0 or newer is external. No Go/npm/build is
needed on the recipient's machine. Unsigned binaries may trigger Windows warnings.

Initialize/join and install the service through the CLI first, using one explicit
profile. Double-click `Open-Murmur.cmd`, then select that existing profile folder.
The launcher checks the local runtime and actual tray-to-CLI identity before
opening the menu. It does not create a profile or write client config. After the
first successful open it adds a Murmur shortcut to the Start menu, the Desktop and
the per-user Startup folder, so the tray comes back after sign-in (the service
already starts with Windows); the Startup entry opens minimized. Delete those
shortcuts to undo it. A custom service name must be supplied for the initial selection:

```powershell
.\Open-Murmur.cmd -DataDir 'C:\Users\you\AppData\Local\Murmur' -ServiceName MurmurDaemon
```

The wrapper uses a per-process PowerShell execution-policy override; it does not
change the machine policy. `-NodePath` explicitly selects another installed Node.
`-Check -DataDir ABSOLUTE` performs the read-only binding probe without opening a
window. Ordinary users can inspect status and change the configured wake pause;
SCM start/stop requires an elevated CLI terminal. The tray does not elevate itself.

The tray is English on a fresh profile regardless of the Windows display language. Use
`-Language ru` to open it in Russian; `-Language en` switches back to English. The
choice is saved in `%LOCALAPPDATA%\Murmur\tray-preferences.json`, reused when
`-Language` is omitted, and can also be changed from the tray's **Language** menu.

The app consumes the CLI's selected profile. It pins agent identity across refresh
and before actions, checks response freshness, and discards a changed identity
until explicit app restart/reselection. It never marks inbox messages as read.
Pause/resume changes the setting without applying a service restart; configured,
effective and needs-restart are shown separately. Pending/unread remain visible.
The unsupported Windows log-path menu is disabled with a reason, without inventing
a log location. Closing the tray leaves the service running.

Debug file snapshots are accepted only when no explicit profile is bound, and
cannot authorize actions. A valid response envelope to a mutation still requires
a fresh status read; there is no atomic transaction between that read and mutation.
The native service helper separately checks profile ownership.

This wrapper is not an updater, an installer or a GUI onboarding wizard. Login,
reboot, browser warnings and actual GUI clicks have separate acceptance records.

## Finding and reopening Murmur

On the first successful launcher start, Murmur opens a durable native guide. It
confirms only that the tray controls are running; service and connection health
remain unknown until measured and appear separately. The guide explains the
hidden-icons arrow and that only the user can drag the icon into the visible
notification area. Murmur never changes taskbar or pinning settings. Dismissing
the guide records that choice; **Where is Murmur?** in the menu reopens it. If the
guide is already open, opening a Murmur shortcut again brings that same window to
the front instead of starting another tray or creating another guide.

При первом успешном запуске через launcher Murmur открывает постоянное нативное
окно-подсказку. Оно подтверждает только работу управления в tray; состояние службы
и соединения остаётся неизвестным до измерения и показывается отдельно. Подсказка
объясняет стрелку скрытых значков и ручное перетаскивание значка в видимую область;
Murmur не меняет настройки панели задач и закрепления. Выбор сохраняется только
после явного закрытия окна. Пункт **Где Murmur?** открывает его снова, а повторный
запуск ярлыка выводит уже открытое окно на передний план без второго процесса или
второй подсказки.

After a successful first launch, the launcher creates **Murmur** shortcuts on your
Desktop and in your per-user Start menu. Both remember the selected Node, bundle,
profile and service name. Open either shortcut to show the controls of the same
running tray, including when Windows has put its icon under the hidden-icons arrow.
The shortcuts carry the same purple logo as the tray.

Windows controls which icons appear directly on the taskbar. Murmur keeps its icon
registered while running, but cannot reserve visible taskbar space. To keep it in
view, expand the hidden-icons arrow and drag Murmur onto the taskbar, or choose it
in Windows taskbar notification-area settings. The shortcuts remain another way in.

The purple logo means ready, grey means not ready or not yet measured, a red dot
means unread messages, and a red circle means a failure. Hover for **Murmur** and
the state in words; the first menu item explains the reason. The separate arrow
at the lower right announces an update. Unread and update badges preserve the
underlying health state.

**Quit** asks for confirmation, with **Cancel** selected by default. It closes the
tray only and explains how to reopen it; the service continues independently.
There is no automatic hiding or login-startup change.

The launcher refuses to replace another target's shortcuts. To choose another
bundle/profile, quit the old tray, remove its two Murmur shortcuts, and open the
new bundle with the explicit selection. Keep the old bundle until client bindings
and a returned message are verified. `-Check` does not create shortcuts, change the
saved launch binding or activate a running tray.

## Manual upgrade from 2.9.0 to 2.10.0

The update badge opens the release page; it does not download, install or restart
Murmur. Keep the old bundle until the new service and tray have both been verified.
Use the same absolute profile path and service name throughout the upgrade. **Do not
run `init` or `join` again:** the existing profile contains the identity, private
keys, peer configuration and database that the new runtime must continue to use.
These steps apply to a companion bundle with `service uninstall` support, including
the September 2.9.0 delivery candidates. Older source installations need their
original service manager's removal procedure; do not assume the old v2.9.0 tag
contains these CLI commands.

1. Record the existing profile path and service name. In the old tray, choose
   **Quit**. This closes the tray only; the service continues running.
2. On the release page, download exactly these two assets:
   `Murmur-Windows-2.10.0-x64.zip` and `SHA256SUMS.txt`. In an ordinary PowerShell
   terminal, verify the ZIP against its exact entry in `SHA256SUMS.txt` **before**
   extracting it or running anything from it. Extract into a new directory, separate
   from the 2.9.0 bundle and the profile. The destination must not already exist, and
   the old bundle must remain in place:

   ```powershell
   $ErrorActionPreference = 'Stop'
   $DownloadDir = Join-Path $env:USERPROFILE 'Downloads'
   $Archive = Join-Path $DownloadDir 'Murmur-Windows-2.10.0-x64.zip'
   $ChecksumFile = Join-Path $DownloadDir 'SHA256SUMS.txt'
   $NewBundle = Join-Path $env:LOCALAPPDATA 'Murmur-versions\2.10.0'

   foreach ($File in @($Archive, $ChecksumFile)) {
       if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Missing release asset: $File" }
   }
   $ChecksumLines = @(Get-Content -LiteralPath $ChecksumFile | Where-Object {
       $_ -cmatch '^[0-9a-fA-F]{64}  Murmur-Windows-2\.10\.0-x64\.zip$'
   })
   if ($ChecksumLines.Count -ne 1) { throw 'Expected exactly one checksum for the Windows 2.10.0 ZIP.' }
   $ExpectedHash = $ChecksumLines[0].Substring(0, 64)
   $ActualHash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
   if ($ActualHash -ine $ExpectedHash) { throw 'Windows ZIP checksum mismatch; stop here.' }
   if (Test-Path -LiteralPath $NewBundle) { throw 'Choose a new, unused 2.10.0 destination.' }

   Expand-Archive -LiteralPath $Archive -DestinationPath $NewBundle
   Push-Location $NewBundle
   node .\check-windows-bundle.mjs .
   $Verified = $LASTEXITCODE
   Pop-Location
   if ($Verified -ne 0) { throw 'Bundle verification failed; stop here.' }
   ```

   The extracted-bundle checker inventories the runtime and executes both native
   programs with `--version`. It runs only after the published ZIP checksum matches.
3. Open PowerShell as administrator under the same Windows user that owns the
   profile, set the exact old and new bindings, and keep this terminal open through
   step 4. Replace the example paths and `MurmurDaemon` with the values used by the
   existing installation; a custom service name must remain explicit in every
   command. Uninstall with the **old 2.9.0 CLI** so it can verify and remove the SCM
   registration that points to the old helper. This stops the service, removes its
   registration and helper metadata, and retains the private profile and logs:

   ```powershell
   $OldBundle = 'C:\Murmur\2.9.0'
   $NewBundle = Join-Path $env:LOCALAPPDATA 'Murmur-versions\2.10.0'
   $DataDir = Join-Path $env:LOCALAPPDATA 'Murmur'
   $ServiceName = 'MurmurDaemon'
   $OldCli = Join-Path $OldBundle 'runtime\packages\setup\bin\murmur.mjs'
   $NewCli = Join-Path $NewBundle 'runtime\packages\setup\bin\murmur.mjs'

   node $OldCli service uninstall --data-dir $DataDir --service-name $ServiceName --json
   if ($LASTEXITCODE -ne 0) { throw 'Old service removal failed; stop here.' }
   ```

4. Install with the **new 2.10.0 CLI**, using exactly the same profile and service
   name. Installation starts the service and confirms the daemon before returning
   success. Then verify the live status and declared version:

   ```powershell
   node $NewCli service install --data-dir $DataDir --service-name $ServiceName --json
   if ($LASTEXITCODE -ne 0) { throw 'New service installation failed; see rollback below.' }
   node $NewCli status --data-dir $DataDir --service-name $ServiceName --json
   if ($LASTEXITCODE -ne 0) { throw 'New service status failed; stop here.' }
   node $NewCli version --json
   if ($LASTEXITCODE -ne 0) { throw 'New CLI version check failed; stop here.' }
   ```

   If the new installation fails, leave `$DataDir` untouched and keep its error
   output. In this elevated terminal, remove a partial new service if one remains,
   then restore the old service from the retained bundle:

   ```powershell
   node $NewCli service uninstall --data-dir $DataDir --service-name $ServiceName --json
   if ($LASTEXITCODE -ne 0) { throw 'Partial service removal failed; stop here.' }
   node $OldCli service install --data-dir $DataDir --service-name $ServiceName --json
   if ($LASTEXITCODE -ne 0) { throw 'Old service restoration failed; keep the profile and error output.' }
   ```

5. Open a new ordinary, non-administrator PowerShell terminal. Set the new CLI,
   profile and exact service name again in that terminal, then start the new tray
   with the same binding:

   ```powershell
   $NewBundle = Join-Path $env:LOCALAPPDATA 'Murmur-versions\2.10.0'
   $NewCli = Join-Path $NewBundle 'runtime\packages\setup\bin\murmur.mjs'
   $DataDir = Join-Path $env:LOCALAPPDATA 'Murmur' # use your existing absolute profile
   $ServiceName = 'MurmurDaemon'                  # use your existing exact service name
   & (Join-Path $NewBundle 'Open-Murmur.cmd') -DataDir $DataDir -ServiceName $ServiceName
   ```

   Confirm the expected identity, service state and version, but keep the old bundle.
6. If this installation previously configured a supported MCP client with Murmur,
   update that existing entry from the same ordinary terminal. `--replace` is required
   because the old entry contains an absolute path into the 2.9.0 runtime. Do this
   only for each client that already had a Murmur entry; skip this step when no client
   was configured. Use `codex-cli` instead of `claude-code` when that is the previously
   configured client, and repeat for both only when both were configured:

   ```powershell
   $Client = 'claude-code' # or 'codex-cli' for an existing Codex CLI Murmur entry
   node $NewCli clients configure --data-dir $DataDir --service-name $ServiceName --client $Client --replace --json
   if ($LASTEXITCODE -ne 0) { throw 'MCP client reconfiguration failed; keep the old bundle.' }
   ```

   Fully exit and reopen every reconfigured client. In the reloaded client, call
   `murmur_peers` and send a new message with `murmur_send`. Require a real peer to
   read it with `murmur_inbox` and reply with `murmur_send` in the same conversation;
   confirm that the reloaded local client sees the returned message in `murmur_inbox`.
   Remove the 2.9.0 bundle only after that reply. A manually configured client must
   have its existing absolute Murmur runtime path updated by its original
   configuration procedure and must pass the same reload and reply test.

### Ручное обновление с 2.9.0 до 2.10.0

Индикатор обновления только открывает страницу релиза: Murmur не скачивает и не
устанавливает обновление автоматически. До полной проверки новой службы и значка
сохраните комплект 2.9.0. Во всех командах используйте прежние абсолютный путь
профиля (`$DataDir`) и имя службы (`$ServiceName`). **Не запускайте `init` или `join`
повторно:** существующий профиль хранит личность, закрытые ключи, настройки пиров и
базу данных.
Инструкция относится к комплектам с `service uninstall`, включая сентябрьские
кандидаты 2.9.0. В старом теге v2.9.0 этих команд ещё нет; для старой установки из
исходников используйте её прежний способ удаления службы.

1. Запишите текущие `DataDir` и `ServiceName`, затем выберите **Quit** в старом
   значке. Значок закроется, а служба продолжит работать.
2. На странице релиза скачайте ровно два файла: `Murmur-Windows-2.10.0-x64.zip` и
   `SHA256SUMS.txt`. В обычном PowerShell выполните первый блок шага 2 выше: он
   требует единственную точную строку для Windows ZIP, вычисляет SHA-256 и прекращает
   работу при несовпадении. Только после успешной сверки он распаковывает ZIP в новый,
   ранее не существовавший каталог и запускает проверку комплекта и двух EXE с
   `--version`. Не перезаписывайте и не удаляйте комплект 2.9.0.
3. Откройте PowerShell от имени администратора под той же учётной записью Windows,
   которой принадлежит профиль. Задайте `$OldBundle`, `$NewBundle`, `$DataDir`,
   `$ServiceName`, `$OldCli` и `$NewCli` блоком из шага 3, заменив примеры фактическими
   значениями. Выполните `service uninstall` через старый `$OldCli`: он проверит
   службу, остановит и удалит её, сохранив приватный профиль и журналы. Оставьте этот
   терминал открытым до завершения шага 4.
4. Выполните `service install`, `status` и `version` через `$NewCli`, как в шаге 4.
   Передавайте те же `$DataDir` и `$ServiceName`; установка сама запускает службу и
   подтверждает работу демона. При ошибке не меняйте профиль: в сохранённом elevated
   терминале удалите оставшуюся новую службу через `$NewCli`, если она существует, и
   восстановите старую через `$OldCli` командами отката выше.
5. Откройте новый обычный PowerShell без повышения прав. Повторно задайте
   `$NewBundle`, `$NewCli`, прежний `$DataDir` и точный `$ServiceName` блоком из шага 5,
   затем запустите новый `Open-Murmur.cmd`. Проверьте личность, службу и версию, но
   пока не удаляйте комплект 2.9.0.
6. Если Murmur уже был настроен в поддерживаемом MCP-клиенте, обновите только его
   существующую запись командой `clients configure --replace` из шага 6. Для прежней
   записи Claude Code используйте `claude-code`, для Codex CLI — `codex-cli`; повторите
   команду для обоих только если оба уже были настроены. Если клиент не был настроен,
   пропустите шаг. Полностью закройте и снова откройте каждый изменённый клиент,
   вызовите `murmur_peers` и отправьте новое сообщение через `murmur_send`. Реальный
   пир должен прочитать его через `murmur_inbox` и ответить через `murmur_send` в том
   же разговоре; локальный перезагруженный клиент должен увидеть ответ в
   `murmur_inbox`. Только после этого удаляйте комплект 2.9.0. Для клиента с ручной
   конфигурацией тем же исходным способом замените старый абсолютный путь runtime и
   выполните такую же перезагрузку и проверку ответа.

## Release bundle recipe

Maintainers build the complete companion on Windows from one committed Git ref:

```powershell
node scripts/build-windows-bundle.mjs --ref HEAD --out C:\absolute\new-output
```

The producer needs Git, Node.js 22.13.0 or newer with its adjacent `npm-cli.js`,
tar, and Go 1.24. The
recipient does not need Git, npm, Go, or a compiler. The recipe exports a clean
Git archive, installs its locked build dependencies outside the payload, builds
the portable runtime, and cross-checks its root product version with the lockfile.
It then builds both Windows executables with `GOOS=windows`, `GOARCH=amd64`,
`CGO_ENABLED=0`, `-trimpath`, and linker values for the exact version and commit.
Each executable's `--version` JSON is executed on the producer before packaging.

The new output directory contains `Murmur-Windows-VERSION-x64.zip`, the matching
`release-manifest.json`, and `SHA256SUMS.txt`. The ZIP has this extraction layout:

```text
Open-Murmur.cmd
Open-Murmur.ps1
README-Windows.md
check-windows-bundle.mjs
murmur-tray.exe
release-manifest.json
runtime/
  runtime-manifest.json
  bin/murmur-svc.exe
  ...portable engine...
```

The release manifest records the exact 40-character source commit, declared
product version, release-recipe hash, checker hash, runtime-recipe hash, native component
declarations, and SHA-256 plus byte size for every payload file except the
manifest itself. It also records the Node and Go producer versions. The runtime
manifest independently inventories the portable
engine before the service executable is added. Both recipes reject existing
outputs and symbolic links; only the explicit launcher, documentation, native
binaries, and staged runtime enter the ZIP. User profiles, `.data` directories,
private configuration, source dependencies, and compiler caches are not copied.

After extraction, verify both inventory layers with:

```powershell
node .\check-windows-bundle.mjs .
```

On Windows the checker also executes both native `--version` contracts. The
recipe fixes the source graph and records its provenance; it does not promise
bit-identical executables across different Node or Go toolchain versions.

These unsigned Go executables expose precise version and source-commit metadata
through `--version` and the release manifest. This recipe does not add Windows
Explorer `VERSIONINFO`; the absence of Explorer file properties is not evidence
that the binary is unversioned or signed.
