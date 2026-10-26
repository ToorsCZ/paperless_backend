process.env.DOCUMENTS_PRINTER_DUPLEX = "true"; // as on the server
jest.mock("../../config/database");

import { documentsPrinterGsArgs } from "../../services/documentPrinterService";

describe("documentsPrinterGsArgs — documentation on A4", () => {
    it("puts every page on A4, rotated/scaled to fit (no cut-off, no 'load other paper')", () => {
        const args = documentsPrinterGsArgs("doc.pdf");
        expect(args).toEqual(expect.arrayContaining(["-sPAPERSIZE=a4", "-dFIXEDMEDIA", "-dPDFFitPage"]));
        expect(args[args.length - 1]).toBe("doc.pdf");
    });

    it("keeps a QR sticker at its own size", () => {
        const args = documentsPrinterGsArgs("qr.pdf", false);
        expect(args).not.toContain("-dPDFFitPage");
        expect(args.some((a) => a.startsWith("-sPAPERSIZE"))).toBe(false);
    });
});

describe("buildIppPrintJob — documentation over IPP", () => {
    const { buildIppPrintJob } = jest.requireActual("../../services/documentPrinterService");
    const pdf = Buffer.from("%PDF-1.4 test");
    const text = (b: Buffer) => b.toString("latin1");

    it("is an IPP 1.1 Print-Job carrying the PDF itself, duplex long edge, on A4, fitted", () => {
        const req: Buffer = buildIppPrintJob("ipp://10.110.10.36:631/ipp/print", pdf, { jobName: "P605623_Customer_BOM.pdf" });
        expect([...req.subarray(0, 4)]).toEqual([0x01, 0x01, 0x00, 0x02]);
        for (const part of ["ipp://10.110.10.36:631/ipp/print", "application/pdf", "P605623_Customer_BOM.pdf", "two-sided-long-edge", "iso_a4_210x297mm", "print-scaling", "fit"])
            expect(text(req)).toContain(part);
        expect(req.subarray(req.length - pdf.length).equals(pdf)).toBe(true);
    });

    it("without fitting: no paper size, print-scaling none", () => {
        const req: Buffer = buildIppPrintJob("ipp://x/ipp/print", pdf, { jobName: "x", fitToPaper: false });
        expect(text(req)).not.toContain("iso_a4");
        expect(text(req)).toContain("none");
    });
});
