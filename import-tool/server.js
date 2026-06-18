// Standalone KVK data-import tool — a SEPARATE little app (its own server + page + port).
// It does NOT plug into the main site; it only reuses the proven import engine + repositories.
// Upload an Excel/JSON scrape -> preview what maps (and what doesn't) -> pick a KVK -> push.
// Writes go straight to whatever database DATABASE_URL points at (the same DB the site reads),
// so imported data shows up on the live site immediately.
//
// Run:  cd backend && node import-tool/server.js     (opens http://localhost:5050)
const express = require('express');
const path = require('path');
const prisma = require('../config/prisma');
const { previewImport, commitImport, commitRecords } = require('../services/import/kvkImportEngine');
const { xlsxToSheets } = require('../services/import/xlsxToSheets');

const app = express();
app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Accept a parsed JSON `data` object (scraper JSON) OR a base64-encoded .xlsx upload.
async function toData(body) {
  if (body && body.xlsxBase64) return xlsxToSheets(Buffer.from(body.xlsxBase64, 'base64'));
  if (body && body.data && typeof body.data === 'object') return body.data;
  throw new Error('Upload a scraped .xlsx or .json file.');
}

// light per-sheet summary so the UI can "show the fields" that were detected
function sheetSummary(data) {
  return Object.keys(data || {}).map((s) => ({
    sheet: s,
    rows: ((data[s] && data[s].rows) || []).length,
    headers: (data[s] && data[s].headers) || [],
  })).filter((x) => x.rows > 0);
}

// dropdown options for the FK fields, keyed by the record column name the UI sees
app.get('/api/masters', async (req, res) => {
  try {
    const [season, project, agency, acct] = await Promise.all([
      prisma.season.findMany().catch(() => []),
      prisma.financialProject.findMany().catch(() => []),
      prisma.fundingAgency.findMany().catch(() => []),
      prisma.accountTypeMaster.findMany().catch(() => []),
    ]);
    res.json({
      seasonId: season.map((s) => ({ value: s.seasonId, label: s.seasonName })),
      financialProjectId: project.map((p) => ({ value: p.financialProjectId, label: p.projectName })),
      fundingAgencyId: agency.map((a) => ({ value: a.fundingAgencyId, label: a.agencyName })),
      items: acct.map((a) => ({ value: a.accountType, label: a.accountType })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kvks', async (req, res) => {
  try {
    const rows = await prisma.kvk.findMany({ orderBy: { kvkId: 'asc' } });
    res.json(rows.map((k) => ({ kvkId: k.kvkId, kvkName: k.kvkName || k.name || ('KVK ' + k.kvkId) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/preview', async (req, res) => {
  try {
    const data = await toData(req.body);
    const report = await previewImport({ prisma, data });
    res.json({ report, sheets: sheetSummary(data) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/commit', async (req, res) => {
  try {
    const kvkId = Number(req.body && req.body.kvkId);
    if (!kvkId) throw new Error('Choose a KVK to import into.');
    // If the UI sends reviewed/edited records, import those; otherwise re-map the raw file.
    if (req.body && Array.isArray(req.body.forms)) {
      const report = await commitRecords({ prisma, kvkId, forms: req.body.forms });
      return res.json({ report });
    }
    const data = await toData(req.body);
    const report = await commitImport({ prisma, data, kvkId });
    res.json({ report });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const PORT = process.env.PORT || process.env.IMPORT_TOOL_PORT || 5050;
app.listen(PORT, () => {
  console.log(`\n  KVK Data Import tool  ->  http://localhost:${PORT}`);
  console.log(`  Writing to: ${(process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':****@').slice(0, 70)}...\n`);
});
