# BillEase

BillEase is a browser-based billing and business management suite built with Next.js, React and TypeScript. It covers the sales side (invoices, quotations, customers, GST reporting) and the purchasing side (suppliers, purchase orders, goods receipts, purchase bills, supplier payments and payables), joined by one inventory ledger and profit-and-loss reporting.

There are no accounts and no server-side database. Business data lives in your browser, encrypted at rest. The server only renders PDFs and sends email on request.

> BillEase started from the open-source [Invoify](https://github.com/al1abb/invoify) invoice generator (MIT) and has since grown well beyond it. The licence and original copyright are kept in [`LICENSE`](LICENSE). A few internal names still carry the original `invoify` prefix on purpose (see [Storage naming](#storage-naming)).

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Limitations](#limitations)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Commands](#commands)
- [Usage guide](#usage-guide)
- [Backup and restore](#backup-and-restore)
- [Testing](#testing)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Screenshots](#screenshots)
- [License](#license)

## Overview

| | |
| --- | --- |
| Data storage | Encrypted IndexedDB in the user's browser (AES-GCM 256, non-extractable key) |
| Server responsibilities | PDF rendering (headless Chromium), email delivery, file export |
| Accounts / database | None |
| Languages | 18, with right-to-left support |
| Layouts | Desktop and phone |

The application navigation has these sections: Dashboard, Invoices, Quotations, Customers (`/clients`), Products, Suppliers, Purchase Orders, Goods Receipts, Purchase Bills, Payables, Expenses, Profit & Loss, Analytics and Settings. The invoice builder is the home page (`/`).

## Features

### Sales

- **Invoice builder:** a five-step wizard (From & To, Invoice Details, Line Items, Payment Info, Summary) with a live preview, signatures (draw, type or upload), logos, custom fields, per-invoice tax, discount and shipping, and a configurable invoice-number scheme.
- **13 invoice PDF templates** and a font and theme designer.
- **Invoice lifecycle:** statuses derived from recorded payments and due dates, partial payments, revision history with restore, duplicate, cancel, saved templates, and recurring-invoice schedules.
- **Quotations:** builder, status tracking, PDF output and conversion to an invoice (a quotation converts once; the conversion check is made against storage so a second tab cannot create a duplicate).
- **Real PDFs:** rendered server-side with headless Chromium, in the interface language; sent by email on request.
- **Exports:** the invoice form exports to JSON, CSV or XML, and imports from JSON.
- **Voice input** for the builder, and keyboard shortcuts (press `?` in the app for the list).

### Customers (CRM)

- Customer profiles with tags, notes and category, outstanding and overdue figures, purchase-frequency and payment-behaviour insights, and rule-based alerts.
- Duplicate detection, CSV import and export.
- Payment recording with allocation across open invoices (oldest due first), and customer statements (on screen, CSV and PDF).

### Inventory

- **Product catalogue** (goods and services) with a stock ledger. A product never stores a quantity on hand: stock is the sum of its movements (opening balance, purchases, adjustments, sales, returns), so it is always auditable.
- Issued invoices deduct stock and cancelled or deleted ones return it. The sync compares what the ledger already shows with what the invoice requires and records only the difference, so saving twice or recovering from a crash never double-deducts.
- Shortage checks before an invoice is issued, and low-stock reporting.

### Purchasing (ERP modules)

| Module | What it does |
| --- | --- |
| **Suppliers** | Supplier records with GSTIN (checked locally for format and check character), state, payment terms and an opening balance. |
| **Purchase orders** | Draft, sent, closed and cancelled orders with GST per line, intra- vs inter-state split from the supplier and your Business Profile, and PDF output. A PO commits nothing in the books and does not move stock. Partially-received, received and overdue are derived, never stored. |
| **Goods receipts (GRN)** | Records what actually arrived, against a PO or direct, with received, rejected and accepted quantities. Posting raises stock by the accepted quantity; a posted receipt is immutable and is corrected by voiding it (which reverses its stock exactly) and re-entering it. |
| **Purchase bills** | The supplier's invoice to you. Posting a bill is the moment money becomes owed. Includes a three-way match against the PO, receipts and earlier bills (differences are warnings, not blocks), and an `ITC eligible` flag per bill. Only drafts are editable; a posted bill goes back to draft only while nothing is paid against it. |
| **Supplier payments** | Payments with allocations to posted bills of the same supplier and currency. One payment can settle several bills and vice versa. Unallocated amounts are advances. A voided payment settles nothing. |
| **Payables** | What you owe: owed per bill, overdue, advances, net payable per supplier, ageing buckets (current, 1-30, 31-60, 61-90, 90+ days), supplier ledgers, and a payments CSV export. |

Document numbering for purchase documents (`PO-0001`, `GRN-0001`, `PB-0001`) uses the prefixes set in Settings. Totals are always recomputed from the lines with the same GST engine invoices use, never stored.

### GST

- CGST / SGST / IGST calculation, GSTIN and HSN/SAC validation, state codes and place of supply.
- **GST sales report** (output tax) by period with CSV export.
- Purchase bills and expenses carry whether their tax is recoverable, which feeds profit and loss.
- All validation is local; BillEase never contacts the GST portal. See [Limitations](#limitations).

### Finance and reports

- **Expenses:** categories (built-in and custom), recoverable-tax flag, CSV export, and linking an expense to a purchase bill so the same spend is not counted twice.
- **Profit & Loss**, on two deliberately separate bases, each with CSV and PDF export:
  - *Cash basis:* collected payments, expenses paid and supplier payments by payment date, giving net cash flow.
  - *Invoice basis:* revenue (invoiced minus tax), cost (expenses and posted purchase bills less recoverable input tax) and an estimated profit.
  - Receivables are reported separately and never inflate cash flow.
- **Analytics:** monthly, yearly, client, tax and outstanding reports with CSV export, a GST report panel, and a dashboard with needs-attention, payables and profit snapshots.

### Platform

- Encrypted local storage, one-file backup and restore, and per-category data clearing.
- 18 interface and PDF languages, right-to-left layout, light and dark themes.

## Limitations

Please read these before relying on BillEase for compliance or for more than one person.

- **GSTR-3B netting is not implemented.** Purchase bills and expenses record whether input tax credit (ITC) is eligible, and that flag affects profit and loss. BillEase does **not** net ITC against output tax, produce a GSTR-3B (or GSTR-1) summary, handle ITC reversals, or reconcile with GSTR-2B.
- **The GST report is output-tax only.** It is a working summary to help prepare returns. It does not file anything, and it does not produce e-invoices or e-way bills.
- **Local-only data.** Data exists only in the browser profile that created it. There is no sync between devices or browsers and no multi-user access. Clearing site data deletes everything; make backups regularly.
- **Encryption scope.** It protects against someone reading the browser profile off disk. It does not protect against a script injected into the page, which holds the same key handle the app does.
- **Documents leave the browser** when you generate a PDF or send email: the invoice data is posted to the server, rendered and returned, and not retained. The server keeps a small in-memory cache of recent PDFs and in-memory rate limits (on email sending and the warm-up endpoint); both are per instance and lost on restart.
- **Email** is sent through Gmail (Nodemailer's `gmail` service) with an app password; other providers are not configured.
- **Currencies are never added together.** Every total is per currency, with no conversion.
- **Docker is unverified.** The `Dockerfile` prunes dev dependencies, but the PDF service uses `puppeteer` (a dev dependency) outside Vercel, Netlify and AWS Lambda. PDF generation in the image has not been tested here and may need adjusting.
- Some PDF translations are incomplete and fall back to English.
- There is no banking, cash-flow forecasting, rule-based automation or ITC ledger.

## Architecture

```
Browser                                        Server (Next.js, Node runtime)
-------                                        ------------------------------
React UI (app/, contexts/)                     POST /api/invoice/generate   PDF (invoice, quotation, PO)
  |                                            GET  /api/invoice/warm       pre-launch Chromium
  |-- lib/*.ts  pure business logic            POST /api/invoice/send       email a PDF
  |   (GST, finance, profit, payables ...)     POST /api/invoice/export     JSON / CSV / XML
  |                                            POST /api/statement/generate customer statement PDF
  '-- lib/secureStore.ts  AES-GCM + IndexedDB  POST /api/report/profit-loss P&L PDF
```

Key design choices:

- **Pure logic is separate from storage and UI.** Modules in `lib/` (GST, finance, profit, payables, statements, CRM, products, purchasing) are plain functions with no React or storage, and are covered by browser-less logic tests.
- **Everything is derived.** Totals, statuses (overdue, partial, received), stock on hand and payables are computed from the saved records rather than stored, so screens cannot disagree.
- **One encrypted store.** All persistence goes through `lib/secureStore.ts` (and `lib/repository.ts` for the newer modules): per-key serial queues, validation on every read, change events so other screens refresh.
- **Single-instance PDF renderer.** One shared headless Chromium is kept alive across requests and warmed when the invoice or quotation builder opens.
- **Internationalisation** uses `next-intl` with locale-prefixed routes (`/en`, `/de`, ...). Non-English locales are layered over English so a missing key falls back to readable English instead of breaking the page.

### Storage naming

Stored keys keep the original `invoify` naming (`invoify:*` keys, the `invoify-secure` IndexedDB database, the `invoify-backup` file format, and the unprefixed `savedInvoices` key) so data and backups made earlier remain readable. Do not rename them.

## Tech stack

| Area | Technology |
| --- | --- |
| Framework | Next.js 15.3 (App Router), React 18.2, TypeScript 5.2 |
| UI | Tailwind CSS 3.3, shadcn/ui on Radix UI, lucide-react, dnd-kit (line-item ordering) |
| Forms and validation | React Hook Form, Zod |
| i18n | next-intl 4 |
| PDF | puppeteer-core with `@sparticuz/chromium` on serverless hosts; `puppeteer` elsewhere |
| Email | Nodemailer, `@react-email/components` |
| Exports | `@json2csv/node`, `xml2js` |
| Tests | Playwright |
| Tooling | ESLint 9, Prettier 3 |

## Getting started

Requirements: Node.js 20 or later (CI uses 20, the Dockerfile uses 22) and npm.

```bash
npm install
npm run dev
```

Open <http://localhost:3000> (Next.js picks the next free port if 3000 is taken). `npm install` also downloads Chromium via `puppeteer`, which local PDF generation uses; its cache is configured by `puppeteer.config.cjs` to live in `.cache/puppeteer`.

`predev` and `prebuild` run `scripts/build-pdf-css.mjs`, which compiles the stylesheet and fonts the PDF renderer inlines into `lib/pdfStyles.generated.ts` (a generated file of about 1 MB).

## Configuration

Everything is optional; with no configuration the app runs fully, minus email. Put values in `.env.local` (git-ignored). There is no checked-in `.env` file or example file.

| Variable | Used for | Notes |
| --- | --- | --- |
| `NODEMAILER_EMAIL` | Sending PDFs by email | The Gmail address that sends the mail. |
| `NODEMAILER_PW` | Sending PDFs by email | A [Gmail App Password](https://support.google.com/accounts/answer/185833), not your account password. Without both, the send endpoint reports the service as not configured. |
| `NEXT_PUBLIC_SITE_URL` | Deployed builds | Canonical origin for metadata, sitemap and email assets. Defaults to `http://localhost:3000`. |
| `GOOGLE_SC_VERIFICATION` | Optional | Google Search Console verification token. |

Variables read by tooling rather than the app: `ANALYZE=true` (bundle analyzer, set by `npm run analyze`), `NEXT_DIST_DIR` (alternative build folder, used by the isolated test config), `CI` and `REUSE_SERVER=1` (test runner behaviour). On Vercel, Netlify and AWS Lambda the PDF service detects the platform from its standard environment variables and uses the bundled `@sparticuz/chromium`.

In-app preferences (Settings page): invoice numbering scheme, default due days and reminder lead days, **Business Profile** (your name, GSTIN and state, which decide intra- vs inter-state for purchases), purchase document prefixes, and backup and data management.

## Commands

All defined in `package.json`:

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server. |
| `npm run build` | Production build. |
| `npm run start` | Serve the production build. |
| `npm run lint` | ESLint (`next lint`). |
| `npm run format` / `npm run format:check` | Prettier write / check. |
| `npm run analyze` | Production build with the bundle analyzer. |
| `npm run build:pdf-css` | Regenerate the PDF stylesheet (also runs before `dev` and `build`). |
| `npm run test:logic` | Browser-less logic specs only. |
| `npm run test:e2e` | Full Playwright suite. |
| `npm run test:e2e:ui` | The same in Playwright's UI mode. |
| `npx tsc --noEmit` | Typecheck. |
| `npx playwright test -c playwright.isolated.config.ts` | Full suite against its own production build on port 3100 and folder `.next-test`, so it never disturbs a running dev server. |

## Usage guide

1. **Set up your business.** In *Settings*, fill in the Business Profile (name, GSTIN, state), numbering and purchase prefixes. The GSTIN and state drive GST on purchase documents.
2. **Sell.** Build an invoice on the home page, generate or email the PDF, and track it from *Invoices*. Record payments against it; status follows the payments and due date. Quotations convert into invoices.
3. **Stock.** Add products in *Products* (with an opening balance if you hold stock). Issuing an invoice deducts stock; cancelling returns it.
4. **Buy.** Add a *Supplier*, raise a *Purchase Order*, record a *Goods Receipt* when goods arrive (stock goes up by the accepted quantity), then post the supplier's *Purchase Bill* (matched against the order and receipts). Record *Supplier Payments* and allocate them to bills.
5. **Watch what you owe and earn.** *Payables* shows balances, overdue amounts and ageing per supplier. *Profit & Loss* and *Analytics* report on both bases, and the GST sales report is on the *Analytics* page.
6. **Back up** from *Settings → Backup* regularly.

## Backup and restore

*Settings → Backup* (the `#backup` section) exports one JSON file (format `invoify-backup`, version 2) with a SHA-256 checksum. It holds: invoices, customers, senders, saved templates, settings, products, stock movements, quotations, expenses and expense categories, suppliers, purchase orders, goods receipts, purchase bills and supplier payments. The in-progress draft is not part of the backup.

Restore is two steps by design:

1. **Inspect.** The file is validated (size limit, format, version, checksum) and BillEase reports exactly what would be added, skipped or renumbered. Nothing is written yet.
2. **Apply.** You choose how to treat duplicates and whether to restore settings, then confirm.

Older backup versions, a bare array of invoices, and a single-invoice JSON export are also accepted. A backup from a newer version of the app is refused. Stock for goods receipts is re-synced after a restore. *Settings* also reports what is stored and its size, and can clear categories of data separately, after confirmation.

Clearing site data in the browser deletes everything, including the encryption key, and a backup is the only way back.

## Testing

```bash
npx playwright install --with-deps chromium   # once
npm run test:logic                             # pure logic, no browser, quick
npm run test:e2e                               # full suite
```

- `e2e/*.logic.spec.ts` are pure logic specs that need no browser, build or server.
- The remaining specs drive the UI and PDF generation. The default config builds and serves the production bundle (`npm run build && npm run start`) and runs in a desktop and a 375 px mobile viewport (Chromium for both). It reuses a server already answering on port 3000 when not in CI, so stop `next dev` first or use the isolated config above.
- A full run is memory-hungry because it builds the app and launches Chromium; use `npm run test:logic` when resources are tight.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint and the Playwright suite on Node 20.

## Deployment

- **Node host:** `npm run build` then `npm run start`. The server needs a runtime that can launch Chromium.
- **Vercel / Netlify / AWS Lambda:** detected automatically; PDF generation uses `@sparticuz/chromium`. The generation route allows up to 60 s.
- **Docker:** a multi-stage `Dockerfile` is included (`docker build -t billease .`, then `docker run -p 3000:3000 billease`). See the Docker caveat under [Limitations](#limitations); verify PDF generation in the image before relying on it.

Set `NEXT_PUBLIC_SITE_URL` to your public origin, and the email variables if you want email.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| PDF generation fails or the first PDF is slow | Chromium has to launch (about 2 s). Opening the builder warms it. Locally, confirm `npm install` finished downloading Chromium (`.cache/puppeteer`). The warm-up endpoint answers 429 above 30 calls a minute per client (the app tolerates this). |
| "Email service not configured" | Set both `NODEMAILER_EMAIL` and `NODEMAILER_PW` (a Gmail App Password) in `.env.local` and restart. Sending is rate-limited and attachments are capped at 10 MB. |
| Data is gone | Site data was cleared or you are in another browser profile or a private window. Restore from a backup. Data does not sync between browsers. |
| "Could not save to this browser" toast | Storage is full or disabled (quota, or a private window). Free space, export a backup, or use a normal window. |
| Restore is refused | The file failed validation: wrong format, checksum mismatch (edited or truncated), too large, or made by a newer version of the app. |
| Stock goes negative or is blocked | Issuing an invoice that exceeds stock is refused up front. Negative stock can still appear from receipts being voided; add stock through a goods receipt or an adjustment. |
| First load is slow in `npm run dev` | Routes compile on demand in development; later visits are fast. Link prefetching is switched off in development for this reason. |
| Tests fail against the wrong server | The default Playwright config reuses whatever is on port 3000. Stop `next dev` or run `-c playwright.isolated.config.ts`. |
| Type errors on a fresh clone | Run `npx tsc --noEmit` after `npm install`; `next-env.d.ts` is committed on purpose. |

## Project layout

| Path | Contents |
| --- | --- |
| `app/` | Next.js routes (`[locale]/(app)/...` for the management pages), API routes, and UI components grouped by module. |
| `app/api/` | PDF generate/warm, email send, export, statement and P&L PDF routes. |
| `app/components/templates/` | The 13 invoice PDF layouts, statement and report templates, and the email template. |
| `lib/` | Pure business logic and storage modules (GST, finance, profit, CRM, products, expenses, quotations, suppliers, purchase orders, goods receipts, purchase bills, supplier payments, payables, backup). |
| `lib/secureStore.ts` | The encrypted browser store everything persists through. |
| `lib/server/` | Server-only helpers (environment, rate limiting, request validation). |
| `contexts/` | React providers and data hooks. |
| `services/` | Server-side PDF, export and email services. |
| `i18n/` | Routing, message loading, and the 18 locale files. |
| `scripts/` | `build-pdf-css.mjs`. |
| `e2e/` | Playwright specs. |

## Screenshots

No current screenshots of BillEase are included. The only image in `public/assets/img/` that shows the app (`invoify-web-app.png`) is from the original Invoify interface and does not represent the current UI.

## License

Distributed under the MIT License. See [`LICENSE`](LICENSE).
