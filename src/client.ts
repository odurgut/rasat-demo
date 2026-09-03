import {
  SearchError,
  type Bottleneck,
  type BuildInfo,
  type CriticalPathStep,
  type ErrorCause,
  type LogRow,
  type MetricPoint,
  type MetricsResponse,
  type OperationRow,
  type ServiceMapGraph,
  type ServiceMetrics,
  type ServiceRow,
  type SpanDetail,
  type TraceDetail,
  type TraceListRow,
} from "../rasat/web/src/search/api";
import { logMatchesForm, rowMatchesForm } from "../rasat/web/src/search/live";
import type { LogForm, SearchForm } from "../rasat/web/src/search/query";
import { logs, traces, type TapeLog, type TapeSpan, type TapeTrace } from "./cassette";

type HydratedTrace = {
  row: TraceListRow;
  detail: TraceDetail;
};

type World = {
  traces: HydratedTrace[];
  logs: LogRow[];
};

const historyShiftsMs = [
  20 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  3 * 60 * 60 * 1000,
  60 * 60 * 1000,
];

let world: World | null = null;
let originMs = 0;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function replayId(base: string, gen: number): string {
  const prefix = gen.toString(16).padStart(4, "0");
  return (prefix + base).slice(0, 32);
}

function expandTraces(): TapeTrace[] {
  const out: TapeTrace[] = traces.map((t) => ({ ...t, spans: t.spans }));
  historyShiftsMs.forEach((shift, i) => {
    for (const t of traces) {
      out.push({
        offset_ms: t.offset_ms + shift,
        trace_id: replayId(t.trace_id, i + 1),
        spans: t.spans,
      });
    }
  });
  return out;
}

function expandLogs(): TapeLog[] {
  const out: TapeLog[] = logs.map((row) => ({ ...row }));
  historyShiftsMs.forEach((shift, i) => {
    for (const row of logs) {
      out.push({
        ...row,
        offset_ms: row.offset_ms + shift,
        trace_id: replayId(row.trace_id, i + 1),
      });
    }
  });
  return out;
}

function toSpan(s: TapeSpan, traceStartMs: number): SpanDetail {
  return {
    timestamp: iso(traceStartMs + s.start_ms),
    span_id: s.span_id,
    parent_span_id: s.parent_span_id,
    service: s.service,
    operation: s.operation,
    kind: s.kind,
    duration_ns: s.dur_ms * 1e6,
    start_offset_ns: s.start_ms * 1e6,
    status_code: s.status_code,
    status_message: s.status_message,
    scope_name: "rasat-demo",
    scope_version: "",
    resource_attributes: { "service.name": s.service },
    span_attributes: s.attrs,
    events: s.events.map((e) => ({
      time: iso(traceStartMs + e.at_ms),
      name: e.name,
      attributes: e.attrs,
    })),
    links: [],
  };
}

function longestChild(spans: SpanDetail[], parentID: string): SpanDetail | undefined {
  let best: SpanDetail | undefined;
  let bestEnd = -1;
  for (const s of spans) {
    if (s.parent_span_id !== parentID) {
      continue;
    }
    const start = Date.parse(s.timestamp);
    const end = start + s.duration_ns / 1e6;
    if (end > bestEnd) {
      bestEnd = end;
      best = s;
    }
  }
  return best;
}

function insight(spans: SpanDetail[]): { path: CriticalPathStep[]; pathNs: number; bottlenecks: Bottleneck[] } {
  const root = spans.find((s) => !s.parent_span_id) ?? spans[0];
  const path: CriticalPathStep[] = [];
  let cur = root;
  while (cur) {
    path.push({
      span_id: cur.span_id,
      service: cur.service,
      operation: cur.operation,
      duration_ns: cur.duration_ns,
    });
    cur = longestChild(spans, cur.span_id);
  }
  const childSum = new Map<string, number>();
  for (const s of spans) {
    if (!s.parent_span_id) {
      continue;
    }
    childSum.set(s.parent_span_id, (childSum.get(s.parent_span_id) ?? 0) + s.duration_ns);
  }
  const bottlenecks = spans
    .map((s) => ({
      span_id: s.span_id,
      service: s.service,
      operation: s.operation,
      exclusive_ns: Math.max(0, s.duration_ns - (childSum.get(s.span_id) ?? 0)),
    }))
    .filter((b) => b.exclusive_ns > 0)
    .sort((a, b) => b.exclusive_ns - a.exclusive_ns)
    .slice(0, 3);
  const pathNs = root?.duration_ns ?? 0;
  return { path, pathNs, bottlenecks };
}

function hydrateTrace(t: TapeTrace, origin: number): HydratedTrace {
  const startMs = origin - t.offset_ms;
  const root = t.spans[0];
  const duration_ns = (root?.dur_ms ?? 0) * 1e6;
  const spans = t.spans.map((s) => toSpan(s, startMs));
  const extra = insight(spans);
  return {
    row: {
      trace_id: t.trace_id,
      service: root?.service ?? "",
      operation: root?.operation ?? "",
      duration_ns,
      span_count: t.spans.length,
      timestamp: iso(startMs),
      status_code: root?.status_code ?? 1,
    },
    detail: {
      trace_id: t.trace_id,
      timestamp: iso(startMs),
      duration_ns,
      span_count: t.spans.length,
      critical_path: extra.path,
      critical_path_ns: extra.pathNs,
      bottlenecks: extra.bottlenecks,
      spans,
    },
  };
}

function loadWorld(): World {
  if (world) {
    return world;
  }
  originMs = Date.now();
  world = {
    traces: expandTraces().map((t) => hydrateTrace(t, originMs)),
    logs: expandLogs().map((row) => ({
      timestamp: iso(originMs - row.offset_ms),
      service: row.service,
      level: row.level,
      message: row.message,
      trace_id: row.trace_id,
      span_id: row.span_id,
    })),
  };
  return world;
}

function inWindow(ts: string, start: string, end: string): boolean {
  const t = Date.parse(ts);
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(t)) {
    return false;
  }
  if (Number.isFinite(a) && t < a) {
    return false;
  }
  if (Number.isFinite(b) && t >= b) {
    return false;
  }
  return true;
}

function parseLimit(raw: string, fallback: number): number {
  const n = Number.parseInt(raw.trim() || String(fallback), 10);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return n;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

function parseStepS(raw: string, windowS: number): number {
  const s = raw.trim();
  if (!s) {
    return Math.max(60, Math.floor(windowS / 24) || 60);
  }
  const m = s.match(/^(\d+)(s|m|h)$/);
  if (!m || m[1] === undefined || m[2] === undefined) {
    return Math.max(60, Math.floor(windowS / 24) || 60);
  }
  const n = Number(m[1]);
  if (m[2] === "s") {
    return n;
  }
  if (m[2] === "m") {
    return n * 60;
  }
  return n * 3600;
}

function spanCause(s: SpanDetail): string {
  const ex = s.events.find((e) => e.attributes["exception.type"]);
  const t = ex?.attributes["exception.type"];
  if (t) {
    return t;
  }
  if (s.status_message) {
    return s.status_message;
  }
  return "error";
}

/** Recent cassette rows for the fake live ring (not the 24h replicas). */
export function liveTraceRows(): TraceListRow[] {
  loadWorld();
  return traces.map((t) => hydrateTrace(t, originMs).row);
}

export function liveLogRows(): LogRow[] {
  loadWorld();
  return logs.map((row) => ({
    timestamp: iso(originMs - row.offset_ms),
    service: row.service,
    level: row.level,
    message: row.message,
    trace_id: row.trace_id,
    span_id: row.span_id,
  }));
}

export async function searchTraces(form: SearchForm, signal?: AbortSignal): Promise<TraceListRow[]> {
  throwIfAborted(signal);
  const { traces: all } = loadWorld();
  const limit = parseLimit(form.limit, 50);
  const rows = all
    .map((t) => t.row)
    .filter((row) => rowMatchesForm(row, form, false))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
  throwIfAborted(signal);
  return rows;
}

export async function getTrace(id: string, _form: SearchForm, signal?: AbortSignal): Promise<TraceDetail> {
  throwIfAborted(signal);
  const found = loadWorld().traces.find((t) => t.detail.trace_id === id);
  if (!found) {
    throw new SearchError("trace not found");
  }
  throwIfAborted(signal);
  return found.detail;
}

export async function listServices(form: SearchForm, signal?: AbortSignal): Promise<ServiceRow[]> {
  throwIfAborted(signal);
  const counts = new Map<string, { last_seen: number; spans: number; errors: number }>();
  for (const t of loadWorld().traces) {
    for (const s of t.detail.spans) {
      if (!inWindow(s.timestamp, form.start, form.end)) {
        continue;
      }
      const cur = counts.get(s.service) ?? { last_seen: 0, spans: 0, errors: 0 };
      const ts = Date.parse(s.timestamp);
      cur.spans += 1;
      if (s.status_code === 2) {
        cur.errors += 1;
      }
      if (ts > cur.last_seen) {
        cur.last_seen = ts;
      }
      counts.set(s.service, cur);
    }
  }
  const limit = parseLimit(form.limit, 100);
  const rows: ServiceRow[] = [...counts.entries()]
    .map(([service, v]) => ({
      service,
      last_seen: iso(v.last_seen),
      spans: v.spans,
      errors: v.errors,
    }))
    .sort((a, b) => b.spans - a.spans)
    .slice(0, limit);
  throwIfAborted(signal);
  return rows;
}

export async function listOperations(
  service: string,
  start: string,
  end: string,
  signal?: AbortSignal,
  limit = "100",
): Promise<OperationRow[]> {
  throwIfAborted(signal);
  const want = service.trim();
  const byOp = new Map<string, { durs: number[]; errors: number }>();
  for (const t of loadWorld().traces) {
    for (const s of t.detail.spans) {
      if (s.service !== want || !inWindow(s.timestamp, start, end)) {
        continue;
      }
      const cur = byOp.get(s.operation) ?? { durs: [], errors: 0 };
      cur.durs.push(s.duration_ns);
      if (s.status_code === 2) {
        cur.errors += 1;
      }
      byOp.set(s.operation, cur);
    }
  }
  const cap = parseLimit(limit, 100);
  const rows: OperationRow[] = [...byOp.entries()]
    .map(([operation, v]) => {
      const durs = [...v.durs].sort((a, b) => a - b);
      return {
        operation,
        spans: v.durs.length,
        errors: v.errors,
        error_rate: v.durs.length === 0 ? 0 : v.errors / v.durs.length,
        p50_ns: quantile(durs, 50),
        p95_ns: quantile(durs, 95),
      };
    })
    .sort((a, b) => b.spans - a.spans)
    .slice(0, cap);
  throwIfAborted(signal);
  return rows;
}

export async function getServiceMap(form: SearchForm, signal?: AbortSignal): Promise<ServiceMapGraph> {
  throwIfAborted(signal);
  const nodes = new Map<string, { spans: number; errors: number }>();
  const edges = new Map<string, { calls: number; errors: number; dur: number }>();
  const byID = new Map<string, SpanDetail>();
  for (const t of loadWorld().traces) {
    byID.clear();
    for (const s of t.detail.spans) {
      byID.set(s.span_id, s);
    }
    for (const s of t.detail.spans) {
      if (!inWindow(s.timestamp, form.start, form.end)) {
        continue;
      }
      const node = nodes.get(s.service) ?? { spans: 0, errors: 0 };
      node.spans += 1;
      if (s.status_code === 2) {
        node.errors += 1;
      }
      nodes.set(s.service, node);
      if (!s.parent_span_id) {
        continue;
      }
      const parent = byID.get(s.parent_span_id);
      if (!parent || parent.service === s.service) {
        continue;
      }
      const key = `${parent.service}\0${s.service}`;
      const edge = edges.get(key) ?? { calls: 0, errors: 0, dur: 0 };
      edge.calls += 1;
      edge.dur += s.duration_ns;
      if (s.status_code === 2) {
        edge.errors += 1;
      }
      edges.set(key, edge);
    }
  }
  const limit = parseLimit(form.limit, 100);
  throwIfAborted(signal);
  return {
    nodes: [...nodes.entries()]
      .map(([service, v]) => ({ service, spans: v.spans, errors: v.errors }))
      .sort((a, b) => b.spans - a.spans)
      .slice(0, limit),
    edges: [...edges.entries()].map(([key, v]) => {
      const [from, to] = key.split("\0");
      return {
        from: from ?? "",
        to: to ?? "",
        calls: v.calls,
        errors: v.errors,
        avg_duration_ns: v.calls === 0 ? 0 : Math.round(v.dur / v.calls),
      };
    }),
  };
}

export async function searchLogs(form: LogForm, signal?: AbortSignal): Promise<LogRow[]> {
  throwIfAborted(signal);
  const limit = parseLimit(form.limit, 50);
  const rows = loadWorld()
    .logs.filter((row) => logMatchesForm(row, form, false))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
  throwIfAborted(signal);
  return rows;
}

function metricsFor(
  spans: SpanDetail[],
  startMs: number,
  endMs: number,
  windowS: number,
): ServiceMetrics[] {
  const bySvc = new Map<string, { durs: number[]; errors: number }>();
  for (const s of spans) {
    const ts = Date.parse(s.timestamp);
    if (!Number.isFinite(ts) || ts < startMs || ts >= endMs) {
      continue;
    }
    const cur = bySvc.get(s.service) ?? { durs: [], errors: 0 };
    cur.durs.push(s.duration_ns);
    if (s.status_code === 2) {
      cur.errors += 1;
    }
    bySvc.set(s.service, cur);
  }
  return [...bySvc.entries()]
    .map(([service, v]) => {
      const durs = [...v.durs].sort((a, b) => a - b);
      const spansN = v.durs.length;
      return {
        service,
        spans: spansN,
        errors: v.errors,
        rate: windowS > 0 ? spansN / windowS : 0,
        error_rate: spansN === 0 ? 0 : v.errors / spansN,
        avg_ns: spansN === 0 ? 0 : v.durs.reduce((n, d) => n + d, 0) / spansN,
        p50_ns: quantile(durs, 50),
        p95_ns: quantile(durs, 95),
        p99_ns: quantile(durs, 99),
      };
    })
    .sort((a, b) => b.spans - a.spans);
}

function emptyPoint(t: string): MetricPoint {
  return { t, spans: 0, errors: 0, rate: 0, error_rate: 0, avg_ns: 0, p50_ns: 0, p95_ns: 0, p99_ns: 0 };
}

export async function getMetrics(
  opts: { start: string; end: string; limit: string; service?: string; step?: string },
  signal?: AbortSignal,
): Promise<MetricsResponse> {
  throwIfAborted(signal);
  const startMs = Date.parse(opts.start.trim());
  const endMs = Date.parse(opts.end.trim());
  const windowS = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? (endMs - startMs) / 1000 : 0;
  const stepS = parseStepS(opts.step ?? "", windowS);
  const want = (opts.service ?? "").trim();
  const allSpans: SpanDetail[] = [];
  for (const t of loadWorld().traces) {
    for (const s of t.detail.spans) {
      if (want && s.service !== want) {
        continue;
      }
      allSpans.push(s);
    }
  }
  const cap = parseLimit(opts.limit, 50);
  const metrics = metricsFor(allSpans, startMs, endMs, windowS).slice(0, cap);
  const seriesNames = metrics.map((m) => m.service);
  const buckets = windowS > 0 && stepS > 0 ? Math.max(1, Math.ceil(windowS / stepS)) : 0;
  const series = seriesNames.map((service) => {
    const points: MetricPoint[] = [];
    for (let i = 0; i < buckets; i++) {
      const a = startMs + i * stepS * 1000;
      const b = Math.min(endMs, a + stepS * 1000);
      const slice = allSpans.filter((s) => s.service === service);
      const m = metricsFor(slice, a, b, stepS)[0];
      points.push(
        m
          ? {
              t: iso(a),
              spans: m.spans,
              errors: m.errors,
              rate: m.rate,
              error_rate: m.error_rate,
              avg_ns: m.avg_ns,
              p50_ns: m.p50_ns,
              p95_ns: m.p95_ns,
              p99_ns: m.p99_ns,
            }
          : emptyPoint(iso(a)),
      );
    }
    return { service, points };
  });
  throwIfAborted(signal);
  return { window_s: windowS, step_s: stepS, metrics, series };
}

export async function getErrorCauses(
  opts: { start: string; end: string; limit: string; service?: string },
  signal?: AbortSignal,
): Promise<ErrorCause[]> {
  throwIfAborted(signal);
  const want = (opts.service ?? "").trim();
  const counts = new Map<string, { count: number; first: number }>();
  for (const t of loadWorld().traces) {
    for (const s of t.detail.spans) {
      if (s.status_code !== 2 || !inWindow(s.timestamp, opts.start, opts.end)) {
        continue;
      }
      if (want && s.service !== want) {
        continue;
      }
      const cause = spanCause(s);
      const ts = Date.parse(s.timestamp);
      const cur = counts.get(cause) ?? { count: 0, first: ts };
      cur.count += 1;
      if (ts < cur.first) {
        cur.first = ts;
      }
      counts.set(cause, cur);
    }
  }
  const cap = Math.min(parseLimit(opts.limit, 5), 8);
  const rows: ErrorCause[] = [...counts.entries()]
    .map(([cause, v]) => ({ cause, count: v.count, first_seen: iso(v.first) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, cap);
  throwIfAborted(signal);
  return rows;
}

export async function getBuild(_signal?: AbortSignal): Promise<BuildInfo | null> {
  const version = import.meta.env.VITE_DEMO_VERSION || "demo";
  return { version, commit: "cassette" };
}
