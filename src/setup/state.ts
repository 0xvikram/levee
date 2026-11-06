// Partial-state reader for idempotent setup steps (readState() throws when the file is missing).
import fs from "node:fs";
import path from "node:path";
import type { DeployState } from "../shared/config.js";

export function loadState(): Partial<DeployState> & Record<string, any> {
  const f = path.resolve("state", "deploy.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}
