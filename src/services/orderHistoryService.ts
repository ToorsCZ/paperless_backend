/**
 * The full, chronological history of an order position at one workstation:
 * who prepared each cycle, who completed it (and with which status), and
 * EVERY standard check and quality-control sign-off — not just the latest
 * one. Checks can go round several times (check → QC finds a problem → fix
 * → check again → QC again …); each round is its own row in
 * order_cycle_checks / order_qc_checks, so nothing is ever lost, and this
 * puts them back in order. Used by the document viewer (both check modals)
 * and the archived "Výrobní záznam" page.
 */

import { getDb } from "../config/database";

export type OrderHistoryEventType = "prepared" | "completed" | "check" | "qc";

export interface OrderHistoryEvent {
    cycleIndex: number;
    type: OrderHistoryEventType;
    by: string;
    /** completion status for "completed"; "ok" | "issue" for check/qc; null for "prepared" */
    status: string | null;
    note: string | null;
    at: string;
}

const toIso = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value ?? "");

export async function getOrderHistory(
    projectNumber: string,
    position: string,
    workstation: string,
): Promise<OrderHistoryEvent[]> {
    const db = await getDb();

    const [prepRows, completionRows, checkRows, qcRows] = await Promise.all([
        // No workstation column — preparation is shared per position.
        db("order_preparation_log")
            .where({ project_number: projectNumber, position })
            .select("cycle_index", "employee_name", "created_at"),
        db("order_completion_log")
            .where({ project_number: projectNumber, position, workstation })
            .select("cycle_index", "employee_name", "status", "created_at"),
        // Rows recorded before order_cycle_checks had a workstation column
        // are NULL there and apply to any workstation (same rule as
        // filesController.getCheckStatusForPositions).
        db("order_cycle_checks")
            .where({ project_number: projectNumber, position })
            .select("cycle_index", "employee_name", "status", "note", "workstation", "created_at"),
        db("order_qc_checks")
            .where({ project_number: projectNumber, position, workstation })
            .select("cycle_index", "engineer_name", "status", "note", "created_at"),
    ]);

    const events: OrderHistoryEvent[] = [
        ...(prepRows as any[]).map((r) => ({
            cycleIndex: r.cycle_index ?? 1,
            type: "prepared" as const,
            by: r.employee_name,
            status: null,
            note: null,
            at: toIso(r.created_at),
        })),
        ...(completionRows as any[]).map((r) => ({
            cycleIndex: r.cycle_index ?? 1,
            type: "completed" as const,
            by: r.employee_name,
            status: r.status,
            note: null,
            at: toIso(r.created_at),
        })),
        ...(checkRows as any[])
            .filter((r) => !r.workstation || r.workstation === workstation)
            .map((r) => ({
                cycleIndex: r.cycle_index ?? 1,
                type: "check" as const,
                by: r.employee_name,
                status: r.status,
                note: r.note || null,
                at: toIso(r.created_at),
            })),
        ...(qcRows as any[]).map((r) => ({
            cycleIndex: r.cycle_index ?? 1,
            type: "qc" as const,
            by: r.engineer_name,
            status: r.status,
            note: r.note || null,
            at: toIso(r.created_at),
        })),
    ];

    // Oldest first — reads as a log. Same timestamp: keep the natural
    // order prepared → completed → check → qc.
    const typeOrder: Record<OrderHistoryEventType, number> = { prepared: 0, completed: 1, check: 2, qc: 3 };
    return events.sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at) || typeOrder[a.type] - typeOrder[b.type],
    );
}
