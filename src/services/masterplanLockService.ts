/**
 * masterplanLockService.ts
 *
 * Keeps a history of the Masterplan lock (vyroba.tisk_zamcen: 1 = locked
 * automatically, 2 = by a user) in masterplan_lock_log, because Masterplan
 * itself only holds the current value. A lock by a user usually means the
 * order is being changed in ERP — and TOORS then refuses to close it
 * ("Project status is Simulated"), so we want to know when it was locked.
 *
 *  - runLockWatch: every LOCK_CHECK_INTERVAL_MS, reads the lock of every
 *    prep-queue order and every order started in the last 14 days, and logs
 *    each position whose value changed (source "poll").
 *  - checkLockOnStart: on every STARTED from PTL, logs the value at that
 *    moment (source "started") and, if locked, warns the app.
 */

import { getDb, getMasterplanDb } from "../config/database";
import type { OrderUpdate } from "./workstationService";

export const LOCK_CHECK_INTERVAL_MS = parseInt(process.env.LOCK_CHECK_INTERVAL_MS || "300000", 10);

interface Position {
    project_number: string;
    position: string;
}

// "010" and "10" are the same position.
const normPos = (p: string) => String(p ?? "").trim().replace(/^0+(?=\d)/, "");
const keyOf = (project: string, position: string) => `${String(project).trim()}::${normPos(position)}`;

export const isLockedValue = (v: number | null | undefined) => v === 1 || v === 2;

/** tisk_zamcen per "project::position"; null when empty in Masterplan. Throws if Masterplan is unreachable. */
async function fetchLockValues(positions: Position[]): Promise<Map<string, number | null>> {
    const unique = new Map(positions.map((p) => [keyOf(p.project_number, p.position), p]));
    const values = new Map<string, number | null>();
    if (unique.size === 0) return values;
    const mp = await getMasterplanDb();
    const all = [...unique.values()];
    for (let i = 0; i < all.length; i += 200) {
        const chunk = all.slice(i, i + 200);
        const rows: { zak: string; poz: string; tisk_zamcen: any }[] = await mp("vyroba")
            .where(function () {
                for (const p of chunk) this.orWhere({ zak: String(p.project_number).trim(), poz: normPos(p.position) });
            })
            .select("zak", "poz", "tisk_zamcen");
        for (const r of rows) {
            values.set(keyOf(r.zak, r.poz), r.tisk_zamcen === null || r.tisk_zamcen === undefined ? null : Number(r.tisk_zamcen));
        }
    }
    return values;
}

/** The positions whose lock value differs from the last one logged (or that were never logged). */
export function changedLocks(
    last: Map<string, number | null>,
    current: Map<string, number | null>,
): [string, number | null][] {
    return [...current].filter(([key, value]) => !last.has(key) || last.get(key) !== value);
}

async function lastLoggedValues(keys: string[]): Promise<Map<string, number | null>> {
    const db = await getDb();
    const rows: { project_number: string; position: string; tisk_zamcen: number | null }[] = await db("masterplan_lock_log")
        .distinctOn("project_number", "position")
        .whereIn(["project_number", "position"], keys.map((k) => k.split("::")))
        .orderBy([{ column: "project_number" }, { column: "position" }, { column: "id", order: "desc" }])
        .select("project_number", "position", "tisk_zamcen");
    return new Map(rows.map((r) => [keyOf(r.project_number, r.position), r.tisk_zamcen]));
}

export async function runLockWatch(): Promise<void> {
    try {
        const db = await getDb();
        const positions: Position[] = [
            ...(await db("ptl_prep_queue").distinct("project_number", "position")),
            ...(await db("cycle_timings")
                .where("started_at", ">", db.raw("now() - interval '14 days'"))
                .distinct("project_number", "position")),
        ].filter((p) => p.project_number && p.position);
        const current = await fetchLockValues(positions);
        if (current.size === 0) return;
        const changes = changedLocks(await lastLoggedValues([...current.keys()]), current);
        if (changes.length === 0) return;
        await db("masterplan_lock_log").insert(
            changes.map(([key, value]) => {
                const [project_number, position] = key.split("::");
                return { project_number, position, tisk_zamcen: value, locked: isLockedValue(value), source: "poll" };
            }),
        );
        const nowLocked = changes.filter(([, v]) => isLockedValue(v)).map(([k]) => k.replace("::", "/"));
        console.log(
            `[LOCKS] ${changes.length} lock change(s) logged` + (nowLocked.length ? ` — now locked: ${nowLocked.join(", ")}` : ""),
        );
    } catch (err: any) {
        console.error(`[LOCKS] Lock watch failed: ${err.message}`);
    }
}

/**
 * Logs the order's lock at the moment PTL started it and, when locked,
 * tells the app (socket "order-locked") so the station sees a warning.
 * Never throws — a Masterplan outage must not affect the STARTED handling.
 */
export async function checkLockOnStart(update: OrderUpdate): Promise<boolean> {
    const { order } = update;
    if (!order.projectNumber || !order.position) return false;
    try {
        const value = (await fetchLockValues([{ project_number: order.projectNumber, position: order.position }]))
            .get(keyOf(order.projectNumber, order.position)) ?? null;
        const locked = isLockedValue(value);
        const db = await getDb();
        await db("masterplan_lock_log").insert({
            project_number: String(order.projectNumber).trim(),
            position: normPos(order.position),
            tisk_zamcen: value,
            locked,
            source: "started",
            order_id: order._id,
            workplace: order.workplace,
            cycle_index: update.cycleIndex,
        });
        if (locked) {
            console.warn(
                `[LOCKS] ${order.workplace} started ${order.projectNumber}/${order.position} (PO ${order.productOrder}, ` +
                    `cycle ${update.cycleIndex}/${update.totalCycles}) while it is LOCKED in Masterplan (tisk_zamcen=${value})`,
            );
            const { io } = require("../index");
            io?.emit("order-locked", {
                orderId: order._id,
                projectNumber: order.projectNumber,
                position: order.position,
                productOrder: order.productOrder,
                workplace: order.workplace,
                cycleIndex: update.cycleIndex,
                totalCycles: update.totalCycles,
            });
        }
        return locked;
    } catch (err: any) {
        console.error(`[LOCKS] Lock check on start of ${order.projectNumber}/${order.position} failed: ${err.message}`);
        return false;
    }
}
