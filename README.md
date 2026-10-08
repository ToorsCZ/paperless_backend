# Paperless Backend

Node.js/Express + PostgreSQL backend for a paperless production-floor system:
it tracks workstations on the shop floor, serves production documents (PDFs)
to the **Paperless Mobile** app, receives production-order events, prints
hardware labels/QR stickers, and pushes live updates over Socket.IO.

---

## 1. What this service does

- **Workstation tracking** — polls the production system's API
  (`WORKSTATIONS_API_URL`) on an interval and mirrors workstation/order state
  into Postgres (`workstationService.ts`).
- **Order-update webhook** — the production system calls
  `POST /workstations/order-update` on `STARTED`/`FINISHED` order events.
  This single event fans out to:
  - Hardware label + QR sticker printing (`labelPrintingService.ts`)
  - Order documentation printing on `STARTED` (Hardware) — the
    `DOCUMENTS_TYPES` documents fetched from doc_manager, once per
    project/position (`document_print_log`)
  - A synthetic `FINISHED` for Motor orders with no PTL items
    (`motorOrderService.ts`)
  - Live Socket.IO broadcast to connected mobile clients
- **Document serving & annotation** — opens BOMs from doc_manager, tracks
  revisions and saves edited PDFs. Each edit is also copied to the share,
  into the `Production_BOM\{Subtype}` folder of its document type, so
  doc_manager indexes it under the right type (`workstationController.ts`,
  `config/documentTypes.ts`).
- **Prep queue** — reads a `productionPlanPTL.json` drop from a network
  share on a timer and exposes it as a queryable prep queue
  (`ptlPlanService.ts`). Hardware rows are matched to their PTL order file
  in `HISTORY\OK` (newest file wins) for the production order, the hardware
  family and the checklist of items that are not in P2L and must be
  prepared by hand (`hardwareOrderLookupService.ts`). An admin-managed BAAN
  code list narrows that checklist.
- **Prep-station labels** — 100 × 130 mm Godex-sized labels, one per door,
  with a Code 39 barcode of the production order (from Norms, newest
  `txtfiles` row). The door count comes from the newest PTL order file.
  Already printed labels can be reprinted door by door, identical to the
  original (`documentPrinterService.buildPrepLabelPdf`,
  `utils/code39Barcode.ts`).
- **Order completion** — kiosk-style "who finished this cycle, with what
  status" logging (`completionService.ts`). `complete` queues the order for
  closing in the ERP via the TOORS status bridge (`toorsService.ts`). A
  hidden, admin-PIN-protected manual completion covers orders that never go
  through P2L (non-`complete` statuses only).
- **Check & quality control** — a standard per-cycle check (only of cycles
  that have finished) and a separate QC sign-off by quality engineers with
  personal PINs. Orders whose TMP file asks for QC are flagged
  (`qcRequirementService.ts`); a QC problem sends the cycle back to
  "awaiting fix". Every preparation, completion, check and QC round is kept
  as history (`qualityControlService.ts`, `orderHistoryService.ts`).
- **Stats** — completed/checked products per day.
- **Administration** — employees, quality engineers and BAAN codes, behind
  `EMPLOYEE_ADMIN_PIN`.
- **Retention archival** — periodic sweep that converts finished orders'
  PDFs to PDF/A, stamps the production record (preparation, completion,
  check and QC per cycle, in Czech) and archives them to a network share
  (`archivalService.ts`).
- **Document printing** — renders PDFs with Ghostscript and sends them to a
  network printer (`documentPrinterService.ts`). A live switch
  (`/settings/printing`) turns printing on/off without a restart.
- **Logging** — timestamped, leveled logs go to the console **and**
  `app.log` in the project root (`utils/logger.ts`). All pre-existing
  `console.*` output is captured into the file too, so the file is a
  complete record across restarts.

## 2. Tech stack

| Layer       | Choice                                                             |
| ----------- | ------------------------------------------------------------------ |
| Runtime     | Node.js + TypeScript (`ts-node`/`tsc`)                             |
| HTTP        | Express 5                                                          |
| Realtime    | Socket.IO 4                                                        |
| Database    | PostgreSQL via Knex query builder                                  |
| Testing     | Jest + Supertest, `ts-jest`                                        |
| Packaging   | `@yao-pkg/pkg` → standalone `.exe`                                 |
| Lint/format | ESLint 10 (flat config) + Prettier, Husky + lint-staged pre-commit |

## 3. Project layout

```text
src/
├── index.ts                  # App bootstrap: express, http server, socket.io,
│                              # dotenv (must load first), route mounting,
│                              # polling/archival/prep-queue interval starters
├── config/
│   ├── database.ts           # Postgres/Knex connection + schema setup (+ Norms DB)
│   ├── documentTypes.ts      # doc_manager type ids, workplace ↔ PBOM type, share folders
│   ├── icc/, pdfa/           # Color profiles / PDF-A conversion assets
├── middleware/
│   ├── apiKeyAuth.ts         # X-API-Key on every request; X-Admin-Pin for admin routes
│   └── webFrontend.ts        # Serves the web build of the mobile app (see §8)
├── routes/                   # Thin Express routers, one per resource
│   ├── workstations.ts       # /workstations
│   ├── files.ts              # /files
│   ├── queue.ts              # /queue
│   ├── prepQueue.ts          # /prep-queue
│   ├── employees.ts          # /employees (+ /employees/admin)
│   └── settings.ts           # /settings
├── controllers/              # Request handling per route file
│   ├── workstationController.ts
│   ├── filesController.ts
│   ├── queueController.ts
│   ├── prepQueueController.ts
│   ├── completionController.ts     # completion, prep labels, checks, admin, stats
│   ├── qualityControlController.ts
│   └── settingsController.ts
├── services/                 # Business logic, no req/res
│   ├── workstationService.ts         # polling, order-update handling, doc printing, socket emits
│   ├── labelPrintingService.ts       # hardware label + QR sticker pipeline
│   ├── ptlPlanService.ts             # prep-queue plan file watcher, prep checklist
│   ├── hardwareOrderLookupService.ts # HISTORY\OK Hardware order files
│   ├── motorOrderService.ts          # Motor order files, non-PTL auto-finish
│   ├── completionService.ts          # completion/preparation/check logs, stats
│   ├── qualityControlService.ts      # QC sign-offs, engineer PINs
│   ├── qcRequirementService.ts       # which orders need QC (TMP flag)
│   ├── orderHistoryService.ts        # per-cycle history for the check modals
│   ├── toorsService.ts               # ERP close via the TOORS status bridge
│   ├── archivalService.ts            # PDF/A retention sweep
│   ├── documentPrinterService.ts     # network printer output, prep label PDF
│   ├── printSettingsService.ts       # live printing on/off switch
│   ├── pdfaService.ts                # Ghostscript-based PDF → PDF/A conversion
│   └── notificationService.ts        # queue-updated / queue-new-item socket emits
├── models/
├── utils/
│   ├── logger.ts             # Leveled logger: console + app.log capture
│   └── code39Barcode.ts      # Code 39 geometry, BC3of9 font discovery + PDF embedding
└── tests/
    ├── unit/
    ├── integration/
    └── helpers/
```

## 4. REST API surface

Every request needs the `X-API-Key` header. Routes marked **admin** also
need `X-Admin-Pin` (`EMPLOYEE_ADMIN_PIN`; unset = admin routes disabled).
QC routes take the quality engineer's PIN in `X-QC-Pin`. PINs travel in
headers, never in bodies, because request bodies are logged.

### Workstations, documents & printing

| Method | Path                                 | Purpose                                                                                                |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| GET    | `/health`                            | Liveness check                                                                                         |
| GET    | `/workstations`                      | Current state of all tracked workstations                                                              |
| GET    | `/workstations/workplaces`           | Distinct list of known workplace names                                                                 |
| POST   | `/workstations/order-update`         | **Webhook** from the production system (`STARTED`/`FINISHED`); labels, documentation, socket broadcast |
| GET    | `/workstations/log`                  | Historical order-update log                                                                            |
| POST   | `/workstations/import-pbom`          | Open a BOM from doc_manager for an order/position (find-or-create document)                            |
| GET    | `/workstations/search-pbom`          | Search orders/positions that have BOMs                                                                 |
| GET    | `/workstations/pbom-types`           | BOM types available for one position                                                                   |
| GET    | `/workstations/resolve-scan`         | Resolve a scanned barcode (production order or order number) to search results                         |
| POST   | `/workstations/print-documents`      | Print an order's documentation (`DOCUMENTS_TYPES`) now, even if already printed                        |
| POST   | `/workstations/save-edited`          | Save an edited PDF as a new revision (and copy it to its `Production_BOM` folder)                      |
| GET    | `/workstations/documents/:id/render` | Render a document for viewing/printing                                                                 |
| GET    | `/files`                             | Documents overview (status, check/QC progress, filters)                                                |
| GET    | `/files/:id`                         | Single document with status, cycles, check/QC state and history                                        |
| POST   | `/files/:id/export-pdfa`             | Convert & export a document as PDF/A                                                                   |
| GET    | `/files/*` (static)                  | Serves PDFs from `STORAGE_PATH`                                                                        |
| GET    | `/settings/printing`                 | Is printing switched on?                                                                               |
| POST   | `/settings/printing`                 | Switch printing on/off (live, no restart)                                                              |

### Completion, checks & stats

| Method | Path                              | Purpose                                                                         |
| ------ | --------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/workstations/order-completion`  | Record a cycle's completion status (kiosk); `complete` closes it in the ERP     |
| GET    | `/workstations/completion-queue`  | Finished cycles still waiting for a completion (kiosk backlog)                  |
| POST   | `/workstations/manual-completion` | **admin** — complete a cycle outside P2L (non-`complete` statuses only)         |
| POST   | `/workstations/order-check`       | Record a standard check of a finished cycle                                     |
| POST   | `/workstations/qc-check/verify`   | Verify a quality engineer's PIN (`X-QC-Pin`), with lockout                      |
| POST   | `/workstations/order-qc-check`    | Record a QC sign-off (`X-QC-Pin`); a problem sends the cycle to "awaiting fix"  |
| GET    | `/workstations/stats`             | Completed/checked products for a date range                                     |

### Prep station

| Method | Path                               | Purpose                                                              |
| ------ | ---------------------------------- | -------------------------------------------------------------------- |
| GET    | `/prep-queue`                      | Pending prep-queue items (filter by date/workplace/hardware type)    |
| GET    | `/prep-queue/workplaces`           | Distinct workplaces in the prep queue                                |
| GET    | `/prep-queue/hardware-types`       | Distinct hardware families (Indy, Guardy, …)                         |
| POST   | `/prep-queue/refresh`              | Force a re-read of the production plan files                         |
| GET    | `/prep-queue/items`                | An order's checklist of items to prepare by hand (not in P2L)        |
| POST   | `/prep-queue/items/check`          | Tick a checklist item                                                |
| POST   | `/prep-queue/items/uncheck`        | Untick a checklist item                                              |
| POST   | `/workstations/print-prep-label`   | Print the prep labels (one per door) and record the preparation      |
| GET    | `/workstations/prep-label-status`  | Was the label already printed (when, by whom), how many doors        |
| POST   | `/workstations/reprint-prep-label` | Reprint chosen doors, identical to the original; records nothing new |

### Employees & administration

| Method   | Path                                                          | Purpose                                              |
| -------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| GET      | `/employees`                                                  | Visible employees (every "who did this" picker)      |
| GET/POST | `/employees/admin`                                            | **admin** — list all / add an employee               |
| PUT      | `/employees/admin/:id`                                        | **admin** — rename                                   |
| POST     | `/employees/admin/:id/hide`, `…/restore`                      | **admin** — hide from / return to the pickers        |
| GET/POST | `/employees/admin/quality-engineers`                          | **admin** — list / add a quality engineer (with PIN) |
| PUT      | `/employees/admin/quality-engineers/:id`                      | **admin** — edit name / PIN (PINs are unique)        |
| POST     | `/employees/admin/quality-engineers/:id/hide`, `…/restore`    | **admin** — hide / restore                           |
| GET/POST | `/employees/admin/prep-baan-codes`                            | **admin** — BAAN codes the prep checklist shows      |
| DELETE   | `/employees/admin/prep-baan-codes/:id`                        | **admin** — remove a code                            |

### Queue

| Method | Path                | Purpose                      |
| ------ | ------------------- | ---------------------------- |
| GET    | `/queue`            | Print/processing queue       |
| POST   | `/queue`            | Add an item to the queue     |
| PATCH  | `/queue/:id/status` | Update a queue item's status |

## 5. Socket.IO events (server → client)

| Event                      | Emitted by               | Payload                                                     | Purpose                                  |
| -------------------------- | ------------------------ | ----------------------------------------------------------- | ---------------------------------------- |
| `workstation-order-update` | `workstationService.ts`  | `{ order, cycleIndex, totalCycles, _id, datetime, action }` | Real-time order STARTED/FINISHED event   |
| `workstations-updated`     | `workstationService.ts`  | full workstation list (or none)                             | Tells clients to refetch `/workstations` |
| `queue-updated`            | `notificationService.ts` | queue item                                                  | A queue item changed                     |
| `queue-new-item`           | `notificationService.ts` | queue item                                                  | A new item was added to the queue        |

CORS is currently wide open (`origin: "*"`) on both the HTTP and Socket.IO
layers, matching the mobile app connecting from arbitrary dev-machine IPs.

## 6. Running locally

```bash
npm install
cp .env.example .env      # fill in DB + network share + printer settings
npm run dev                # nodemon + ts-node, watches src/**/*.ts
```

The server logs to the console and appends to `app.log` in the project
root (gitignored). Tune with `LOG_LEVEL` (`debug|info|warn|error`, default
`info`) and `LOG_FILE_PATH` in `.env` — see `.env.example`.

For the barcode on prep-station labels, drop the `BC C39 3 of 9 Light.ttf`
font file into `config/` (or point `PREP_LABEL_BARCODE_FONT_PATH` at it).
Without it the barcode is drawn as vector bars instead — same symbology,
slightly different look.

Other scripts:

```bash
npm run build               # tsc -> dist/
npm start                   # node dist/index.js
npm test                    # jest --forceExit
npm run lint / format
npm run test:compare        # VBA-vs-backend label byte-comparison (Windows/PowerShell)
```

Requires a reachable PostgreSQL instance (`createdb paperless`) and, for the
label-printing and document features specifically, the Windows network
shares and printer.

## 7. How this connects to the mobile app

The companion **`paperless_mobile`** Expo app is the primary client of this
API:

- It calls this server's REST endpoints (`/workstations`, `/files`,
  `/prep-queue`, `/employees`, `/settings`, `/queue`) via Axios, pointed at
  `http://<dev-machine-ip>:5300` in dev or a fixed production host/port.
- It listens on the same Socket.IO server for `workstation-order-update`
  and `workstations-updated` to refresh workstation cards live instead of
  polling.
- Its **kiosk mode** posts to `/workstations/order-completion` for
  shop-floor order completion; the prep queue and document viewer print
  prep labels (`/workstations/print-prep-label`, reprints via
  `/workstations/reprint-prep-label`).
- The document viewer also runs the check and QC flows
  (`/workstations/order-check`, `/workstations/order-qc-check`) and the
  hidden manual completion; the Search tab prints order documentation
  (`/workstations/print-documents`).
- Its document viewer/annotation screens read from `/files` and
  `/workstations/documents/:id/render`, and save annotated revisions via
  `/workstations/save-edited`.

See the [mobile repo's README](https://github.com/bourama1/paperless_mobile/blob/main/README.md) for the client-side
details. In short: **this backend is the single source of truth and event
bus; the mobile app is a thin, mostly stateless UI over it.**

## 8. Web frontend (optional)

The same `paperless_mobile` codebase can also run as a browser app, served
directly by this backend at the same origin/port — no separate web server,
port, or certificate. Intended for internal access over the company VPN,
not public exposure (see the caveats below).

**Build and deploy:**

```bash
# in the mobile project
npx expo export --platform web
# copy the resulting dist/ folder to wherever WEB_BUILD_PATH points, e.g.:
cp -r dist /path/to/backend/web-dist
```

Set `WEB_BUILD_PATH` in this project's `.env` (see `.env.example`) to that
folder's path, then restart the server. The console logs which mode it's
running in on startup (`[WEB] Serving web build from ...` vs
`[WEB] No web build found ... running API-only`). Leaving `WEB_BUILD_PATH`
unset, or pointing it somewhere that doesn't exist, disables the web
frontend entirely — the API keeps working exactly as before either way.

**How the routing works:** requests matching a real API prefix
(`/workstations`, `/queue`, `/files`, `/employees`, `/prep-queue`,
`/settings`, `/health` — see `middleware/webFrontend.ts`) go through the normal
`apiKeyAuth` + route handling, unchanged. Everything else is treated as a
page request: a real static file (JS bundle, fonts, images) is served
directly if it exists, and any other GET falls back to the same
`index.html` shell so expo-router's client-side routing resolves correctly
on a fresh load or page refresh (e.g. `/document/123`). This part is
deliberately public — a plain browser navigation can't attach a custom
`X-API-Key` header — but the actual data the page fetches afterward goes
through the normal authenticated API calls, same as the native app.

**Two things worth knowing before relying on this:**

- **The API key ships inside the page's JS bundle.** `EXPO_PUBLIC_API_KEY`
  gets inlined into client-side JS for web the same way it's baked into the
  native app binary — except a browser makes it trivially visible via
  "View Source" or dev tools, unlike a compiled app most people never
  inspect. Fine for access gated behind your VPN; not something to expose
  further without adding a real login layer in front of it.
- **Use a trusted certificate.** With the IIS setup in §9 (the Sectigo
  certificate for `tocz-app4.toors.cz`) browsers show no warning — open the
  hostname, not the IP. A self-signed certificate (`SSL_PFX_PATH`) would
  have to be installed as trusted on every PC (on Windows: double-click the
  `.crt` → "Install Certificate" → Local Machine → Trusted Root
  Certification Authorities, or push it via Group Policy).

## 9. HTTPS through IIS (certificate with a non-exportable key)

The backend can serve HTTPS itself (`SSL_PFX_PATH`), but that needs the
certificate's private key as a `.pfx`. When the server's certificate
(Sectigo, `tocz-app4.toors.cz`) sits in the Windows store with a
**non-exportable** key, let IIS terminate HTTPS instead — IIS uses the key
straight from the store — and forward to the backend on localhost.
Clients keep the same address: `https://tocz-app4.toors.cz:5300`.

1. **IIS** — Server Manager → Add Roles and Features → *Web Server (IIS)*,
   including *Application Development → WebSocket Protocol*.
2. Install Microsoft's **URL Rewrite 2.1** and **Application Request
   Routing 3.0**.
3. IIS Manager → server node → *Application Request Routing Cache* →
   *Server Proxy Settings* → tick **Enable proxy** (leave "Preserve client
   IP in X-Forwarded-For" on) → Apply.
4. Create a folder, e.g. `C:\inetpub\paperless-proxy`, and copy
   [`iis/web.config`](iis/web.config) into it.
5. IIS Manager → Sites → *Add Website*: name `paperless`, physical path
   that folder, binding **https**, port **5300**, host name
   `tocz-app4.toors.cz`, SSL certificate: the Sectigo one.
6. Backend `.env`, then restart the backend:

   ```text
   PORT=5301
   HOST=127.0.0.1
   TRUST_PROXY=true
   SSL_PFX_PATH=
   ```

   (`HOST=127.0.0.1` keeps the plain-HTTP port unreachable from the LAN;
   `TRUST_PROXY` makes per-device logic like the QC PIN lockout see the
   tablet's real IP instead of IIS's.)
7. Check `https://tocz-app4.toors.cz:5300/health` from another PC — padlock,
   no warning.

Then switch every client at once — plain HTTP on 5300 is gone: the
external production system's webhook
(`https://tocz-app4.toors.cz:5300/workstations/order-update`), the tablets
(APK built with `EXPO_PUBLIC_BACKEND_USE_HTTPS=true`), and browsers (open
the hostname, not the IP — the certificate is for the name). When the
certificate is renewed in the Windows store, re-select it in the site's
https binding; nothing on the backend side changes.
