// QR code as inline SVG (client-side, `qrcode` package for the matrix; no data URLs, no innerHTML).
import { useMemo } from "react";
import QRCode from "qrcode";

/** One SVG path of dark modules, in module units (viewBox includes a 2-module quiet zone). */
export function qrPath(text: string): { size: number; d: string } | null {
  try {
    const q = QRCode.create(text, { errorCorrectionLevel: "L" });
    const n = q.modules.size;
    const data = q.modules.data;
    let d = "";
    for (let y = 0; y < n; y++) {
      let x = 0;
      while (x < n) {
        if (!data[y * n + x]) {
          x++;
          continue;
        }
        let w = 1;
        while (x + w < n && data[y * n + x + w]) w++;
        d += `M${x + 2} ${y + 2}h${w}v1h-${w}z`;
        x += w;
      }
    }
    return { size: n + 4, d };
  } catch {
    return null;
  }
}

export function QR({ text, label, px = 112 }: { text: string; label: string; px?: number }) {
  const q = useMemo(() => qrPath(text), [text]);
  if (!q) return null;
  return (
    <svg className="qr" viewBox={`0 0 ${q.size} ${q.size}`} width={px} height={px} role="img" aria-label={`QR code: ${label}`} shapeRendering="crispEdges">
      <rect width={q.size} height={q.size} fill="#efe6d2" />
      <path d={q.d} fill="#1b1a17" />
    </svg>
  );
}
