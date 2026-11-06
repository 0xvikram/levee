import { useEffect } from "react";
import "./logos.css";
import { Link } from "../components/router";
import { LOGOS, type LogoOption } from "../components/logos";

/** /logos: the four logo options side by side for choosing. Not linked from the nav. */
export function Logos() {
  useEffect(() => {
    const prev = document.title;
    document.title = "Levee · logo options";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <main className="lg">
      <header className="lg-head">
        <Link to="/" className="lg-back">
          ← Levee
        </Link>
        <h1>Logo options</h1>
        <p>
          Four marks for Levee, each with the wordmark. Shown large, at 32 px and at 16 px, in cream and yellow on cobalt, and in cobalt on cream. The site still uses ▲ until one is
          picked: set <code>CURRENT</code> in <code>components/SiteLogo.tsx</code> to the option's id.
        </p>
      </header>
      <div className="lg-grid">
        {LOGOS.map((o) => (
          <Option key={o.id} o={o} />
        ))}
      </div>
    </main>
  );
}

function Lockup({ o, size }: { o: LogoOption; size: number }) {
  const { Mark } = o;
  return (
    <span className="lg-lockup" style={{ fontSize: size }}>
      <Mark size="0.92em" /> <span>Levee</span>
    </span>
  );
}

function Option({ o }: { o: LogoOption }) {
  const { Mark } = o;
  return (
    <section className="lg-card" aria-labelledby={`lg-${o.id}`}>
      <div className="lg-card-head">
        <span className="lg-letter">{o.letter}</span>
        <h2 id={`lg-${o.id}`}>{o.name}</h2>
        <code>{o.id}</code>
      </div>
      <p className="lg-idea">{o.idea}</p>

      <div className="lg-panel cobalt">
        <div className="lg-hero">
          <Mark size={160} className="cream" title={`${o.name} mark`} />
        </div>
        <div className="lg-row">
          <span className="cream">
            <Lockup o={o} size={56} />
          </span>
        </div>
        <div className="lg-row">
          <span className="yellow">
            <Lockup o={o} size={56} />
          </span>
        </div>
        <div className="lg-sizes">
          <Size label="32 px">
            <Mark size={32} className="cream" />
            <Mark size={32} className="yellow" />
          </Size>
          <Size label="16 px">
            <Mark size={16} className="cream" />
            <Mark size={16} className="yellow" />
          </Size>
          <Size label="nav">
            <span className="cream lg-nav">
              <Mark size="0.8em" className="yellow" /> Levee
            </span>
          </Size>
        </div>
      </div>

      <div className="lg-panel cream-bg">
        <div className="lg-row">
          <span className="cobalt">
            <Lockup o={o} size={48} />
          </span>
        </div>
        <div className="lg-sizes">
          <Size label="32 px">
            <Mark size={32} className="cobalt" />
          </Size>
          <Size label="16 px">
            <Mark size={16} className="cobalt" />
          </Size>
          <Size label="favicon">
            <span className="lg-fav">
              <Mark size={12} />
            </span>
          </Size>
        </div>
      </div>
    </section>
  );
}

function Size({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure className="lg-size">
      <div>{children}</div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}
