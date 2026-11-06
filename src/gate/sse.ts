// Tiny Server-Sent Events hub shared by the gate and the watcher (dashboard feed).
import type { Request, Response } from "express";

/** Format one SSE frame. Multi-line data is split into several `data:` lines as the spec requires. */
export function formatSse(event: string, data: unknown, id?: number | string): string {
  const json = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const safeEvent = event.replace(/[\r\n]/g, "");
  let out = "";
  if (id !== undefined) out += `id: ${String(id).replace(/[\r\n]/g, "")}\n`;
  out += `event: ${safeEvent}\n`;
  for (const line of json.split(/\r?\n/)) out += `data: ${line}\n`;
  return out + "\n";
}

export class SseHub {
  private clients = new Set<Response>();
  private nextId = 1;
  private history: string[] = [];

  constructor(private keep = 50) {}

  /** Express handler: keeps the connection open and replays recent events. */
  handler = (req: Request, res: Response): void => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected\n\n");
    for (const frame of this.history) res.write(frame);
    this.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  };

  publish(event: string, data: unknown): string {
    const frame = formatSse(event, data, this.nextId++);
    this.history.push(frame);
    if (this.history.length > this.keep) this.history.shift();
    for (const c of this.clients) c.write(frame);
    return frame;
  }

  get size(): number {
    return this.clients.size;
  }
}
