import type { SVGProps } from "react";

export type MarkProps = Omit<SVGProps<SVGSVGElement>, "viewBox"> & { size?: number | string; title?: string };

/** Shared SVG shell: 32-unit grid, single colour (currentColor), decorative unless given a title. */
export function markSvgProps({ size = "1em", title, ...rest }: MarkProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 32 32",
    fill: "currentColor",
    role: title ? "img" : undefined,
    "aria-hidden": title ? undefined : true,
    focusable: "false" as const,
    ...rest,
  };
}
