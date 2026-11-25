/**
 * Backup and restore.
 *
 * A backup is one JSON file holding everything this app keeps in the browser:
 * invoices, client and sender address books, saved templates and settings. It
 * carries a SHA-256 checksum of its data so a truncated or hand-edited file is
 * detected before anything is written.
 *
 * Restoring is two steps on purpose. `analyseBackup` only reads and validates —
 * it never touches storage — and returns exactly what would happen. Nothing is
 * imported until the user has seen that and chosen how to treat duplicates.
 *
 * Versions
 *   1  `{ format, version: 1, invoices }` (written by the first dashboard), a
 *      bare array of invoices, or one invoice (the per-invoice JSON export)
 *   2  `{ format, version: 2, data: { invoices, clients, senders, templates,
 *      settings }, checksum }`
 */

import { InvoiceSchema } from "@/lib/schemas";
import {
    clientKey,
    hasMeaningfulChange,
    type StoredStatus,
} from "@/lib/invoiceRecords";
import { normalise, type SavedParty } from "@/lib/partyStore";
import { sanitizeMovement, sanitizeProduct, type Product, type StockMovement } from "@/lib/products";
import { sanitizeQuotation, type Quotation } from "@/lib/quotations";
import { sanitizeCategory, sanitizeExpense, type Expense, type ExpenseCategory } from "@/lib/expenses";
import { sanitizeGoodsReceipt, type GoodsReceipt } from "@/lib/goodsReceipts";
import { sanitizePurchaseBill, type PurchaseBill } from "@/lib/purchaseBills";
import { sanitizeSupplierPayment, type SupplierPayment } from "@/lib/supplierPayments";
import { sanitizePurchaseOrder, type PurchaseOrder } from "@/lib/purchaseOrders";
import { sanitizeSupplier, type Supplier } from "@/lib/suppliers";
import { sanitizeSettings, type AppSettings } from "@/lib/settings";
import { normaliseTemplate, type SavedTemplate } from "@/lib/templateStore";
import type { InvoiceType } from "@/types";

export const BACKUP_FORMAT = "invoify-backup";
export const BACKUP_VERSION = 2;
/** A backup larger than this is refused outright rather than parsed. */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const MAX_INVOICES = 10_000;

export type BackupData = {
    invoices: InvoiceType[];
    clients: SavedParty[];
    senders: SavedParty[];
    templates: SavedTemplate[];
    settings: AppSettings | null;
    /**
     * Added after version 2 first shipped. Optional in files (older backups
     * lack them) but always present once read, so callers need no checks.
     */
    products: Product[];
    stockMovements: StockMovement[];
    quotations: Quotation[];
    /** Added after version 2 first shipped; absent from older files, always present once read. */
    expenses: Expense[];
    expenseCategories: ExpenseCategory[];
    /** Purchasing, added after version 2 first shipped; absent from older files, always present once read. */
    suppliers: Supplier[];
    purchaseOrders: PurchaseOrder[];
    goodsReceipts: GoodsReceipt[];
    purchaseBills: PurchaseBill[];
    supplierPayments: SupplierPayment[];
};

export type BackupFile = {
    format: typeof BACKUP_FORMAT;
    version: typeof BACKUP_VERSION;
    exportedAt: string;
    counts: { invoices: number; clients: number; senders: number; templates: number; products?: number; quotations?: number; expenses?: number; suppliers?: number; purchaseOrders?: number; goodsReceipts?: number; purchaseBills?: number; supplierPayments?: number };
    data: BackupData;
    checksum: string | null;
};

/** SHA-256 hex, or null where Web Crypto is unavailable (insecure origin). */
export async function sha256Hex(text: string): Promise<string | null> {
    try {
        const bytes = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
        return null;
    }
}

export async function buildBackup(data: BackupData, now = new Date()): Promise<BackupFile> {
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: now.toISOString(),
        counts: {
            invoices: data.invoices.length,
            clients: data.clients.length,
            senders: data.senders.length,
            templates: data.templates.length,
            products: data.products.length,
            quotations: data.quotations.length,
            expenses: data.expenses.length,
            suppliers: data.suppliers.length,
            purchaseOrders: data.purchaseOrders.length,
            goodsReceipts: data.goodsReceipts.length,
            purchaseBills: data.purchaseBills.length,
            supplierPayments: data.supplierPayments.length,
        },
        data,
        checksum: await sha256Hex(JSON.stringify(data)),
    };
}

/* ---------------------------------------------------------------- analyse */

export type BackupIssue = {
    kind: "invoice" | "client" | "sender" | "template" | "product" | "stock" | "quotation" | "expense" | "category" | "supplier" | "purchaseOrder" | "goodsReceipt" | "purchaseBill" | "supplierPayment";
    /** Position in the file, 1-based, for the user to find it. */
    index: number;
    message: string;
};

export type BackupError = "tooLarge" | "notJson" | "unrecognised" | "newerVersion" | "tooMany";

export type BackupAnalysis =
    | { ok: false; error: BackupError }
    | {
          ok: true;
          version: number;
          exportedAt: string | null;
          /** "valid" and "mismatch" need a checksum in the file; v1 files have none. */
          checksum: "valid" | "mismatch" | "missing";
          data: BackupData;
          issues: BackupIssue[];
      };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function checkInvoices(raw: unknown[], issues: BackupIssue[]): InvoiceType[] {
    const out: InvoiceType[] = [];
    raw.forEach((candidate, i) => {
        const parsed = InvoiceSchema.safeParse(candidate);
        if (parsed.success) {
            out.push(candidate as InvoiceType);
        } else {
            const first = parsed.error.issues[0];
            issues.push({
                kind: "invoice",
                index: i + 1,
                message: `${first.path.join(".") || "invoice"}: ${first.message}`,
            });
        }
    });
    return out;
}

function checkParties(raw: unknown, kind: "client" | "sender", issues: BackupIssue[]): SavedParty[] {
    if (!Array.isArray(raw)) return [];
    const out: SavedParty[] = [];
    raw.forEach((entry, i) => {
        const party = normalise(entry);
        if (party) out.push(party);
        else issues.push({ kind, index: i + 1, message: "missing a name" });
    });
    return out;
}

export async function analyseBackup(text: string): Promise<BackupAnalysis> {
    if (text.length > MAX_BACKUP_BYTES) return { ok: false, error: "tooLarge" };

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, error: "notJson" };
    }

    const issues: BackupIssue[] = [];

    // v2
    if (isRecord(parsed) && isRecord(parsed.data) && parsed.format === BACKUP_FORMAT) {
        const version = typeof parsed.version === "number" ? parsed.version : 2;
        if (version > BACKUP_VERSION) return { ok: false, error: "newerVersion" };

        const d = parsed.data;
        const rawInvoices = Array.isArray(d.invoices) ? d.invoices : [];
        if (rawInvoices.length > MAX_INVOICES) return { ok: false, error: "tooMany" };

        const rawTemplates = Array.isArray(d.templates) ? d.templates : [];
        const templates: SavedTemplate[] = [];
        rawTemplates.forEach((t, i) => {
            const n = normaliseTemplate(t);
            if (n) templates.push(n);
            else issues.push({ kind: "template", index: i + 1, message: "not a valid template" });
        });

        const products: Product[] = [];
        (Array.isArray(d.products) ? d.products : []).forEach((p, i) => {
            const n = sanitizeProduct(p);
            if (n) products.push(n);
            else issues.push({ kind: "product", index: i + 1, message: "missing an id or a name" });
        });
        const stockMovements: StockMovement[] = [];
        (Array.isArray(d.stockMovements) ? d.stockMovements : []).forEach((m, i) => {
            const n = sanitizeMovement(m);
            if (n) stockMovements.push(n);
            else issues.push({ kind: "stock", index: i + 1, message: "not a valid stock movement" });
        });

        // Full-schema check, as for invoices: an imported quotation must be
        // renderable to a PDF and convertible, not merely well-shaped.
        const quotations: Quotation[] = [];
        (Array.isArray(d.quotations) ? d.quotations : []).forEach((raw, i) => {
            const q = sanitizeQuotation(raw);
            if (!q) {
                issues.push({ kind: "quotation", index: i + 1, message: "not a valid quotation" });
                return;
            }
            const parsed = InvoiceSchema.safeParse(q.doc);
            if (parsed.success) quotations.push(q);
            else {
                const first = parsed.error.issues[0];
                issues.push({ kind: "quotation", index: i + 1, message: `${first.path.join(".") || "quotation"}: ${first.message}` });
            }
        });

        // Every imported expense is rebuilt and checked; one that cannot be a real
        // expense is reported and left out rather than repaired into a false figure.
        const expenses: Expense[] = [];
        (Array.isArray(d.expenses) ? d.expenses : []).forEach((x, i) => {
            const e = sanitizeExpense(x);
            if (e) expenses.push(e);
            else issues.push({ kind: "expense", index: i + 1, message: "not a valid expense (needs a title, a positive amount, a currency and a real date)" });
        });
        const expenseCategories: ExpenseCategory[] = [];
        (Array.isArray(d.expenseCategories) ? d.expenseCategories : []).forEach((x, i) => {
            const c = sanitizeCategory(x);
            if (c) expenseCategories.push(c);
            else issues.push({ kind: "category", index: i + 1, message: "not a valid expense category" });
        });

        // Purchasing records are rebuilt the same way: one that cannot be real is reported and left out.
        const suppliers: Supplier[] = [];
        (Array.isArray(d.suppliers) ? d.suppliers : []).forEach((x, i) => {
            const s = sanitizeSupplier(x);
            if (s) suppliers.push(s);
            else issues.push({ kind: "supplier", index: i + 1, message: "not a valid supplier (needs an id and a name)" });
        });
        const purchaseOrders: PurchaseOrder[] = [];
        (Array.isArray(d.purchaseOrders) ? d.purchaseOrders : []).forEach((x, i) => {
            const p = sanitizePurchaseOrder(x);
            if (p) purchaseOrders.push(p);
            else issues.push({ kind: "purchaseOrder", index: i + 1, message: "not a valid purchase order (needs a number, a supplier, a real date and a status)" });
        });

        const goodsReceipts: GoodsReceipt[] = [];
        (Array.isArray(d.goodsReceipts) ? d.goodsReceipts : []).forEach((x, i) => {
            const g = sanitizeGoodsReceipt(x);
            if (g) goodsReceipts.push(g);
            else issues.push({ kind: "goodsReceipt", index: i + 1, message: "not a valid goods receipt (needs a number, a supplier, a real date and at least one item)" });
        });

        const purchaseBills: PurchaseBill[] = [];
        (Array.isArray(d.purchaseBills) ? d.purchaseBills : []).forEach((x, i) => {
            const b = sanitizePurchaseBill(x);
            if (b) purchaseBills.push(b);
            else issues.push({ kind: "purchaseBill", index: i + 1, message: "not a valid purchase bill (needs a number, a supplier, real dates and a status)" });
        });
        const supplierPayments: SupplierPayment[] = [];
        (Array.isArray(d.supplierPayments) ? d.supplierPayments : []).forEach((x, i) => {
            const p = sanitizeSupplierPayment(x);
            if (p) supplierPayments.push(p);
            else issues.push({ kind: "supplierPayment", index: i + 1, message: "not a valid supplier payment (needs a supplier, a real date, a positive amount, and allocations within it)" });
        });

        const computed = await sha256Hex(JSON.stringify(d));
        const checksum =
            typeof parsed.checksum !== "string" || !computed
                ? "missing"
                : parsed.checksum === computed
                  ? "valid"
                  : "mismatch";

        return {
            ok: true,
            version,
            exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : null,
            checksum,
            data: {
                invoices: checkInvoices(rawInvoices, issues),
                clients: checkParties(d.clients, "client", issues),
                senders: checkParties(d.senders, "sender", issues),
                templates,
                settings: isRecord(d.settings) ? sanitizeSettings(d.settings) : null,
                products,
                stockMovements,
                quotations,
                expenses,
                expenseCategories,
                suppliers,
                purchaseOrders,
                goodsReceipts,
                purchaseBills,
                supplierPayments,
            },
            issues,
        };
    }

    // v1: { invoices: [...] }, a bare array, or a single invoice
    let candidates: unknown[] | null = null;
    if (Array.isArray(parsed)) candidates = parsed;
    else if (isRecord(parsed) && Array.isArray(parsed.invoices)) candidates = parsed.invoices;
    else if (isRecord(parsed) && isRecord(parsed.details)) candidates = [parsed];
    if (!candidates) return { ok: false, error: "unrecognised" };
    if (candidates.length > MAX_INVOICES) return { ok: false, error: "tooMany" };

    return {
        ok: true,
        version: 1,
        exportedAt: isRecord(parsed) && typeof parsed.exportedAt === "string" ? parsed.exportedAt : null,
        checksum: "missing",
        data: {
            invoices: checkInvoices(candidates, issues),
            clients: [],
            senders: [],
            templates: [],
            settings: null,
            products: [],
            stockMovements: [],
            quotations: [],
            expenses: [],
            expenseCategories: [],
            suppliers: [],
            purchaseOrders: [],
            goodsReceipts: [],
            purchaseBills: [],
            supplierPayments: [],
        },
        issues,
    };
}

/* ------------------------------------------------------------------ merge */

export type DuplicateStrategy = "skip" | "overwrite" | "keepBoth";

export type DuplicateInfo = {
    number: string;
    /** Same content as the invoice already saved, so importing changes nothing. */
    identical: boolean;
};

/** Which incoming invoices collide with saved ones (or with each other). */
export function findDuplicates(existing: InvoiceType[], incoming: InvoiceType[]): DuplicateInfo[] {
    const byNumber = new Map(existing.map((i) => [i.details.invoiceNumber, i]));
    const seen = new Set<string>();
    const out: DuplicateInfo[] = [];
    for (const inv of incoming) {
        const n = inv.details.invoiceNumber;
        const match = byNumber.get(n);
        if (match) out.push({ number: n, identical: !hasMeaningfulChange(match, inv) });
        else if (seen.has(n)) out.push({ number: n, identical: false });
        seen.add(n);
    }
    return out;
}

export type MergeResult<T> = { list: T[]; added: number; skipped: number; overwritten: number; renumbered: number };

export function mergeInvoices(
    existing: InvoiceType[],
    incoming: InvoiceType[],
    strategy: DuplicateStrategy,
    nextNumber: (previous: string) => string
): MergeResult<InvoiceType> {
    const list = [...existing];
    const index = new Map(list.map((i, n) => [i.details.invoiceNumber, n]));
    let added = 0, skipped = 0, overwritten = 0, renumbered = 0;

    for (const inv of incoming) {
        const number = inv.details.invoiceNumber;
        const at = index.get(number);
        if (at === undefined) {
            index.set(number, list.push(inv) - 1);
            added += 1;
            continue;
        }
        if (strategy === "skip") {
            skipped += 1;
        } else if (strategy === "overwrite") {
            list[at] = inv;
            overwritten += 1;
        } else {
            let fresh = nextNumber(number);
            for (let i = 0; i < 1000 && index.has(fresh); i++) fresh = nextNumber(fresh);
            index.set(fresh, list.push({ ...inv, details: { ...inv.details, invoiceNumber: fresh } }) - 1);
            added += 1;
            renumbered += 1;
        }
    }
    return { list, added, skipped, overwritten, renumbered };
}

export function mergeParties(
    existing: SavedParty[],
    incoming: SavedParty[],
    strategy: DuplicateStrategy
): MergeResult<SavedParty> {
    const list = [...existing];
    const index = new Map(list.map((p, n) => [clientKey(p), n]));
    let added = 0, skipped = 0, overwritten = 0;
    for (const p of incoming) {
        const at = index.get(clientKey(p));
        if (at === undefined) {
            index.set(clientKey(p), list.push(p) - 1);
            added += 1;
        } else if (strategy === "overwrite") {
            list[at] = { ...p, id: list[at].id };
            overwritten += 1;
        } else {
            // "keepBoth" has no meaning for an address book entry; it is a skip.
            skipped += 1;
        }
    }
    return { list, added, skipped, overwritten, renumbered: 0 };
}

export function mergeTemplates(existing: SavedTemplate[], incoming: SavedTemplate[]): MergeResult<SavedTemplate> {
    const list = [...existing];
    const names = new Set(list.map((t) => t.name.toLowerCase()));
    let added = 0, skipped = 0;
    for (const t of incoming) {
        if (names.has(t.name.toLowerCase()) || list.some((x) => x.id === t.id)) {
            skipped += 1;
            continue;
        }
        names.add(t.name.toLowerCase());
        list.push(t);
        added += 1;
    }
    return { list, added, skipped, overwritten: 0, renumbered: 0 };
}

export type { StoredStatus };
