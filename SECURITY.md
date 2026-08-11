# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x     | Latest release only |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report vulnerabilities via [GitHub Security Advisories](https://github.com/alexfrmn/murmur/security/advisories/new).

- You will receive an acknowledgment within **48 hours**
- We aim to provide an initial assessment within **7 days**

Include as much detail as possible:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Encryption

Mur-Mur uses **X25519** key exchange with **XChaCha20-Poly1305** authenticated
encryption (via NaCl/libsodium). All inter-agent messages are encrypted
end-to-end; the NATS transport never sees plaintext payloads.

## Local state

`agent-config.json` contains long-term private keys and broker credentials. Murmur creates and
atomically replaces it as mode `0600` inside a mode `0700` state directory, rejects symlinked or
wrong-owner state paths, and starts the daemon with umask `0077`. SQLite database, WAL, and shared
memory files are also forced to `0600`. Deployments should apply the same `UMask=0077` policy in
their service manager and protect backups equivalently.

Decrypted message bodies are currently stored as plaintext in the local SQLite database for search
and conversation history. File permissions reduce cross-user disclosure but do not protect against
the daemon identity itself being compromised. Run Murmur under a dedicated OS identity and use
full-disk/volume encryption or an explicit retention policy until application-level database
encryption is available.

## Disclosure

We follow coordinated disclosure. Once a fix is released, we will credit
reporters (unless anonymity is requested) in the changelog.
