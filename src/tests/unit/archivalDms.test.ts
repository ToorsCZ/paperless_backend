process.env.ARCHIVE_SHARE_PATH = "/tmp/test-archive-share";
// Old name of ARCHIVE_DMS_PATH — still honoured, so existing .env files keep working.
process.env.ARCHIVE_GUARDY_PATH = "/tmp/test-dms-scan";

jest.mock("../../config/database");
jest.mock("axios");
jest.mock("../../services/pdfaService", () => ({
    convertToPdfA: jest.fn(),
    PdfaConversionError: class PdfaConversionError extends Error {},
}));
jest.mock("../../services/workstationService", () => ({ DOC_MANAGER_URL: "http://doc-manager.test" }));
jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return {
        ...actual,
        writeFileSync: jest.fn(),
        copyFileSync: jest.fn(),
        unlink: jest.fn((_path: string, cb: (err: any) => void) => cb(null)),
    };
});

import path from "path";
import fs from "fs";
import axios from "axios";
import { getDb } from "../../config/database";
import { convertToPdfA } from "../../services/pdfaService";
import { runArchivalSweep } from "../../services/archivalService";

const thenable = <T>(value: T) => ({ then: (resolve: (v: T) => void) => resolve(value) });
function chainableEmpty() {
    const chain: any = {};
    chain.where = () => chain;
    chain.whereIn = () => chain;
    chain.orderBy = () => chain;
    chain.select = () => thenable([]);
    return chain;
}

it("archives every order (Indy and Motor too) flat into the DMS scan folder, copying in only finished PDFs", async () => {
    const row = {
        id: 9,
        order_id: "order-9",
        project_number: "P9",
        position: "20",
        sales_order: "SO9",
        finished_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        attempts: 0,
    };
    const db = Object.assign(
        jest.fn((table: string) => {
            if (table === "order_archive_log") {
                return {
                    whereNull: () => ({ andWhere: () => ({ andWhere: () => ({ orderBy: () => thenable([row]) }) }) }),
                    where: () => ({ update: jest.fn(() => thenable(undefined)) }),
                };
            }
            if (table === "workstation_log") {
                return {
                    distinct: () => ({
                        where: () => thenable([{ workstation_name: "Hardware" }, { workstation_name: "Motor" }]),
                    }),
                };
            }
            return chainableEmpty();
        }),
        { fn: { now: () => "NOW()" } },
    );
    (getDb as jest.Mock).mockResolvedValue(db);
    (axios.get as jest.Mock).mockResolvedValue({
        status: 200,
        headers: { "content-disposition": 'attachment; filename="doc.pdf"' },
        data: Buffer.from("%PDF-fake"),
    });
    (convertToPdfA as jest.Mock).mockResolvedValue(undefined);

    await runArchivalSweep();

    const dms = (name: string) => path.join("/tmp/test-dms-scan", name);
    expect((fs.copyFileSync as jest.Mock).mock.calls.map((c) => c[1]).sort()).toEqual([
        dms("SVM_SO9_020.pdf"),
        dms("SVM_SO9_021.pdf"),
    ]);
    // Built elsewhere first, never written straight into the scanned folder.
    for (const call of (convertToPdfA as jest.Mock).mock.calls) expect(call[1]).not.toContain("test-dms-scan");
});
