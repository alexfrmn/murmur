# Preparing workspace manifests without publishing

Run `node scripts/prep-publish.mjs --check` to detect manifest drift without writing.
Exit 0 means the selected public manifests already match the preparation rules;
exit 1 reports manifests needing preparation. Graph-validation errors abort before
manifest writes; filesystem write failures are reported and are not transactionally
rolled back.

`node scripts/prep-publish.mjs` prepares public workspace manifests locally. It
resolves each internal dependency to that dependency's version, including optional
and development dependencies. It validates the complete graph before writing,
rejecting missing/private internal dependencies. Existing descriptions are kept.
Packages marked `private: true`, including setup, are left byte-for-byte unchanged.
Removing that flag is a separate release decision, not an effect of this helper.

After preparation, update the workspace lockfile and review the manifest diff.
Build and test, then inspect local `npm pack --dry-run --ignore-scripts --json`
results for each selected public workspace after a successful build. This checks
packaging; it does not install a published package or prove a clean-machine setup.

Preparation neither chooses new release versions nor publishes anything. Before
any later account-owner-approved release, versions must be compared to the live
registry: an already published version cannot be reused for changed contents.
The npm account hold and installation notice remain in force until explicitly
lifted. Do not invoke `scripts/publish-all.mjs` as a validation command; it performs
real publication. No npm publication, deprecation or authentication change is part
of this preparation change.
