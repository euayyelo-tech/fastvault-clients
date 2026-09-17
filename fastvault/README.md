# FastVault overlay

This directory holds everything that turns a clean checkout of
[bitwarden/clients](https://github.com/bitwarden/clients) into FastVault.
It is the only thing this fork adds on top of upstream — see `../NOTICE.md`
for the full list of what gets changed and why.

## How the overlay works

`fastvault/apply.mjs` rewrites a clean upstream checkout into FastVault at
build time — locally in a throwaway build worktree, or on the clean
checkout that CI starts from. It never touches the working tree you are
editing in; run it against a disposable copy and throw that copy away
after building. Every replacement it makes is **anchored**: it looks for
an exact, expected match count of some literal text (an asset path, a
string key, a URL, a config block) and calls `fail()` — exiting non-zero
— the moment a count is wrong, rather than silently matching nothing or
matching too much. That anchor failure is the drift detector: when
Bitwarden's next release changes something the overlay depends on, the
build stops there instead of shipping a half-rebranded app. Fix the
anchor in `apply.mjs`, not the checked-out tree. Nothing under
`fastvault/` ever modifies an upstream file directly in a commit — the
overlay is applied fresh on every build — except the two changes ratified
as standing exceptions elsewhere in this repo: `README.md` at the fork
root (documentation, trivial to resolve on merge) and the
`"fastvault/"` ignores entry already present in `eslint.config.mjs`.

What actually gets rewritten — assets, strings, the default server
region, links and menus, build/packaging config, and the theme colours —
is listed in full in `../NOTICE.md`; this file is about the mechanics of
_how_, not a second copy of _what_.

## Releases (this is real and already live)

`.github/workflows/fastvault-desktop.yml` builds the Windows desktop app
on `windows-2022` runners whenever the `fastvault` branch is pushed or a
`fastvault-desktop-v*` tag is pushed (also runnable by hand via
`workflow_dispatch`). It runs `apply.mjs` against a clean checkout, builds
the Rust native modules and the Angular renderer, and packages `nsis`
(installer) and `portable` targets with `electron-builder`, publishing
them as GitHub Releases on this repo.

Two real releases exist today:
[fastvault-desktop-v2026.7.0](https://github.com/euayyelo-tech/fastvault-clients/releases/tag/fastvault-desktop-v2026.7.0)
and
[fastvault-desktop-v2026.7.1](https://github.com/euayyelo-tech/fastvault-clients/releases/tag/fastvault-desktop-v2026.7.1).
Auto-update via `electron-updater`'s GitHub provider, pointed at this
repo, has been proven working end to end: installing `2026.7.0` and then
publishing `2026.7.1` had the running app offer the update and restart
into it.

## Building locally

**Not available on this machine yet.** `fastvault/build-win.ps1` — the
script that would set up a throwaway build worktree, run `apply.mjs`,
build the Rust native modules, and package the app locally — does not
exist yet. Writing it is a separate, still-pending task, blocked on this
machine's local toolchain: Rust and the Visual Studio 2022 C++ Build
Tools need an admin-rights install here that hasn't happened yet (see the
design spec's §9 for the exact `winget` commands once that's cleared).
This is a local-machine gap only — it has no bearing on CI or releases,
which already work as described above. Do not treat this section as a
placeholder for made-up build instructions; there genuinely is no local
build script here today.

## Taking a new upstream release

```bash
git fetch upstream --tags
git merge desktop-vX.Y.Z          # conflicts should only be in files this overlay added
# update fastvault/UPSTREAM and fastvault/version.txt to the new tag/version
# run the build; fix any apply.mjs anchor that no longer matches
```

Conflicts should be rare and confined to files the overlay owns, since
upstream files are never edited directly. An anchor that stops matching
is expected from time to time — that is the overlay's early-warning
system for a rename or restructure upstream, not a bug in `apply.mjs`
itself.

## Known limitations

Carried over as-is from the design spec (`C:\Projects\fastvault\docs\superpowers\specs\2026-09-16-fastvault-clients-design.md`, §7):

- **Chrome/Edge import (app-bound encryption):** the Rust importer only
  launches its elevated helper when the helper's signature thumbprint
  matches a constant compiled into the app, and release builds refuse to
  disable that check. Azure Trusted Signing rotates certificates, so a
  thumbprint can't be pinned — that one import path reports "Helper
  executable signature is not valid"; import via Chrome's CSV export
  instead. Every other importer works.
- **SSO and Duo callbacks:** the desktop app listens on `fastvault://`,
  but the web vault served by FastVault Server still redirects to
  `bitwarden://` (from `bw_web_builds`). SSO isn't a FastVault feature;
  Duo 2FA is supported by Vaultwarden, so Duo from the desktop app needs
  one more rewrite in `fastvault-server/scripts/build-web-vault.sh`
  (`bitwarden://` → `fastvault://`) — a server-side follow-up, not part
  of this overlay.
- **LastPass direct import** relies on an OAuth redirect registered to
  Bitwarden's own client id and will not work; CSV import does.
- **Phishing-site list** (`assets.bitwarden.com`) sits behind the
  `phishing-detection` feature flag, default off; Vaultwarden doesn't
  turn it on, so it's inert with no network call.
- **Auto-update** contacts `api.github.com` / `github.com` to check for
  and download releases — the privacy policy needs to say so.
- **Passkey login ("Log in with passkey")** isn't implemented by
  Vaultwarden; the button behaves exactly as it does in the official app
  today (errors).

## Signing

Unsigned for now — installers trigger a SmartScreen warning. The
packaging config is already wired for **Azure Trusted Signing**, the same
route used by Dolda and GetInbox's desktop apps, and will switch on as
soon as FSITES LTD's Azure Trusted Signing account exists.
