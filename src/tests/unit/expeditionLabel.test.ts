jest.mock("../../config/database");
jest.mock("../../services/printSettingsService");
jest.mock("axios");

import axios from "axios";
import { fetchExpedition, generateExpeditionLabel, LabelRow } from "../../services/labelPrintingService";

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

    it("EZPL: one label with order, position, project and the date", () => {
        const ezpl = generateExpeditionLabel(row, exp, "ezpl", 203).toString("latin1");
        expect(ezpl).toContain("AE,22,40,2,2,0,0,252977");
        expect(ezpl).toContain("AE,22,130,2,2,0,0,010");
        expect(ezpl).toContain("Z605001");
        expect(ezpl).toContain("AE,50,550,3,3,0,0,03.11.2026");
        expect(ezpl.match(/^E$/gm)).toHaveLength(1);
    });

    it("ZPL: same fields, no time line when the time is not planned", () => {
        const zpl = generateExpeditionLabel(row, { ...exp, time: "" }, "zpl", 203).toString("ascii");
        expect(zpl.startsWith("^XA")).toBe(true);
        expect(zpl).toContain("^FD03.11.2026^FS");
        expect(zpl).not.toContain("09:00");
        expect(zpl.match(/\^XZ/g)).toHaveLength(1);
    });
});
