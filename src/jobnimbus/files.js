// Fetch document files stored on a JobNimbus contact/job. The JobNimbus API
// returns file metadata; GET /files/{jnid} 302-redirects to a signed download
// URL. fetch() follows the redirect automatically.

import fs from "node:fs";
import path from "node:path";
import { ReadOnlyJobNimbusClient } from "./client.js";

export async function listContactFiles(config, contactJnid) {
  const client = new ReadOnlyJobNimbusClient(config);
  const payload = await client.getJson(config.endpoints.documents, { related: contactJnid, size: 200, from: 0 });
  const rows = payload.files || payload.results || payload.data || [];
  return rows.map((f) => ({
    jnid: f.jnid,
    filename: f.filename || f.name || "",
    contentType: f.content_type || f.type || "",
    size: f.size || 0
  }));
}

// Find the best matching file by keyword (e.g. "TDI", "LOR", "estimate").
export function findFile(files, keyword) {
  const re = new RegExp(keyword, "i");
  return files.find((f) => re.test(f.filename)) || null;
}

export async function downloadFile(config, jnid, destPath) {
  const url = `${config.apiBaseUrl}/files/${encodeURIComponent(jnid)}`;
  const response = await fetch(url, {
    headers: { authorization: `${config.authScheme} ${config.apiKey}` },
    redirect: "follow"
  });
  if (!response.ok) {
    throw new Error(`JobNimbus file ${jnid} download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);
  return { path: destPath, bytes: buffer.length };
}
