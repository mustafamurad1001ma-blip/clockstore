import { pgTable, serial, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

// One row per store. `id` is a SHA-256 hash of the store's sync code, so the code itself is never stored.
export const storeState = pgTable("store_state", {
  id: text().primaryKey(),
  payload: jsonb().notNull(),
  version: integer().notNull().default(1),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Every change made in the app is appended here.
export const activityLog = pgTable(
  "activity_log",
  {
    id: serial().primaryKey(),
    storeId: text("store_id").notNull(),
    version: integer().notNull(),
    action: text().notNull(),
    section: text(),
    details: text(),
    actor: text(),
    device: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("activity_log_store_created_idx").on(t.storeId, t.createdAt)],
);
