# npm deprecation preparation — NOT EXECUTED

Only Alex (the npm account owner) may execute these commands after account recovery
and explicit approval. They change public registry metadata; this PR only prepares
them. Do not run during the account hold. No publish, unpublish or deprecate command
was executed while preparing this file.

Inventory read directly from registry.npmjs.org on 2026-09-19T14:06:25.049376+00:00:
12 packages and 28 exact versions. Package versions differ from the repository's
2.x release version. The warning concerns the frozen release set, not a claim that
every individual library independently contains the ACK defect.

Before execution, compare the live inventory with `docs/npm-registry-snapshot.json`
and stop if it changed; update this reviewed list deliberately. Each command targets
an exact existing version, so a later fixed release cannot be deprecated accidentally.
The single-quoted arguments below work in Bash and PowerShell. Repeating a command
with the same message is idempotent. Do not clear warnings on old versions when a
new release is published; only newly verified versions should be recommended.

```text
npm deprecate '@murmurv2/bridge-a2a@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/bridge-a2a@0.2.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/bridge-murmur@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/bridge-murmur@0.1.1' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/bridge-openclaw@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/bridge-telegram@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/broker-nats@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/broker-nats@0.2.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/broker-nats@0.3.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/broker-nats@0.3.1' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/broker-ws@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/broker-ws@0.2.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/core@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/core@0.2.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/core@0.3.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/core@0.3.1' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/core@0.4.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/core@0.5.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/federation@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/federation@0.2.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/federation-nats@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/mcp-server@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/mcp-server@0.2.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/observability@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/observability@0.1.1' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/observability@0.1.2' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/security@0.1.0' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
npm deprecate '@murmurv2/security@0.1.1' 'Murmur npm installation is paused. This version belongs to a frozen release set that predates later delivery hardening. Do not install or update from npm; use the reviewed source instructions at https://github.com/alexfrmn/murmur#install until a verified release announcement.'
```

After each command, read back `npm view PACKAGE@VERSION deprecated` and verify the
exact warning. An attempted command or successful login is not proof of registry
metadata change. Record the completed versions and leave the rest pending on failure.
