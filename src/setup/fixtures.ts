// Saves real Mirror Node JSON examples for the watcher agent (tests/fixtures/*.json).
import fs from "node:fs";
import path from "node:path";

export function saveFixture(name: string, data: unknown): void {
  const dir = path.resolve("tests", "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + "\n");
  console.log(`saved fixture tests/fixtures/${name}`);
}
