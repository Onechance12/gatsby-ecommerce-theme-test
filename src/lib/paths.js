import fs from "node:fs";

export function ensureRuntimeDirs(config) {
  for (const dir of [
    config.paths.dataDir,
    config.paths.rawDir,
    config.paths.normalizedDir,
    config.paths.reportsDir,
    config.paths.workDir
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
