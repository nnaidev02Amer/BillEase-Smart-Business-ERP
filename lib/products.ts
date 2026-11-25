/**
 * Product catalogue and stock ledger: pure logic, no React and no storage.
 *
 * THE LEDGER IS THE SOURCE OF TRUTH
 *   A product never stores "quantity on hand". Stock is the sum of its
 *   movements (opening balance, purchases, adjustments, sales, returns), so it
 *   can always be audited and cannot drift from its own history.
 *
 * HOW INVOICES AFFECT STOCK (and why it cannot double-deduct)
 *   An invoice consumes stock while it is *issued* (status "sent"). For each
 *   invoice and product we compare
 *       desired  = quantity on the invoice's lines, if issued, else 0
 *       applied  = what the ledger already shows for that invoice + product
 *   and record only the difference. So:
 *       draft → sent         records a sale
 *       saving it again      records nothing (desired == applied)
 *       editing a quantity   records only the change
 *       sent → cancelled     records a return of everything
 *       deleting the invoice records a return
 *   Because the result depends on the ledger rather than on "an event
 *   happened", running the same sync twice, or after a crash, is harmless.
 *
 * SERVICES
 *   A line with no productId, or whose product is a service / untracked, never
 *   touches stock.
 */

import { stripControlChars } from "@/lib/schemas";
import { storedStatus } from "@/lib/invoiceRecords";
import type { InvoiceType } from "@/types";

/* ------------------------------------------------------------------ types */

export const PRODUCT_TYPES = ["product", "service"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const MOVEMENT_KINDS = ["opening", "purchase", "adjustment", "sale", "return"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export type Product = {
    id: string;
    name: string;
    sku: string;
    category: string;
    description: string;
    type: ProductType;
    /** Unit of measure printed on the line: pcs, kg, hr … */
    unit: string;
    sellingPrice: number;
    purchasePrice: number;
    /** GST rate in percent, used to prefill an invoice line. */
    taxRate: number;
    hsn: string;
    /** Whether stock is counted. Always false for services. */
    trackStock: boolean;
    /** Alert when stock is at or below this. 0 disables the alert. */
    minStock: number;
    archived: boolean;
    createdAt: string;
    updatedAt: string;
};

export type StockMovement = {
    id: string;
    productId: string;
    /** ISO timestamp. */
    date: string;
    /** Signed: positive adds stock, negative removes it. Never 0. */
    qty: number;
    kind: MovementKind;
    /** Set for sale / return movements generated from an invoice. */
    invoiceNumber?: string;
    /** Set for movements generated from a goods receipt: its id (stable, unlike its number). */
    grnId?: string;
    note?: string;
};

/* ---------------------------------------------------------------- numbers */

/** Quantities keep three decimals (kg, litres); more is float noise. */
export const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (v: unknown, min: number, max: number, fallback = 0): number => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const text = (v: unknown, max: number): string =>
    typeof v === "string" ? stripControlChars(v).trim().slice(0, max) : "";

/* -------------------------------------------------------------- sanitise */

/**
 * Accepts anything and returns a well-formed product, or null if it has no
 * usable id or name. Used on every read from storage and on backup import.
 */
export function sanitizeProduct(input: unknown): Product | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const id = text(o.id, 64);
    const name = text(o.name, 120);
    if (!id || !name) return null;

    const type: ProductType = o.type === "service" ? "service" : "product";
    const now = new Date().toISOString();
    return {
        id,
        name,
        sku: text(o.sku, 40).toUpperCase(),
        category: text(o.category, 60),
        description: text(o.description, 500),
        type,
        unit: text(o.unit, 20) || (type === "service" ? "hr" : "pcs"),
        sellingPrice: round2(num(o.sellingPrice, 0, 1e12)),
        purchasePrice: round2(num(o.purchasePrice, 0, 1e12)),
        taxRate: num(o.taxRate, 0, 100),
        hsn: text(o.hsn, 8).replace(/\D/g, ""),
        trackStock: type === "product" && o.trackStock !== false,
        minStock: round3(num(o.minStock, 0, 1e9)),
        archived: o.archived === true,
        createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
        updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : now,
    };
}

export function sanitizeMovement(input: unknown): StockMovement | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const id = text(o.id, 64);
    const productId = text(o.productId, 64);
    const qty = typeof o.qty === "number" ? round3(o.qty) : NaN;
    const kind = MOVEMENT_KINDS.find((k) => k === o.kind);
    if (!id || !productId || !Number.isFinite(qty) || qty === 0 || !kind) return null;
    const invoiceNumber = text(o.invoiceNumber, 100);
    const grnId = text(o.grnId, 64);
    const note = text(o.note, 200);
    return {
        id,
        productId,
        date: typeof o.date === "string" && !Number.isNaN(Date.parse(o.date)) ? o.date : new Date().toISOString(),
        qty,
        kind,
        ...(invoiceNumber ? { invoiceNumber } : {}),
        ...(grnId ? { grnId } : {}),
        ...(note ? { note } : {}),
    };
}

/* ------------------------------------------------------------- validation */

export type ProductErrors = Partial<Record<"name" | "sku" | "sellingPrice" | "purchasePrice" | "taxRate" | "hsn" | "minStock" | "openingStock", string>>;

export type ProductDraft = {
    name: string;
    sku: string;
    sellingPrice: string | number;
    purchasePrice: string | number;
    taxRate: string | number;
    hsn: string;
    minStock: string | number;
    openingStock?: string | number;
};

/**
 * Field-level problems, as error codes (`products.errors.<code>` in the locale
 * files). `others` are the other products, for SKU uniqueness.
 */
export function validateProduct(draft: ProductDraft, others: Product[], selfId?: string): ProductErrors {
    const errors: ProductErrors = {};
    if (text(draft.name, 120).length < 2) errors.name = "name";

    const sku = text(draft.sku, 40).toUpperCase();
    if (sku && others.some((p) => p.id !== selfId && p.sku === sku)) errors.sku = "skuTaken";

    const isNum = (v: unknown) => v === "" || v === undefined || Number.isFinite(Number(v));
    const nonNeg = (v: unknown) => isNum(v) && Number(v || 0) >= 0;
    if (!nonNeg(draft.sellingPrice)) errors.sellingPrice = "price";
    if (!nonNeg(draft.purchasePrice)) errors.purchasePrice = "price";
    if (!nonNeg(draft.minStock)) errors.minStock = "quantity";
    if (draft.openingStock !== undefined && !nonNeg(draft.openingStock)) errors.openingStock = "quantity";

    const rate = Number(draft.taxRate || 0);
    if (!isNum(draft.taxRate) || rate < 0 || rate > 100) errors.taxRate = "rate";

    const hsn = (draft.hsn ?? "").trim();
    if (hsn && !/^\d{2,8}$/.test(hsn)) errors.hsn = "hsn";
    return errors;
}

/* ------------------------------------------------------------------ stock */

export const isTracked = (p: Product) => p.type === "product" && p.trackStock;

export function stockLevels(movements: StockMovement[]): Map<string, number> {
    const levels = new Map<string, number>();
    for (const m of movements) levels.set(m.productId, round3((levels.get(m.productId) ?? 0) + m.qty));
    return levels;
}

export const stockOf = (productId: string, movements: StockMovement[]): number =>
    stockLevels(movements).get(productId) ?? 0;

export type StockStatus = "untracked" | "out" | "low" | "ok";

export function stockStatus(product: Product, stock: number): StockStatus {
    if (!isTracked(product)) return "untracked";
    if (stock <= 0) return "out";
    if (product.minStock > 0 && stock <= product.minStock) return "low";
    return "ok";
}

/** Active, tracked products at or below their minimum (or out of stock). */
export function lowStockProducts(products: Product[], movements: StockMovement[]) {
    const levels = stockLevels(movements);
    return products
        .filter((p) => !p.archived && isTracked(p))
        .map((p) => ({ product: p, stock: levels.get(p.id) ?? 0 }))
        .filter(({ product, stock }) => {
            const s = stockStatus(product, stock);
            // Out of stock only matters as an alert if the user wants alerts.
            return s === "low" || (s === "out" && product.minStock > 0);
        });
}

/* ----------------------------------------------------------------- search */

export type ProductQuery = {
    search: string;
    category: string;
    type: "all" | ProductType;
    stock: "all" | "ok" | "low" | "out";
    showArchived: boolean;
};

export const EMPTY_PRODUCT_QUERY: ProductQuery = { search: "", category: "", type: "all", stock: "all", showArchived: false };

export function queryProducts(products: Product[], movements: StockMovement[], q: ProductQuery) {
    const levels = stockLevels(movements);
    const needle = q.search.trim().toLowerCase();
    return products
        .filter((p) => (q.showArchived ? true : !p.archived))
        .filter((p) => (q.category ? p.category === q.category : true))
        .filter((p) => (q.type === "all" ? true : p.type === q.type))
        .filter((p) => {
            if (!needle) return true;
            return [p.name, p.sku, p.category, p.description, p.hsn].join(" ").toLowerCase().includes(needle);
        })
        .map((p) => ({ product: p, stock: levels.get(p.id) ?? 0 }))
        .filter(({ product, stock }) => {
            if (q.stock === "all") return true;
            const s = stockStatus(product, stock);
            return q.stock === "ok" ? s === "ok" : q.stock === "low" ? s === "low" : s === "out";
        })
        .sort((a, b) => a.product.name.localeCompare(b.product.name));
}

export const categoriesOf = (products: Product[]) =>
    [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/* ------------------------------------------------------- invoice → stock */

/** Quantity each tracked product consumes on one invoice, if it is issued. */
export function desiredConsumption(invoice: InvoiceType, tracked: Set<string>): Map<string, number> {
    const out = new Map<string, number>();
    if (storedStatus(invoice) !== "sent") return out;
    for (const item of invoice.details.items) {
        const id = item.productId;
        const qty = Number(item.quantity);
        if (!id || !tracked.has(id) || !Number.isFinite(qty) || qty <= 0) continue;
        out.set(id, round3((out.get(id) ?? 0) + qty));
    }
    return out;
}

const KEY = (invoiceNumber: string, productId: string) => `${invoiceNumber}\u0000${productId}`;

/** What the ledger says each invoice has consumed (sales minus returns). */
export function appliedConsumption(movements: StockMovement[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of movements) {
        if (!m.invoiceNumber || (m.kind !== "sale" && m.kind !== "return")) continue;
        const k = KEY(m.invoiceNumber, m.productId);
        out.set(k, round3((out.get(k) ?? 0) - m.qty));
    }
    return out;
}

export type Shortage = { productId: string; name: string; available: number; needed: number };

export type StockPlan = {
    /** Movements to append to the ledger. Empty when nothing needs to change. */
    movements: StockMovement[];
    /** Products that would go below zero because of this change. */
    shortages: Shortage[];
};

export type PlanOptions = {
    now?: Date;
    newId?: () => string;
};

/**
 * The difference between what the invoices say and what the ledger records.
 *
 * Idempotent: apply the returned movements and planning again yields none.
 * Pure: it neither reads nor writes storage, so callers can use it to *check*
 * a proposed change (is there enough stock?) before committing to it.
 */
export function planStockSync(
    products: Product[],
    movements: StockMovement[],
    invoices: InvoiceType[],
    { now = new Date(), newId = () => crypto.randomUUID() }: PlanOptions = {}
): StockPlan {
    const tracked = new Set(products.filter(isTracked).map((p) => p.id));
    const byId = new Map(products.map((p) => [p.id, p]));
    const applied = appliedConsumption(movements);

    // desired, per (invoice, product), across every current invoice
    const desired = new Map<string, number>();
    for (const inv of invoices) {
        const number = inv.details.invoiceNumber;
        for (const [productId, qty] of desiredConsumption(inv, tracked)) desired.set(KEY(number, productId), qty);
    }

    const planned: StockMovement[] = [];
    const net = new Map<string, number>(); // product → total consumed by this plan
    const date = now.toISOString();

    const keys = new Set([...desired.keys(), ...applied.keys()]);
    for (const key of keys) {
        const [invoiceNumber, productId] = key.split("\u0000");
        // A product that no longer exists or is no longer tracked is left alone.
        if (!tracked.has(productId)) continue;
        const delta = round3((desired.get(key) ?? 0) - (applied.get(key) ?? 0));
        if (delta === 0) continue;

        net.set(productId, round3((net.get(productId) ?? 0) + delta));
        planned.push({
            id: newId(),
            productId,
            date,
            qty: -delta, // consuming 3 = a movement of −3; releasing 3 = +3
            kind: delta > 0 ? "sale" : "return",
            invoiceNumber,
        });
    }

    const levels = stockLevels(movements);
    const shortages: Shortage[] = [];
    for (const [productId, consumed] of net) {
        const available = levels.get(productId) ?? 0;
        if (consumed > 0 && available - consumed < 0) {
            shortages.push({ productId, name: byId.get(productId)?.name ?? productId, available, needed: consumed });
        }
    }

    return { movements: planned, shortages };
}

/**
 * Would issuing / saving these invoices need more stock than exists?
 * Convenience for UI pre-checks.
 */
export const stockShortages = (products: Product[], movements: StockMovement[], invoices: InvoiceType[]) =>
    planStockSync(products, movements, invoices).shortages;

/* -------------------------------------------------------------- history */

export type HistoryRow = StockMovement & { balance: number };

/** One product's movements, oldest first, with a running balance. */
export function historyOf(productId: string, movements: StockMovement[]): HistoryRow[] {
    const rows = movements
        .filter((m) => m.productId === productId)
        .sort((a, b) => a.date.localeCompare(b.date));
    let balance = 0;
    return rows.map((m) => {
        balance = round3(balance + m.qty);
        return { ...m, balance };
    });
}
