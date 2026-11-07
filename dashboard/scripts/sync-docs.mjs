// Copies ../docs-site (the Mintlify source of truth) into ./docs-site so the site build is self-contained:
// Vercel uploads only this folder. On Vercel ../docs-site is absent and the uploaded copy is used as is.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../docs-site");
const dst = resolve(here, "../docs-site");
if (existsSync(src)) {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log("docs-site synced into dashboard/docs-site");
} else if (!existsSync(dst)) {
  throw new Error("docs-site not found (expected ../docs-site or ./docs-site)");
}
