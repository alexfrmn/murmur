## What

<!-- One logical change per PR. Say what changes for the person or assistant using Murmur, not only which files moved. -->

## Why

<!-- The problem or issue this closes. Link it: Closes #NNN -->

## Checks

<!-- Paste the commands you ran and their result. A claim without output is not a check. -->

- [ ] `npm run test:unit` passes
- [ ] Documentation updated where public behavior changed (README, docs/, CHANGELOG `Unreleased`)
- [ ] Person-facing strings follow `contracts/vocabulary.md` (`node --test tests/vocabulary.test.mjs`)
- [ ] Website touched → `node scripts/build-site-ru.mjs` re-run and `site/ru/index.html` committed

## Screens

<!-- For anything a person sees (tray, menu bar app, installer, website): before/after screenshots. Skip for pure code changes. -->

## Not verified

<!-- What this PR does not prove yet (a live OS, a real assistant, a reboot). Name it here so nobody assumes it. -->
