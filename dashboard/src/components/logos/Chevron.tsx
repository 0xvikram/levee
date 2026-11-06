import { markSvgProps, type MarkProps } from "./types";

/** Option B: an upward chevron (the embankment) standing over three wave lines (the water it holds). */
export function ChevronMark(props: MarkProps) {
  return (
    <svg {...markSvgProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M5 15 L16 4 L27 15" fill="none" stroke="currentColor" strokeWidth="4" strokeLinejoin="miter" strokeLinecap="butt" />
      <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M4.5 19.5 q2.875 -2.6 5.75 0 t5.75 0 t5.75 0 t5.75 0" />
        <path d="M4.5 24.25 q2.875 -2.6 5.75 0 t5.75 0 t5.75 0 t5.75 0" />
        <path d="M4.5 29 q2.875 -2.6 5.75 0 t5.75 0 t5.75 0 t5.75 0" />
      </g>
    </svg>
  );
}
