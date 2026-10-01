import { Router } from "express";
import {
    getWorkstations,
    listWorkplaces,
    receiveOrderUpdate,
    getWorkstationLog,
    importPbom,
    searchPbomHandler,
    resolveScanHandler,
    listPbomTypesHandler,
    saveEdited,
    renderDocument,
} from "../controllers/workstationController";
import {
    createOrderCompletion,
    getCompletionQueueHandler,
    createPrepLabel,
    reprintPrepLabel,
    createOrderCheck,
    getStatsHandler,
    createManualCompletion,
} from "../controllers/completionController";
import { verifyQcPin, createOrderQcCheck } from "../controllers/qualityControlController";
import { adminPinAuth } from "../middleware/apiKeyAuth";

const router = Router();

router.get("/", getWorkstations);
router.get("/workplaces", listWorkplaces);
router.post("/order-update", receiveOrderUpdate);
router.get("/log", getWorkstationLog);
router.post("/import-pbom", importPbom);
router.get("/search-pbom", searchPbomHandler);
router.get("/resolve-scan", resolveScanHandler);
router.get("/pbom-types", listPbomTypesHandler);
router.post("/order-completion", createOrderCompletion);
// Hidden, admin-PIN-protected completion of an order that can't go through
// P2L (non-complete statuses only) — see createManualCompletion.
router.post("/manual-completion", adminPinAuth, createManualCompletion);
router.get("/completion-queue", getCompletionQueueHandler);
router.get("/stats", getStatsHandler);
router.post("/print-prep-label", createPrepLabel);
router.post("/reprint-prep-label", reprintPrepLabel);
router.post("/order-check", createOrderCheck);
// Quality-control sign-off — the engineer's PIN travels in X-QC-Pin.
router.post("/qc-check/verify", verifyQcPin);
router.post("/order-qc-check", createOrderQcCheck);
router.post("/save-edited", saveEdited);
router.get("/documents/:id/render", renderDocument);

export default router;
