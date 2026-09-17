# Putting the extension in the stores — owner runbook

What the pipeline gives you, and the clicks only you can do. Stop at
"draft uploaded, ID recorded" for Chrome and Edge; publishing waits for a
desktop release that allow-lists the two ids (step 4). Firefox can be
published as soon as its review passes — its id is fixed in the code.

## 0. Get the packages

Every push to `fastvault` builds them (Actions → "FastVault browser
extension" → artifact `fastvault-extension`). A tag publishes them as a
GitHub release:

    git tag fastvault-extension-v<version> && git push origin fastvault-extension-v<version>

`<version>` must equal `fastvault/version.txt`. The release carries
`dist-chrome.zip`, `dist-edge.zip`, `dist-firefox.zip`. Use those files —
never a local `FV_DEV=1` build, which carries the dev key.

Listing text: `listing.en.md`. Privacy answers: `privacy.md`.
Screenshots: `screenshots/` (1280×800 PNGs; five of them, taken from the
real extension signed in to a test vault — see the checklist at the bottom).
Icons: the store asks for a 128×128 icon — `fastvault/branding/generated/browser/store/chrome-icon128.png`; Edge also takes a 300×300 (`windows-icon300.png`).

## 1. Chrome Web Store

1. https://chrome.google.com/webstore/devconsole — register as a developer
   under FSITES LTD (one-off $5 fee). Use the company Google account, not a
   personal one; enable 2-step verification on it (Google requires it).
2. New item → upload `dist-chrome.zip`.
3. Store listing: name, summary, description from `listing.en.md`; category
   Productivity; language English; icon 128; the five screenshots.
4. Privacy practices tab: answers from `privacy.md` (single purpose, the two
   data types, the certifications, no remote code).
5. Distribution: public, all regions.
6. **Save as draft. Do not submit yet.** Copy the item ID from the URL
   (`…/devconsole/<publisher>/<ITEM ID>/edit`) — 32 lowercase letters — into
   the table below.

## 2. Microsoft Edge Add-ons

1. https://partner.microsoft.com/dashboard/microsoftedge — register (free)
   under FSITES LTD.
2. Create new extension → upload `dist-edge.zip`.
3. Availability: public, all markets. Properties: category Productivity,
   privacy policy URL, support URL https://fastvault.app/support.
4. Listing: same text; the 300×300 logo; screenshots.
5. **Save, do not publish.** The product ID is in the dashboard; the
   _extension id_ (what the desktop app needs) only appears after the first
   submission is certified — so for Edge, submit once, wait for the
   certification email, then copy the CRX id from the store page URL and
   put it in the table. Until the desktop allow-list release ships, users
   who install it can do everything except biometric unlock.

## 3. Firefox Add-ons (AMO)

1. https://addons.mozilla.org/developers/ — sign in with the company account.
2. Submit a new add-on → "On this site" → upload `dist-firefox.zip`.
3. Because the build is a fork of an open-source project, AMO will ask for
   the source: attach a zip of the `fastvault` branch (`git archive
fastvault -o source.zip`) and point them at `fastvault/README.md`'s build
   steps. This is normal for large bundled extensions and speeds up review.
4. Listing text, screenshots, privacy policy URL as above. Category:
   Privacy & Security.
5. Submit. The id is already `{5d0312ec-4a31-4081-b970-5ac6f03f9c19}` —
   the desktop app already allow-lists this id; biometric unlock from the
   store build is unproven until checked once after publishing.

## 4. Allow-list the Chrome and Edge ids, then publish

| Store  | ID                                 | Recorded on |
| ------ | ---------------------------------- | ----------- |
| Chrome | `________________________________` |             |
| Edge   | `________________________________` |             |

Give both ids to Claude (or edit `fastvault/apply.mjs` yourself): each goes
into `CHROME_IDS` as `"chrome-extension://<id>/"`. Then bump
`fastvault/version.txt`, commit "Desktop: allow-list the store extension
ids", tag `fastvault-desktop-v<version>`, push — installed desktop apps
auto-update. Once that release is live, publish the Chrome and Edge drafts.

## 5. After publishing

- Put the three store links on the site's Apps page (fastvault repo, branch
  `phase-1`; `check:todo` + `check:site` before pushing; never `main`).
- Check biometric unlock once from each store build (unproven until then).

## Screenshot checklist (1280×800, PNG)

1. Popup, signed out (the intro screen with the FastVault lockup).
2. Vault list, signed in.
3. One item open.
4. The inline autofill menu on a login form (the FastVault mark, not a shield).
5. Settings.

No Bitwarden branding may be visible anywhere in them.
