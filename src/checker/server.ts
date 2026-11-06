// Leash checker: verifies signed machine heartbeats, keeps each machine's pass alive on Arkiv,
// and answers the gate's "is this machine's pass live?" question. Run: npm run checker
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../shared/config.js";
import { createPassStore, type PassStore } from "../shared/arkiv.js";
import { CheckerCore, HttpError } from "./core.js";

export function createApp(core: CheckerCore) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) => async (req: express.Request, res: express.Response) => {
    try {
      res.json(await fn(req, res));
    } catch (e) {
      if (e instanceof HttpError) res.status(e.status).json({ ok: false, error: e.message });
      else res.status(500).json({ ok: false, error: (e as Error).message });
    }
  };
  app.post("/enrol", wrap((req) => core.enrol(req.body ?? {}, req.header("x-enrol-token"))));
  app.get("/nonce", wrap((req) => core.nonce(String(req.query.machine ?? ""))));
  app.post("/heartbeat", wrap((req) => core.heartbeat(req.body)));
  app.get("/machine/:machine", wrap((req) => core.machine(String(req.params.machine))));
  app.get("/pass/:machine", wrap((req) => core.pass(String(req.params.machine))));
  app.get("/passes", wrap(() => core.passes()));
  app.get("/events", (req, res) => {
    res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    res.flushHeaders();
    res.write(": levee checker events\n\n");
    const on = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    core.events.on("event", on);
    const ka = setInterval(() => res.write(": ka\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ka);
      core.events.off("event", on);
    });
  });
  return app;
}

export function startChecker(store: PassStore, port = env.checkerPort) {
  const core = new CheckerCore({
    store,
    passSeconds: env.passSeconds,
    stateFile: path.resolve("state/checker-machines.json"),
    enrolToken: process.env.ENROL_TOKEN || undefined,
  });
  return createApp(core).listen(port, () =>
    console.log(`[checker] listening on :${port}, pass lifetime ${env.passSeconds}s, /enrol ${process.env.ENROL_TOKEN ? "needs ENROL_TOKEN" : "OPEN (no ENROL_TOKEN set)"}`),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const store: PassStore = process.argv.includes("--memory") ? new (await import("../shared/arkiv.js")).MemoryPassStore() : createPassStore();
  if (process.argv.includes("--memory")) console.log("[checker] --memory: passes kept in memory, nothing is written to Arkiv");
  startChecker(store);
}
