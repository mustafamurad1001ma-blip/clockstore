import type { Config } from "@netlify/server";
import { createHash } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { activityLog, storeState } from "../../db/schema.js";

export const config: Config = {
  path: "/api/*",
  region: "fra",
};

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_ACTIONS = 100;

type IncomingAction = { action?: unknown; section?: unknown; details?: unknown; actor?: unknown; at?: unknown };

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

const clip = (value: unknown, max: number): string | null => {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
};

// The sync code is never stored; rows are keyed by its salted hash.
function storeIdFrom(req: Request): string | null {
  const code = (req.headers.get("x-store-code") || "").trim();
  if (code.length < 6 || code.length > 128) return null;
  return createHash("sha256").update("clockstore-sync:" + code).digest("hex");
}

function cleanActions(raw: unknown, fallbackActor: string | null, device: string | null) {
  if (!Array.isArray(raw)) return [];
  return (raw as IncomingAction[]).slice(0, MAX_ACTIONS).flatMap((a) => {
    const action = clip(a?.action, 300);
    if (!action) return [];
    // Actions queued offline keep the time they actually happened (bounded to the last 30 days).
    const at = typeof a?.at === "string" ? new Date(a.at) : null;
    const now = Date.now();
    const createdAt = at && !isNaN(at.getTime()) && at.getTime() <= now + 60_000 && at.getTime() > now - 30 * 864e5 ? at : new Date();
    return [{
      action,
      section: clip(a?.section, 80),
      details: clip(a?.details, 2000),
      actor: clip(a?.actor, 120) ?? fallbackActor,
      device,
      createdAt,
    }];
  });
}

async function readBody(req: Request): Promise<any> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY_BYTES) throw Object.assign(new Error("Payload too large"), { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw Object.assign(new Error("Payload too large"), { status: 413 });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

async function getState(storeId: string, since: number) {
  const [row] = await db
    .select({ version: storeState.version, updatedAt: storeState.updatedAt, updatedBy: storeState.updatedBy })
    .from(storeState)
    .where(eq(storeState.id, storeId));
  if (!row) return { version: 0, payload: null };
  if (row.version <= since) return { ...row, payload: null };
  const [full] = await db.select({ payload: storeState.payload }).from(storeState).where(eq(storeState.id, storeId));
  return { ...row, payload: full?.payload ?? null };
}

async function putState(storeId: string, body: any) {
  if (!body || typeof body.payload !== "object" || body.payload === null || Array.isArray(body.payload)) {
    throw Object.assign(new Error("payload must be an object"), { status: 400 });
  }
  const device = clip(body.device, 120);
  const actor = clip(body.actor, 120);
  const now = new Date();
  const returning = { version: storeState.version, updatedAt: storeState.updatedAt };
  const force = body.force === true;
  const base = Number.isInteger(body.baseVersion) ? (body.baseVersion as number) : null;
  let row: { version: number; updatedAt: Date } | undefined;

  if (force || base === null) {
    [row] = await db
      .insert(storeState)
      .values({ id: storeId, payload: body.payload, version: 1, updatedBy: device, updatedAt: now })
      .onConflictDoUpdate({
        target: storeState.id,
        set: { payload: body.payload, version: sql`${storeState.version} + 1`, updatedBy: device, updatedAt: now },
      })
      .returning(returning);
  } else if (base === 0) {
    [row] = await db
      .insert(storeState)
      .values({ id: storeId, payload: body.payload, version: 1, updatedBy: device, updatedAt: now })
      .onConflictDoNothing()
      .returning(returning);
  } else {
    // Optimistic concurrency: only write if nobody else saved since the client's last sync.
    [row] = await db
      .update(storeState)
      .set({ payload: body.payload, version: sql`${storeState.version} + 1`, updatedBy: device, updatedAt: now })
      .where(and(eq(storeState.id, storeId), eq(storeState.version, base)))
      .returning(returning);
  }

  if (!row) {
    const current = await getState(storeId, -1);
    throw Object.assign(new Error("conflict"), { status: 409, current });
  }

  const actions = cleanActions(body.actions, actor, device);
  if (actions.length) {
    await db.insert(activityLog).values(actions.map((a) => ({ ...a, storeId, version: row.version })));
  }
  return { version: row.version, updatedAt: row.updatedAt, logged: actions.length };
}

async function addLog(storeId: string, body: any) {
  const device = clip(body?.device, 120);
  const actor = clip(body?.actor, 120);
  const actions = cleanActions(body?.actions, actor, device);
  if (!actions.length) return { logged: 0 };
  const [row] = await db.select({ version: storeState.version }).from(storeState).where(eq(storeState.id, storeId));
  await db.insert(activityLog).values(actions.map((a) => ({ ...a, storeId, version: row?.version ?? 0 })));
  return { logged: actions.length };
}

async function getLog(storeId: string, url: URL) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 500);
  const before = Number(url.searchParams.get("before")) || 0;
  const where = before
    ? and(eq(activityLog.storeId, storeId), lt(activityLog.id, before))
    : eq(activityLog.storeId, storeId);
  const entries = await db
    .select({
      id: activityLog.id,
      version: activityLog.version,
      action: activityLog.action,
      section: activityLog.section,
      details: activityLog.details,
      actor: activityLog.actor,
      device: activityLog.device,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(where)
    .orderBy(desc(activityLog.id))
    .limit(limit);
  return { entries };
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "");

  if (!route.startsWith("/api/sync/")) return json({ error: "Not found" }, 404);

  const storeId = storeIdFrom(req);
  if (!storeId) return json({ error: "A sync code of 6-128 characters is required" }, 401);

  try {
    if (route === "/api/sync/state" && req.method === "GET") {
      return json(await getState(storeId, Number(url.searchParams.get("since")) || 0));
    }
    if (route === "/api/sync/state" && req.method === "PUT") {
      return json(await putState(storeId, await readBody(req)));
    }
    if (route === "/api/sync/log" && req.method === "GET") {
      return json(await getLog(storeId, url));
    }
    if (route === "/api/sync/log" && req.method === "POST") {
      return json(await addLog(storeId, await readBody(req)));
    }
    return json({ error: "Not found" }, 404);
  } catch (err: any) {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status === 500) console.error("sync api error", err);
    if (status === 409) return json({ error: "conflict", current: err.current }, 409);
    return json({ error: status === 500 ? "Server error" : err.message }, status);
  }
};
