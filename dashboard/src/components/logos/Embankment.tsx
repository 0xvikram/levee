import { markSvgProps, type MarkProps } from "./types";

/** Option A: a levee cross-section. A trapezoid embankment on a ground line, water held on its left. */
export function EmbankmentMark(props: MarkProps) {
  return (
    <svg {...markSvgProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M12 26 L18 8 H24 L30 26 Z" />
      <path d="M1 16.5 Q3.5 13.5 6 16.5 T11 16.5 H12.6 L9.4 26 H1 Z" />
      <rect x="1" y="27.5" width="29" height="2.5" />
    </svg>
  );
}
