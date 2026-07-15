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
  const previewPath = path.join(dir, `${base}.png`);

  fs.writeFileSync(htmlPath, renderHtml(file));

  const chrome = findChromium();
  if (!chrome) {
    return { htmlPath, pdfPath: "", previewPath: "", error: "Chromium not found; HTML written but not rendered to PDF." };
  }
  const result = spawnSync(chrome, [
    "--headless", "--no-sandbox", "--disable-gpu",
    "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`
  ], { encoding: "utf8", timeout: 60000 });

  if (result.status !== 0 && !fs.existsSync(pdfPath)) {
    return { htmlPath, pdfPath: "", previewPath: "", error: config.redact(result.stderr || "chromium render failed") };
  }
  const previewRendered = renderPdfPreview(pdfPath, previewPath);
  const preview = previewRendered ? null : spawnSync(chrome, [
      "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
      "--window-size=816,1056", `--screenshot=${previewPath}`,
      `file://${htmlPath}`
    ], { encoding: "utf8", timeout: 60000 });
  return {
    htmlPath,
    pdfPath,
    previewPath: fs.existsSync(previewPath) && (previewRendered || preview?.status === 0) ? previewPath : ""
  };
}

function renderPdfPreview(pdfPath, previewPath) {
  const which = spawnSync("which", ["pdftoppm"], { encoding: "utf8" });
  const command = which.status === 0 ? which.stdout.trim() : "";
  if (!command) return false;
  const base = previewPath.replace(/\.png$/i, "");
  const rendered = spawnSync(command, ["-png", "-f", "1", "-singlefile", "-r", "110", pdfPath, base], {
    encoding: "utf8",
    timeout: 60000
  });
  return rendered.status === 0 && fs.existsSync(previewPath);
}

function renderHtml(file) {
  const today = displayDate(new Date().toISOString().slice(0, 10));
  const v = (x) => escapeHtml(x || "");
  const [addressLine1, addressLine2] = splitAddress(file.address);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: letter; margin: 0.78in; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color:#111; line-height:1.24; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; color:#004f91; }
  .co { font-family: Georgia, 'Times New Roman', serif; font-size:25pt; line-height:1.05; white-space:nowrap; }
  .lic { color:#666; font-size:13pt; margin-top:3px; }
  .office { text-align:right; font-family: Georgia, 'Times New Roman', serif; font-size:11pt; line-height:1.18; margin-top:5px; }
  .meta { margin:22px 0 18px; display:grid; grid-template-columns:94px 1fr; column-gap:0; row-gap:4px; }
  .label { font-weight:normal; }
  .value { min-width:0; }
  .address-extra { grid-column:2; margin-top:-5px; }
  p { margin:0 0 10px; }
  .redirect { margin:3px auto 12px; width:max-content; line-height:1.2; }
  .sig { margin-top:10px; line-height:1.2; }
  .sig .name { font-family: Georgia, 'Times New Roman', serif; font-size:24pt; margin:15px 0 10px; }
  </style></head><body>
  <div class="header"><div><div class="co">Wave Public Adjusters LLC</div>
  <div class="lic">TX License #: 3351885</div></div>
  <div class="office">3500 Oak Lawn Ave<br>Suite 460C<br>Dallas, TX 75219</div></div>
  <div class="meta">
    <div class="label">DATE:</div><div class="value">${v(displayDate(file.lorDate || today))}</div>
    <div class="label">CARRIER:</div><div class="value">${v(file.carrier)}</div>
    <div class="label">INSURED:</div><div class="value">${v(file.customer)}</div>
    <div class="label">ADDRESS:</div><div class="value">${v(addressLine1)}</div>
    ${addressLine2 ? `<div class="address-extra">${v(addressLine2)}</div>` : ""}
    <div class="label">DOL:</div><div class="value">${v(displayDate(file.dateOfLoss))}</div>
    <div class="label">CLAIM #:</div><div class="value">${v(file.claimNumber)}</div>
  </div>
  <p>Attention Claims Department:</p>
  <p>Please be advised that we, Wave Public Adjusters, represent the named insured for their loss as stated above. We have previously forwarded to you a copy of our Texas Public Adjusters Agreement with the insured (FIN535). As stated by the insured, we hereby request that all further communication and correspondence regarding this claim be directed to this office.</p>
  <p>The name &ldquo;Wave Public Adjusters, LLC&rdquo; must be included on all drafts, checks, and correspondence pertaining to this loss, and mailed directly to:</p>
  <div class="redirect">Wave Public Adjusting LLC<br>3500 Oak Lawn Ave #460C<br>Dallas TX 75219</div>
  <p>Kindly contact me as soon as possible to discuss this loss or set an appointment to inspect this claim.</p>
  <div class="sig"><div>Sincerely,</div>
  <div class="name">Chance Pearson</div><div>cpearson@wavepa.com</div><div>972.573.1730</div>
  <div>Wave Public Adjusting LLC</div><div>3500 Oak Lawn Ave #460C</div><div>Dallas, TX 75219</div></div>
  </body></html>`;
}

function displayDate(value) {
  const text = String(value || "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : text;
}

function splitAddress(value) {
  const parts = String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return [parts[0] || "", ""];
  return [parts[0], parts.slice(1).join(", ")];
}

export function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
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
