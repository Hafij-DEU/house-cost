# House Cost

Share house expenses: who paid, who owes, month by month. Works offline. English and Turkish.

- **Web app:** https://hafij-deu.github.io/house-cost/ (installable as a PWA)
- **Android:** APK on the Releases page, or build it from `android/`

## Sync

All data stays on the device until you sync. To share it with housemates, create a **private** GitHub repo for the data (for example `house-cost-data`) and a fine-grained token with *Contents: read and write* on that repo only. Enter both under People → Shared online. Every sync is a commit in that repo, so you get a dated history of every change. The token is stored only on the device.

Without GitHub, use People → Send / save file and Import & merge.

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
3. Send that APK to the housemates privately (chat, MeshDrop). On first start
   it asks for the house password, turns auto sync on and asks who they are.

`web/house-key.json` is gitignored, so it is never in the public repo, the web
app or the GitHub releases. Never upload an APK that contains it: anyone with
the file can try passwords offline, and a short one falls quickly. To lock a
phone out, revoke the token on GitHub and make a new key.

The app refuses to sync to a public repo.

## Undoing mistakes

Every sync is a commit in the data repo, so every earlier version is in its
history. To go back: open an old commit of `house-cost.json`, copy the raw
file, paste it into Settings, Backup and tap Restore. The restored records
count as new edits, so they win over later deletes on all phones.
