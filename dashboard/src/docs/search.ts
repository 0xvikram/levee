// Client-side docs search over page titles, descriptions, headings and body text. Every word of the
// query must appear somewhere in the page; titles weigh most, then headings, then the description, then body text.
export interface SearchDoc {
  slug: string;
  href: string;
  title: string;
  description: string;
  group: string;
  headings: { text: string; id: string }[];
  text: string;
}

export interface SearchHit {
  slug: string;
  href: string; // with #heading when the best match is a heading
  title: string;
  group: string;
  heading?: string;
  snippet: string;
  score: number;
}

const words = (q: string) =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter(Boolean);

function snippetAround(text: string, term: string, span = 70): string {
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return text.slice(0, span * 2).trim() + (text.length > span * 2 ? "…" : "");
  const start = Math.max(0, i - span);
  const end = Math.min(text.length, i + term.length + span);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

export function search(docs: SearchDoc[], query: string, limit = 8): SearchHit[] {
  const terms = words(query);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const d of docs) {
    const title = d.title.toLowerCase();
    const desc = d.description.toLowerCase();
    const body = d.text.toLowerCase();
    let score = 0;
    let all = true;
    let bestHeading: { text: string; id: string } | undefined;
    let bestHeadingHits = 0;
    for (const t of terms) {
      const inTitle = title.includes(t);
      const inDesc = desc.includes(t);
      const headingHits = d.headings.filter((h) => h.text.toLowerCase().includes(t));
      const inBody = body.includes(t);
      if (!inTitle && !inDesc && !headingHits.length && !inBody) {
        all = false;
        break;
      }
      if (inTitle) score += title === t || title.startsWith(t) ? 14 : 10;
      if (headingHits.length) score += 5;
      if (inDesc) score += 3;
      if (inBody) score += 1 + Math.min(3, body.split(t).length - 2) * 0.25;
    }
    if (!all) continue;
    for (const h of d.headings) {
      const n = terms.filter((t) => h.text.toLowerCase().includes(t)).length;
      if (n > bestHeadingHits) {
        bestHeadingHits = n;
        bestHeading = h;
      }
    }
    if (title.includes(query.toLowerCase().trim())) score += 6; // whole phrase in the title
    const titleHit = terms.some((t) => title.includes(t));
    const useHeading = bestHeading && !titleHit;
    hits.push({
      slug: d.slug,
      href: useHeading ? `${d.href}#${bestHeading!.id}` : d.href,
      title: d.title,
      group: d.group,
      heading: useHeading ? bestHeading!.text : undefined,
      snippet: snippetAround(d.text, terms.find((t) => body.includes(t)) ?? terms[0]),
      score,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
