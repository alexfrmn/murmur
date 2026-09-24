# contracts/vocabulary.md

One word for one thing, on every surface a person reads: the macOS window and
menu, the Windows tray and installer, the shared status texts and the website.
Machine-readable rules live next to this file in `vocabulary.json`; the test
`tests/vocabulary.test.mjs` fails the build when a forbidden word appears in a
person-facing string.

## Why

Before 2.12 the same entity had up to four names across the two apps and the
site: "your assistant" meant the agent ID on one screen and Claude Code on the
next, "connect the first agent" meant a peer, and wake-up was called "Wake",
"agent delivery", "handoff to the agent" and "drain". A person cannot answer
"what does this mean?" when the words move under them. The fix is a small,
closed set of words.

## The words

| Russian | English | What it is | No longer said |
|---|---|---|---|
| **Личность** | **Identity** | my ID on the Murmur network | помощник / агент (about yourself), профиль · agent, profile |
| **Контакт** | **Contact** | a colleague I am paired with | пир, подключение, агент · peer, agent |
| **Приглашение** · **Ответ** | **Invitation** · **Reply** | the two lines exchanged when two people pair | invite-блоб, reply-файл · invite blob, reply file |
| **Служба** | **Service** | the background mail carrier; survives a restart | демон, LaunchAgent, runtime · daemon, LaunchAgent, runtime |
| **Помощник** | **Assistant** | Claude Code, Codex or Claude Desktop — where the mail arrives | AI-приложение, клиент, AI-сессия · AI app, client, AI session |
| **Пробуждение** | **Wake-up** | the assistant reads its mail by itself, without a person | wake, приём агентом, передача агенту, drain · wake, agent delivery, drain |
| **Сервер** | **Server** | the address both services connect to | брокер, NATS, `nats://` · broker, NATS, `nats://` |

"Invite" stays an ordinary English verb ("Invite a colleague"); only the
nouns listed above are replaced.

## Where technical words still belong

`--json` output, logs and the text produced by "Copy diagnostics" keep the
engineering names (`daemon`, `broker`, `peer`, `nats://…`). Those surfaces are
read by the people and assistants who debug, and renaming them would break
scripts. Everything a person reads in a window, a menu, a dialog, a tooltip, an
installer page or the website uses the words above.

## What the test reads

| Surface | Source | What is checked |
|---|---|---|
| macOS window and menu | `apps/macos-menubar/Sources/MurmurTrayCore/Resources/{en,ru}.lproj/Localizable.strings` | values (the right-hand side); keys are source identifiers |
| Windows tray | `spikes/windows-tray-go/locales/{en,ru}.json` | values |
| Windows service helper | `spikes/windows-service-go/locales/{en,ru}.json` | values |
| Shared status texts | `contracts/setup/presentation/status-reasons.json` | `messages.*.en` / `messages.*.ru` |
| Website | `site/index.html` | the `I18N` dictionary, visible text, `<title>`, meta descriptions, `aria-label`/`title`/`alt` attributes, JSON-LD |

Code inside `<code>`, `<pre>`, `<style>` and non-`I18N` scripts on the website
is not read: commands and identifiers are quoted exactly. `site/llms.txt` and
`site/llms-full.txt` are written for assistants and are not checked.

## Exceptions

An exception is a line in `vocabulary-allowlist.json` with the file, the key,
the forbidden term and a reason a reviewer can judge. There is no pattern-wide
switch: every exception names one string. Search-engine category phrases
("AI agents" in the page title) are the expected kind of exception; a screen
that says "peer" because renaming it was inconvenient is not.
