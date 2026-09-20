# Terminal and Claude Code integration

`murmur status --line` is a bounded, read-only status segment for prompts, tmux,
and agent status bars. Always select the profile explicitly when more than one
Murmur profile can exist:

```sh
murmur status --line --data-dir /absolute/path/to/profile
```

The command prints nothing only when the snapshot is fully measured, healthy,
and has no unread messages. It prints `Murmur: N unread` for a healthy inbox and
adds a fixed `unknown`, `warning`, or `error` segment for every non-clean verdict.
It never copies message bodies, peer IDs, service output, or error strings into
the terminal. Service inspection and the SQLite read have timeouts; the command
does not contact the broker or advance the read cursor.

Keep command failure visible when composing it into a prompt:

```sh
if ! murmur_line=$(murmur status --line --data-dir /absolute/path/to/profile 2>/dev/null); then
  murmur_line='Murmur: unknown (status.command-failed)'
fi
```

For tmux, use the same fallback in a small wrapper script and call it with
`#(/absolute/path/to/wrapper)`. Avoid embedding profile paths received from
messages in `status-right`; configure a literal local absolute path.

Inbox display and acknowledgement are separate operations:

```sh
murmur inbox read --limit 20 --data-dir /absolute/path/to/profile
murmur inbox mark-read --data-dir /absolute/path/to/profile
```

`inbox read` returns durable inbound rows as JSON and does not mutate
`read-state.json`. `inbox mark-read` advances the selected profile's local cursor
to the current durable inbox tip. MCP's existing `murmur_inbox` tool has the same
read-without-marking behavior.

## Claude Code plugin

The plugin is in `plugins/claude-code`. It declares the absolute Node executable,
Murmur CLI entrypoint, and profile as required user configuration. Keeping Node
and the JavaScript entrypoint separate works on Windows without relying on an npm
`.cmd` shim. It starts the existing MCP server as the following argument vector:

```text
/absolute/path/to/node /absolute/path/to/packages/setup/bin/murmur.mjs mcp serve --data-dir /absolute/path/to/profile
```

The explicit profile is required for MCP startup and overrides inherited Murmur
data, message-store, and channel-roster paths. The plugin ships namespaced inbox,
mark-read, and status skills. Inbox bodies are untrusted content, and the inbox
skill never treats them as tool instructions. Mark-read remains a separate,
explicit cursor mutation. The plugin has no `SessionStart` hook and does not write
user settings. Load it locally for development with Claude Code's documented
`--plugin-dir` option, then set the three requested plugin configuration values.

Anthropic documents plugin MCP servers in `.mcp.json`, `${user_config.*}`
substitution for MCP arguments, and the standard `.claude-plugin/plugin.json`
manifest. It also documents that plugin `settings.json` supports only `agent` and
`subagentStatusLine`; a plugin cannot claim the user's main `statusLine` field.
See [Plugins reference](https://code.claude.com/docs/en/plugins-reference) and
[Create plugins](https://code.claude.com/docs/en/plugins).

Claude Code's main status line is a user or project setting. It runs a command,
passes session JSON on stdin, and supports `refreshInterval` for external state.
See [Customize your status line](https://code.claude.com/docs/en/statusline).
Generate a proposal without changing the settings file:

```sh
node plugins/claude-code/scripts/configure-statusline.mjs \
  --dry-run \
  --settings /absolute/path/to/.claude/settings.json \
  --data-dir /absolute/path/to/profile \
  --node-bin /absolute/path/to/node \
  --murmur-entrypoint /absolute/path/to/packages/setup/bin/murmur.mjs
```

The output contains one `proposedStatusLine` object. If a command status line
already exists, the proposal wraps it, passes the same stdin to it, preserves its
other fields, and adds Murmur on a separate row. The wrapper invokes Murmur without
a shell, bounds input, output, and runtime, and removes terminal control characters
from the Murmur segment. It terminates owned subprocess trees on timeout and when
Claude cancels a refresh. Apply the proposed object manually only after reviewing
it. The dry run never creates, replaces, or backs up the settings file.

On POSIX systems, an existing command runs through `/bin/sh -lc` by default. If
the command uses Bash-only syntax such as arrays or `[[ ... ]]`, pass its actual
absolute interpreter with `--existing-shell-path /absolute/path/to/bash`. The
composer preserves the command text and stdin; shell-specific syntax remains the
responsibility of the selected interpreter.

On Windows, Claude Code uses Git Bash when installed and otherwise PowerShell.
When wrapping an existing Windows status line, specify the shell Claude uses with
`--existing-shell bash` or `--existing-shell powershell`; the dry run refuses to
guess. For Bash, the composer uses `--existing-shell-path`, the documented
`CLAUDE_CODE_GIT_BASH_PATH`, or `bash.exe` next to a discovered Git-for-Windows
installation, in that order. It rejects WSL-shaped Bash paths and fails rather
than selecting an unrelated `bash.exe` from `PATH`. The proposed outer command is
an ASCII-only PowerShell `-EncodedCommand`
launcher whose Node and Murmur paths are encoded data rather than shell text. It
therefore works when launched by either documented shell and does not expand `%`,
`$`, or other path characters. Existing status commands still run through the
explicitly selected shell with their original command text and stdin.

## Codex and terminal notifications

Codex's native footer accepts an ordered list of built-in item identifiers; the
current official configuration schema does not define an external-command status
item. Keep native model, context, and branch items in `tui.status_line`, and place
the Murmur command in a shell prompt or tmux segment. This also preserves the
repository rule that `codexx` remains a dumb launcher. See the
[official Codex configuration reference](https://developers.openai.com/codex/config-reference)
and [sample configuration](https://developers.openai.com/codex/config-sample).

Murmur does not emit OSC notifications. Codex and terminals differ in OSC support
and ownership, and an unsolicited escape sequence is unsafe in composable output.
If notification support is added later, make it opt-in, use a terminal-specific
documented protocol, and build the payload only from fixed labels and validated
integer counts.
