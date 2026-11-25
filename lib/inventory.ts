/**
 * Storage and operations for the product catalogue and the stock ledger.
 *
 * Lives beside partyStore: same encrypted browser store, validated on every
 * read, and kept behind plain async functions so the whole module can later be
 * swapped for a database-backed implementation without touching the UI.
 *
 * Every read-modify-write goes through one queue. Two quick actions (a save
 * landing while a sync is running) therefore cannot interleave and lose an
 * update.
 */

import { readSecure, writeSecure } from "@/lib/secureStore";
import { GOODS_RECEIPTS_KEY, planGrnSync, sanitizeGoodsReceipt, type GoodsReceipt, type PriceUpdate } from "@/lib/goodsReceipts";
import {
    isTracked,
    planStockSync,
    round3,
    sanitizeMovement,
    sanitizeProduct,
    stockOf,
    validateProduct,
    type Product,
    type ProductDraft,
    type ProductErrors,
    type ProductType,
    type StockMovement,
    type StockPlan,
} from "@/lib/products";
import type { InvoiceType } from "@/types";

export const PRODUCTS_KEY = "invoify:products";
export const MOVEMENTS_KEY = "invoify:stockMovements";
export const INVENTORY_EVENT = "invoify:inventory-changed";

const MAX_PRODUCTS = 5_000;
const MAX_MOVEMENTS = 100_000;

/* ------------------------------------------------------------------ queue */

let queue: Promise<unknown> = Promise.resolve();
/** Runs `task` after everything already queued, whatever happened to it. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
}

const announce = () => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(INVENTORY_EVENT));
};

/* ------------------------------------------------------------------ reads */

export async function readProducts(): Promise<Product[]> {
    const raw = await readSecure<unknown>(PRODUCTS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeProduct).filter((p): p is Product => p !== null);
}

export async function readMovements(): Promise<StockMovement[]> {
    const raw = await readSecure<unknown>(MOVEMENTS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeMovement).filter((m): m is StockMovement => m !== null);
}

export async function loadInventory() {
    const [products, movements] = await Promise.all([readProducts(), readMovements()]);
    return { products, movements };
}

/** Replaces a whole store (backup restore). Not queued on its own: callers hold the queue via `replaceInventory`. */
const writeProducts = (list: Product[]) => writeSecure(PRODUCTS_KEY, list.slice(0, MAX_PRODUCTS));
const writeMovements = (list: StockMovement[]) => writeSecure(MOVEMENTS_KEY, list.slice(-MAX_MOVEMENTS));

export function replaceInventory(products: Product[], movements: StockMovement[]) {
    return enqueue(async () => {
        const ok = (await writeProducts(products)) && (await writeMovements(movements));
        announce();
        return ok;
    });
}

/* ------------------------------------------------------------ invoice sync */

/**
 * Brings the ledger in line with the invoices (see lib/products for the rules).
 * Safe to call as often as you like: with nothing to change it writes nothing.
 *
 * Negative stock is allowed *here*. Refusing happens earlier, at the point the
 * user issues the invoice (`stockShortages`); by the time we are syncing the
 * invoice is already saved, and leaving the ledger out of step with it would be
 * worse than a negative balance that the low-stock alert will flag.
 */
export function syncInventory(invoices: InvoiceType[]): Promise<StockPlan> {
    return syncInventoryAndLoad(invoices).then((r) => r.plan);
}

/**
 * `syncInventory`, but also hands back the catalogue and ledger as they stand
 * once the sync is done. The app's start-up used to sync and then immediately
 * `loadInventory()` again to fill its pre-check cache: the same two encrypted
 * records decrypted and parsed twice in a row, the ledger being the big one.
 * Sync already holds them, so it returns them.
 */
export function syncInventoryAndLoad(
    invoices: InvoiceType[]
): Promise<{ plan: StockPlan; products: Product[]; movements: StockMovement[] }> {
    return enqueue(async () => {
        const { products, movements } = await loadInventory();
        const plan = planStockSync(products, movements, invoices);
        // Goods receipts are reconciled in the same step, so a receipt whose stock-in was interrupted
        // (browser closed mid-write) is finished the next time the app loads, with no double count.
        const intake = planGrnSync(products, movements, await readReceipts());
        const planned = [...plan.movements, ...intake];
        let written = false;
        if (planned.length > 0) {
            written = await writeMovements([...movements, ...planned]);
            announce();
        }
        // Mirror what a fresh read would return: writeMovements keeps the newest MAX_MOVEMENTS,
        // and a write that failed leaves the stored ledger as it was.
        const after = written ? [...movements, ...planned].slice(-MAX_MOVEMENTS) : movements;
        return { plan, products, movements: after };
    });
}

/* ---------------------------------------------------------- goods receipts */

async function readReceipts(): Promise<GoodsReceipt[]> {
    const raw = await readSecure<unknown>(GOODS_RECEIPTS_KEY);
    return Array.isArray(raw) ? raw.map(sanitizeGoodsReceipt).filter((g): g is GoodsReceipt => g !== null) : [];
}

/**
 * Brings the ledger in line with the saved goods receipts: a posted receipt
 * records its stock-in once, a voided one records the exact reversal, and with
 * nothing to change it writes nothing. Returns how many movements it recorded.
 */
export function syncGoodsReceiptStock(): Promise<number> {
    return enqueue(async () => {
        const { products, movements } = await loadInventory();
        const planned = planGrnSync(products, movements, await readReceipts());
        if (planned.length > 0) {
            await writeMovements([...movements, ...planned]);
            announce();
        }
        return planned.length;
    });
}

/**
 * Sets purchase prices from a receipt, for the products whose price really
 * differs. Returns what was changed. Only called when the user asked for it and
 * confirmed.
 */
export function updatePurchasePrices(changes: { productId: string; to: number }[]): Promise<PriceUpdate[]> {
    return enqueue(async () => {
        const products = await readProducts();
        const wanted = new Map(changes.map((c) => [c.productId, c.to]));
        const applied: PriceUpdate[] = [];
        const stamp = new Date().toISOString();
        const next = products.map((p) => {
            const to = wanted.get(p.id);
            if (to === undefined || !(to > 0) || to === p.purchasePrice) return p;
            applied.push({ productId: p.id, name: p.name, from: p.purchasePrice, to });
            return { ...p, purchasePrice: to, updatedAt: stamp };
        });
        if (applied.length === 0) return [];
        if (!(await writeProducts(next))) return [];
        announce();
        return applied;
    });
}

/* --------------------------------------------------------------- products */

export type SaveProductInput = ProductDraft & {
    type: ProductType;
    category: string;
    description: string;
    unit: string;
    trackStock: boolean;
};

export type SaveProductResult =
    | { ok: true; product: Product }
    | { ok: false; errors: ProductErrors }
    | { ok: false; storage: true };

/** Creates a product, or updates `id`. A new tracked product may start with stock. */
export function saveProduct(input: SaveProductInput, id?: string): Promise<SaveProductResult> {
    return enqueue(async () => {
        const [products, movements] = await Promise.all([readProducts(), readMovements()]);
        const errors = validateProduct(input, products, id);
        if (Object.keys(errors).length > 0) return { ok: false as const, errors };
        if (!id && products.length >= MAX_PRODUCTS) return { ok: false as const, errors: { name: "limit" } };

        const now = new Date().toISOString();
        const existing = id ? products.find((p) => p.id === id) : undefined;
        const candidate = sanitizeProduct({
            ...input,
            id: existing?.id ?? crypto.randomUUID(),
            archived: existing?.archived ?? false,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            trackStock: input.type === "product" && input.trackStock,
        });
        if (!candidate) return { ok: false as const, errors: { name: "name" } };

        const next = existing ? products.map((p) => (p.id === candidate.id ? candidate : p)) : [...products, candidate];
        if (!(await writeProducts(next))) return { ok: false as const, storage: true as const };

        const opening = round3(Number(input.openingStock || 0));
        if (!existing && isTracked(candidate) && opening > 0) {
            const movement: StockMovement = {
                id: crypto.randomUUID(),
                productId: candidate.id,
                date: now,
                qty: opening,
                kind: "opening",
                note: "Opening stock",
            };
            await writeMovements([...movements, movement]);
        }
        announce();
        return { ok: true as const, product: candidate };
    });
}

export type AdjustResult = { ok: true; stock: number } | { ok: false; reason: "notFound" | "notTracked" | "zero" | "negative" | "storage"; stock?: number };

/**
 * Manual stock change: positive for a purchase / found stock, negative for
 * damage or loss. Refuses to take stock below zero.
 */
export function adjustStock(
    productId: string,
    qty: number,
    kind: "purchase" | "adjustment",
    note: string
): Promise<AdjustResult> {
    return enqueue(async () => {
        const { products, movements } = await loadInventory();
        const product = products.find((p) => p.id === productId);
        if (!product) return { ok: false as const, reason: "notFound" as const };
        if (!isTracked(product)) return { ok: false as const, reason: "notTracked" as const };

        const change = round3(qty);
        if (!Number.isFinite(change) || change === 0) return { ok: false as const, reason: "zero" as const };

        const current = stockOf(productId, movements);
        if (current + change < 0) return { ok: false as const, reason: "negative" as const, stock: current };

        const movement = sanitizeMovement({
            id: crypto.randomUUID(),
            productId,
            date: new Date().toISOString(),
            qty: change,
            kind,
            note,
        });
        if (!movement) return { ok: false as const, reason: "zero" as const };
        if (!(await writeMovements([...movements, movement]))) return { ok: false as const, reason: "storage" as const };
        announce();
        return { ok: true as const, stock: round3(current + change) };
    });
}

export function setArchived(productId: string, archived: boolean): Promise<boolean> {
    return enqueue(async () => {
        const products = await readProducts();
        const ok = await writeProducts(
            products.map((p) => (p.id === productId ? { ...p, archived, updatedAt: new Date().toISOString() } : p))
        );
        announce();
        return ok;
    });
}

export const isProductInUse = (productId: string, invoices: InvoiceType[]) =>
    invoices.some((inv) => inv.details.items.some((item) => item.productId === productId));

export type DeleteResult = { ok: true } | { ok: false; reason: "inUse" | "storage" };

/**
 * Deletes a product and its history, but only if no invoice refers to it. A
 * product that has been sold is archived instead, so old invoices and the
 * ledger keep making sense.
 */
export function deleteProduct(productId: string, invoices: InvoiceType[]): Promise<DeleteResult> {
    return enqueue(async () => {
        if (isProductInUse(productId, invoices)) return { ok: false as const, reason: "inUse" as const };
        const { products, movements } = await loadInventory();
        const ok =
            (await writeProducts(products.filter((p) => p.id !== productId))) &&
            (await writeMovements(movements.filter((m) => m.productId !== productId)));
        announce();
        return ok ? { ok: true as const } : { ok: false as const, reason: "storage" as const };
    });
}

/* ----------------------------------------------------------------- backup */

/**
 * Merges imported catalogue data.
 *
 * A product already held (same id, or same SKU) is skipped, and so is its
 * history: this browser's ledger for it is already the record, and adding the
 * file's movements on top would count the same stock twice. Only products the
 * merge actually adds bring their movements along. Importing one file twice
 * therefore adds nothing the second time.
 */
export function mergeInventory(
    existingProducts: Product[],
    existingMovements: StockMovement[],
    incomingProducts: Product[],
    incomingMovements: StockMovement[]
) {
    const products = [...existingProducts];
    const ids = new Set(products.map((p) => p.id));
    const skus = new Set(products.map((p) => p.sku).filter(Boolean));
    const added = new Set<string>();
    let skippedProducts = 0;

    for (const p of incomingProducts) {
        if (ids.has(p.id) || (p.sku && skus.has(p.sku))) {
            skippedProducts++;
            continue;
        }
        products.push(p);
        ids.add(p.id);
        if (p.sku) skus.add(p.sku);
        added.add(p.id);
    }

    const movements = [...existingMovements];
    const movementIds = new Set(movements.map((m) => m.id));
    let addedMovements = 0;
    for (const m of incomingMovements) {
        if (!added.has(m.productId) || movementIds.has(m.id)) continue;
        movements.push(m);
        movementIds.add(m.id);
        addedMovements++;
    }
    return { products, movements, addedProducts: added.size, skippedProducts, addedMovements };
}
