/**
 * Storage for goods receipts, on the shared repository layer, and the stock-in
 * that goes with them.
 *
 * Shares `purchasingQueue` with suppliers and purchase orders, so a receipt
 * and the order it is against can never be changed at the same moment.
 *
 * ORDER OF WRITES, AND WHY IT IS SAFE TO INTERRUPT
 *   1. the receipt is saved (or voided);
 *   2. the stock ledger is brought in line with the receipts.
 *   Step 2 is idempotent and also runs every time the app loads, so if the
 *   browser closes between the two, the missing stock-in (or reversal) is
 *   recorded next time, exactly once.
 */

import { nextSequentialNumber } from "@/lib/docNumbers";
import {
    MAX_GOODS_RECEIPTS,
    GOODS_RECEIPTS_KEY,
    hasGrnErrors,
    overReceipts,
    priceChanges,
    receivedByLine,
    sanitizeGoodsReceipt,
    sanitizeGrnLine,
    validateGoodsReceipt,
    voidShortages,
    type GoodsReceipt,
    type GrnDraft,
    type GrnErrors,
    type GrnLine,
    type OverReceipt,
    type ReversalShortage,
} from "@/lib/goodsReceipts";
import { loadInventory, syncGoodsReceiptStock, updatePurchasePrices } from "@/lib/inventory";
import { stockLevels } from "@/lib/products";
import { readPurchaseOrders } from "@/lib/purchaseOrderStore";
import { createCollection, newId, subscribe } from "@/lib/repository";
import { purchasingQueue, readSuppliers } from "@/lib/supplierStore";

export const goodsReceiptsCollection = createCollection<GoodsReceipt>({
    name: "goodsReceipts",
    sanitise: sanitizeGoodsReceipt,
    max: MAX_GOODS_RECEIPTS,
    queue: purchasingQueue,
});

// The pure module names the key so the stock sync can read it without importing this store; they must agree.
if (goodsReceiptsCollection.key !== GOODS_RECEIPTS_KEY) throw new Error("goods receipt storage key mismatch");

export const GOODS_RECEIPTS_EVENT = goodsReceiptsCollection.event;
export const readGoodsReceipts = () => goodsReceiptsCollection.read();
export const subscribeGoodsReceipts = (listener: () => void) => subscribe(goodsReceiptsCollection, listener);

export type PostGrnInput = Omit<GrnDraft, "lines"> & {
    lines: GrnLine[];
    /** From Settings → Business profile → purchase prefixes. */
    prefix: string;
};

export type PostGrnOptions = {
    /** The user confirmed receiving more than was ordered. */
    allowOver?: boolean;
    /** The user asked to adopt this receipt's prices as the products' purchase prices, and confirmed. */
    updatePrices?: boolean;
};

export type PostGrnResult =
    | { ok: true; receipt: GoodsReceipt; stockMovements: number }
    | { ok: false; errors: GrnErrors }
    | { ok: false; overReceipt: OverReceipt[] }
    | { ok: false; reason: "limit" | "storage" };

/** Posts a receipt: validates it, saves it, records its stock-in, and (if asked) updates purchase prices. */
export async function postGoodsReceipt(input: PostGrnInput, { allowOver = false, updatePrices = false }: PostGrnOptions = {}, now: Date = new Date()): Promise<PostGrnResult> {
    let failure: PostGrnResult | null = null;
    const [suppliers, orders, inventory] = await Promise.all([readSuppliers(), readPurchaseOrders(), loadInventory()]);

    const res = await goodsReceiptsCollection.update<GoodsReceipt>((current) => {
        const errors = validateGoodsReceipt(input, { suppliers, orders, receipts: current });
        if (hasGrnErrors(errors)) {
            failure = { ok: false, errors };
            return null;
        }
        if (current.length >= MAX_GOODS_RECEIPTS) {
            failure = { ok: false, reason: "limit" };
            return null;
        }
        const po = input.poId ? orders.find((o) => o.id === input.poId) : undefined;
        if (po) {
            const over = overReceipts(po, input.lines, receivedByLine(current, po.id));
            if (over.length > 0 && !allowOver) {
                failure = { ok: false, overReceipt: over };
                return null;
            }
        }
        const supplier = suppliers.find((s) => s.id === input.supplierId)!;
        const stamp = now.toISOString();
        const candidate = sanitizeGoodsReceipt({
            id: newId("grn"),
            number: input.number.trim() || nextSequentialNumber(current.map((g) => g.number), { prefix: input.prefix }),
            supplierId: supplier.id,
            supplierName: supplier.name,
            ...(po ? { poId: po.id, poNumber: po.number } : {}),
            date: input.date,
            currency: input.currency || po?.currency || supplier.currency,
            reference: input.reference,
            note: input.note,
            // Lines where nothing arrived are noise, not part of the record.
            lines: input.lines.filter((l) => l.received > 0).map((l) => sanitizeGrnLine(l)).filter((l): l is GrnLine => l !== null),
            status: "posted",
            priceUpdates: [],
            createdAt: stamp,
            updatedAt: stamp,
        });
        if (!candidate) {
            failure = { ok: false, reason: "storage" };
            return null;
        }
        return { next: [...current, candidate], result: candidate };
    });
    if (!res.ok) return failure ?? { ok: false, reason: "storage" };

    // Stock-in, exactly once (see the header). A failure here is repaired by the next sync.
    const stockMovements = await syncGoodsReceiptStock();
    let receipt = res.result;

    if (updatePrices) {
        const changes = priceChanges(inventory.products, receipt.lines);
        const applied = changes.length > 0 ? await updatePurchasePrices(changes.map((c) => ({ productId: c.productId, to: c.to }))) : [];
        if (applied.length > 0) {
            const recorded = await goodsReceiptsCollection.update<GoodsReceipt>((current) => {
                const g = current.find((x) => x.id === receipt.id);
                if (!g) return null;
                const updated = { ...g, priceUpdates: applied };
                return { next: current.map((x) => (x.id === g.id ? updated : x)), result: updated };
            });
            if (recorded.ok) receipt = recorded.result;
        }
    }
    return { ok: true, receipt, stockMovements };
}

export type VoidGrnResult =
    | { ok: true; receipt: GoodsReceipt }
    | { ok: false; reason: "notFound" | "alreadyVoid" | "storage" }
    | { ok: false; reason: "insufficientStock"; shortages: ReversalShortage[] };

/**
 * Voids a posted receipt and reverses its stock exactly. Refused, with the
 * products named, if the goods have since been sold or used so the reversal
 * would take stock below zero. Purchase prices changed by the receipt are left
 * as they are.
 */
export async function voidGoodsReceipt(id: string, reason: string, now: Date = new Date()): Promise<VoidGrnResult> {
    // Make sure the ledger already reflects this receipt, or the stock check below could read too low.
    await syncGoodsReceiptStock();
    const { products, movements } = await loadInventory();
    const levels = stockLevels(movements);

    let failure: VoidGrnResult | null = null;
    const res = await goodsReceiptsCollection.update<GoodsReceipt>((current) => {
        const g = current.find((x) => x.id === id);
        if (!g) {
            failure = { ok: false, reason: "notFound" };
            return null;
        }
        if (g.status === "void") {
            failure = { ok: false, reason: "alreadyVoid" };
            return null;
        }
        const shortages = voidShortages(g, products, levels);
        if (shortages.length > 0) {
            failure = { ok: false, reason: "insufficientStock", shortages };
            return null;
        }
        const stamp = now.toISOString();
        const voided: GoodsReceipt = { ...g, status: "void", voidedAt: stamp, voidReason: reason.trim().slice(0, 300) || undefined, updatedAt: stamp };
        if (!voided.voidReason) delete voided.voidReason;
        return { next: current.map((x) => (x.id === id ? voided : x)), result: voided };
    });
    if (!res.ok) return failure ?? { ok: false, reason: "storage" };

    await syncGoodsReceiptStock();
    return { ok: true, receipt: res.result };
}

/** Replaces the whole list (backup restore). Stock is reconciled by the caller afterwards. */
export const replaceGoodsReceipts = (list: GoodsReceipt[]) => goodsReceiptsCollection.replace(list);
