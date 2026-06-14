# ATARI Data Mapper — web app

`index.html` is a **single self-contained web app**. It converts an old-site scraped
`data.xlsx` into the new-site bulk-upload Excel, **entirely in the browser** (nothing is
uploaded to any server). The new-site schema and the field mappings are baked into the file.

## Use it
- **Locally:** double-click `index.html` (needs internet for the SheetJS library).
- **Deployed:** share the link with your team — no install, any browser.

## Deploy this folder (pick one)
- **Netlify Drop (easiest):** open <https://app.netlify.com/drop> and **drag this `uploader` folder** onto the page → you get a public URL instantly.
- **Vercel:** <https://vercel.com/new> → import the repo (or `npx vercel deploy uploader --prod`) → set the root/output to `uploader`.
- **GitHub Pages:** push the repo → Settings → Pages → deploy from branch; the app is at `…github.io/<repo>/uploader/`.
- **Cloudflare Pages:** create a project, build output directory = `uploader`.

## Updating the mappings
The app is generated. When the form mappings change, edit `mapper/mapping.config.json`,
then regenerate and redeploy:

```bash
node mapper/build-schema.js     # only if the template/forms changed
node mapper/build-uploader.js   # rebuilds uploader/index.html
```

Currently wired forms: **FLD, OFT (+ grid), Bank account, Equipments**. Others auto-match by
label where possible; unmatched ones show in the output's **_MAPPING_REPORT** tab.
