jest.mock("../../config/database");
jest.mock("../../services/printSettingsService");
jest.mock("axios");
jest.mock("../../services/documentPrinterService", () => ({
    ...jest.requireActual("../../services/documentPrinterService"),
    renderPdfToZplBuffer: jest.fn(async () => Buffer.from("^XA^GFA^XZ")),
}));

import axios from "axios";
import fs from "fs";
import { PDFDocument } from "pdf-lib";
import { renderPdfToZplBuffer } from "../../services/documentPrinterService";
import { buildExpeditionLabelPdf, fetchExpedition, generateExpeditionLabel, LabelRow } from "../../services/labelPrintingService";

const row = { salesOrder: "252977", position: "10", orderNumber: "Z605001" } as LabelRow;

describe("fetchExpedition", () => {
    it("asks MasterPlan by project number + position and formats the date", async () => {
        (axios.get as jest.Mock).mockResolvedValue({
            data: { ok: true, datum_expedice: "2026-11-03", cas_expedice: "09:00" },
        });
        expect(await fetchExpedition("605001", "10")).toEqual({ date: "03.11.2026", time: "09:00" });
        expect(axios.get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            params: { zak: "605001", poz: "10" },
        }));
    });

    it("returns null when not found, not planned or unreachable", async () => {
        (axios.get as jest.Mock).mockResolvedValueOnce({ data: { ok: false, error: "nenalezena" } });
        expect(await fetchExpedition("1", "10")).toBeNull();
        (axios.get as jest.Mock).mockResolvedValueOnce({ data: { ok: true, datum_expedice: "" } });
        expect(await fetchExpedition("1", "10")).toBeNull();
        (axios.get as jest.Mock).mockRejectedValueOnce(new Error("timeout"));
        expect(await fetchExpedition("1", "10")).toBeNull();
    });
});

describe("generateExpeditionLabel", () => {
    const exp = { date: "03.11.2026", time: "09:00" };

    it("EZPL: exactly the plant's template", async () => {
        const so = { salesOrder: "605737", position: "10", orderNumber: "Z605765" } as LabelRow;
        const ezpl = (await generateExpeditionLabel(so, { date: "12.11.2026", time: "13:00" }, "ezpl", 203)).toString("latin1");
        expect(ezpl).toBe([
            "^Q130,3", "^W100", "^H5", "^P1", "^S2", "^AD", "^C1", "^R0", "~Q+0", "^O0", "^D0", "^E12", "~R255", "^L",
            "AB,63,16,2,2,0,0,PLANOVANE DATUM EXPEDICE",
            "AC,40,220,5,7,0,0,12.11.2026",
            "AC,100,500,8,8,0,0,13:00",
            "Lo,40,800,755,803",
            "AC,40,850,2,2,0,0,PO 605737/Z605765, poz. 010",
            "E",
            "",
        ].join("\n"));
    });

    it("ZPL: the label PDF, rasterized like the prep label", async () => {
        let pdfPath = "";
        (renderPdfToZplBuffer as jest.Mock).mockImplementationOnce(async (p: string) => {
            pdfPath = p;
            expect((await PDFDocument.load(fs.readFileSync(p))).getPageCount()).toBe(1);
            return Buffer.from("^XA^GFA^XZ");
        });
        const zpl = await generateExpeditionLabel(row, exp, "zpl", 203);
        expect(zpl.toString()).toBe("^XA^GFA^XZ");
        expect(renderPdfToZplBuffer).toHaveBeenCalledWith(pdfPath, 203, true);
    });

    it("PDF: one 100 × 130 mm label, also without a planned time", async () => {
        const pdf = await PDFDocument.load(await buildExpeditionLabelPdf(row, { ...exp, time: "" }));
        const { width, height } = pdf.getPage(0).getSize();
        expect([Math.round(width), Math.round(height)]).toEqual([283, 369]);
    });
});
