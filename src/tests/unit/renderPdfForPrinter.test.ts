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
