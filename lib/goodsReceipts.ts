/**
 * Goods receipts (GRN): pure logic, no React and no storage.
 *
 * A goods receipt records what a supplier actually delivered. It is the moment
 * stock goes up, and it is what a purchase bill is later checked against. A
 * receipt may be raised against a purchase order (so the order's progress
 * moves) or direct, with no order at all.
 *
 * RECEIVED, REJECTED, ACCEPTED
 *   `received`  what arrived at the door.
 *   `rejected`  the part of it refused (damaged, wrong item). It never enters
 *               stock and does not count toward the order.
 *   accepted  = received − rejected. This is what goes into stock and what
 *               the purchase order counts as delivered.
 *
 * THE STOCK LEDGER STAYS THE SOURCE OF TRUTH
 *   A receipt does not "add stock"; the ledger records movements that say so.
 *   Those movements are kept in step with the receipts by the same idea that
 *   keeps invoices from double-deducting (see lib/products): for each receipt
 *   and product we compare
 *       desired  = accepted quantity, if the receipt is posted, else 0
 *       applied  = what the ledger already shows for that receipt + product
 *   and record only the difference. So posting records a stock-in, running the
 *   sync again records nothing, voiding records the exact reversal, and a
 *   write that was interrupted half-way is finished by the next sync.
 *   A receipt that no longer exists is left alone rather than reversed: losing
 *   a record must never silently take stock away.
 *
 * IMMUTABLE ONCE POSTED
 *   A posted receipt is not edited. To correct one, void it (which reverses its
 *   stock exactly) and enter it again. That keeps every stock figure traceable.
 */

import { isValidDay } from "@/lib/expenses";
import { isNumberTaken } from "@/lib/docNumbers";
import { round3, round2, type PoLine, type PurchaseOrder } from "@/lib/purchaseOrders";
import { isTracked, type Product, type StockMovement } from "@/lib/products";
import { toCsv } from "@/lib/invoiceRecords";
import { stripControlChars } from "@/lib/schemas";

/** Where receipts live. Named here so the stock sync can read them without importing the store. */
export const GOODS_RECEIPTS_KEY = "invoify:goodsReceipts";
export const MAX_GOODS_RECEIPTS = 20_000;
export const MAX_GRN_LINES = 200;

/* ------------------------------------------------------------------ types */

export const GRN_STATUSES = ["posted", "void"] as const;
export type GrnStatus = (typeof GRN_STATUSES)[number];

export type GrnLine = {
    id: string;
    /** The purchase order line this delivers, if raised against an order. */
    poLineId?: string;
    productId?: string;
    name: string;
    unit: string;
    received: number;
    rejected: number;
    /** Price per unit as delivered, before tax. */
    unitPrice: number;
};

export type PriceUpdate = { productId: string; name: string; from: number; to: number };

export type GoodsReceipt = {
    id: string;
    number: string;
    supplierId: string;
    supplierName: string;
    poId?: string;
    /** The order's number when the receipt was made, kept so it still reads right if the order is later gone. */
    poNumber?: string;
    /** yyyy-mm-dd */
    date: string;
    currency: string;
    /** The supplier's delivery note or challan number. */
    reference: string;
    note: string;
    lines: GrnLine[];
    status: GrnStatus;
    voidedAt?: string;
    voidReason?: string;
    /** Purchase prices changed when this receipt was posted, kept as a record. Voiding does not undo them. */
    priceUpdates: PriceUpdate[];
    createdAt: string;
    updatedAt: string;
};

/* ---------------------------------------------------------------- numbers */

const clip = (v: unknown, max: number) => (typeof v === "string" ? stripControlChars(v).trim().slice(0, max) : "");
const num = (v: unknown, min: number, max: number, fallback = 0): number => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** What goes into stock for a line. */
export const accepted = (l: Pick<GrnLine, "received" | "rejected">) => round3(Math.max(0, l.received - l.rejected));

/* -------------------------------------------------------------- sanitise */

export function sanitizeGrnLine(input: unknown): GrnLine | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const id = clip(o.id, 64);
    const name = clip(o.name, 120);
    if (!id || !name) return null;
    const received = round3(num(o.received, 0, 1e9));
    const poLineId = clip(o.poLineId, 64);
    const productId = clip(o.productId, 64);
    return {
        id,
        ...(poLineId ? { poLineId } : {}),
        ...(productId ? { productId } : {}),
        name,
        unit: clip(o.unit, 20) || "pcs",
        received,
        // Rejected can never exceed what arrived.
        rejected: Math.min(received, round3(num(o.rejected, 0, 1e9))),
        unitPrice: round2(num(o.unitPrice, 0, 1e12)),
    };
}

function sanitizePriceUpdate(input: unknown): PriceUpdate | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const productId = clip(o.productId, 64);
    if (!productId) return null;
    return { productId, name: clip(o.name, 120), from: round2(num(o.from, 0, 1e12)), to: round2(num(o.to, 0, 1e12)) };
}

export function sanitizeGoodsReceipt(input: unknown): GoodsReceipt | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const id = clip(o.id, 64);
    const number = clip(o.number, 40);
    const supplierId = clip(o.supplierId, 64);
    const date = typeof o.date === "string" && isValidDay(o.date) ? o.date : "";
    const status = GRN_STATUSES.find((s) => s === o.status);
    if (!id || !number || !supplierId || !date || !status) return null;

    const lines = (Array.isArray(o.lines) ? o.lines : [])
        .slice(0, MAX_GRN_LINES)
        .map(sanitizeGrnLine)
        .filter((l): l is GrnLine => l !== null);
    if (lines.length === 0) return null;

    const currency = clip(o.currency, 3).toUpperCase();
    const poId = clip(o.poId, 64);
    const poNumber = clip(o.poNumber, 40);
    const now = new Date().toISOString();
    const voidedAt = typeof o.voidedAt === "string" ? o.voidedAt : "";
    const voidReason = clip(o.voidReason, 300);
    return {
        id,
        number,
        supplierId,
        supplierName: clip(o.supplierName, 120),
        ...(poId ? { poId } : {}),
        ...(poId && poNumber ? { poNumber } : {}),
        date,
        currency: /^[A-Z]{3}$/.test(currency) ? currency : "INR",
        reference: clip(o.reference, 80),
        note: clip(o.note, 1000),
        lines,
        status,
        ...(status === "void" && voidedAt ? { voidedAt } : {}),
        ...(status === "void" && voidReason ? { voidReason } : {}),
        priceUpdates: (Array.isArray(o.priceUpdates) ? o.priceUpdates : []).slice(0, MAX_GRN_LINES).map(sanitizePriceUpdate).filter((p): p is PriceUpdate => p !== null),
        createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
        updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : now,
    };
}

/* ------------------------------------------------- receipts of an order */

/** Accepted quantity received so far per purchase-order line, from posted receipts only. */
export function receivedByLine(receipts: GoodsReceipt[], poId: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const g of receipts) {
        if (g.poId !== poId || g.status !== "posted") continue;
        for (const l of g.lines) {
            if (l.poLineId) out.set(l.poLineId, round3((out.get(l.poLineId) ?? 0) + accepted(l)));
        }
    }
    return out;
}

/** Every order's received map at once, for list screens. */
export function receivedByOrder(receipts: GoodsReceipt[]): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    for (const g of receipts) {
        if (!g.poId || g.status !== "posted") continue;
        let m = out.get(g.poId);
        if (!m) out.set(g.poId, (m = new Map()));
        for (const l of g.lines) if (l.poLineId) m.set(l.poLineId, round3((m.get(l.poLineId) ?? 0) + accepted(l)));
    }
    return out;
}

/** Whether goods have been received against the order (posted receipts only). */
export const hasPostedReceipts = (receipts: GoodsReceipt[], poId: string) => receipts.some((g) => g.poId === poId && g.status === "posted");

/** Whether any receipt, posted or void, refers to the order (so it must not be deleted). */
export const hasAnyReceipts = (receipts: GoodsReceipt[], poId: string) => receipts.some((g) => g.poId === poId);

/** How much of each order line is still to come. Never negative. */
export function remainingByLine(po: Pick<PurchaseOrder, "lines">, received: Map<string, number>): Map<string, number> {
    return new Map(po.lines.map((l) => [l.id, round3(Math.max(0, l.quantity - (received.get(l.id) ?? 0)))]));
}

/** An order can take more goods while it is sent. Drafts have not been placed; closed and cancelled are over. */
export const canReceiveAgainst = (po: Pick<PurchaseOrder, "status">) => po.status === "sent";

/**
 * Editing an order that already has goods received against it: a line can't be
 * removed, and can't be cut below what has arrived. Returns error codes by line
 * id, plus `removed` line ids.
 */
export function checkEditAgainstReceipts(newLines: Pick<PoLine, "id" | "quantity">[], received: Map<string, number>) {
    const lineErrors: Record<string, string> = {};
    const removed: string[] = [];
    const ids = new Set(newLines.map((l) => l.id));
    for (const [lineId, qty] of received) {
        if (qty > 0 && !ids.has(lineId)) removed.push(lineId);
    }
    for (const l of newLines) {
        if (l.quantity < (received.get(l.id) ?? 0)) lineErrors[l.id] = "belowReceived";
    }
    return { lineErrors, removed };
}

/* ------------------------------------------------------------- validation */

export type GrnDraft = {
    number: string;
    supplierId: string;
    poId?: string;
    date: string;
    reference: string;
    note: string;
    currency: string;
    lines: GrnLine[];
};

export type GrnLineField = "name" | "received" | "rejected" | "unitPrice";
export type GrnErrors = {
    supplier?: string;
    order?: string;
    date?: string;
    number?: string;
    lines?: string;
    /** line id → field → error code */
    lineErrors: Record<string, Partial<Record<GrnLineField, string>>>;
};

export const hasGrnErrors = (e: GrnErrors) => Object.entries(e).some(([k, v]) => (k === "lineErrors" ? Object.keys(v as object).length > 0 : Boolean(v)));

/** Error codes are `goodsReceipts.errors.<code>` keys in the locale files. */
export function validateGoodsReceipt(
    draft: GrnDraft,
    ctx: { suppliers: { id: string }[]; orders: PurchaseOrder[]; receipts: GoodsReceipt[] }
): GrnErrors {
    const errors: GrnErrors = { lineErrors: {} };
    if (!draft.supplierId || !ctx.suppliers.some((s) => s.id === draft.supplierId)) errors.supplier = "supplierRequired";
    if (!isValidDay(draft.date)) errors.date = "dateInvalid";

    if (draft.poId) {
        const po = ctx.orders.find((o) => o.id === draft.poId);
        if (!po) errors.order = "orderNotFound";
        else if (!canReceiveAgainst(po)) errors.order = "orderNotOpen";
        else if (po.supplierId !== draft.supplierId) errors.order = "orderSupplierMismatch";
    }
    const number = draft.number.trim();
    if (number && isNumberTaken(number, ctx.receipts)) errors.number = "numberTaken";

    if (draft.lines.length === 0) errors.lines = "linesRequired";
    else if (draft.lines.length > MAX_GRN_LINES) errors.lines = "linesLimit";
    else if (!draft.lines.some((l) => l.received > 0)) errors.lines = "nothingReceived";

    for (const l of draft.lines) {
        const e: Partial<Record<GrnLineField, string>> = {};
        if (!clip(l.name, 120)) e.name = "nameRequired";
        if (!(l.received >= 0) || l.received > 1e9) e.received = "quantityInvalid";
        if (!(l.rejected >= 0) || l.rejected > l.received) e.rejected = "rejectedTooMany";
        if (!(l.unitPrice >= 0)) e.unitPrice = "priceInvalid";
        if (Object.keys(e).length) errors.lineErrors[l.id] = e;
    }
    return errors;
}

/* ---------------------------------------------------------- over-receipt */

export type OverReceipt = { poLineId: string; name: string; ordered: number; alreadyReceived: number; nowAccepted: number; over: number };

/**
 * Lines of this receipt that would take an order line past its ordered
 * quantity. It is a warning to confirm, not an error: suppliers do over-ship.
 */
export function overReceipts(po: Pick<PurchaseOrder, "lines">, lines: GrnLine[], received: Map<string, number>): OverReceipt[] {
    const incoming = new Map<string, number>();
    for (const l of lines) if (l.poLineId) incoming.set(l.poLineId, round3((incoming.get(l.poLineId) ?? 0) + accepted(l)));
    const out: OverReceipt[] = [];
    for (const pl of po.lines) {
        const already = received.get(pl.id) ?? 0;
        const now = incoming.get(pl.id) ?? 0;
        const over = round3(already + now - pl.quantity);
        if (now > 0 && over > 0) out.push({ poLineId: pl.id, name: pl.name, ordered: pl.quantity, alreadyReceived: already, nowAccepted: now, over });
    }
    return out;
}

/** Receipt lines pre-filled from what is still to come on an order. */
export function linesFromOrder(po: Pick<PurchaseOrder, "lines">, received: Map<string, number>, newId: () => string): GrnLine[] {
    const remaining = remainingByLine(po, received);
    return po.lines
        .filter((l) => (remaining.get(l.id) ?? 0) > 0)
        .map((l) => ({
            id: newId(),
            poLineId: l.id,
            ...(l.productId ? { productId: l.productId } : {}),
            name: l.name,
            unit: l.unit,
            received: remaining.get(l.id) ?? 0,
            rejected: 0,
            unitPrice: l.unitPrice,
        }));
}

/* ---------------------------------------------------------------- stock */

const KEY = (grnId: string, productId: string) => `${grnId}\u0000${productId}`;

/** Accepted quantity per (receipt, product) that the ledger should show, over tracked products. */
function desiredIntake(receipts: GoodsReceipt[], tracked: Set<string>): Map<string, number> {
    const out = new Map<string, number>();
    for (const g of receipts) {
        for (const l of g.lines) {
            if (!l.productId || !tracked.has(l.productId)) continue;
            const q = g.status === "posted" ? accepted(l) : 0;
            out.set(KEY(g.id, l.productId), round3((out.get(KEY(g.id, l.productId)) ?? 0) + q));
        }
    }
    return out;
}

/** What the ledger already shows for each (receipt, product). */
function appliedIntake(movements: StockMovement[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of movements) {
        if (!m.grnId) continue;
        out.set(KEY(m.grnId, m.productId), round3((out.get(KEY(m.grnId, m.productId)) ?? 0) + m.qty));
    }
    return out;
}

/**
 * The movements that bring the ledger in line with the receipts. Empty when it
 * already is, so it is safe to run as often as you like.
 */
export function planGrnSync(
    products: Product[],
    movements: StockMovement[],
    receipts: GoodsReceipt[],
    { now = new Date(), newId = () => crypto.randomUUID() }: { now?: Date; newId?: () => string } = {}
): StockMovement[] {
    const tracked = new Set(products.filter(isTracked).map((p) => p.id));
    const byId = new Map(receipts.map((g) => [g.id, g]));
    const desired = desiredIntake(receipts, tracked);
    const applied = appliedIntake(movements);
    const date = now.toISOString();

    const planned: StockMovement[] = [];
    // Only receipts that still exist are reconciled: a missing record is never read as "reverse it".
    for (const [key, want] of desired) {
        const delta = round3(want - (applied.get(key) ?? 0));
        if (delta === 0) continue;
        const [grnId, productId] = key.split("\u0000");
        const g = byId.get(grnId)!;
        planned.push({
            id: newId(),
            productId,
            date,
            qty: delta,
            kind: delta > 0 ? "purchase" : "adjustment",
            grnId,
            note: delta > 0 ? `${g.number} · ${g.supplierName}`.slice(0, 200) : `Reversal of ${g.number}`.slice(0, 200),
        });
    }
    return planned;
}

export type ReversalShortage = { productId: string; name: string; available: number; needed: number };

/**
 * Would voiding this receipt take any product's stock below zero (because the
 * goods have since been sold or used)? Returns those products. Voiding is
 * refused in that case: the reversal would make the books say something that
 * cannot be true.
 */
export function voidShortages(receipt: GoodsReceipt, products: Product[], levels: Map<string, number>): ReversalShortage[] {
    const tracked = new Map(products.filter(isTracked).map((p) => [p.id, p]));
    const needed = new Map<string, number>();
    for (const l of receipt.lines) {
        if (l.productId && tracked.has(l.productId)) needed.set(l.productId, round3((needed.get(l.productId) ?? 0) + accepted(l)));
    }
    const out: ReversalShortage[] = [];
    for (const [productId, qty] of needed) {
        const available = levels.get(productId) ?? 0;
        if (qty > 0 && available - qty < 0) out.push({ productId, name: tracked.get(productId)!.name, available, needed: qty });
    }
    return out;
}

/* ------------------------------------------------------------------ price */

/**
 * Purchase prices that would change if this receipt's prices were adopted. A
 * suggestion only: nothing is applied unless the user asks for it and
 * confirms. Lines that bring nothing in (all rejected) never propose a price.
 */
export function priceChanges(products: Product[], lines: GrnLine[]): PriceUpdate[] {
    const byId = new Map(products.map((p) => [p.id, p]));
    const out = new Map<string, PriceUpdate>();
    for (const l of lines) {
        if (!l.productId || l.unitPrice <= 0 || accepted(l) <= 0) continue;
        const p = byId.get(l.productId);
        if (!p || p.purchasePrice === l.unitPrice) continue;
        out.set(p.id, { productId: p.id, name: p.name, from: p.purchasePrice, to: l.unitPrice });
    }
    return [...out.values()];
}

/* -------------------------------------------------------------- listing */

export type GrnQuery = { q: string; status: GrnStatus | "all"; poId: string };
export const EMPTY_GRN_QUERY: GrnQuery = { q: "", status: "all", poId: "" };

export function queryGoodsReceipts(list: GoodsReceipt[], query: GrnQuery): GoodsReceipt[] {
    const q = query.q.trim().toLowerCase();
    return list
        .filter((g) => query.status === "all" || g.status === query.status)
        .filter((g) => !query.poId || g.poId === query.poId)
        .filter((g) => !q || [g.number, g.supplierName, g.poNumber ?? "", g.reference].some((f) => f.toLowerCase().includes(q)) || g.lines.some((l) => l.name.toLowerCase().includes(q)))
        .sort((a, b) => (a.date === b.date ? b.number.localeCompare(a.number) : b.date.localeCompare(a.date)));
}

export const totalsOf = (g: Pick<GoodsReceipt, "lines">) => ({
    received: round3(g.lines.reduce((s, l) => s + l.received, 0)),
    rejected: round3(g.lines.reduce((s, l) => s + l.rejected, 0)),
    accepted: round3(g.lines.reduce((s, l) => s + accepted(l), 0)),
});

export function goodsReceiptsCsv(list: GoodsReceipt[]): string {
    return toCsv(
        ["GRN #", "Status", "Supplier", "PO #", "Date", "Reference", "Item", "Received", "Rejected", "Accepted", "Unit", "Unit price", "Currency"],
        list.flatMap((g) => g.lines.map((l) => [g.number, g.status, g.supplierName, g.poNumber ?? "", g.date, g.reference, l.name, l.received, l.rejected, accepted(l), l.unit, l.unitPrice, g.currency]))
    );
}

/** Merge for backup restore: ids already held are kept; a clashing number is renumbered, never dropped. */
export function mergeGoodsReceipts(existing: GoodsReceipt[], incoming: GoodsReceipt[], remapSupplier: Map<string, string>, renumber: (taken: string[]) => string) {
    const list = [...existing];
    const ids = new Set(existing.map((g) => g.id));
    let added = 0;
    let skipped = 0;
    let renumbered = 0;
    for (const raw of incoming) {
        if (ids.has(raw.id) || list.length >= MAX_GOODS_RECEIPTS) {
            skipped++;
            continue;
        }
        let g = { ...raw, supplierId: remapSupplier.get(raw.supplierId) ?? raw.supplierId };
        if (isNumberTaken(g.number, list)) {
            g = { ...g, number: renumber(list.map((x) => x.number)) };
            renumbered++;
        }
        list.push(g);
        ids.add(g.id);
        added++;
    }
    return { list, added, skipped, renumbered };
}

export const goodsReceiptFilename = (number: string) => `goods-receipt-${number.replace(/[^\w.-]+/g, "_")}.csv`;
