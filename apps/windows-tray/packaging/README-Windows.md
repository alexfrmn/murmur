# Windows companion bundle

Keep `Open-Murmur.cmd`, `Open-Murmur.ps1`, `murmur-tray.exe` and `runtime/` together.
The runtime is the prebuilt portable engine; Windows adds its matching native
`runtime/bin/murmur-svc.exe`. Node.js 22.13.0 or newer is external. No Go/npm/build is
needed on the recipient's machine. Unsigned binaries may trigger Windows warnings.

Initialize/join and install the service through the CLI first, using one explicit
profile. Double-click `Open-Murmur.cmd`, then select that existing profile folder.
The launcher checks the local runtime and actual tray-to-CLI identity before
opening the menu. It neither creates a profile nor writes client config or login
startup. A custom service name must be supplied every time:

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
until explicit app restart/reselection. It never consumes inbox unread state.
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
2. Extract the 2.10.0 ZIP into a new directory, separate from the 2.9.0 bundle and
   the profile. Do not overwrite or delete the old bundle yet. Verify the extracted
   ZIP against the release's published SHA-256 first. Then open PowerShell as
   administrator under the same Windows user that owns the profile and keep this
   terminal open through step 4. The extracted-bundle checker below also executes
   both native programs with `--version`:

   ```powershell
   $OldBundle = 'C:\Murmur\2.9.0'
   $NewBundle = 'C:\Murmur\2.10.0'
   $DataDir = Join-Path $env:LOCALAPPDATA 'Murmur'
   $ServiceName = 'MurmurDaemon'
   $OldCli = Join-Path $OldBundle 'runtime\packages\setup\bin\murmur.mjs'
   $NewCli = Join-Path $NewBundle 'runtime\packages\setup\bin\murmur.mjs'

   Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\Murmur-Windows-2.10.0-x64.zip" -DestinationPath $NewBundle
   Push-Location $NewBundle
   node .\check-windows-bundle.mjs .
   $Verified = $LASTEXITCODE
   Pop-Location
   if ($Verified -ne 0) { throw 'Bundle verification failed; stop here.' }
   ```

   Replace the example paths and `MurmurDaemon` with the values used by the existing
   installation. A custom service name must remain explicit in every command.
3. In the same elevated terminal, uninstall with the **old 2.9.0 CLI** so it can verify and remove the SCM
   registration that points to the old helper. This stops the service, removes its
   registration and helper metadata, and retains the private profile and logs:

   ```powershell
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
   node $NewCli version --json
   ```

5. Open an ordinary, non-administrator PowerShell terminal. Set the same values
   again in that terminal, then start the new tray with that binding:

   ```powershell
   $NewBundle = 'C:\Murmur\2.10.0'
   $DataDir = Join-Path $env:LOCALAPPDATA 'Murmur' # use your existing absolute profile
   $ServiceName = 'MurmurDaemon'                # use your existing exact service name
   & (Join-Path $NewBundle 'Open-Murmur.cmd') -DataDir $DataDir -ServiceName $ServiceName
   ```

   Confirm the expected identity, service state and version before removing the old
   bundle. If the new installation fails, leave `$DataDir` untouched and keep its
   error output. Return to the elevated terminal from steps 2–4. If a partial new service remains, uninstall it with `$NewCli`; then
   restore the old service with the retained bundle:

   ```powershell
   node $NewCli service uninstall --data-dir $DataDir --service-name $ServiceName --json
   node $OldCli service install --data-dir $DataDir --service-name $ServiceName --json
   ```

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
2. Распакуйте ZIP 2.10.0 в новый каталог отдельно от комплекта 2.9.0 и профиля.
   Не перезаписывайте и не удаляйте старый комплект. Сначала сверьте SHA-256 ZIP с
   опубликованной суммой. Откройте PowerShell от имени администратора под владельцем
   профиля, задайте переменные и выполните первый блок выше с вашими путями и именем
   службы. Проверка запускает оба EXE с `--version`. Этот терминал оставьте открытым
   до завершения шага 4; при ошибке остановитесь.
3. В том же терминале выполните `service uninstall` через `$OldCli` из
   шага 3 выше: старая CLI проверит привязанную к старому EXE службу, остановит и
   удалит её, сохранив приватный профиль и журналы.
4. Выполните `service install`, `status` и `version` через `$NewCli`, как в шаге 4.
   Передавайте те же `$DataDir` и `$ServiceName`; установка сама запускает службу и
   подтверждает работу демона.
5. В новом обычном PowerShell без повышения прав повторно задайте прежние значения
   и запустите `Open-Murmur.cmd` блоком из шага 5. Удаляйте комплект 2.9.0
   только после проверки личности, состояния службы и версии. Если установка 2.10.0
   завершилась ошибкой, не меняйте профиль: удалите оставшуюся новую службу через
   `$NewCli`, если она существует, и восстановите старую через `$OldCli` командами
   отката выше в сохранённом терминале администратора.

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
