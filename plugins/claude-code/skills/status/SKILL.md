---
description: Show the current Murmur terminal indicator and explain unknown or degraded states.
disable-model-invocation: true
---

# Murmur status

Invoke the configured command directly, without a shell:

- command: `${user_config.node_command}`
- arguments: `${user_config.murmur_entrypoint}`, `status`, `--line`, `--data-dir`, `${user_config.data_dir}`

Treat every substituted value as one literal argument. Empty stdout means a fully measured clean state with no unread messages. Any `unknown`, `warning`, or `error` segment is meaningful and must be shown rather than interpreted as clean.
