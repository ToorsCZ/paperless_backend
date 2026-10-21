// Prints one test prep label on a given printer — through the same code the
// app uses (buildPrepLabelPdf → Ghostscript → ZPL → raw port 9100), so it
// tests the real thing. Nothing is recorded in the database.
//
//   npx ts-node --transpile-only scripts/test-prep-label.ts <printer-ip> [doors] [dpi]
//
// e.g.  npx ts-node --transpile-only scripts/test-prep-label.ts 10.110.10.40
//       (2 doors → 2 labels, 203 DPI, ZPL)
const [ip, doorsArg = "2", dpiArg = "203"] = process.argv.slice(2);
if (!ip) {
    console.error("usage: test-prep-label.ts <printer-ip> [doors] [dpi]");
    process.exit(1);
}

require("dotenv").config();
// Must be set before the printer module loads — it reads them once.
process.env.PREP_LABEL_PRINTER_HOST = ip;
process.env.PREP_LABEL_PRINTER_PORT = "9100";
process.env.PREP_LABEL_PRINTER_DEVICE = "zpl";
process.env.PREP_LABEL_PRINTER_DPI = dpiArg;

(async () => {
    const { buildPrepLabelPdf, printPrepLabelBuffer } = require("../src/services/documentPrinterService");
    const pdf = buildPrepLabelPdf("605009", "030", "TEST tisku", Number(doorsArg), "604984", "238549");
    const sent = await printPrepLabelBuffer(pdf);
    console.log(sent ? `Sent ${doorsArg} test label(s) to ${ip}:9100 (${dpiArg} DPI, ZPL)` : "Not sent — printing is switched off in /settings/printing");
    // printPrepLabelBuffer keeps the connection open a few seconds after
    // sending — exiting at once would cut it and lose labels.
    setTimeout(() => process.exit(sent ? 0 : 2), 6000);
})().catch((err: any) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
});
