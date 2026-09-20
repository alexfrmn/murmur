---
description: Explain how to advance the Murmur terminal unread cursor after the user has reviewed the inbox.
disable-model-invocation: true
---

# Mark the Murmur inbox read

This is an explicit local cursor mutation. Tell the user the exact configured invocation before running it. Invoke it directly, without a shell, using this argument vector:

- command: `${user_config.node_command}`
- arguments: `${user_config.murmur_entrypoint}`, `inbox`, `mark-read`, `--data-dir`, `${user_config.data_dir}`

Treat every substituted value as one literal argument. Do not substitute another profile, do not run this while merely displaying status, and do not describe `murmur_inbox` as marking messages read.
