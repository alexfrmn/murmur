# Значок Murmur для Windows — спайк

Трей-значок без окон: состояние видно цветом, детали в меню. Данные берутся только из
`murmur status --json` и `murmur doctor --json`, в SQLite значок не лезет.

## Сборка и запуск

```
go build -ldflags "-H windowsgui -s -w" -o murmur-tray.exe .
murmur-tray.exe
```

Бинарь 3.18 МБ, внешних зависимостей при запуске нет.

Пока `bin/murmur` не существует, значок читает файл той же формы:

```
set MURMUR_STATUS_FILE=fixtures\status-green.json
set MURMUR_DOCTOR_FILE=fixtures\doctor-broker-fail.json
murmur-tray.exe
```

Переменные: `MURMUR_BIN` — путь к CLI (по умолчанию `murmur` из PATH),
`MURMUR_STATUS_FILE` и `MURMUR_DOCTOR_FILE` — отладочный файловый источник.

Образцы в `fixtures/` намеренно помечены `generatedAt` из будущего: снимок старше двух
минут гасится в серый, и без этого проверить цвет руками нельзя. Единственное
исключение — `status-stale.json`, он существует ровно чтобы проверить само гашение.

`murmur-tray.exe --dump-icons <dir>` выкладывает пять состояний значка файлами `.ico`
и `.png` — иконки собираются кодом, и это способ посмотреть на них в ревью.

## Проверка

```
go test ./...
```

Правило цвета проверяется на образцах, включая устаревший снимок, незнакомую версию
схемы и пустой статус.

## Что рядом

- `CONTRACT.md` — схема `status --json` и `doctor --json` с правилом вывода цвета.
- `SPIKE-LOG.md` — лог прохождения с временем на каждом этапе и граблями.
