# Contributing

Issues and pull requests are welcome.

- **No network in tests.** Tests run against a fake muster server
  (`test/helpers/fakeMuster.ts`) and fake sites over a fake browser driver
  (`test/helpers/fakeBrowser.ts`). Never add a test that touches a live site,
  a live account or a real browser.
- **A safety guard needs a test that fails without it.** If you add or change
  a guard (anything that decides whether to click, or what to report), add a
  mutant for it to `scripts/mutation-check.mjs` and check that its named test
  kills it: `node scripts/mutation-check.mjs <id>`.
- **Selectors live only in `src/sites/selectors.ts`.** When a site changes its
  markup, update the table and add or update a fixture under `test/fixtures/`
  that shows the new markup.
- **Never weaken the after-click rule.** After the click, only `posted` or
  `unknown` exist. An unknown outcome is never reported as failed.
- Run `npm run typecheck && npm test` before opening a PR. CI runs the same,
  plus the mutation check.

The tests fsync the attempt journal for real. On a disk with very slow fsync,
point `TMPDIR` at a tmpfs (`TMPDIR=/dev/shm npm test`).
