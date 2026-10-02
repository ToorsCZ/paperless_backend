import { Request, Response } from "express";
import {
    listEmployees,
    listEmployeesForAdmin,
    addEmployee,
    renameEmployee,
    setEmployeeActive,
    recordOrderCompletion,
    recordOrderPreparation,
    recordOrderCheck,
    isValidCompletionStatus,
    isValidCheckStatus,
    getCompletionQueue,
    getProductStats,
    OrderCompletionStatus,
} from "../services/completionService";
import { buildPrepLabelPdf, printPrepLabelBuffer } from "../services/documentPrinterService";
import { getDb, getNormsDb } from "../config/database";
import { closeOrderInToors } from "../services/toorsService";
import { normalizeWorkplace } from "../utils/normalizeWorkplace";
import { getOrderCycleSnapshot, motorCycleRange } from "../services/workstationService";
import { completionWorkplaceForPbomType } from "../config/documentTypes";
import { resolveHardwareOrders } from "../services/hardwareOrderLookupService";

/**
 * Looks up the sales order number from ptl_prep_queue using project number
 * + position — avoids needing the mobile app to pass it through route params.
 * Falls back to Norms (newest txtfiles row) when the order isn't in the
 * plan (anymore). Returns null if neither knows it.
 */
async function lookupSalesOrder(
    projectNumber: string,
    position: string,
): Promise<string | null> {
    try {
        const db = await getDb();
        const row = await db("ptl_prep_queue")
            .where({ project_number: projectNumber, position })
            .select("sales_order")
            .first();
        if (row?.sales_order) return row.sales_order;

        const norms = await getNormsDb();
        const txtfile = await norms("txtfiles")
            .where({ zakazka: projectNumber, pozice: position })
            .orderBy("id", "desc")
            .select("prodejni_objednavka")
            .first();
        return txtfile?.prodejni_objednavka ? String(txtfile.prodejni_objednavka) : null;
    } catch (err: any) {
        console.error(
            `[PREP] Could not look up sales order for ${projectNumber}/${position}: ${err.message}`,
        );
        return null;
    }
}

/**
 * Looks up the production order number (vyr_obj) for a given order from the
 * Norms database. Path: txtfiles (zakazka + prodejni_objednavka + pozice)
 * → konfiguratory (id_txtfile + nazev LIKE '%hardware%' → vyr_obj).
 * The nazev filter is required because each txtfile row has multiple
 * konfiguratory rows for different parts (motor, hardware, etc.) — only
 * the Hardware row is relevant here. Returns null and fails open if the
 * Norms DB is unavailable or no row is found — the label still prints, just
 * without the production order barcode.
 */
async function lookupProductionOrderNumber(
    projectNumber: string,
    salesOrder: string,
    position: string,
): Promise<string | null> {
    try {
        const db = await getNormsDb();

        const txtfile = await db("txtfiles")
            .where({
                zakazka: projectNumber,
                prodejni_objednavka: salesOrder,
                pozice: position,
            })
            // An order re-released in Norms gets a second txtfiles row (with a
            // new vyr_obj) — the newest one is the live production order.
            .orderBy("id", "desc")
            .select("id")
            .first();

        if (!txtfile?.id) return null;

        const konfig = await db("konfiguratory")
            .where({ id_txtfile: txtfile.id })
            .whereRaw("LOWER(nazev) LIKE '%hardware%'")
            .select("vyr_obj")
            .first();

        return konfig?.vyr_obj ? String(konfig.vyr_obj) : null;
    } catch (err: any) {
        console.error(
            `[NORMS] Could not look up production order for ${projectNumber}/${position}: ${err.message}`,
        );
        return null;
    }
}

/**
 * What a prep label prints for an order: sales order, production order and
 * the number of doors. The newest PTL order file (HISTORY\OK, Hardware) is
 * the authority for the door count — the app only knows it while the order
 * is in the plan, and once a label was printed with a wrong count, its own
 * preparation log would keep repeating it.
 */
async function resolvePrepOrder(projectNumber: string, position: string) {
    const salesOrder = await lookupSalesOrder(projectNumber, position);
    const productionOrderNumber = salesOrder
        ? await lookupProductionOrderNumber(projectNumber, salesOrder, position)
        : null;
    const orderFile = salesOrder ? resolveHardwareOrders([{ salesOrder, position }]).get(`${salesOrder}::${position}`) : undefined;
    return {
        salesOrder,
        productionOrderNumber: productionOrderNumber ?? orderFile?.productOrder ?? null,
        doors: orderFile?.quantity ?? null,
    };
}

export const getEmployees = async (req: Request, res: Response) => {
    try {
        const employees = await listEmployees();
        res.json(employees);
    } catch (error) {
        console.error("Error fetching employees:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createEmployee = async (req: Request, res: Response) => {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name is required" });
    }
    try {
        const employee = await addEmployee(name);
        res.status(201).json(employee);
    } catch (error) {
        console.error("Error adding employee:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// ── Hidden employee-admin screen (see routes/employees.ts — everything
// under /employees/admin requires adminPinAuth on top of the normal
// X-API-Key) ──────────────────────────────────────────────────────────────

export const getEmployeesAdmin = async (req: Request, res: Response) => {
    try {
        res.json(await listEmployeesForAdmin());
    } catch (error) {
        console.error("Error fetching employees (admin):", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const updateEmployee = async (req: Request, res: Response) => {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name is required" });
    }
    try {
        res.json(await renameEmployee(Number(req.params.id), name));
    } catch (error: any) {
        if (error.message === "Employee not found") {
            return res.status(404).json({ error: error.message });
        }
        console.error("Error renaming employee:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

async function setEmployeeActiveHandler(req: Request, res: Response, active: boolean) {
    try {
        res.json(await setEmployeeActive(Number(req.params.id), active));
    } catch (error: any) {
        if (error.message === "Employee not found") {
            return res.status(404).json({ error: error.message });
        }
        console.error(`Error ${active ? "restoring" : "hiding"} employee:`, error);
        res.status(500).json({ error: "Internal server error" });
    }
}

// "Delete" — hides, never a real DELETE (see setEmployeeActive).
export const hideEmployee = (req: Request, res: Response) =>
    setEmployeeActiveHandler(req, res, false);

export const restoreEmployee = (req: Request, res: Response) =>
    setEmployeeActiveHandler(req, res, true);

export const createOrderCompletion = async (req: Request, res: Response) => {
    const {
        orderId,
        workstation,
        cycleIndex,
        totalCycles,
        productOrder,
        projectNumber,
        position,
        salesOrder,
        employeeName,
        status,
        quantity,
    } = req.body;

    if (!orderId || !workstation || !employeeName || !status) {
        return res.status(400).json({
            error: "orderId, workstation, employeeName, and status are required",
        });
    }
    if (!isValidCompletionStatus(status)) {
        return res.status(400).json({
            error: "status must be one of: complete, complete_with_changes, missing_product, shipped_incomplete",
        });
    }

    try {
        await recordOrderCompletion({
            orderId,
            workstation,
            cycleIndex,
            totalCycles,
            productOrder,
            projectNumber,
            position,
            salesOrder,
            employeeName,
            status,
        });

        // Tell any other completion kiosk tablet that might have this exact
        // order/cycle queued or on screen (two tablets can run kiosk mode at
        // once, in different physical locations) that it's resolved now —
        // whatever the status, someone already handled this cycle, so a
        // sibling tablet must drop it rather than let a worker complete it
        // again. Matched on orderId + cycleIndex, not just orderId, since a
        // multi-cycle order's other cycles are still genuinely pending.
        const { io } = require("../index");
        if (io) {
            io.emit("order-completed", { orderId, cycleIndex });
        }

        // Close the order in the ERP system (TOORS) when status is "complete".
        // Other statuses (complete_with_changes, missing_product, etc.) are
        // intentionally skipped — only clean completions are auto-closed.
        // Awaited only long enough to confirm the bridge accepted the job
        // (queued, not the actual TOORS close — see toorsService.ts) so the
        // kiosk operator isn't kept waiting on TOORS itself.
        let toorsResult: Awaited<ReturnType<typeof closeOrderInToors>> | null = null;
        if (status === "complete" && productOrder) {
            // Only Motor batches multiple units into one completion call —
            // every other workstation (Hardware included) closes exactly 1
            // unit per cycle (see toorsService.ts's header comment).
            const isMotor = normalizeWorkplace(workstation) === "motor";
            let closeQty = 1;
            if (isMotor) {
                // The mobile app's `quantity` is just order.quantity, the
                // order's raw TOTAL (see kiosk.tsx) — never this cycle's
                // batch size. Re-derive the real per-cycle amount from the
                // SAME order data (quantity + maxCycle) the printing path
                // used for this exact cycle, via motorCycleRange, so
                // printing and completion can never disagree.
                const snapshot = await getOrderCycleSnapshot(orderId, cycleIndex);
                if (snapshot) {
                    closeQty = motorCycleRange(
                        snapshot.quantity,
                        snapshot.maxCycle,
                        cycleIndex,
                        totalCycles,
                    ).count;
                } else if (typeof quantity === "number" && quantity > 1) {
                    // No snapshot on record (e.g. an order-update was never
                    // logged for this cycle) — fall back to trusting the
                    // mobile-sent quantity rather than closing nothing.
                    closeQty = Math.floor(quantity);
                }
            }
            toorsResult = await closeOrderInToors(productOrder, Math.max(1, closeQty));
        }

        res.status(201).json({
            status: "ok",
            toors: toorsResult
                ? {
                      queued: toorsResult.queued,
                      error: toorsResult.error,
                  }
                : null,
        });
    } catch (error) {
        console.error("Error recording order completion:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// The completion kiosk's durable backlog — see completionService.getCompletionQueue.
// Called on mount and whenever the selected workplace changes, so a tablet
// opening kiosk mode picks up anything finished while no tablet had it open.
export const getCompletionQueueHandler = async (req: Request, res: Response) => {
    const { workplace } = req.query;

    try {
        const queue = await getCompletionQueue(
            typeof workplace === "string" ? workplace : undefined,
        );
        res.json(queue);
    } catch (error) {
        console.error("Error fetching completion queue:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// `from`/`to` are "YYYY-MM-DD"; both optional, defaulting to today only
// (see getProductStats) — lets the stats tab page through whole weeks.
// `stage` is "completed" (default) or "checked".
export const getStatsHandler = async (req: Request, res: Response) => {
    try {
        const { from, to, stage } = req.query;
        res.json(
            await getProductStats(
                typeof from === "string" ? from : undefined,
                typeof to === "string" ? to : undefined,
                stage === "checked" ? "checked" : "completed",
            ),
        );
    } catch (error) {
        console.error("Error fetching stats:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// Statuses a manual completion may use — never plain "complete", so a
// manual completion never closes the order in TOORS automatically.
const MANUAL_COMPLETION_STATUSES: OrderCompletionStatus[] = [
    "complete_with_changes",
    "missing_product",
    "shipped_incomplete",
];

/**
 * Completes one cycle of an order that can't be completed through P2L
 * (so there's no FINISHED event and no kiosk entry for it) — from the
 * hidden, admin-PIN-protected action in the document viewer. Everything
 * is derived from the opened document: its type gives the workplace
 * (Hardware/Motor), and if the order DID partly go through P2L, the
 * existing completion's order_id/sales order/production order are reused
 * so its cycles stay one order. Otherwise a synthetic order_id
 * ("manual:<project>:<position>:<workplace>") groups its cycles, and the
 * sales/production order are looked up like the prep label does.
 */
export const createManualCompletion = async (req: Request, res: Response) => {
    const { documentId, cycleIndex, totalCycles, employeeName, status } = req.body ?? {};
    if (!documentId || !cycleIndex || !employeeName || !status) {
        return res.status(400).json({
            error: "documentId, cycleIndex, employeeName, and status are required",
        });
    }
    if (!MANUAL_COMPLETION_STATUSES.includes(status)) {
        return res.status(400).json({
            error: `status must be one of: ${MANUAL_COMPLETION_STATUSES.join(", ")}`,
        });
    }

    try {
        const db = await getDb();
        const doc = await db("documents").where({ id: documentId }).first();
        if (!doc) {
            return res.status(404).json({ error: "Document not found" });
        }
        const workstation = completionWorkplaceForPbomType(doc.document_type);
        if (!workstation) {
            return res.status(400).json({
                error: "Manual completion is only possible for Hardware and Motor BOMs",
            });
        }

        const existing = await db("order_completion_log")
            .where({ project_number: doc.project_number, position: doc.position, workstation })
            .orderBy("created_at", "desc")
            .first();
        const salesOrder = existing?.sales_order ?? (await lookupSalesOrder(doc.project_number, doc.position));
        const productOrder =
            existing?.product_order ??
            (salesOrder ? await lookupProductionOrderNumber(doc.project_number, salesOrder, doc.position) : null);
        const cycles =
            typeof totalCycles === "number" && totalCycles > 0 ? Math.floor(totalCycles) : existing?.total_cycles ?? 1;
        const cycle = Number(cycleIndex);
        if (!Number.isInteger(cycle) || cycle < 1 || cycle > cycles) {
            return res.status(400).json({ error: `cycleIndex must be between 1 and ${cycles}` });
        }

        const orderId = existing?.order_id ?? `manual:${doc.project_number}:${doc.position}:${workstation}`;
        await recordOrderCompletion({
            orderId,
            workstation,
            cycleIndex: cycle,
            totalCycles: cycles,
            productOrder: productOrder ?? undefined,
            projectNumber: doc.project_number,
            position: doc.position,
            salesOrder: salesOrder ?? undefined,
            employeeName,
            status,
        });
        console.log(
            `[COMPLETION] Manual completion (no P2L) of ${doc.project_number}/${doc.position} ${workstation} ` +
                `cycle ${cycle}/${cycles} as "${status}" by ${employeeName} (order ${orderId})`,
        );
        res.status(201).json({ status: "ok" });
    } catch (error) {
        console.error("Error recording manual completion:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createPrepLabel = async (req: Request, res: Response) => {
    const { projectNumber, position, employeeName, totalCycles } = req.body;

    if (!projectNumber || !position || !employeeName) {
        return res.status(400).json({
            error: "projectNumber, position, and employeeName are required",
        });
    }

    // Look up sales order, production order number and door count on the
    // backend — the mobile app doesn't need to carry them through route
    // params. All fail open: if unavailable the label still prints, just
    // without those fields / with the app's door count.
    const { salesOrder, productionOrderNumber, doors } = await resolvePrepOrder(projectNumber, position);
    const cycles =
        doors ??
        (typeof totalCycles === "number" && totalCycles > 0 ? Math.floor(totalCycles) : 1);

    try {
        const pdfBuffer = buildPrepLabelPdf(
            projectNumber,
            position,
            employeeName,
            cycles,
            salesOrder ?? null,
            productionOrderNumber,
        );
        await recordOrderPreparation(projectNumber, position, employeeName, cycles);
        await sendPrepLabel(res, pdfBuffer, projectNumber, position);
    } catch (error: any) {
        console.error("Error generating prep label:", error);
        res.status(500).json({
            error: error.message || "Internal server error",
        });
    }
};

// Try to send directly to the Godex prep label printer.
// If PREP_LABEL_PRINTER_HOST is configured, the backend prints it and
// returns a simple JSON success so the mobile app shows a confirmation.
// If not configured, fall back to returning the PDF bytes so the mobile
// app can open the system share sheet (previous behaviour — useful for
// dev/test or if the printer isn't set up yet).
async function sendPrepLabel(res: Response, pdfBuffer: Buffer, projectNumber: string, position: string) {
    const sentToPrinter = await printPrepLabelBuffer(pdfBuffer);
    if (sentToPrinter) {
        res.json({ success: true });
    } else {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="label_${projectNumber}_${position}.pdf"`);
        res.send(pdfBuffer);
    }
}

async function latestPrepLabel(projectNumber: string, position: string) {
    const db = await getDb();
    return db("order_preparation_log")
        .where({ project_number: projectNumber, position })
        .orderBy("created_at", "desc")
        .first();
}

/**
 * Whether this order's prep label was already printed, and how — the
 * print dialog switches to reprinting chosen doors when it was.
 */
export const getPrepLabelStatus = async (req: Request, res: Response) => {
    const { projectNumber, position } = req.query;
    if (typeof projectNumber !== "string" || typeof position !== "string") {
        return res.status(400).json({ error: "projectNumber and position are required" });
    }
    try {
        const original = await latestPrepLabel(projectNumber, position);
        const { doors } = await resolvePrepOrder(projectNumber, position);
        res.json({
            // Door count from the order file — what a print would use; null if unknown.
            doors,
            printed:
                original ?
                    {
                        employeeName: original.employee_name,
                        printedAt: original.created_at,
                        totalCycles: doors ?? original.total_cycles ?? 1,
                    }
                :   null,
        });
    } catch (error) {
        console.error("Error reading prep label status:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

/**
 * Reprints chosen doors of an already printed prep label (e.g. the printer
 * ran out of ink halfway through a 20-door order). The labels match the
 * original print — same preparer and time, taken from its
 * order_preparation_log rows — and nothing new is recorded. The door count
 * is the order file's (see resolvePrepOrder), so a label first printed with
 * a wrong count can be reprinted right.
 */
export const reprintPrepLabel = async (req: Request, res: Response) => {
    const { projectNumber, position, cycles } = req.body;
    if (!projectNumber || !position || !Array.isArray(cycles) || cycles.length === 0) {
        return res.status(400).json({ error: "projectNumber, position and cycles are required" });
    }

    try {
        const original = await latestPrepLabel(projectNumber, position);
        if (!original) {
            return res.status(404).json({ error: "No prep label has been printed for this order yet" });
        }
        const { salesOrder, productionOrderNumber, doors: orderDoors } = await resolvePrepOrder(projectNumber, position);
        const total = orderDoors ?? original.total_cycles ?? 1;
        const doors = [...new Set(cycles.map(Number))].sort((a, b) => a - b);
        if (doors.some((c) => !Number.isInteger(c) || c < 1 || c > total)) {
            return res.status(400).json({ error: `cycles must be between 1 and ${total}` });
        }
        const pdfBuffer = buildPrepLabelPdf(
            projectNumber,
            position,
            original.employee_name,
            total,
            salesOrder ?? null,
            productionOrderNumber,
            { cycles: doors, printedAt: new Date(original.created_at) },
        );
        console.log(`[PREP] Reprinting doors ${doors.join(",")}/${total} of ${projectNumber}/${position}`);
        await sendPrepLabel(res, pdfBuffer, projectNumber, position);
    } catch (error: any) {
        console.error("Error reprinting prep label:", error);
        res.status(500).json({ error: error.message || "Internal server error" });
    }
};

export const createOrderCheck = async (req: Request, res: Response) => {
    const { projectNumber, position, workstation, cycleIndex, totalCycles, employeeName, status, note } =
        req.body;

    if (!projectNumber || !position || !workstation || !employeeName || !status || !cycleIndex) {
        return res.status(400).json({
            error: "projectNumber, position, workstation, cycleIndex, employeeName, and status are required",
        });
    }
    if (!isValidCheckStatus(status)) {
        return res.status(400).json({
            error: "status must be one of: ok, issue",
        });
    }

    try {
        await recordOrderCheck({
            projectNumber,
            position,
            workstation,
            cycleIndex,
            totalCycles: typeof totalCycles === "number" && totalCycles > 0 ? totalCycles : 1,
            employeeName,
            status,
            note,
        });
        res.status(201).json({ status: "ok" });
    } catch (error) {
        console.error("Error recording order check:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
