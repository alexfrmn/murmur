# Official MCP Registry

`server.json` in the repository root describes Murmur for the official MCP Registry
(registry.modelcontextprotocol.io) under the name `io.github.alexfrmn/murmur`. The
catalogs (Glama, PulseMCP, Smithery, mcp.so and others) read from that registry.

## Publishing

`mcp-registry.workflow.yml` in this directory is a ready GitHub Actions workflow. It
is not under `.github/workflows/` yet because the automation token that opened the
pull request has no `workflow` scope, and GitHub refuses such pushes. To enable it,
a maintainer moves the file to `.github/workflows/mcp-registry.yml` (through the
GitHub UI or with a token that has the `workflow` scope). Nothing else is needed:
authentication is GitHub Actions OIDC for the `io.github.alexfrmn/*` namespace.

The registry verifies that the npm package named in `server.json` carries
`"mcpName": "io.github.alexfrmn/murmur"` in its `package.json`. That field is in
`packages/setup/package.json` and reaches npm with the next publish of
`@murmurv2/cli`, so the first successful registry publish happens with the first
stable release after 2.11.0. Publish npm first, then the GitHub release.

Manual alternative from a maintainer machine:

```sh
mcp-publisher login github      # browser device flow as the repository owner
mcp-publisher publish           # validates server.json and publishes
```
