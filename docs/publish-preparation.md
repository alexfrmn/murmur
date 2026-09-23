# Preparing and rehearsing npm publication

`node scripts/prep-publish.mjs --check` detects manifest drift without writing.
`node scripts/prep-publish.mjs` prepares only public workspaces. Private packages
remain byte-for-byte unchanged; changing publication status is an explicit release
decision. `packages/setup` is now the public **`@murmurv2/cli`**, with bin `murmur`.
Its version must equal the root product version.

Preparation validates the entire graph before writing. It converts `file:` paths
that name the correct workspace to `^<version>`; `workspace:*`, `workspace:^`, and
`workspace:~` become an exact, caret, or tilde registry range respectively. Existing
compatible pins, ranges and peer unions are preserved. A missing/private target,
wrong local path, or range excluding the workspace version aborts before writes.
Choose an intentional new compatibility contract instead of relying on preparation
to rewrite it. Filesystem write failures are reported, not transactionally rolled back.

Review the diff and refresh the lockfile after changing manifests. Build and test
before packing. Public library packages retain their build-before-pack guard. The
CLI prepack builds the checkout and stages a curated `runtime/` subtree, plus a Go
cross-build of the Windows x64 SCM helper. Producers need Node, npm, TypeScript and
Go >=1.24; **consumers need only Node >=22.13.0**. There are no install/postinstall
scripts or postinstall downloads, and no git/URL dependency declarations. Private
profiles, invitations, databases, checkout files and node_modules are excluded.

`runtime/npm-runtime-manifest.json` records the source SHA (or null when unavailable),
whether the checkout was dirty, product version, lockfile hash, every runtime file
hash/size, and Windows helper version/SHA256. A cross-build does not claim native
execution: the Windows probe executes `--version` and compares the embedded version
and source SHA. The actual service still needs a separate elevated native acceptance.

## Pack and install probes

```sh
npm ci
npm run build
node scripts/prep-publish.mjs --check
node --test tests/prep-publish.test.mjs tests/publish-all.test.mjs tests/runtime-bundle.test.mjs
node scripts/test-npm-cli.mjs
```

The installation probe packs the five Murmur packages needed by the CLI, installs
those exact tarballs in a temporary path with spaces and Unicode, disables install
scripts, clears checkout module lookup, verifies the runtime inventory, and exercises
version/init/status plus MCP initialize/tools-list/peers. Third-party dependencies
use the registry as needed. Do not prefer stale cached range metadata for a release
probe: an old packument can report ETARGET for an available dependency version.
CI runs this probe on Linux (minimum/current Node), macOS and Windows; Windows also
executes the packaged helper's version contract. It does not install a system service.

## Publication is explicit

A registry argument is mandatory. The default is a **local dry run**, not publication:

```sh
node scripts/publish-all.mjs --registry <approved-registry-url> --dry-run
```

The script prepares all public tarballs in dependency order, validates every entry
and SHA512 integrity before any publication, and writes `publication.json` beside
them. The CLI runtime and service helper are required entries. Private files and
build caches are rejected. `--out` may select a new absolute output directory.

Only within an approved publication scope, from a clean committed checkout:

```sh
node scripts/publish-all.mjs --registry <approved-registry-url> --publish
```

The script checks all registry versions before the first publish and publishes the
exact tarballs it checked, with lifecycle scripts disabled. It rereads registry
integrity after each publish. Existing versions fail closed. For a partially completed
publication, `--skip-existing` skips **only byte-identical** existing tarballs;
changed bytes need a new version. `--otp=123456` is optional; the script does not
log in, change authentication, or select new versions. Local tarballs and the
publication report are retained as evidence.

Rehearsal permission applies only to the explicitly approved rehearsal registry.
Public npm publication, lifting the install notice and production rollout are
separate gates owned by the release coordinator/account owner.
