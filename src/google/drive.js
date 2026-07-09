// Google Drive read-only layer (new — the old bridge had Gmail only).
// Used to find and read templates (LOR, TDI/FIN535), estimates, dec pages.

import { googleApi } from "./googleAuth.js";

const DRIVE = "https://www.googleapis.com";

export async function runDriveTool(config, args) {
  const [tool, ...rest] = args;
  const input = parseInput(rest.join(" "));

  if (!tool || tool === "list") {
    printJson({
      tools: [
        { name: "search", input: { query: "name text", limit: "optional" }, note: "e.g. 'LOR' or 'letter of representation'" },
        { name: "read", input: { fileId: "string" }, note: "Google Docs export as text; text/csv read directly; other types return metadata + link" },
        { name: "recent", input: { limit: "optional" }, note: "recently modified files" }
      ]
    });
    return;
  }

  if (tool === "search") {
    const query = required(input.query || input._, "query");
    const limit = clamp(Number(input.limit || 15), 1, 50);
    const q = encodeURIComponent(`(name contains '${escapeQuery(query)}' or fullText contains '${escapeQuery(query)}') and trashed = false`);
    const result = await googleApi(config, DRIVE, `/drive/v3/files?q=${q}&pageSize=${limit}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink,parents)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`);
    printJson({ query, files: result.files || [] });
    return;
  }

  if (tool === "recent") {
    const limit = clamp(Number(input.limit || 20), 1, 50);
    const result = await googleApi(config, DRIVE, `/drive/v3/files?orderBy=modifiedTime desc&pageSize=${limit}&q=${encodeURIComponent("trashed = false")}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`);
    printJson({ files: result.files || [] });
    return;
  }

  if (tool === "read") {
    const fileId = required(input.fileId || input._, "fileId");
    const meta = await googleApi(config, DRIVE, `/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime,webViewLink&supportsAllDrives=true`);
    const mime = meta.mimeType || "";

    if (mime === "application/vnd.google-apps.document") {
      const text = await googleApi(config, DRIVE, `/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`, { raw: true });
      printJson({ file: meta, content: text.slice(0, 40000) });
      return;
    }
    if (mime === "application/vnd.google-apps.spreadsheet") {
      const text = await googleApi(config, DRIVE, `/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/csv`, { raw: true });
      printJson({ file: meta, content: text.slice(0, 40000) });
      return;
    }
    if (/^text\/|json|csv|xml/.test(mime)) {
      const text = await googleApi(config, DRIVE, `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { raw: true });
      printJson({ file: meta, content: text.slice(0, 40000) });
      return;
    }
    printJson({
      file: meta,
      content: null,
      note: `Binary type (${mime}). Not extracted as text here — download via webViewLink, or use the OCR pipeline for scanned PDFs.`
    });
    return;
  }

  throw new Error(`Unknown drive tool: ${tool}. Run 'npm run drive -- list'.`);
}

function escapeQuery(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function required(value, name) {
  const text = typeof value === "string" ? value.trim() : value;
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function parseInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { _: trimmed };
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
