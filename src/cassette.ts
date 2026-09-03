/** OTLP span kind. */
export const KIND = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
} as const;

export type TapeSpan = {
  span_id: string;
  parent_span_id: string;
  service: string;
  operation: string;
  kind: number;
  start_ms: number;
  dur_ms: number;
  status_code: number;
  status_message: string;
  attrs: Record<string, string>;
  events: { at_ms: number; name: string; attrs: Record<string, string> }[];
};

export type TapeTrace = {
  /** Milliseconds before hydrate origin. */
  offset_ms: number;
  trace_id: string;
  spans: TapeSpan[];
};

export type TapeLog = {
  offset_ms: number;
  service: string;
  level: string;
  message: string;
  trace_id: string;
  span_id: string;
};

function sid(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function tid(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function sp(
  n: number,
  parent: number,
  service: string,
  operation: string,
  kind: number,
  start_ms: number,
  dur_ms: number,
  extra?: Partial<Pick<TapeSpan, "status_code" | "status_message" | "attrs" | "events">>,
): TapeSpan {
  return {
    span_id: sid(n),
    parent_span_id: parent === 0 ? "" : sid(parent),
    service,
    operation,
    kind,
    start_ms,
    dur_ms,
    status_code: extra?.status_code ?? 1,
    status_message: extra?.status_message ?? "",
    attrs: extra?.attrs ?? {},
    events: extra?.events ?? [],
  };
}

function http(method: string, path: string, status: string): Record<string, string> {
  return {
    "http.request.method": method,
    "url.path": path,
    "http.response.status_code": status,
  };
}

/** Shop cassette — same services as rasat-seed. */
export const traces: TapeTrace[] = [
  {
    offset_ms: 8_000,
    trace_id: tid(1),
    spans: [
      sp(1, 0, "web-bff", "HTTP POST /checkout", KIND.server, 0, 96, { attrs: { ...http("POST", "/checkout", "200"), "enduser.id": "u-1842" } }),
      sp(2, 1, "gateway", "HTTP POST /checkout", KIND.server, 1, 91, { attrs: http("POST", "/checkout", "200") }),
      sp(3, 2, "auth", "VerifyToken", KIND.internal, 2, 6, { attrs: { "rpc.system": "grpc", "rpc.method": "VerifyToken" } }),
      sp(4, 2, "checkout", "HTTP POST /pay", KIND.server, 10, 78, {
        attrs: { ...http("POST", "/pay", "200"), "order.id": "ord-4412" },
        events: [{ at_ms: 12, name: "checkout.step", attrs: { step: "charge" } }],
      }),
      sp(5, 4, "redis", "GetCart", KIND.client, 12, 4, { attrs: { "db.system": "redis", "db.operation": "GET" } }),
      sp(6, 4, "postgres", "QueryOrder", KIND.client, 14, 18, { attrs: { "db.system": "postgresql", "db.statement": "SELECT * FROM orders WHERE id = $1" } }),
      sp(7, 4, "inventory", "Reserve", KIND.server, 18, 22, { attrs: { "rpc.method": "Reserve" } }),
      sp(8, 7, "postgres", "UpdateStock", KIND.client, 20, 16, { attrs: { "db.system": "postgresql", "db.statement": "UPDATE stock SET qty = qty - $1 WHERE sku = $2" } }),
      sp(9, 4, "payment", "Charge", KIND.server, 22, 48, { attrs: { "rpc.method": "Charge", "payment.method": "card" } }),
      sp(10, 9, "fraud", "Score", KIND.client, 24, 14, { attrs: { "rpc.system": "grpc", "rpc.method": "Score" } }),
      sp(11, 9, "postgres", "InsertPayment", KIND.client, 40, 15, { attrs: { "db.system": "postgresql", "db.statement": "INSERT INTO payments (order_id, amount) VALUES ($1, $2)" } }),
      sp(12, 4, "checkout", "publish orders.confirmed", KIND.producer, 72, 6, {
        attrs: { "messaging.system": "kafka", "messaging.destination": "orders.confirmed", "messaging.operation": "publish" },
      }),
      sp(13, 12, "kafka", "append orders.confirmed", KIND.internal, 73, 4, {
        attrs: { "messaging.system": "kafka", "messaging.destination": "orders.confirmed" },
      }),
    ],
  },
  {
    offset_ms: 14_000,
    trace_id: tid(2),
    spans: [
      sp(1, 0, "web-bff", "HTTP POST /checkout", KIND.server, 0, 64, {
        status_code: 2,
        status_message: "payment declined",
        attrs: http("POST", "/checkout", "402"),
      }),
      sp(2, 1, "gateway", "HTTP POST /checkout", KIND.server, 1, 59, {
        status_code: 2,
        status_message: "payment declined",
        attrs: http("POST", "/checkout", "402"),
      }),
      sp(3, 2, "auth", "VerifyToken", KIND.internal, 2, 5, { attrs: { "rpc.method": "VerifyToken" } }),
      sp(4, 2, "checkout", "HTTP POST /pay", KIND.server, 9, 47, {
        status_code: 2,
        status_message: "card declined",
        attrs: { ...http("POST", "/pay", "402"), "order.id": "ord-fail" },
      }),
      sp(5, 4, "redis", "GetCart", KIND.client, 11, 3, { attrs: { "db.system": "redis", "db.operation": "GET" } }),
      sp(6, 4, "payment", "Charge", KIND.server, 16, 32, {
        status_code: 2,
        status_message: "insufficient funds",
        attrs: { "rpc.method": "Charge", "http.status_code": "402" },
        events: [
          {
            at_ms: 40,
            name: "exception",
            attrs: { "exception.type": "CardDeclined", "exception.message": "insufficient funds" },
          },
        ],
      }),
      sp(7, 6, "fraud", "Score", KIND.client, 18, 10, { attrs: { "rpc.method": "Score" } }),
    ],
  },
  {
    offset_ms: 22_000,
    trace_id: tid(3),
    spans: [
      sp(1, 0, "web-bff", "HTTP POST /checkout", KIND.server, 0, 520, { attrs: http("POST", "/checkout", "200") }),
      sp(2, 1, "gateway", "HTTP POST /checkout", KIND.server, 1, 509, { attrs: http("POST", "/checkout", "200") }),
      sp(3, 2, "checkout", "HTTP POST /pay", KIND.server, 4, 496, { attrs: http("POST", "/pay", "200") }),
      sp(4, 3, "postgres", "QueryOrder", KIND.client, 8, 422, {
        attrs: {
          "db.system": "postgresql",
          "db.statement": "SELECT * FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.id = $1",
        },
        events: [{ at_ms: 200, name: "db.query.plan", attrs: { hint: "seq scan" } }],
      }),
    ],
  },
  {
    offset_ms: 31_000,
    trace_id: tid(4),
    spans: [
      sp(1, 0, "web-bff", "HTTP GET /products", KIND.server, 0, 42, { attrs: http("GET", "/products", "200") }),
      sp(2, 1, "gateway", "HTTP GET /products", KIND.server, 1, 37, { attrs: http("GET", "/products", "200") }),
      sp(3, 2, "catalog", "ListProducts", KIND.internal, 3, 31, { attrs: { "rpc.system": "grpc", "rpc.method": "ListProducts" } }),
      sp(4, 3, "redis", "GET products:home", KIND.client, 4, 4, {
        attrs: { "db.system": "redis", "db.operation": "GET" },
        events: [{ at_ms: 6, name: "cache.hit", attrs: { "cache.key": "products:home" } }],
      }),
    ],
  },
  {
    offset_ms: 45_000,
    trace_id: tid(5),
    spans: [
      sp(1, 0, "web-bff", "HTTP GET /search", KIND.server, 0, 188, {
        attrs: { ...http("GET", "/search", "200"), "url.query": "q=linen shirt" },
      }),
      sp(2, 1, "gateway", "HTTP GET /search", KIND.server, 1, 184, { attrs: http("GET", "/search", "200") }),
      sp(3, 2, "search", "SearchProducts", KIND.internal, 3, 179, { attrs: { "rpc.method": "SearchProducts", "search.query": "linen shirt" } }),
      sp(4, 3, "elasticsearch", "POST /products/_search", KIND.client, 5, 175, {
        attrs: { "db.system": "elasticsearch", "db.operation": "search" },
      }),
    ],
  },
  {
    offset_ms: 58_000,
    trace_id: tid(6),
    spans: [
      sp(1, 0, "web-bff", "HTTP POST /login", KIND.server, 0, 55, { attrs: http("POST", "/login", "200") }),
      sp(2, 1, "gateway", "HTTP POST /login", KIND.server, 1, 49, { attrs: http("POST", "/login", "200") }),
      sp(3, 2, "auth", "Login", KIND.internal, 3, 43, { attrs: { "rpc.system": "grpc", "rpc.method": "Login", "enduser.id": "u-1842" } }),
      sp(4, 3, "postgres", "LookupUser", KIND.client, 5, 17, { attrs: { "db.system": "postgresql", "db.statement": "SELECT id, hash FROM users WHERE email = $1" } }),
      sp(5, 3, "redis", "SET session", KIND.client, 24, 6, { attrs: { "db.system": "redis", "db.operation": "SET" } }),
    ],
  },
  {
    offset_ms: 72_000,
    trace_id: tid(7),
    spans: [
      sp(1, 0, "web-bff", "HTTP POST /checkout", KIND.server, 0, 28, {
        status_code: 2,
        status_message: "unauthorized",
        attrs: http("POST", "/checkout", "401"),
      }),
      sp(2, 1, "gateway", "HTTP POST /checkout", KIND.server, 1, 23, {
        status_code: 2,
        status_message: "unauthorized",
        attrs: http("POST", "/checkout", "401"),
      }),
      sp(3, 2, "auth", "VerifyToken", KIND.internal, 2, 16, {
        status_code: 2,
        status_message: "token expired",
        attrs: { "rpc.system": "grpc", "rpc.method": "VerifyToken" },
        events: [
          {
            at_ms: 12,
            name: "exception",
            attrs: { "exception.type": "AuthError", "exception.message": "token expired" },
          },
        ],
      }),
    ],
  },
  {
    offset_ms: 90_000,
    trace_id: tid(8),
    spans: [
      sp(1, 0, "web-bff", "HTTP GET /home", KIND.server, 0, 48, { attrs: http("GET", "/home", "200") }),
      sp(2, 1, "gateway", "HTTP GET /home", KIND.server, 1, 43, { attrs: http("GET", "/home", "200") }),
      sp(3, 2, "auth", "Session", KIND.internal, 2, 7, { attrs: { "rpc.method": "Session" } }),
      sp(4, 2, "catalog", "ListProducts", KIND.internal, 2, 20, { attrs: { "rpc.method": "ListProducts" } }),
      sp(5, 2, "cart", "GetCart", KIND.internal, 3, 11, { attrs: { "rpc.method": "GetCart" } }),
      sp(6, 2, "search", "Popular", KIND.internal, 3, 27, { attrs: { "rpc.method": "Popular" } }),
    ],
  },
  {
    offset_ms: 140_000,
    trace_id: tid(9),
    spans: [
      sp(1, 0, "web-bff", "HTTP POST /cart", KIND.server, 0, 36, { attrs: { ...http("POST", "/cart", "200"), "enduser.id": "u-1842" } }),
      sp(2, 1, "gateway", "HTTP POST /cart", KIND.server, 1, 31, { attrs: http("POST", "/cart", "200") }),
      sp(3, 2, "cart", "AddItem", KIND.internal, 3, 25, { attrs: { "rpc.method": "AddItem", "product.id": "sku-2291" } }),
      sp(4, 3, "redis", "HSET cart", KIND.client, 4, 5, { attrs: { "db.system": "redis", "db.operation": "HSET" } }),
      sp(5, 3, "postgres", "InsertCartItem", KIND.client, 10, 12, {
        attrs: { "db.system": "postgresql", "db.statement": "INSERT INTO cart_items (cart_id, sku, qty) VALUES ($1, $2, $3)" },
      }),
    ],
  },
  {
    offset_ms: 400_000,
    trace_id: tid(10),
    spans: [
      sp(1, 0, "web-bff", "HTTP GET /products", KIND.server, 0, 48, { attrs: http("GET", "/products", "200") }),
      sp(2, 1, "gateway", "HTTP GET /products", KIND.server, 1, 43, { attrs: http("GET", "/products", "200") }),
      sp(3, 2, "catalog", "ListProducts", KIND.internal, 3, 37, { attrs: { "rpc.method": "ListProducts" } }),
      sp(4, 3, "redis", "GET products:home", KIND.client, 4, 1, {
        attrs: { "db.system": "redis", "db.operation": "GET" },
        events: [{ at_ms: 4, name: "cache.miss", attrs: { "cache.key": "products:home" } }],
      }),
      sp(5, 3, "postgres", "SELECT products", KIND.client, 9, 19, {
        attrs: {
          "db.system": "postgresql",
          "db.name": "shop",
          "db.statement": "SELECT id, name, price FROM products WHERE featured = true LIMIT 24",
        },
      }),
    ],
  },
];

export const logs: TapeLog[] = [
  { offset_ms: 8_200, service: "checkout", level: "INFO", message: "order confirmed", trace_id: tid(1), span_id: sid(4) },
  { offset_ms: 8_400, service: "payment", level: "INFO", message: "charge succeeded", trace_id: tid(1), span_id: sid(9) },
  { offset_ms: 14_200, service: "payment", level: "ERROR", message: "insufficient funds", trace_id: tid(2), span_id: sid(6) },
  { offset_ms: 14_400, service: "web-bff", level: "WARN", message: "checkout returned 402", trace_id: tid(2), span_id: sid(1) },
  { offset_ms: 22_500, service: "postgres", level: "WARN", message: "slow query seq scan", trace_id: tid(3), span_id: sid(4) },
  { offset_ms: 31_100, service: "catalog", level: "INFO", message: "listed featured products", trace_id: tid(4), span_id: sid(3) },
  { offset_ms: 45_200, service: "search", level: "INFO", message: "query linen shirt", trace_id: tid(5), span_id: sid(3) },
  { offset_ms: 58_100, service: "auth", level: "INFO", message: "login u-1842", trace_id: tid(6), span_id: sid(3) },
  { offset_ms: 72_100, service: "auth", level: "ERROR", message: "token expired", trace_id: tid(7), span_id: sid(3) },
  { offset_ms: 90_200, service: "web-bff", level: "INFO", message: "home assembled", trace_id: tid(8), span_id: sid(1) },
  { offset_ms: 140_200, service: "cart", level: "INFO", message: "added sku-2291", trace_id: tid(9), span_id: sid(3) },
  { offset_ms: 400_200, service: "postgres", level: "INFO", message: "featured products from db", trace_id: tid(10), span_id: sid(5) },
];
