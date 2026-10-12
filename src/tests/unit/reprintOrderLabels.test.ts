jest.mock("../../config/database");
jest.mock("../../services/labelPrintingService", () => ({
    handleLabelPrinting: jest.fn().mockResolvedValue(undefined),
    getTriggerForWorkplace: jest.fn(() => "STARTED"),
}));
jest.mock("../../index", () => ({ io: { emit: jest.fn() } }));

import { Request, Response } from "express";
import { getDb } from "../../config/database";
import { reprintOrderLabels } from "../../controllers/workstationController";
import { handleLabelPrinting } from "../../services/labelPrintingService";

const snapshot = (cycle: number) => ({
    order_snapshot: JSON.stringify({ _id: "ord1", salesOrder: "604984", position: "30", workplace: "Hardware", quantity: 3 }),
    cycle_index: cycle,
    total_cycles: 3,
});

function mockStarts(rows: any[]) {
    const chain: any = {};
    chain.whereRaw = jest.fn(() => chain);
    chain.andWhereRaw = jest.fn(() => chain);
    chain.andWhere = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => chain);
    chain.select = jest.fn().mockResolvedValue(rows);
    (getDb as jest.Mock).mockResolvedValue(jest.fn(() => chain));
}

describe("reprintOrderLabels", () => {
    let json: jest.Mock;
    let status: jest.Mock;
    let res: Partial<Response>;
    beforeEach(() => {
        jest.clearAllMocks();
        json = jest.fn();
        status = jest.fn(() => res as Response);
        res = { json, status };
    });
    const call = (body: any) => reprintOrderLabels({ body } as Request, res as Response);

    it("replays every door that has started — once each, labels only (no QR sticker)", async () => {
        // newest first, door 1 started twice
        mockStarts([snapshot(2), snapshot(1), snapshot(1)]);
        await call({ salesOrder: "604984", position: "030" });

        expect(handleLabelPrinting).toHaveBeenCalledTimes(2);
        const calls = (handleLabelPrinting as jest.Mock).mock.calls;
        expect(calls.map((c) => c[0].cycleIndex)).toEqual([1, 2]);
        expect(calls[0][0]).toMatchObject({ action: "STARTED", totalCycles: 3, order: { salesOrder: "604984" } });
        expect(calls[0][1]).toEqual({ qrSticker: false });
        expect(json).toHaveBeenCalledWith({ cycles: [1, 2] });
    });

    it("404s when no door has started yet", async () => {
        mockStarts([]);
        await call({ salesOrder: "604984", position: "30" });
        expect(status).toHaveBeenCalledWith(404);
        expect(handleLabelPrinting).not.toHaveBeenCalled();
    });
});
