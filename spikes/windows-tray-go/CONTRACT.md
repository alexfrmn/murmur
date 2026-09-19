# Контракт `murmur status --json` и `murmur doctor --json`

Схему пишет потребитель — значок. Правило, которому она подчинена: **цвет значка
выводится из полей ответа однозначно, без догадок на стороне UI**. Не хватает поля под
цвет — это дефект схемы, и чинится он здесь, а не в значке.

Версия схемы лежит внутри ответа полем `schema`. Движок и значок живут врозь и
обновляются врозь; незнакомую версию значок обязан гасить в серый со словами «схема
незнакома», вместо того чтобы нарисовать цвет наугад.

Обе команды пишут JSON в stdout, диагностику — в stderr, и завершаются кодом 0, когда
ответ сформирован. Ненулевой код означает «ответа нет», а не «состояние плохое»:
плохое состояние — это валидный ответ с полями.

---

## `murmur status --json` — `murmur.status/1`

```json
{
  "schema": "murmur.status/1",
  "generatedAt": "2026-09-19T12:20:00Z",
  "agentId": "agent-misha",

  "service": {
    "state": "running | stopped | failed | unknown",
    "manager": "windows-service | scheduled-task | launchd | systemd | none",
    "since": "2026-09-19T11:03:45Z",
    "pid": 18232,
    "lastExitCode": null
  },

  "broker": {
    "url": "nats://nats.server-pilot.ru:4222",
    "state": "connected | disconnected | unauthorized | unknown",
    "connectedAt": "2026-09-19T11:03:45Z",
    "lastError": null
  },

  "peers": [
    {
      "agentId": "agent-jarvis",
      "paired": true,
      "lastInboundAt": "2026-09-19T12:00:50Z",
      "lastOutboundAt": "2026-09-19T12:05:11Z"
    }
  ],

  "inbox": { "unread": 2, "total": 149, "lastAt": "2026-09-19T12:00:50Z" },

  "outbox": {
    "pending": 0,
    "inflight": 0,
    "delivered": 41,
    "failed": 0,
    "dlq": 0,
    "oldestPendingAt": null
  },

  "deliveries": [
    {
      "msgId": "2aece01c-…",
      "peer": "agent-jarvis",
      "direction": "outbound | inbound",
      "state": "delivered | pending | inflight | failed | dlq",
      "at": "2026-09-19T12:05:11Z",
      "attempts": 1,
      "error": null
    }
  ],

  "wake": {
    "enabled": true,
    "mode": "hook | monitor | none",
    "responder": "claude-code | codex | none",
    "lastDeliveredAt": "2026-09-19T12:00:51Z",
    "lastFault": null,
    "pendingUndelivered": 0
  }
}
```

Обязательные к заполнению: `schema`, `generatedAt`, `service.state`, `broker.state`,
`inbox.unread`, `outbox.failed`, `outbox.dlq`, `wake.enabled`, `wake.lastFault`,
`wake.pendingUndelivered`. Без них цвет не выводится.

`deliveries` — последние доставки, по убыванию `at`, разумный предел 20 записей.
Значок их не раскрашивает; они нужны для строки «Скопировать диагностику».

`generatedAt` — момент снятия снимка, не момент печати. Значок считает снимок старше
двух минут несостоятельным и гасит его в серый: показывать вчерашнее зелёное как
сегодняшнее — тот же способ врать, каким врёт `/health`, всегда отвечающий двести.

### Вывод цвета

| цвет | условие | поля |
|------|---------|------|
| серый | `schema` незнакома, либо ответа нет, либо `generatedAt` старше 2 мин, либо `service.state ∈ {stopped, unknown}` | `schema`, `generatedAt`, `service.state` |
| красный | `service.state = failed`, либо `outbox.failed > 0`, либо `outbox.dlq > 0`, либо `wake.lastFault ≠ null`, либо `wake.pendingUndelivered > 0` | `service.state`, `outbox.failed`, `outbox.dlq`, `wake.lastFault`, `wake.pendingUndelivered` |
| жёлтый | `broker.state ≠ connected`, либо у любого пира `paired = false` | `broker.state`, `peers[].paired` |
| зелёный | всё перечисленное выше не сработало | — |
| синяя точка | `inbox.unread > 0` | `inbox.unread` |

Порядок проверки сверху вниз, первое совпадение выигрывает. Синяя точка живёт поверх
любого цвета.

**Серый выигрывает у красного сознательно.** При остановленной службе `outbox.failed` и
`wake.lastFault` описывают прошлое, и красный на их основании утверждал бы то, чего
никто сейчас не измеряет. Серый говорит «не знаю», и это честнее.

---

## `murmur doctor --json` — `murmur.doctor/1`

Поэтапно, в фиксированном порядке. Одна зелёная точка «connected» не отвечает на вопрос
«что сломалось», поэтому её здесь нет.

```json
{
  "schema": "murmur.doctor/1",
  "generatedAt": "2026-09-19T12:20:00Z",
  "agentId": "agent-misha",
  "stages": [
    {
      "id": "config",
      "title": "конфиг валиден",
      "state": "ok | warn | fail | skip",
      "detail": "agent-config.json разобран, 4 пира",
      "reason": null,
      "fixHint": null,
      "elapsedMs": 3,
      "measuredAt": "2026-09-19T12:20:00Z"
    }
  ],
  "summary": { "worst": "ok | warn | fail", "failedStage": null }
}
```

Этапы и их `id` — закрытый список, порядок значим:

| # | `id` | что проверяет | замер времени |
|---|------|----------------|----------------|
| 1 | `config` | конфиг на месте, разобран, ключи и пиры читаются | да |
| 2 | `daemon` | демон жив и работает именно с этим store (pid + путь к базе) | да |
| 3 | `broker` | брокер отвечает и токен принят | да, RTT |
| 4 | `peers` | пиры спарены: ключи на месте с обеих сторон | да |
| 5 | `roundtrip` | тестовое сообщение ушло и вернулось | да, полный круг |
| 6 | `wake` | режим wake и кто на него отвечает | нет |

Правила, без которых поэтапность бессмысленна:

- **Отказ останавливает цепочку.** Этапы после `fail` получают `state: "skip"` и
  `reason: "blocked-by:<id>"`. Пропущенный этап не зелёный и не красный — он пропущен.
- **`reason` — код, `detail` — человеческий текст.** Коды устойчивы и пригодны для
  сравнения между запусками: `config.missing`, `daemon.store-mismatch`,
  `broker.unauthorized`, `peers.unpaired`, `roundtrip.timeout`, `wake.no-responder`.
- **`fixHint` — одна конкретная команда или действие**, либо `null`. Совет «проверьте
  настройки» в это поле не кладётся.
- **`elapsedMs` обязателен там, где в таблице «да».** Медленный этап — тоже диагноз.
- **Этапа нет в ответе — значок пишет «нет в ответе».** Пустая строка читалась бы как
  «ок», а это ровно та ложь, против которой doctor делается поэтапным.

`doctor` шлёт тестовое сообщение, поэтому значок не гоняет его по таймеру: проверка,
меняющая то, что она измеряет, не должна крутиться фоном. Запуск — при старте значка и
по явному «Проверить сейчас».

---

## Что нужно от движка, кроме полей

1. Обе команды работают, когда демон **не** запущен: `status` отдаёт
   `service.state: "stopped"`, `doctor` — `fail` на этапе `daemon` и `skip` дальше.
   Команда, которая при остановленной службе падает с трассировкой, значку бесполезна.
2. Обе команды не требуют прав администратора. Права нужны только `service install`,
   `start` и `stop`.
3. Время везде RFC 3339 с зоной. Локальное время без зоны запрещено.
4. `null` вместо пустой строки там, где значения нет. `""` и `null` не должны означать
   одно и то же.

Образцы ответов всех состояний лежат в `fixtures/`, на них же гоняется проверка правила
цвета (`go test ./...`, `status_test.go`). Реализация в движке может сверяться с ними
напрямую.
