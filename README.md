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
