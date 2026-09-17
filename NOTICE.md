# NOTICE

FastVault clients are a modified version of the Bitwarden clients
(https://github.com/bitwarden/clients), licensed under the GNU General
Public License v3.0 — see LICENSE_GPL.txt, which is unchanged.

Modifications by FSITES LTD (https://fastvault.app), starting 2026-09-16,
live entirely in `fastvault/` and are applied to a clean checkout at build
time by `fastvault/apply.mjs`:

- **Assets:** the desktop app icons, tray icons, and wordmarks are
  replaced with the FastVault mark, and the inline logo and shield SVG
  components used on the login and navigation screens are replaced with
  the FastVault lockup under their original export names. (FastVault
  browser-extension artwork is generated and kept in `fastvault/branding`,
  but nothing wires it into the extension yet — that is part of the
  separate browser-extension plan, and no browser build is published
  today.)
- **Strings:** "Bitwarden" is replaced with "FastVault" in every message
  value of every locale file of both apps. Compound names such as
  "Bitwarden Send" and "Bitwarden Authenticator" are covered by that same
  sweep and need no special handling. The lowercase domain reference
  "bitwarden.com" is a separate substitution, also applied to every
  message value of every locale file: it becomes "fastvault.app" except
  in the self-hosted base-URL hint, where the whole illustrative example
  is swapped for a brand-neutral one instead of a literal domain swap. A
  small set of _keys_ is then overridden outright, where a straight word
  swap would say something untrue — the mobile-apps menu entry (which
  points at the official Bitwarden apps), the help/feedback and
  bug-report labels, and a new attribution string shown in the About
  screen.
- **Server default:** the built-in region list is replaced with a single
  FastVault-hosted region (`vault.fastvault.app`) in place of Bitwarden's
  US/EU/Gov entries; the "Self-hosted" option is unaffected.
- **Links and menus:** help, terms, privacy, download, and issue-tracker
  links throughout the desktop menus and both apps' UI point at
  fastvault.app and this repository instead of bitwarden.com; the
  desktop app's protocol scheme, appdata folder name, OS credential-store
  service names, and native-messaging host name are renamed from
  Bitwarden's to FastVault's. In the desktop Help menu the "Follow us"
  social submenu is removed, and the mobile-app and browser-extension
  submenus (store links for Bitwarden's own distribution) are replaced
  with a single link to fastvault.app/apps.
- **Generated file names and in-app text:** vault exports are written as
  `fastvault_export_<date>` instead of `bitwarden_export_<date>`, the
  diagnostic flight-recorder CSV as `FastVault-diagnostic-report-<date>`,
  and the import screen's format labels and instructions name FastVault.
  The import/export file _formats_ are unchanged, so files move between
  FastVault and the official Bitwarden apps in both directions.
- **Build/packaging config:** product name, app ID, installer/portable
  artifact names, protocol registration, publisher metadata, author and
  repository fields of the manifest shipped inside the app, and the
  GitHub Releases publish target in the Electron packaging config are
  changed to FastVault's own; the extension manifests get FastVault's
  name, description, and identifiers.
- **Theme:** the brand and primary colour scales in the shared component
  library's theme file are replaced with a green palette derived from
  fastvault.app's own design tokens; no component markup or behaviour is
  changed.

Two checks enforce the above rather than trusting it: `apply.mjs`'s own
`verify()` re-scans every source file it rewrote, and
`fastvault/verify-build.mjs` re-scans the built output
(`apps/desktop/build`) before packaging. Both fail the build on an
unexplained "Bitwarden" reference.

`bitwarden_license/` is present because it is part of the upstream tree;
no FastVault build compiles or ships anything from it.

The complete corresponding source for each release is this repository, at
the tag named on that release's GitHub Releases page. Bitwarden is a
trademark of Bitwarden, Inc., which is not affiliated with FastVault.
