// Generates a filled LOR (Letter of Representation) PDF from a file's data,
// using Chance's real template. Renders HTML -> PDF with the pre-installed
// Chromium (no external service). Returns the local PDF path.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function generateLor(config, file, outDir) {
  const dir = outDir || path.join(config.paths.workDir, "lor");
  fs.mkdirSync(dir, { recursive: true });

  const safe = String(file.customer || "insured").replace(/[^a-z0-9]+/gi, "_");
  const claim = String(file.claimNumber || "").replace(/[^a-z0-9-]+/gi, "") || "NOCLAIM";
  const base = `LOR_${safe}_${claim}`;
  const htmlPath = path.join(dir, `${base}.html`);
  const pdfPath = path.join(dir, `${base}.pdf`);

  fs.writeFileSync(htmlPath, renderHtml(file));

  const chrome = findChromium();
  if (!chrome) {
    return { htmlPath, pdfPath: "", error: "Chromium not found; HTML written but not rendered to PDF." };
  }
  const result = spawnSync(chrome, [
    "--headless", "--no-sandbox", "--disable-gpu",
    "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`
  ], { encoding: "utf8", timeout: 60000 });

  if (result.status !== 0 && !fs.existsSync(pdfPath)) {
    return { htmlPath, pdfPath: "", error: config.redact(result.stderr || "chromium render failed") };
  }
  return { htmlPath, pdfPath };
}

function renderHtml(file) {
  const today = new Date().toISOString().slice(0, 10);
  const v = (x) => escapeHtml(x || "");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: letter; margin: 0.9in; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt; color:#111; line-height:1.5; }
  .co { font-weight:bold; font-size:13pt; } .lic { color:#444; }
  .meta { margin:14px 0 18px; } .meta div { margin:2px 0; }
  .label { display:inline-block; width:90px; font-weight:bold; }
  p { margin:12px 0; } .redirect { margin:12px 0 12px 28px; }
  .sig { margin-top:34px; } .sig .name { font-weight:bold; }
  </style></head><body>
  <div><div class="co">Wave Public Adjusters LLC</div>
  <div class="lic">TX License #: 3351885</div>
  <div>3500 Oak Lawn Ave, Suite 460C</div><div>Dallas, TX 75219</div></div>
  <div class="meta">
    <div><span class="label">DATE:</span> ${v(file.lorDate || today)}</div>
    <div><span class="label">CARRIER:</span> ${v(file.carrier)}</div>
    <div><span class="label">INSURED:</span> ${v(file.customer)}</div>
    <div><span class="label">ADDRESS:</span> ${v(file.address)}</div>
    <div><span class="label">DOL:</span> ${v(file.dateOfLoss)}</div>
    <div><span class="label">CLAIM #:</span> ${v(file.claimNumber)}</div>
  </div>
  <p>Attention Claims Department:</p>
  <p>Please be advised that we, Wave Public Adjusters, represent the named insured for their loss as stated above. We have previously forwarded to you a copy of our Texas Public Adjusters Agreement with the insured (FIN535). As stated by the insured, we hereby request that all further communication and correspondence regarding this claim be directed to this office.</p>
  <p>The name &ldquo;Wave Public Adjusters, LLC&rdquo; must be included on all drafts, checks, and correspondence pertaining to this loss, and mailed directly to:</p>
  <div class="redirect">Wave Public Adjusting LLC<br>3500 Oak Lawn Ave #460C<br>Dallas, TX 75219</div>
  <p>Kindly contact me as soon as possible to discuss this loss or set an appointment to inspect this claim.</p>
  <div class="sig"><div>Sincerely,</div><div style="height:30px"></div>
  <div class="name">Chance Pearson</div><div>cpearson@wavepa.com</div><div>972.573.1730</div>
  <div>Wave Public Adjusting LLC</div><div>3500 Oak Lawn Ave #460C</div><div>Dallas, TX 75219</div></div>
  </body></html>`;
}

export function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // glob the pw-browsers dir
  try {
    const root = "/opt/pw-browsers";
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, "chrome-linux", "chrome");
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    const which = spawnSync("which", [name], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  }
  return "";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
