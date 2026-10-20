jest.mock("../../config/database");
jest.mock("../../services/labelPrintingService", () => ({
    handleLabelPrinting: jest.fn().mockResolvedValue(undefined),
    getTriggerForWorkplace: jest.fn(() => "STARTED"),
}));
jest.mock("../../index", () => ({ io: { emit: jest.fn() } }));

import { Request, Response } from "express";
import { getDb } from "../../config/database";
import { getOrderLabelStatus, reprintOrderLabels } from "../../controllers/workstationController";
import { handleLabelPrinting } from "../../services/labelPrintingService";

const start = (cycle: number) => ({
    order_snapshot: JSON.stringify({ _id: "ord1", salesOrder: "604984", position: "30", workplace: "Hardware", quantity: 3 }),
    cycle_index: cycle,
    total_cycles: 3,
    created_at: "2026-10-12T11:36:44Z",
});

// workstation_log → `starts` (newest first); label_print_log → `printedPerCycle`
// rows per door, plus `extra` more after a reprint (what got printed).
function mockDb(starts: any[], printedPerCycle: Record<number, number> = {}, extra = 0) {
    let reprinted = false;
    (handleLabelPrinting as jest.Mock).mockImplementation(async () => {
        reprinted = true;
    });
    const db = jest.fn((table: string) => {
        const chain: any = {};
        let cycle = 0;
        chain.whereRaw = jest.fn(() => chain);
        chain.andWhereRaw = jest.fn(() => chain);
        chain.andWhere = jest.fn(() => chain);
        chain.orderBy = jest.fn(() => chain);
        chain.select = jest.fn().mockResolvedValue(starts);
        chain.where = jest.fn((w: any) => ((cycle = w.cycle_index), chain));
        chain.count = jest.fn(() => chain);
        chain.max = jest.fn(() => chain);
        chain.first = jest.fn(async () => ({
            n: String((printedPerCycle[cycle] ?? 0) + (reprinted ? extra : 0)),
            last: null,
        }));
        return table === "workstation_log" || table === "label_print_log" ? chain : {};
    });
    (getDb as jest.Mock).mockResolvedValue(db);
}

describe("label reprint (admin)", () => {
    let json: jest.Mock;
    let status: jest.Mock;
    let res: Partial<Response>;
    beforeEach(() => {
        jest.clearAllMocks();
        json = jest.fn();
        status = jest.fn(() => res as Response);
        res = { json, status };
    });
    const reprint = (body: any) => reprintOrderLabels({ body } as Request, res as Response);

    it("lists the doors that started, with how many labels each printed", async () => {
        mockDb([start(2), start(1), start(1)], { 1: 5, 2: 0 });
        await getOrderLabelStatus({ query: { salesOrder: "604984", position: "030" } } as any, res as Response);
        expect(json).toHaveBeenCalledWith({
            doors: [
                expect.objectContaining({ cycle: 1, totalCycles: 3, printed: 5 }),
                expect.objectContaining({ cycle: 2, totalCycles: 3, printed: 0 }),
            ],
        });
    });

    it("by default replays every started door once, missing labels only, never the QR sticker", async () => {
        mockDb([start(2), start(1), start(1)]);
        await reprint({ salesOrder: "604984", position: "030" });
        const calls = (handleLabelPrinting as jest.Mock).mock.calls;
        expect(calls.map((c) => c[0].cycleIndex)).toEqual([1, 2]);
        expect(calls[0][0]).toMatchObject({ action: "STARTED", totalCycles: 3, order: { salesOrder: "604984" } });
        expect(calls[0][1]).toEqual({ qrSticker: false, force: false });
    });

    it("force + cycles prints everything again for just the chosen doors, and says how many", async () => {
        mockDb([start(2), start(1)], { 1: 5, 2: 5 }, 5);
        await reprint({ salesOrder: "604984", position: "030", force: true, cycles: [2] });
        const calls = (handleLabelPrinting as jest.Mock).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0][0].cycleIndex).toBe(2);
        expect(calls[0][1]).toEqual({ qrSticker: false, force: true });
        expect(json).toHaveBeenCalledWith({ results: [{ cycle: 2, printed: 5 }] });
    });

    it("404s when no door has started yet", async () => {
        mockDb([]);
        await reprint({ salesOrder: "604984", position: "30" });
        expect(status).toHaveBeenCalledWith(404);
        expect(handleLabelPrinting).not.toHaveBeenCalled();
    });
});

describe("label reprint (admin) — Motor", () => {
    let json: jest.Mock;
    let status: jest.Mock;
    let res: Partial<Response>;
    beforeEach(() => {
        jest.clearAllMocks();
        json = jest.fn();
        status = jest.fn(() => res as Response);
        res = { json, status };
    });
    const motorStart = (cycle: number) => ({
        ...start(cycle),
        order_snapshot: JSON.stringify({ _id: "mot1", salesOrder: "604984", position: "30", workplace: "Motor", quantity: 3, maxCycle: 2 }),
    });

    it("replays Motor starts too, so a Motor batch's labels can be printed again", async () => {
        mockDb([motorStart(2), motorStart(1)], { 1: 4, 2: 2 }, 4);
        await reprintOrderLabels({ body: { salesOrder: "604984", position: "030", workplace: "Motor", force: true, cycles: [1] } } as Request, res as Response);
        const calls = (handleLabelPrinting as jest.Mock).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toMatchObject({ cycleIndex: 1, order: { workplace: "Motor", maxCycle: 2 } });
        expect(calls[0][1]).toEqual({ qrSticker: false, force: true });
    });

    it("refuses any other workplace", async () => {
        mockDb([start(1)]);
        await reprintOrderLabels({ body: { salesOrder: "604984", position: "30", workplace: "PredHridel" } } as Request, res as Response);
        expect(status).toHaveBeenCalledWith(400);
        expect(handleLabelPrinting).not.toHaveBeenCalled();
    });
});
