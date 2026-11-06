// Records the real /live command centre for the landing hero's product window: send a normal payment,
// hack the treasury, watch Levee freeze and take the money back, then unlock with 2 of 3 managers.
// Frames come from Chrome's screencast (timestamped, so the stopwatch section plays at real speed);
// the waiting parts are sped up with ffmpeg. Writes dashboard/public/media/demo.mp4, demo.webm, demo-poster.jpg.
//
// Needs: the dashboard dev server (default http://localhost:5173), the demo runner on 127.0.0.1:8713
// (DEMO_MODE=1), gate/watcher/signer running, ffmpeg, and playwright-core + a Chromium build. Playwright is
// a recording tool, not a repo dependency: point PLAYWRIGHT_CORE at any install of it.
//   PLAYWRIGHT_CORE=~/.cache/video-skills/node/node_modules/playwright-core CHROME=/path/to/chrome \
//     node scripts/demo/record-demo.mjs [http://localhost:5173]
//   node scripts/demo/record-demo.mjs --encode-only   # re-cut the last recording without touching testnet
// Spends a few testnet transactions (one payment, one theft + containment, one 2-of-3 unlock).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const ENCODE_ONLY = args.includes("--encode-only");
const U = args.find((a) => a.startsWith("http")) || "http://localhost:5173";
const RUNNER = process.env.RUNNER || "http://127.0.0.1:8713";
const OUT = new URL("../../dashboard/public/media/", import.meta.url).pathname;
const WORK = process.env.WORK || join(tmpdir(), "levee-demo-frames");
const W = 1600;
const H = 1000;
const FPS = 30;

// ------------------------------------------------------------------ record

async function record() {
  const PW = process.env.PLAYWRIGHT_CORE || join(homedir(), ".cache/video-skills/node/node_modules/playwright-core");
  const { chromium } = createRequire(import.meta.url)(PW);
  const CHROME = process.env.CHROME || (existsSync(join(homedir(), ".cache/video-skills/chrome_path")) ? readFileSync(join(homedir(), ".cache/video-skills/chrome_path"), "utf8").trim() : undefined);

  const h = await fetch(`${RUNNER}/health`).then((r) => r.json());
  if (!h.ok || h.busy) throw new Error(`demo runner not ready: ${JSON.stringify(h)}`);

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(WORK, "f"), { recursive: true });

  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  // a small pointer + click ripple, so a viewer sees what was pressed
  await ctx.addInitScript(() => {
    const mount = () => {
      if (document.getElementById("dm-pointer")) return;
      const s = document.createElement("style");
      s.textContent = `#dm-pointer{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .7s cubic-bezier(.3,.7,.2,1);filter:drop-shadow(0 4px 10px rgba(0,0,0,.5))}
        .dm-ripple{position:fixed;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2.5px solid #fff;pointer-events:none;animation:dmr .6s ease-out forwards}
        @keyframes dmr{to{transform:scale(4.5);opacity:0}}`;
      document.head.appendChild(s);
      const p = document.createElement("div");
      p.id = "dm-pointer";
      p.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L10 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      p.style.transform = `translate(${innerWidth * 0.55}px, ${innerHeight * 0.6}px)`;
      document.body.appendChild(p);
    };
    if (document.body) mount();
    else addEventListener("DOMContentLoaded", mount);
    window.__dm = {
      move(x, y) {
        const p = document.getElementById("dm-pointer");
        if (p) p.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
      },
      ripple(x, y) {
        const r = document.createElement("span");
        r.className = "dm-ripple";
        r.style.left = `${x}px`;
        r.style.top = `${y}px`;
        document.body.appendChild(r);
        setTimeout(() => r.remove(), 700);
      },
    };
  });
  // freeze the page as served: no Vite HMR socket (so no reloads or error overlays from edits elsewhere)
  await ctx.routeWebSocket(/./, () => {});
  await ctx.addInitScript(() => {
    const s = document.createElement("style");
    s.textContent = "vite-error-overlay{display:none!important}";
    (document.head || document.documentElement).appendChild(s);
  });
  const p = await ctx.newPage();
  const wait = (ms) => p.waitForTimeout(ms);

  await p.goto(`${U}/live`);
  // data loaded: treasury badge says OPEN and the runner buttons are enabled
  await p.waitForSelector(".tb-item .state-badge.open", { timeout: 60_000 });
  await p.waitForSelector(".step-btn:not([disabled])", { timeout: 60_000 });
  await wait(4000); // let the chart and feed fill in

  const cdp = await ctx.newCDPSession(p);
  const frames = [];
  cdp.on("Page.screencastFrame", async (e) => {
    const file = join(WORK, "f", `${String(frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(e.data, "base64"));
    frames.push({ file, t: e.metadata.timestamp, rx: Date.now() / 1000 });
    await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
  });
  const marks = {};
  const proof = {};
  const grab = async (k) => (proof[k] = await p.$$eval(".cc-proofs a[href]", (as) => as.map((a) => ({ label: a.querySelector(".qr-label")?.textContent || a.textContent.trim(), url: a.href }))));
  const mark = (k) => (marks[k] = Date.now() / 1000);

  const press = async (label) => {
    const btn = p.locator(".step-btn", { hasText: label }).first();
    const b = await btn.boundingBox();
    const x = b.x + Math.min(b.width / 2, 120);
    const y = b.y + b.height / 2;
    await p.evaluate(({ x, y }) => window.__dm.move(x, y), { x, y });
    await wait(800);
    await p.evaluate(({ x, y }) => window.__dm.ripple(x, y), { x, y });
    await btn.click();
  };
  const runOk = async (kind, timeout) => {
    await p.waitForFunction(
      (k) => {
        const el = document.querySelector(".run-line");
        return !!el && el.textContent.startsWith(k) && !el.textContent.includes("running");
      },
      kind,
      { timeout, polling: 200 },
    );
    const ok = await p.locator(".run-line.r-ok").count();
    if (!ok) throw new Error(`${kind} failed: ${await p.locator(".run-line").textContent()}`);
  };

  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  mark("start");
  await wait(1500);

  // ① a normal payment: receipt first, then the transfer, matched ✓
  mark("sendClick");
  await press("Send 500");
  await p.waitForFunction(() => /matched its receipt/.test(document.querySelector(".pipe-caption")?.textContent || ""), null, { timeout: 120_000, polling: 100 });
  mark("matched");
  await runOk("pay", 120_000).catch((e) => console.warn(String(e)));
  await wait(2500);
  await grab("send");

  // ② the theft: the stopwatch runs until the treasury is frozen and the money is taken back
  mark("hackClick");
  await press("Hack it");
  await p.waitForSelector(".cc-watch.running", { timeout: 120_000 });
  mark("running");
  await p.waitForFunction(() => /Frozen and taken back in/.test(document.querySelector(".cc-caption")?.textContent || ""), null, { timeout: 180_000, polling: 50 });
  mark("contained");
  await wait(3000);
  mark("holdEnd");
  await runOk("attack", 120_000).catch((e) => console.warn(String(e)));
  await grab("hack");

  // ③ two of three managers sign the unlock
  mark("unlockClick");
  await press("Unlock");
  await runOk("reopen", 240_000);
  mark("unlockDone");
  await wait(3000);
  mark("end");
  await cdp.send("Page.stopScreencast");
  await wait(300);

  await grab("unlock");
  const caption = await p.locator(".cc-caption").textContent();
  await browser.close();
  writeFileSync(join(WORK, "rec.json"), JSON.stringify({ frames, marks, proof, caption }, null, 1));
  console.log("caption:", caption);
  console.log("proof:", JSON.stringify(proof, null, 1));
}

// ------------------------------------------------------------------ cut + encode

const ff = (a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { stdio: "inherit" });

function encode() {
  const { frames, marks } = JSON.parse(readFileSync(join(WORK, "rec.json"), "utf8"));
  // screencast timestamps → marks: offset = median(receive time − frame time)
  const offs = frames.map((f) => f.rx - f.t).sort((a, b) => a - b);
  const off = offs[Math.floor(offs.length / 2)];
  const t0 = frames[0].t;
  const at = (k) => marks[k] - off - t0; // seconds into the real-speed take

  // 1. real-speed take at a constant frame rate
  const lines = [];
  frames.forEach((f, i) => {
    const next = frames[i + 1] ? frames[i + 1].t : f.t + 1 / FPS;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`);
  writeFileSync(join(WORK, "list.txt"), lines.join("\n"));
  const take = join(WORK, "take.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", join(WORK, "list.txt"), "-vf", `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-crf", "12", "-preset", "fast", take]);

  // 2. segments: [from, to, seconds on screen] — null keeps real speed (the stopwatch reads true)
  const m = { start: at("start"), sendClick: at("sendClick"), matched: at("matched"), hackClick: at("hackClick"), running: at("running"), contained: at("contained"), holdEnd: at("holdEnd"), unlockClick: at("unlockClick"), unlockDone: at("unlockDone"), end: at("end") };
  console.log("marks (s):", Object.fromEntries(Object.entries(m).map(([k, v]) => [k, +v.toFixed(2)])));
  // CUT=contain ends on the containment (for a take whose unlock part is unusable)
  const full = process.env.CUT !== "contain";
  const seg = [
    [Math.max(0, m.sendClick - (full ? 1.2 : 2.0)), m.sendClick + 0.9, null], // pointer reaches ①
    [m.sendClick + 0.9, m.matched, full ? 3.5 : 6.5], // receipt → transfer → check
    [m.matched, m.matched + 2.5, null], // ✓ matched
    [m.matched + 2.5, m.hackClick + 0.9, 0.9], // pointer to ②
    [m.hackClick + 0.9, m.running - 0.3, full ? 2.0 : 4.0], // theft lands on chain
    [m.running - 0.3, m.contained + 3.0, null], // stopwatch: real time
    ...(full
      ? [
          [m.contained + 3.0, m.unlockClick + 0.9, 0.9], // pointer to ③
          [m.unlockClick + 0.9, m.unlockDone, 5.0], // 2 of 3 managers sign
          [m.unlockDone, Math.min(m.end, m.unlockDone + 2.5), null], // unlocked
        ]
      : []),
  ].filter(([a, b]) => b - a > 0.05);
  const parts = seg.map(([a, b, d], i) => {
    const speed = d && b - a > d ? (b - a) / d : 1;
    return `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(4)},fps=${FPS}[s${i}]`;
  });
  const graph = `${parts.join(";")};${seg.map((_, i) => `[s${i}]`).join("")}concat=n=${seg.length}:v=1:a=0${full ? "" : ",tpad=stop_mode=clone:stop_duration=2.5"}[v]`;
  const total = seg.reduce((s, [a, b, d]) => s + (d && b - a > d ? d : b - a), 0) + (full ? 0 : 2.5);
  console.log(`cut: ${seg.length} segments, ${total.toFixed(1)} s`);

  mkdirSync(OUT, { recursive: true });
  const cut = join(WORK, "cut.mp4");
  ff(["-i", take, "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-crf", "10", "-preset", "fast", "-pix_fmt", "yuv420p", cut]);
  ff(["-i", cut, "-an", "-c:v", "libx264", "-profile:v", "high", "-crf", process.env.CRF || "26", "-preset", "slow", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(OUT, "demo.mp4")]);
  ff(["-i", cut, "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", process.env.VP9_CRF || "40", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", join(OUT, "demo.webm")]);
  // poster: the containment moment, a second after it landed (red/olive stopwatch + milestones)
  ff(["-ss", (m.contained + 1.0).toFixed(3), "-i", take, "-frames:v", "1", "-q:v", "3", join(OUT, "demo-poster.jpg")]);
  for (const f of ["demo.mp4", "demo.webm", "demo-poster.jpg"]) console.log(f, `${(statSync(join(OUT, f)).size / 1e6).toFixed(2)} MB`);
}

if (!ENCODE_ONLY) await record();
encode();
