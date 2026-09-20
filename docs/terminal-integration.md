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

The plugin is in `plugins/claude-code`. It declares the absolute Murmur command
and profile as required user configuration and starts the existing MCP server as:

```text
murmur mcp serve --data-dir /absolute/path/to/profile
```

The explicit profile is required for MCP startup. The plugin ships namespaced
inbox, mark-read, and status skills. It has no `SessionStart` hook and does not
write user settings. Load it locally for development with Claude Code's documented
`--plugin-dir` option, then set the two requested plugin configuration values.

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
  --murmur-bin /absolute/path/to/murmur
```

The output contains one `proposedStatusLine` object. If a command status line
already exists, the proposal wraps it, passes the same stdin to it, preserves its
other fields, and adds Murmur on a separate row. The wrapper invokes Murmur without
a shell, bounds input, output, and runtime, and removes terminal control characters
from the Murmur segment. Apply the proposed object manually only after reviewing
it. The dry run never creates, replaces, or backs up the settings file.

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
