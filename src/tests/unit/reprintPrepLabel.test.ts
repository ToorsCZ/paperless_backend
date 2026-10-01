jest.mock("../../config/database");
jest.mock("../../services/documentPrinterService");
jest.mock("../../services/completionService", () => ({
    ...jest.requireActual("../../services/completionService"),
    recordOrderPreparation: jest.fn(),
}));
jest.mock("../../index", () => ({ io: { emit: jest.fn() } }));

import { Request, Response } from "express";
import { getDb, getNormsDb } from "../../config/database";
import { reprintPrepLabel } from "../../controllers/completionController";
import { buildPrepLabelPdf, printPrepLabelBuffer } from "../../services/documentPrinterService";
import { recordOrderPreparation } from "../../services/completionService";

const PRINTED_AT = "2026-10-01T06:05:00.000Z";
const ORIGINAL = { employee_name: "Jan Novak", total_cycles: 20, created_at: PRINTED_AT };

function mockDb(original: any = ORIGINAL) {
    const db = jest.fn((table: string) => {
        const chain: any = {};
        chain.where = jest.fn(() => chain);
        chain.orderBy = jest.fn(() => chain);
        chain.select = jest.fn(() => chain);
        chain.first = jest.fn().mockResolvedValue(table === "order_preparation_log" ? original : undefined);
        return chain;
    });
    (getDb as jest.Mock).mockResolvedValue(db);
    (getNormsDb as jest.Mock).mockRejectedValue(new Error("no norms db"));
}

describe("reprintPrepLabel", () => {
    let res: Partial<Response>;
    let json: jest.Mock;
    let status: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        json = jest.fn();
        status = jest.fn(() => res as Response);
        res = { json, status, send: jest.fn(), setHeader: jest.fn() };
        (buildPrepLabelPdf as jest.Mock).mockReturnValue(Buffer.from("%PDF-fake"));
        (printPrepLabelBuffer as jest.Mock).mockResolvedValue(true);
    });

    const call = (body: any) => reprintPrepLabel({ body } as Request, res as Response);

    it("reprints only the chosen doors as the original label, without logging a new preparation", async () => {
        mockDb();
        await call({ projectNumber: "P1", position: "10", cycles: [17, 3, 3] });

        expect(buildPrepLabelPdf).toHaveBeenCalledWith("P1", "10", "Jan Novak", 20, null, null, {
            cycles: [3, 17],
            printedAt: new Date(PRINTED_AT),
        });
        expect(json).toHaveBeenCalledWith({ success: true });
        expect(recordOrderPreparation).not.toHaveBeenCalled();
    });

    it("rejects doors outside the order", async () => {
        mockDb();
        await call({ projectNumber: "P1", position: "10", cycles: [0, 21] });
        expect(status).toHaveBeenCalledWith(400);
        expect(buildPrepLabelPdf).not.toHaveBeenCalled();
    });

    it("404s when no label was printed yet", async () => {
        mockDb(null);
        await call({ projectNumber: "P1", position: "10", cycles: [1] });
        expect(status).toHaveBeenCalledWith(404);
    });
});
