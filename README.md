# KVK Uploader / Updater

A small standalone web tool to migrate scraped KVK data into the ATARI database.

**What it does**
1. Upload a scraped **Excel (`.xlsx`)** or **JSON** file.
2. **Preview** — see how many rows map per form, which forms/rows have **issues** (unsupported forms, rows that can't be saved), and the **fields detected** in each sheet.
3. Pick the **KVK** and click **Import** — the data is written straight into the database, so it shows on the live site.

Imports are **insert-only and de-duplicated**, so re-running the same file is safe (existing rows are skipped, not duplicated).

---

## Run locally

```bash
npm install
cp .env.example .env      # then edit .env and set DATABASE_URL
npm start                 # opens http://localhost:5050
```

`DATABASE_URL` decides which database it reads/writes. Point it at a **test/sandbox** DB while experimenting, or your **live** DB to publish.

---

## Deploy (Render / Railway / any Node host)

- **Build command:** `npm install` (this also runs `prisma generate` automatically)
- **Start command:** `npm start`
- **Environment variable:** `DATABASE_URL` = a standard `postgresql://…?sslmode=require` URL.
  - The host's `PORT` is picked up automatically.
  - If (and only if) your `DATABASE_URL` is a Prisma Accelerate (`prisma+…`) URL, also set `DIRECT_URL` to a plain postgres URL for the build step.

That's it — open the deployed URL and use the page.

---

## Notes
- The tool reuses the project's proven Prisma models + repositories, so inserts match exactly what the main app would write.
- File forms (SAC documents, RAWE attachments) import their data as metadata; the file itself is left blank (uploading files is a separate step).
- "Special Programmes" is intentionally skipped (no table for it).
