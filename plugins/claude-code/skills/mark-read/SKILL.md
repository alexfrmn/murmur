---
description: Explain how to advance the Murmur terminal unread cursor after the user has reviewed the inbox.
disable-model-invocation: true
---

# Mark the Murmur inbox read

This is an explicit local cursor mutation. Tell the user the exact command before running it:

`murmur inbox mark-read --data-dir /absolute/path/to/profile`

Use the profile configured for this plugin. Do not substitute another profile, do not run this while merely displaying status, and do not describe `murmur_inbox` as marking messages read.
