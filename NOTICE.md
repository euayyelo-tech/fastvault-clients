# NOTICE

FastVault clients are a modified version of the Bitwarden clients
(https://github.com/bitwarden/clients), licensed under the GNU General
Public License v3.0 — see LICENSE_GPL.txt, which is unchanged.

Modifications by FSITES LTD (https://fastvault.app), starting 2026-09-16,
live entirely in `fastvault/` and are applied to a clean checkout at build
time by `fastvault/apply.mjs`:

- **Assets:** the desktop app icons, tray icons, wordmarks, and the
  browser extension's toolbar/popup/store icons are replaced with the
  FastVault mark; the inline logo and shield SVG components used on the
  login and navigation screens are replaced with the FastVault lockup
  under their original export names.
- **Strings:** "Bitwarden" is replaced with "FastVault" across every
  locale file of both apps, with a small set of overrides for compound
  names ("Bitwarden Authenticator", "Bitwarden Send", and similar) and a
  new attribution string shown in each app's About screen.
- **Server default:** the built-in region list is replaced with a single
  FastVault-hosted region (`vault.fastvault.app`) in place of Bitwarden's
  US/EU/Gov entries; the "Self-hosted" option is unaffected.
- **Links and menus:** help, terms, privacy, download, and issue-tracker
  links throughout the desktop menus and both apps' UI point at
  fastvault.app and this repository instead of bitwarden.com; the
  desktop app's protocol scheme, appdata folder name, and
  native-messaging host name are renamed from Bitwarden's to FastVault's;
  submenus and settings pages that only make sense for Bitwarden's own
  distribution (mobile app store links, "More from Bitwarden") are
  removed or pointed at fastvault.app/apps instead.
- **Build/packaging config:** product name, app ID, installer/portable
  artifact names, protocol registration, publisher metadata, and the
  GitHub Releases publish target in the Electron packaging config are
  changed to FastVault's own; the extension manifests get FastVault's
  name, description, and identifiers.
- **Theme:** the brand and primary colour scales in the shared component
  library's theme file are replaced with a green palette derived from
  fastvault.app's own design tokens; no component markup or behaviour is
  changed.

`bitwarden_license/` is present because it is part of the upstream tree;
no FastVault build compiles or ships anything from it.

The complete corresponding source for each release is this repository, at
the tag named on that release's GitHub Releases page. Bitwarden is a
trademark of Bitwarden, Inc., which is not affiliated with FastVault.
