import { markSvgProps, type MarkProps } from "./types";

/** Option D: a lock / sluice gate. Two piers under a lintel, with a wave stopped between them. */
export function SluiceMark(props: MarkProps) {
  return (
    <svg {...markSvgProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <rect x="3" y="3" width="26" height="4" />
      <rect x="3" y="7" width="5" height="22" />
      <rect x="24" y="7" width="5" height="22" />
      <path d="M10.5 29 V18.5 Q13.25 15.25 16 18.5 T21.5 18.5 V29 Z" />
    </svg>
  );
}
