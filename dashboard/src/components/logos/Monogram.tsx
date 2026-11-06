import { markSvgProps, type MarkProps } from "./types";

/** Option C: a monogram L. The stem is a wall; the foot is a body of water with a wave crest, held against it. */
export function MonogramMark(props: MarkProps) {
  return (
    <svg {...markSvgProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <rect x="4" y="3" width="6" height="26" />
      <path d="M10 29 V21 Q13 17.5 16 21 T22 21 T28 21 V29 Z" />
    </svg>
  );
}
