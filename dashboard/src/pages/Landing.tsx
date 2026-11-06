import { useState, type FormEvent } from "react";
import { HeroMedia } from "../components/HeroMedia";
import { Link, navigate } from "../components/router";
import { GITHUB, MEASURED, deploy, hashscan } from "../lib/config";
import { useRiseIn } from "../lib/hooks";

const INCIDENTS = [
  { name: "Resolv USR", when: "Mar 2026", amount: "~$25M", note: "Lost in the exploit." },
  { name: "StablR", when: "May 2026", amount: "~$2.8M", note: "Cashed out by the attacker." },
  { name: "Gala Games", when: "May 2024", amount: "~$21M", note: "About 45 minutes before it was stopped." },
  { name: "Hedera", when: "Mar 2023", amount: "11 h", note: "From first theft to containment." },
];

const STEPS = [
  {
    n: "01",
    title: "Receipt",
    body: "Before any treasury transfer, the gate writes an approved receipt to a Hedera topic. It only signs for machines that hold a live health pass.",
  },
  {
    n: "02",
    title: "Watch",
    body: "A watcher reads every token movement from the Mirror Node and matches it to a receipt. A movement with no receipt is a breach.",
  },
  {
    n: "03",
    title: "Contain",
    body: "A close-only contract freezes the treasury, wipes the stolen tokens from the attacker, freezes the attacker and publishes the incident.",
  },
];

export function Landing() {
  useRiseIn();
  const [token, setToken] = useState("");
  const watch = (e: FormEvent) => {
    e.preventDefault();
    const t = token.trim();
    navigate(t ? `/live?token=${encodeURIComponent(t)}` : "/live");
  };

  return (
    <>
      <header className="hero">
        <HeroMedia />
        <div className="nav">
          <Link to="/" className="logo">
            ▲ Levee
          </Link>
          <nav aria-label="Main">
            <a href="#how">How it works</a>
            <a href={GITHUB} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <Link to="/live" className="btn small">
              Live demo
            </Link>
          </nav>
        </div>

        <div className="hero-copy">
          <span className="chip">✦ Built on Hedera Stablecoin Studio</span>
          <h1>
            Stop a theft before it <span className="accent">spreads</span>
          </h1>
          <p>No receipt, no movement. Anything that moves without one is frozen and undone in seconds.</p>
          <form className="search" onSubmit={watch} role="search">
            <label htmlFor="token" className="sr-only">
              Hedera token ID
            </label>
            <input id="token" type="text" inputMode="text" autoComplete="off" spellCheck={false} placeholder="Paste a Hedera token ID…" value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="btn" type="submit">
              Watch token
            </button>
          </form>
        </div>
      </header>

      <main>
        <section className="section" id="problem">
          <div className="section-inner">
            <div className="section-head" data-rise>
              <span className="eyebrow">01 · The problem</span>
              <h2>
                A stolen key empties a treasury in <span className="accent">minutes</span>
              </h2>
              <p className="muted">Stablecoin issuers find out after the money has moved on. By the time people are awake and on a call, it is gone.</p>
            </div>
            <div className="grid four">
              {INCIDENTS.map((i) => (
                <article className="card incident" key={i.name} data-rise>
                  <span className="when">
                    {i.name} · {i.when}
                  </span>
                  <span className="amount">{i.amount}</span>
                  <p className="muted">{i.note}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="how" style={{ paddingTop: 0 }}>
          <div className="section-inner">
            <div className="section-head" data-rise>
              <span className="eyebrow">02 · How it works</span>
              <h2>
                Every movement needs a <span className="accent">receipt</span>
              </h2>
              <p className="muted">Three parts, all on Hedera. Machines send health heartbeats; an Arkiv pass lasts 180 seconds after the last healthy one, and the gate refuses any machine without a live pass.</p>
            </div>
            <div className="grid three">
              {STEPS.map((s) => (
                <article className="card haze step" key={s.n} data-rise>
                  <span className="num">{s.n}</span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section dark" id="numbers">
          <div className="section-inner">
            <div className="section-head" data-rise>
              <span className="eyebrow">03 · Measured on Hedera testnet, {MEASURED.date}</span>
              <h2>
                Frozen and undone in <span className="accent">8.3 seconds</span>
              </h2>
              <p className="muted">A stolen 2-of-3 key pair sent {MEASURED.wipedAmount} {deploy.token.symbol} to an attacker without a receipt. Times run from the theft reaching consensus.</p>
            </div>
            <div className="grid four">
              <div className="stat" data-rise>
                <span className="val">
                  {MEASURED.detectionS}
                  <small>s</small>
                </span>
                <span>Theft detected</span>
              </div>
              <div className="stat" data-rise>
                <span className="val">
                  {MEASURED.treasuryFrozenS}
                  <small>s</small>
                </span>
                <span>Treasury frozen</span>
              </div>
              <div className="stat" data-rise>
                <span className="val">
                  {MEASURED.wipedS}
                  <small>s</small>
                </span>
                <span>
                  {MEASURED.wipedAmount} {deploy.token.symbol} wiped from the attacker
                </span>
              </div>
              <div className="stat" data-rise>
                <span className="val">
                  {MEASURED.wipedS}
                  <small>s</small>
                </span>
                <span>Attacker frozen</span>
              </div>
            </div>
            <div className="links">
              <a href={hashscan.tx(MEASURED.attackTx)} target="_blank" rel="noreferrer">
                The theft on HashScan
              </a>
              <a href={hashscan.tx(MEASURED.wipeTx)} target="_blank" rel="noreferrer">
                The wipe on HashScan
              </a>
              <a href={hashscan.topic(deploy.topics.incidents)} target="_blank" rel="noreferrer">
                Published incidents
              </a>
            </div>
          </div>
        </section>

        <section className="section" id="reopen">
          <div className="section-inner reopen">
            <div className="section-head" data-rise>
              <span className="eyebrow">04 · Reopening</span>
              <h2>
                The robot only closes doors. Two people reopen <span className="accent">them</span>
              </h2>
            </div>
            <div className="section-head" data-rise>
              <p>The containment contract can freeze, wipe and publish. It cannot unfreeze. Reopening the treasury needs two of the three admins to sign, so a stolen watcher key can only ever lock things.</p>
              <div className="admins">
                {deploy.admins.map((a, i) => (
                  <div className="card admin" key={a}>
                    <span className="eyebrow">Admin {i + 1}</span>
                    <a className="k" href={hashscan.account(a)} target="_blank" rel="noreferrer">
                      {a}
                    </a>
                  </div>
                ))}
              </div>
              <div>
                <Link to="/live" className="btn secondary">
                  Watch it live
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="row">
          <span>▲ Levee · no receipt, no movement</span>
          <span>
            <a href={GITHUB} target="_blank" rel="noreferrer">
              GitHub
            </a>{" "}
            · Hedera {deploy.network}
          </span>
        </div>
      </footer>
    </>
  );
}
