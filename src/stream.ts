import type { LogRow, TraceListRow } from "../rasat/web/src/search/api";
import { liveLogRows, liveTraceRows } from "./client";

const tickMs = 1000;
const ringMs = 45_000;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function withNow(row: TraceListRow): TraceListRow {
  return { ...row, timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
}

function withNowLog(row: LogRow): LogRow {
  return { ...row, timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
}

function loop<T>(items: T[], onItem: (item: T) => void): () => void {
  if (items.length === 0 || reducedMotion()) {
    return () => undefined;
  }
  const step = Math.max(tickMs, Math.floor(ringMs / items.length));
  let i = 0;
  const id = window.setInterval(() => {
    const item = items[i % items.length];
    if (item) {
      onItem(item);
    }
    i += 1;
  }, step);
  return () => window.clearInterval(id);
}

export function listenTraces(onRow: (row: TraceListRow) => void): () => void {
  return loop(liveTraceRows(), (row) => onRow(withNow(row)));
}

export function listenLogs(onRow: (row: LogRow) => void): () => void {
  return loop(liveLogRows(), (row) => onRow(withNowLog(row)));
}
