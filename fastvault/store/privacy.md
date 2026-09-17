# Privacy disclosures — FastVault Password Manager

The answers each store's data-use form asks for. Same facts in three shapes.
Policy: https://fastvault.app/legal/privacy

## What the extension talks to

Only the FastVault server the account is signed in to — `vault.fastvault.app`
by default, or a self-hosted server the user configures — and, if the user
turns on "Unlock with biometrics", the FastVault desktop app on the same
computer through the browser's native-messaging bridge. Nothing else. No
analytics, no crash reporting, no advertising, no third-party SDKs that phone
home.

## Why it asks for access to all sites

Autofill: to recognise a login form on the page and fill the saved username
and password, and to offer to save a new login when one is typed. Page content
is read only for that; nothing about the pages is stored or sent.

## What data is handled

- **Vault items** (logins, passkeys, cards, identities, notes) — created by the
  user, encrypted on the user's device with a key derived from the master
  password, synced to the FastVault server in encrypted form. FastVault cannot
  read them.
- **Account email** — the sign-in identity, sent to the server to sign in.
- **Master password** — never leaves the device; never sent to FastVault.
- **Website addresses of saved logins** — stored inside the encrypted vault
  item, so the extension knows which site a login belongs to.

## Chrome Web Store (Privacy practices tab)

- Single purpose: a password manager — stores credentials and fills them in.
- Data collected: _Personally identifiable information_ (email address, for
  sign-in) and _Authentication information_ (the user's own passwords, stored
  encrypted for the user). Nothing else.
- Certify: not sold to third parties; not used for purposes unrelated to the
  single purpose; not used for creditworthiness or lending.
- Remote code: none.

## Microsoft Partner Center (Edge)

- Does the extension collect personal information? Yes — the account email
  and the user's own credentials, encrypted on the device.
- Privacy policy URL: https://fastvault.app/legal/privacy
- Permission justification (all sites): autofill of saved logins.

## Firefox Add-ons (AMO)

- Privacy policy: https://fastvault.app/legal/privacy
- Source code: https://github.com/euayyelo-tech/fastvault-clients (branch
  `fastvault`; the extension is built from a clean `bitwarden/clients`
  checkout plus the `fastvault/` overlay — see `fastvault/README.md` for the
  exact build steps a reviewer can reproduce).
- Third-party services: FastVault's own server only.
