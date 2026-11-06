import { LOGOS, type LogoId } from "./logos";

/**
 * The logo in both navs (landing and /live). To switch to one of the /logos options,
 * change this one line to its id: "embankment" | "chevron" | "monogram" | "sluice".
 */
const CURRENT = "chevron" as LogoId | "triangle";

export function SiteLogo({ word = "Levee" }: { word?: string }) {
  const option = LOGOS.find((l) => l.id === CURRENT);
  if (!option) {
    return (
      <>
        <span aria-hidden="true">▲</span> {word}
      </>
    );
  }
  const { Mark } = option;
  return (
    <>
      <Mark className="site-logo-mark" /> {word}
    </>
  );
}
