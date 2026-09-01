# Changelog

All notable changes to ContextClues are documented here. This project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.2 — 2026-09-01

### Fixed

- The sponsor link shipped as an unreplaced `REPLACE_ME` placeholder in 0.2.1, so the
  link npm renders on the package page, and the `funding` field `npm fund` reads, both
  pointed at a Stripe URL that does not exist. Both now carry the real link. Code is
  unchanged; this release exists only because npm metadata cannot be edited in place.

## 0.2.1 — 2026-09-01

### Fixed

- **The declared Node floor was wrong.** `node:sqlite` appeared in Node 22.5.0 but
  stayed behind `--experimental-sqlite` until 22.13.0, so ContextClues could not run
  unflagged on 22.5 through 22.12 despite claiming to. `engines`, the startup check,
  the README and the website now all say 22.13. Anyone on an affected version was
  waved past the version guard and then hit a confusing module error; they now get a
  clear message naming the required version.

  Found by a new CI job that installs the published tarball on the declared floor and
  boots the server, rather than assuming the floor is whatever the manifest claims.

### Added

- The dashboard now has a favicon. Previously the tab at `localhost:4310` showed the
  browser's blank default, which is easy to lose among other tabs. Served as SVG with
  an `.ico` fallback for browsers that do not render SVG icons.

## 0.2.0 — 2026-09-01

### Security

- **Secret redaction covered far less than intended.** Previews are written to the local
  SQLite index and rendered in the browser, and ten common credential formats were passing
  through unredacted. All are now scrubbed, each with a regression test:
  - Modern OpenAI keys (`sk-proj-…`, `sk-svcacct-…`, `sk-admin-…`). The old pattern required
    unbroken alphanumerics after `sk-`, so every current-format OpenAI key survived it.
  - Passwords embedded in connection strings (`postgres://user:pw@host`, `mongodb+srv://…`,
    and any `scheme://user:pw@host`). The scheme, host and user stay readable; the password
    is replaced.
  - Google API keys (`AIza…`), Stripe keys (`sk_live_…`, `pk_test_…`), GitLab PATs,
    npm tokens, HuggingFace tokens, and AWS temporary access key ids (`ASIA…`).
  - Lowercase secret assignments such as `aws_secret_access_key = …`, which the
    uppercase-only rule missed.

  If you have run an earlier version, the index at `~/.contextclues/` may contain
  unredacted values. Delete that directory to discard it; it rebuilds from your
  transcripts on next launch.

### Fixed

- Re-ingesting a transcript line no longer erases the `file_path` resolved from its
  matching `tool_use` record, so evidence rows keep their file attribution.
- A tool result stays linked to its call when the call record is written again.

### Added

- Custom 404 pages for the dashboard and the website.
- Loading skeletons that mirror the real dashboard grid, and an empty state that
  distinguishes "still scanning" from "no sessions found". Earlier versions showed
  "Scanning ~/.claude…" indefinitely when no sessions existed.
- A clear message when the port is already in use, instead of an `EADDRINUSE` stack trace.
- A Node version check naming `node:sqlite` as the reason, instead of a module-resolution
  error on Node older than the supported floor.
- Continuous integration across Ubuntu and macOS on Node 22.x and 24.x, including a
  job that installs the packed tarball and runs its CLI.
- A privacy page at https://ctxclues.com/privacy.

### Changed

- The `node:sqlite` experimental warning is suppressed on startup. It was expected and not
  actionable.
- Prepared statements are cached, so a large backfill no longer re-prepares the same
  statement once per transcript line.
- The case list computes event counts in one grouped query rather than one `COUNT(*)`
  per session.
- The website self-hosts its fonts, so it makes no third-party requests.

### Removed

- Dead columns, fields and type variants that were written but never read
  (`git_branch`, `parent_uuid`, `input_chars`, and several parsed-but-unused
  transcript fields). No user-visible change.

## 0.1.0 — 2026-08-25

Initial release.
