import type { ComponentType } from "react";
import type { MarkProps } from "./types";
import { EmbankmentMark } from "./Embankment";
import { ChevronMark } from "./Chevron";
import { MonogramMark } from "./Monogram";
import { SluiceMark } from "./Sluice";

export type LogoId = "embankment" | "chevron" | "monogram" | "sluice";
export type LogoOption = { id: LogoId; letter: string; name: string; idea: string; Mark: ComponentType<MarkProps> };

export const LOGOS: LogoOption[] = [
  { id: "embankment", letter: "A", name: "Embankment", idea: "A levee in cross-section: a trapezoid bank on a ground line, water held on one side.", Mark: EmbankmentMark },
  { id: "chevron", letter: "B", name: "Chevron", idea: "An upward chevron, the bank, standing over three wave lines, the water it holds.", Mark: ChevronMark },
  { id: "monogram", letter: "C", name: "Monogram", idea: "An L whose stem is a wall and whose foot is water with a wave crest, held against it.", Mark: MonogramMark },
  { id: "sluice", letter: "D", name: "Sluice", idea: "A lock gate: two piers under a lintel with a wave stopped between them.", Mark: SluiceMark },
];

export { EmbankmentMark, ChevronMark, MonogramMark, SluiceMark };
export type { MarkProps };
