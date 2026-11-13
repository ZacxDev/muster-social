# muster-social

A [muster](https://github.com/ZacxDev/muster) plugin that posts
**owner-approved** outbound drafts to social sites, from the owner's own
signed-in browser.

A muster officer writes a post (or a reply). You approve the exact text and
the exact images/videos in muster's **Asks → Reply drafts** tab. This plugin,
running on your machine, claims the approved draft, types it into the site in
a browser profile you signed into yourself, checks the page holds exactly what
you approved, clicks **Post** once, reads the post back, and tells muster what
happened. It needs no site API keys and holds no site passwords.

> **Status: v0, not yet run against the live sites.** The site adapters are
> tested only against fixture pages and a fake browser. See
> [Unverified live](#unverified-live) before pointing it at a real account.

Sites in v0:

| site | new post | reply |
|---|---|---|
| X (x.com) | yes, text and up to 4 images or 1 video | yes, under any status |
| LinkedIn | yes, on your own feed, text and up to 4 images or 1 video | yes, a comment on **your own** posts only |

New sites plug in through one adapter interface (`src/sites/types.ts`).

## Read this first: the sites' terms

Both sites' terms, as we read them in November 2026, **forbid** this kind of
automation of a personal account. This is not legal advice; read the documents
yourself.

- **X.** The Terms of Service bar reaching the service by automated means
  other than X's published interfaces (its API), and the automation rules
  expect automated posting to go through the API. Driving the web app with a
  browser automation tool is outside both. X can lock, limit or suspend an
  account it believes is automated this way.
- **LinkedIn.** The User Agreement's "Dos and Don'ts" name the use of bots or
  other unauthorized automated methods to create, comment on, like or share
  posts. LinkedIn restricts accounts it detects doing it, sometimes
  permanently.

What this plugin does to lower, **not remove**, that risk: it posts only what
you approved, one post at a time, with a minimum gap per site (15 minutes on X
and 30 on LinkedIn by default), and it never browses, follows, likes, scrapes
or messages. If losing the account would hurt, do not use this on it.

## How a post goes out

```
officer --officer_post_draft--> muster --GET /drafts/checks--> plugin: rules, media upload, session check
                                       <--POST /drafts/{id}/check--
you approve exact text + media hashes in muster
plugin --POST /drafts/claim--> muster        (long-poll; muster never calls the plugin)
plugin: re-check the rules, re-hash the media, pacing, unresolved attempts
plugin: open the site, type, attach, PRE-CLICK CHECKS
plugin: write the attempt journal's "open" record (fsync), click once
plugin: read back -> posted | unknown
plugin --POST /drafts/{id}/result--> muster  (posted: ok + URL; unknown: nothing, see below)
```

### What keeps it from double-posting or posting the wrong thing

- **Only claimed drafts are posted.** There is no command that posts arbitrary
  text. The poster takes a muster claim and nothing else, and refuses one whose
  body does not hash to the approved `body_sha256`.
- **The sending rules run twice:** once before you can approve (the
  `draft_checks` verdict) and again on the claim, before a browser opens.
- **Media are re-hashed** from the files on your machine. A file whose SHA-256
  is not the approved one posts nothing (`media changed since approval`). The
  bytes that were hashed are copied to a private staging file and that copy is
  attached, so editing the original afterwards cannot reach the post.
- **Pre-click checks**, each its own refusal code: signed in as the configured
  account; for a reply, the target loaded (and on LinkedIn, the post is yours);
  no identical post of yours already there; the editor's text equals the
  approved text after whitespace normalisation; no mention link you did not
  approve (with mentions allowed, no more links than the approved text has
  `@names`); the exact media count; the submit button is enabled.
- **One gate to the click.** The adapter cannot click a submit control itself:
  its driver refuses one. It has to call the poster's gate, which opens once per
  draft, writes the journal's `open` record and fsyncs it, and only then clicks.
- **The attempt journal** (`<state_dir>/journal.jsonl`, append-only, fsynced on
  every record) means a draft is clicked **at most once**, across crashes and
  restarts. A draft that ever had an `open` record is never tried again.
- **After the click there is no "failed".** The read-back finds the post
  (`posted`, reported to muster with its URL) or it does not (`unknown`). An
  `open` record with no outcome, which is what a crash mid-click leaves, also
  counts as `unknown`.
- **An unknown outcome pauses that site.** It is **not reported to muster**:
  reporting `ok: false` would ask the officer to draft again, and the first
  post may be live. muster marks the claim unconfirmed after its 2-minute
  lease and never offers it again. Until you resolve it, every draft claimed
  for that site is refused without a click.
- **Read-back tolerates link rewriting.** X shows a URL through `t.co`, often
  truncated, and LinkedIn through `lnkd.in`. The read-back accepts a link that
  stands for each approved URL, and everything else must match exactly. It
  only accepts a post by your account whose id dates from at most a minute
  before the click.

Resolve an unknown attempt after looking at the site yourself:

```sh
systemctl --user stop muster-social          # the journal admits one process
muster-social status                         # lists unresolved attempts
muster-social resolve 42 --posted https://x.com/you/status/1234567890
muster-social resolve 42 --not-posted        # muster then hands it back to the officer
systemctl --user start muster-social
```

## Install

Requirements: Node.js 22.18 or newer, and an installed Chrome, Edge or Chromium.
`playwright-core` is used, which downloads no browser of its own.

```sh
git clone https://github.com/ZacxDev/muster-social && cd muster-social
npm ci && npm run build
npm install -g .            # puts `muster-social` on your PATH
```

## Set up

### 1. In muster

The muster side is described in muster's
[officers-builtin.md §5b](https://github.com/ZacxDev/muster/blob/main/docs/officers-builtin.md#5b-outbound-drafts-through-a-bound-plugin):

- the server runs with plugins on (`MUSTER_PLUGINS=1`), the built-in officer
  store on (`MUSTER_OFFICERS`), and file attachments configured (media are
  uploaded to muster's object store so you can see them before approving);
- an officer type that grants `outbound_drafts`, and an officer of that type.

### 2. On your machine

```sh
muster-social init --server https://muster.example.com
$EDITOR ~/.config/muster-social/config.json     # enable sites, set each account
muster-social pair --owner you@example.com --deliver-to officer:marketing:main
```

`pair` prints a code like `ABCD-EFGH`. Approve the request on muster's
`/plugins` page (or in Attention) by typing that code. The plugin then receives
its token directly and stores it at `~/.config/muster-social/token` (mode 0600).
You never see, copy or paste the token. The pairing asks for the `messages` and
`draft_checks` capabilities; outbound drafts need both.

```sh
muster-social login        # opens the plugin's own browser profile: sign in to each site, close the window
muster-social check-once   # one pre-approval check sweep, to see it work
```

### 3. Run it as a user service

**Linux (systemd --user):**

```sh
cp contrib/muster-social.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now muster-social
journalctl --user -u muster-social -f
```

**macOS (launchd):** edit the binary path in
`contrib/com.github.muster-social.plist`, then

```sh
cp contrib/com.github.muster-social.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.github.muster-social.plist
```

The service stops only between steps, never mid-post. Exit code 3 means muster
refused the token (revoked, or missing a capability), and the units do not
restart on it.

## Browser modes

- **`persistent`** (default, recommended): the plugin launches your installed
  browser (`browser.channel`: `chrome`, `msedge`, …, or
  `browser.executable_path`) on a **dedicated profile directory**
  (`browser.user_data_dir`) that you signed into once with
  `muster-social login`. Your everyday browser is untouched. Chrome cannot open
  one profile directory twice, so do not point this at your everyday profile
  while that browser is running.
- **`cdp`**: the plugin attaches to a browser you started yourself with
  `--remote-debugging-port=9222` (`browser.cdp_endpoint`, loopback only). It
  opens its own tab, asks the page to behave as focused, without raising the
  window, so a background tab is not throttled, and closes that tab afterwards.
  A DevTools port gives full control of that browser to anything on your
  machine that can reach it. Prefer `persistent`.

## Drafts

- **Body**: the exact text. Mentions (`@name`, including fullwidth `＠name`) are
  refused unless `allow_mentions` is on for the site, because a typed `@word`
  tags whoever holds that name. Invisible characters (zero-width, bidi
  controls) are refused.
- **Target**: `{"kind": "post", "ref": ""}`, or `{"kind": "reply", "ref": …}`:
  - X: a status id, or `https://x.com/<user>/status/<id>`;
  - LinkedIn: an activity id, `urn:li:activity:<id>`, or the post's URL. It
    must be your own post.
- **Media**: muster names each medium `<angle>/<id>`. The plugin resolves it to
  `<media_root>/<angle>/<id>.<png|jpg|jpeg|webp|mp4>`. Exactly one matching file
  must exist, it must stay inside `media_root` (symlinks are resolved), and its
  bytes must be the type its extension says.

### Sending rules (`draft_checks`)

| rule | X | LinkedIn |
|---|---|---|
| length | 280 weighted characters (CJK counts 2, each URL 23; emoji are counted per code point, so the count can only run long). Override with `max_length` | post 3000, comment 1250 characters |
| media types | png, jpeg, webp, mp4 | post: png, jpeg, mp4. Comment: png, jpeg |
| media count | ≤ 4 images or 1 video, never both | post: ≤ 4 images or 1 video. Comment: 1 image |
| media size | image ≤ 5 MiB (muster caps video at 16 MiB) | image ≤ 5 MiB |
| empty body | allowed with media | refused |

A refusal goes back to the officer with the rule in its detail. Two conditions
only you can fix do **not** refuse a draft. The verdict waits, and the draft
with it: the browser signed out or signed in as another account (with
`check_session` on), and muster not taking an upload right now.

## Commands

```
muster-social init --server <url>
muster-social pair --owner <login> [--name muster-social] [--label <label>] [--deliver-to officer:<type>:<area>]
muster-social login
muster-social run
muster-social check-once
muster-social status
muster-social resolve <draft> --posted <url> | --not-posted [--note <text>]
```

## Configuration

`~/.config/muster-social/config.json` (see `contrib/config.example.json`).
Unknown keys are an error, so a typo cannot silently turn a guard off.

| key | default | |
|---|---|---|
| `server_url` | required | `https://` (plain `http://` only for loopback, or with `allow_insecure_http`) |
| `token_file` | `~/.config/muster-social/token` | written by `pair`, must be mode 0600 |
| `state_dir` | `~/.local/state/muster-social` | the attempt journal and the lock |
| `media_root` | `~/.local/share/muster-social/media` | where `<angle>/<id>` refs resolve |
| `claim_wait_seconds` | 25 | long-poll length (0–25) |
| `check_session` | true | confirm the signed-in account before saying a draft is sendable |
| `check_interval_seconds` | 30 | between pre-approval check sweeps |
| `browser.*` | persistent | see Browser modes |
| `sites.<x\|linkedin>.account` | required | X handle, or LinkedIn profile slug (the part after `/in/`) |
| `sites.*.min_gap_seconds` | 900 / 1800 | minimum time between two posts on the site |
| `sites.*.allow_mentions` | false | |
| `sites.*.max_length` | site limit | |

## Unverified live

Nothing here has been run against the live x.com or linkedin.com. In
particular:

- **Every selector** in `src/sites/selectors.ts`. The X ones are the site's
  long-standing `data-testid` attributes. The LinkedIn ones are its visible
  class names, which change more often; the share box's media flow
  ("Add media", then a confirm step) and the comment box's file input are the
  least certain.
- That the X composer's and the LinkedIn editor's serialised DOM reads back as
  the typed text, with emoji as image `alt` text.
- That LinkedIn activity and comment ids carry a millisecond timestamp in
  their top bits, as X status ids do. The read-back relies on it to ignore
  older posts.
- The CDP focus emulation used in `cdp` mode, and Playwright's file-chooser
  handling on LinkedIn.

All of these fail **closed**. A selector that matches nothing refuses before
the click. A read-back that finds nothing after the click is `unknown`, which
pauses the site and is never reported as failed. Expect the first live runs to
refuse more drafts than they should. Fix the selector table and add a fixture
for what the live page really looks like.

## Architecture

```
src/
  cli.ts              commands
  daemon.ts           the loop: check sweep, claim, post, reconcile results
  muster/client.ts    the plugin protocol (claim, result, checks, check, media, pairing)
  pairing.ts          pairing: code, poll, token to a 0600 file
  checker.ts          draft_checks verdicts (rules, media upload, session)
  poster.ts           one claim end to end; the journaled submit gate; the guarded driver
  journal.ts          the attempt journal and the process lock
  rules.ts            the sending rules (pure)
  text.ts             normalisation, mentions, hidden characters, URL-tolerant matching, X length
  media.ts            ref resolution, sniffing, hashing, staging
  sites/types.ts      BrowserDriver and SiteAdapter interfaces
  sites/selectors.ts  every selector, one table per site
  sites/x.ts, sites/linkedin.ts   the adapters
  sites/dom.ts        HTML parsing (the same code reads live pages and fixtures)
  browser/playwright.ts   the real driver
```

Every read of a page goes through `driver.html()` and is parsed in-process, so
an adapter's checks and read-back run the same code against a fixture as
against a live page. The only things a driver does to a page are `goto`,
`insertText`, `attachFiles` and `click`.

### Adding a site

Write `src/sites/<site>.ts` implementing `SiteAdapter`: limits, target parsing,
a session check, and `post()`, which runs its pre-click checks, calls
`ctx.submit(<selector>)` exactly once, and reads back. Put its selectors in
`selectors.ts`, list its submit selectors in `submitSelectors`, add a fake site
to `test/helpers/fakeBrowser.ts`, and add the site's mutants to
`scripts/mutation-check.mjs`.

## Development

```sh
npm ci
npm run typecheck
npm test                             # no network, no browser, no live accounts
node scripts/mutation-check.mjs      # break each safety guard, expect its named test to fail
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
