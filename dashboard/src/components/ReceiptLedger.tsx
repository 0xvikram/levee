// "How it works" as something to watch: two columns, the money that moved (Mirror Node) and the receipts on
// Hedera (HCS), and the watcher's checks between them. Every scenario uses a real recorded testnet run
// (docs/LIVE_RUN.md, the incidents topic) or, for the forged-receipt cases, the watcher's rule tests. It is a
// replay, never live traffic, and it says so.
import { useEffect, useRef, useState } from "react";
import { GITHUB, hashscan } from "../lib/config";
import { FACTS, MINT } from "../lib/numbers";
import type { Showcase } from "../lib/incident";
import { usePrefersReducedMotion } from "../lib/hooks";

type Tone = "ok" | "bad" | "warn";
type Step = { text: string; at?: string; tone?: Tone };
type Link = { label: string; href: string };
export interface Scenario {
  id: string;
  tab: string;
  movement: string;
  receipt: string | null; // null: no receipt exists
  receiptNote?: string;
  steps: Step[];
  verdict: string;
  tone: Tone;
  source: string;
  links: Link[];
}

const RULE_TESTS = `${GITHUB}/blob/build/tests/match.test.ts`;
const HONEST = {
  transfer: "0.0.11333495-1793937199-767624290",
  receipt: "0.0.11333489-1793937200-519056972",
};
const s2 = (s: number) => `${s.toFixed(2)} s`;

export function scenarios(m: Showcase): Scenario[] {
  return [
    {
      id: "honest",
      tab: "Honest payment",
      movement: "Treasury → Asha Pay · 500 RUPC",
      receipt: "Receipt · 500 RUPC to Asha Pay",
      receiptNote: "reached consensus first",
      steps: [
        { text: "Gate checks the request: signature, health pass, caps, known recipient", tone: "ok" },
        { text: "Gate schedules the transfer and signs (key 1 of 3), then writes the receipt to Hedera", tone: "ok" },
        { text: "Issuer signer finds the receipt and signs (key 2 of 3). Money moves", tone: "ok" },
        { text: "Watcher matches the movement to its receipt", at: "~2.2 s", tone: "ok" },
      ],
      verdict: "Paid. Receipt found.",
      tone: "ok",
      source: `Recorded on Hedera testnet · ${FACTS.matchedSends} payments, ${FACTS.falseAlarms} false alarms`,
      links: [
        { label: "transfer", href: hashscan.tx(HONEST.transfer) },
        { label: "receipt", href: hashscan.tx(HONEST.receipt) },
      ],
    },
    {
      id: "theft",
      tab: "Stolen keys",
      movement: "Treasury → unknown account",
      receipt: null,
      steps: [
        { text: "Two stolen keys sign a transfer. The gate is skipped", tone: "bad" },
        { text: "Money moves. No receipt exists on Hedera", tone: "bad" },
        { text: "Watcher: no receipt → breach", at: s2(m.detectionS), tone: "warn" },
        { text: "Treasury frozen, thief wiped and frozen", at: s2(m.wipedS), tone: "ok" },
      ],
      verdict: `Taken back in ${s2(m.wipedS)}.`,
      tone: "ok",
      source: `Recorded on Hedera testnet · ${m.date}`,
      links: [
        { label: "the theft", href: hashscan.tx(m.attackTx) },
        { label: "the wipe", href: hashscan.tx(m.wipeTx) },
      ],
    },
    {
      id: "mint",
      tab: "Fake mint",
      movement: `Mint · ${MINT.amount} RUPC → unknown account`,
      receipt: null,
      steps: [
        { text: "A stolen minting key prints new tokens. No gate, no receipt", tone: "bad" },
        { text: "Watcher: new supply with no receipt → breach", at: s2(MINT.detectedS), tone: "warn" },
        { text: "Fake tokens wiped, account frozen", at: s2(MINT.containedS), tone: "ok" },
        { text: "Total supply back to exactly what it was", tone: "ok" },
      ],
      verdict: "Supply restored.",
      tone: "ok",
      source: `Recorded on Hedera testnet · ${MINT.date}`,
      links: [
        { label: "the mint", href: hashscan.tx(MINT.mintTx) },
        { label: "the wipe", href: hashscan.tx(MINT.wipeTx) },
      ],
    },
    {
      id: "forged-cap",
      tab: "Forged receipt, too big",
      movement: "Treasury → unknown account · 50,000 RUPC",
      receipt: "Receipt · 50,000 RUPC",
      receiptNote: "forged with the stolen gate key",
      steps: [
        { text: "Attacker holds the gate and signer keys, so writes a receipt first", tone: "bad" },
        { text: "Receipt found, but the watcher checks the rules itself", tone: "warn" },
        { text: "Over the per-payment cap, to an unknown account → breach", tone: "warn" },
        { text: "Treasury frozen, receiver wiped and frozen", tone: "ok" },
      ],
      verdict: "A receipt alone is not enough.",
      tone: "ok",
      source: "Watcher rule, covered by the test suite (not a testnet run)",
      links: [{ label: "rule tests", href: RULE_TESTS }],
    },
    {
      id: "forged-partner",
      tab: "Forged receipt, known partner",
      movement: "Treasury → Asha Pay · 2,000 RUPC",
      receipt: "Receipt · 2,000 RUPC to Asha Pay",
      receiptNote: "forged with the stolen gate key",
      steps: [
        { text: "Attacker holds the gate and signer keys, writes a receipt", tone: "bad" },
        { text: "Under the caps, to a known partner: every check passes", tone: "warn" },
        { text: "Allowed. It looks exactly like a normal payment", tone: "warn" },
        { text: "Worst case: one day's cap, paid to a business you know", tone: "warn" },
      ],
      verdict: "The honest limit: damage is capped, not zero.",
      tone: "warn",
      source: "Watcher rule, covered by the test suite (not a testnet run)",
      links: [{ label: "rule tests", href: RULE_TESTS }],
    },
  ];
}

const STEP_MS = 1100;
const HOLD_MS = 3200;

/** Scenario tabs over a two-column ledger. Auto-plays through the scenarios until the visitor picks one. */
export function ReceiptLedger({ m }: { m: Showcase }) {
  const list = scenarios(m);
  const reduced = usePrefersReducedMotion();
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(reduced ? list[0].steps.length : 0);
  const [auto, setAuto] = useState(!reduced);
  const box = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => setOnScreen(es.some((e) => e.isIntersecting)), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const sc = list[i];
  const total = sc.steps.length;

  useEffect(() => {
    if (reduced) return setShown(total);
    if (!onScreen) return;
    if (shown < total) {
      const t = setTimeout(() => setShown((n) => n + 1), STEP_MS);
      return () => clearTimeout(t);
    }
    if (!auto) return;
    const t = setTimeout(() => {
      setI((k) => (k + 1) % list.length);
      setShown(0);
    }, HOLD_MS);
    return () => clearTimeout(t);
  }, [shown, total, auto, reduced, onScreen, list.length]);

  const pick = (k: number) => {
    setAuto(false);
    setI(k);
    setShown(reduced ? list[k].steps.length : 0);
  };

  const moved = shown >= 1;
  const done = shown >= total;
  const matched = sc.receipt !== null;

  return (
    <div className="lp-ledger" ref={box} data-testid="receipt-ledger">
      <div className="lp-ledger-tabs" role="tablist" aria-label="Scenarios">
        {list.map((s, k) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`ledger-tab-${s.id}`}
            aria-selected={k === i}
            aria-controls="ledger-panel"
            className={k === i ? "on" : undefined}
            onClick={() => pick(k)}
          >
            {s.tab}
          </button>
        ))}
        {auto && !reduced && (
          <button type="button" className="lp-ledger-pause" onClick={() => setAuto(false)}>
            Pause
          </button>
        )}
      </div>

      <div className="lp-ledger-panel lp-patch" id="ledger-panel" role="tabpanel" aria-labelledby={`ledger-tab-${sc.id}`}>
        <div className="lp-ledger-cols" aria-hidden={!moved}>
          <div className={`lp-ledger-col ${moved ? "in" : ""}`}>
            <span className="lp-ledger-h">Money moved · Mirror Node</span>
            <div className={`lp-ledger-row ${done ? sc.tone : ""}`}>{sc.movement}</div>
          </div>
          <div className={`lp-ledger-link ${moved ? (matched ? "matched" : "missing") : ""}`} aria-hidden="true">
            <span />
            <b>{moved ? (matched ? "✓" : "✗") : ""}</b>
          </div>
          <div className={`lp-ledger-col ${moved ? "in" : ""}`}>
            <span className="lp-ledger-h">Receipts · Hedera</span>
            {sc.receipt ? (
              <div className="lp-ledger-row receipt">
                {sc.receipt}
                {sc.receiptNote && <small>{sc.receiptNote}</small>}
              </div>
            ) : (
              <div className="lp-ledger-row empty">No receipt</div>
            )}
          </div>
        </div>

        <ol className="lp-ledger-steps">
          {sc.steps.map((st, k) => (
            <li key={k} className={`${k < shown ? "in" : ""} ${st.tone ?? ""}`}>
              <span>{st.text}</span>
              {st.at && <b className="mono">{st.at}</b>}
            </li>
          ))}
        </ol>

        <div className={`lp-ledger-verdict ${done ? `in ${sc.tone}` : ""}`} aria-live="polite">
          {done ? sc.verdict : " "}
        </div>

        <p className="lp-ledger-src">
          <span>Replay · {sc.source}</span>
          {sc.links.map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer">
              {l.label} ↗
            </a>
          ))}
        </p>
      </div>
    </div>
  );
}

/** "Why not just check before signing?" in three rows, with no competitor named. */
export const VERSUS: { case: string; before: string; levee: string }[] = [
  { case: "A stolen key signs a payment", before: "Passes: the signature is valid", levee: "No receipt, so it's frozen and wiped" },
  { case: "The money has already left", before: "Nothing left to check", levee: "Taken back in seconds" },
  { case: "An honest payment", before: "May wait for review or a vote", levee: "Goes through in seconds" },
];
