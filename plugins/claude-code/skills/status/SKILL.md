---
description: Show the current Murmur terminal indicator and explain unknown or degraded states.
disable-model-invocation: true
---

# Murmur status

Run `murmur status --line --data-dir /absolute/path/to/profile` with the profile configured for this plugin. Empty stdout means a fully measured clean state with no unread messages. Any `unknown`, `warning`, or `error` segment is meaningful and must be shown rather than interpreted as clean.
