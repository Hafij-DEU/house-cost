# House Cost

Share house expenses: who paid, who owes, month by month. Works offline. English and Turkish.

- **Web app:** https://hafij-deu.github.io/house-cost/ (installable as a PWA)
- **Android:** APK on the Releases page, or build it from `android/`

## Sync

All data stays on the device until you sync. To share it with housemates, create a **private** GitHub repo for the data (for example `house-cost-data`) and a fine-grained token with *Contents: read and write* on that repo only. Enter both under People → Shared online. Every sync is a commit in that repo, so you get a dated history of every change. The token is stored only on the device.

Without GitHub, use People → Send / save file and Import & merge.

## Personal (offline only)

The 🔒 Personal tab keeps your own spending: what you paid, splits with
anyone (free-text names, not only housemates), who still owes whom, and the
PDF or photo receipts that go with each entry. It lives only on this device
(localStorage `housecost.personal.v1`, files in IndexedDB
`housecost-personal-files`). It is never synced, never in the house file and
never in the house backup.

Use Personal → Save backup now and then. The backup is one JSON file with the
receipts inside. Restoring it merges: new entries come in, newer versions win,
nothing is deleted.

## Develop

```bash
node --test test/*.test.js
cd web && python3 -m http.server 8771
```

Android: `cd android && gradle assembleRelease` (set `HOUSECOST_KEYSTORE`, `HOUSECOST_KEYSTORE_PASSWORD`, `HOUSECOST_KEY_ALIAS`, `HOUSECOST_KEY_PASSWORD` to sign).

## Sending the app to housemates (sync set up by itself)

1. Run `node tools/make-house-key.mjs` on your PC. It asks for the data repo,
   the access token and a house password (typing is hidden), checks that the
   token works and the repo is private, and writes `web/house-key.json`.
2. Build the APK (`gradle assembleRelease` in `android/`). The sealed file goes
   inside it.
3. Send that APK to the housemates. On first start it asks for the house
   password, turns auto sync on and asks who they are.
4. For the web app, store the same file as the repo secret `HOUSE_KEY_JSON`
   (`gh secret set HOUSE_KEY_JSON < web/house-key.json`) and rerun the Pages
   workflow. The site then asks for the house password on a first visit.

`web/house-key.json` is gitignored, so it is never in git. An APK or site that
carries it can be tried offline against passwords, and a short one falls
quickly, so use a long house password when the APK or site is public. To lock
everyone out, revoke the token on GitHub and make a new key.

The app refuses to sync to a public repo.

## Undoing mistakes

Every sync is a commit in the data repo, so every earlier version is in its
history. To go back: open an old commit of `house-cost.json`, copy the raw
file, paste it into Settings, Backup and tap Restore. The restored records
count as new edits, so they win over later deletes on all phones.
