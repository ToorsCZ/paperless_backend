jest.mock("../../config/database");

import { getDb } from "../../config/database";
import { getOrderHistory } from "../../services/orderHistoryService";
import { wrapText } from "../../services/archivalService";

function mockTables(tables: Record<string, any[]>) {
    const db = jest.fn((table: string) => {
        const chain: any = {};
        chain.where = jest.fn(() => chain);
        chain.select = jest.fn().mockResolvedValue(tables[table] ?? []);
        return chain;
    });
    (getDb as jest.Mock).mockResolvedValue(db);
    return db;
}

describe("getOrderHistory", () => {
    it("merges every round of checks and QC, oldest first, with notes", async () => {
        mockTables({
            order_preparation_log: [{ cycle_index: 1, employee_name: "Petr", created_at: "2026-09-20T07:00:00Z" }],
            order_completion_log: [
                { cycle_index: 1, employee_name: "Iveta", status: "missing_product", created_at: "2026-09-20T09:00:00Z" },
            ],
            order_cycle_checks: [
                // second check round (after QC found a problem) comes back first from the DB
                { cycle_index: 1, employee_name: "Eva", status: "ok", note: "doplněno", workstation: "Hardware", created_at: "2026-09-20T12:00:00Z" },
                { cycle_index: 1, employee_name: "Eva", status: "ok", note: null, workstation: "Hardware", created_at: "2026-09-20T10:00:00Z" },
            ],
            order_qc_checks: [
                { cycle_index: 1, engineer_name: "Marie", status: "issue", note: "chybí konzole", created_at: "2026-09-20T11:00:00Z" },
                { cycle_index: 1, engineer_name: "Marie", status: "ok", note: null, created_at: "2026-09-20T13:00:00Z" },
            ],
        });

        const history = await getOrderHistory("P1", "10", "Hardware");

        expect(history.map((e) => `${e.type}:${e.by}:${e.status}`)).toEqual([
            "prepared:Petr:null",
            "completed:Iveta:missing_product",
            "check:Eva:ok",
            "qc:Marie:issue",
            "check:Eva:ok",
            "qc:Marie:ok",
        ]);
        expect(history[3]!.note).toBe("chybí konzole");
    });

    it("includes legacy checks without a workstation, but not another workstation's checks", async () => {
        mockTables({
            order_cycle_checks: [
                { cycle_index: 1, employee_name: "Old", status: "ok", workstation: null, created_at: "2026-01-01T08:00:00Z" },
                { cycle_index: 1, employee_name: "Motor guy", status: "ok", workstation: "Motor", created_at: "2026-01-01T09:00:00Z" },
            ],
        });

        const history = await getOrderHistory("P1", "10", "Hardware");

        expect(history.map((e) => e.by)).toEqual(["Old"]);
    });
});

describe("wrapText", () => {
    it("wraps on spaces and never loses text", () => {
        const lines = wrapText("chybí konzole vlevo a šrouby M8 v sáčku", 15);
        expect(lines.every((l) => l.length <= 15)).toBe(true);
        expect(lines.join(" ")).toBe("chybí konzole vlevo a šrouby M8 v sáčku");
    });

    it("hard-splits a single word longer than a line, and keeps line breaks", () => {
        expect(wrapText("ABCDEFGHIJ\nxy", 4)).toEqual(["ABCD", "EFGH", "IJ", "xy"]);
    });
});
