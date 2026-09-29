jest.mock("../../config/database");
jest.mock("../../services/completionService", () => ({
    ...jest.requireActual("../../services/completionService"),
    recordOrderCompletion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../index", () => ({ io: { emit: jest.fn() } }));

import { Request, Response } from "express";
import { getDb, getNormsDb } from "../../config/database";
import { createManualCompletion } from "../../controllers/completionController";
import { recordOrderCompletion } from "../../services/completionService";
import { DOCUMENT_TYPES } from "../../config/documentTypes";

const HARDWARE_DOC = { id: 7, project_number: "P1", position: "10", document_type: DOCUMENT_TYPES.PBOM_HARDWARE };

function mockDb({ doc = HARDWARE_DOC as any, existing = undefined as any, salesOrder = "SO1" } = {}) {
    const db = jest.fn((table: string) => {
        const chain: any = {};
        chain.where = jest.fn(() => chain);
        chain.orderBy = jest.fn(() => chain);
        chain.select = jest.fn(() => chain);
        chain.first = jest.fn().mockResolvedValue(
            table === "documents" ? doc
            : table === "order_completion_log" ? existing
            : table === "ptl_prep_queue" ? (salesOrder ? { sales_order: salesOrder } : undefined)
            : undefined,
        );
        return chain;
    });
    (getDb as jest.Mock).mockResolvedValue(db);
    // No Norms DB in tests — the production order lookup just fails open.
    (getNormsDb as jest.Mock).mockRejectedValue(new Error("no norms db"));
}

describe("createManualCompletion", () => {
    let res: Partial<Response>;
    let json: jest.Mock;
    let status: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        json = jest.fn();
        status = jest.fn(() => res as Response);
        res = { json, status };
    });

    const call = (body: any) => createManualCompletion({ body } as Request, res as Response);
    const valid = { documentId: 7, cycleIndex: 2, totalCycles: 3, employeeName: "Jan", status: "missing_product" };

    it("never accepts plain \"complete\" (that one would close the order in TOORS)", async () => {
        mockDb();
        await call({ ...valid, status: "complete" });
        expect(status).toHaveBeenCalledWith(400);
        expect(recordOrderCompletion).not.toHaveBeenCalled();
    });

    it("records the cycle under a manual order id derived from the document when P2L never saw the order", async () => {
        mockDb();
        await call(valid);

        expect(status).toHaveBeenCalledWith(201);
        expect(recordOrderCompletion).toHaveBeenCalledWith(
            expect.objectContaining({
                orderId: "manual:P1:10:Hardware",
                workstation: "Hardware",
                cycleIndex: 2,
                totalCycles: 3,
                projectNumber: "P1",
                position: "10",
                salesOrder: "SO1",
                employeeName: "Jan",
                status: "missing_product",
            }),
        );
    });

    it("reuses the P2L order when the order partly went through P2L", async () => {
        mockDb({
            existing: { order_id: "p2l-123", sales_order: "SO9", product_order: "230018", total_cycles: 3 },
        });
        await call({ ...valid, totalCycles: undefined });

        expect(recordOrderCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ orderId: "p2l-123", salesOrder: "SO9", productOrder: "230018", totalCycles: 3 }),
        );
    });

    it("rejects a cycle outside 1..totalCycles", async () => {
        mockDb();
        await call({ ...valid, cycleIndex: 4 });
        expect(status).toHaveBeenCalledWith(400);
        expect(recordOrderCompletion).not.toHaveBeenCalled();
    });

    it("only works for Hardware/Motor BOMs", async () => {
        mockDb({ doc: { ...HARDWARE_DOC, document_type: DOCUMENT_TYPES.CUSTOMER_BOM } });
        await call(valid);
        expect(status).toHaveBeenCalledWith(400);
        expect(recordOrderCompletion).not.toHaveBeenCalled();
    });
});
