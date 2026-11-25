/**
 * Storage for purchase orders, on the shared repository layer.
 *
 * Shares `purchasingQueue` with suppliers (see supplierStore). The PO number is
 * allocated INSIDE the queued step, from what is really stored, so two quick
 * saves can never be given the same number.
 */

import { nextSequentialNumber } from "@/lib/docNumbers";
import {
    GOODS_RECEIPTS_KEY,
    checkEditAgainstReceipts,
    hasAnyReceipts,
    hasPostedReceipts,
    receivedByLine,
    sanitizeGoodsReceipt,
    type GoodsReceipt,
} from "@/lib/goodsReceipts";
import { createCollection, newId, subscribe } from "@/lib/repository";
import {
    MAX_PURCHASE_ORDERS,
    canEdit,
    canTransition,
    hasErrors,
    sanitizePurchaseOrder,
    snapshotOf,
    validatePurchaseOrder,
    type PoDraft,
    type PoErrors,
    type PoStatus,
    type PurchaseOrder,
} from "@/lib/purchaseOrders";
import { readBillsRaw } from "@/lib/purchasingRaw";
import { readSecure } from "@/lib/secureStore";
import { purchasingQueue, readSuppliers } from "@/lib/supplierStore";

/**
 * Receipts are read straight from storage rather than through their own store,
 * which imports this one. They decide what an order may still do: once goods
 * have arrived against it, it cannot be cancelled, sent back to draft or
 * deleted, and its lines cannot be removed or cut below what was received.
 */
async function readReceipts(): Promise<GoodsReceipt[]> {
    const raw = await readSecure<unknown>(GOODS_RECEIPTS_KEY);
    return Array.isArray(raw) ? raw.map(sanitizeGoodsReceipt).filter((g): g is GoodsReceipt => g !== null) : [];
}

export const purchaseOrdersCollection = createCollection<PurchaseOrder>({
    name: "purchaseOrders",
    sanitise: sanitizePurchaseOrder,
    max: MAX_PURCHASE_ORDERS,
    queue: purchasingQueue,
});

export const PURCHASE_ORDERS_KEY = purchaseOrdersCollection.key;
export const PURCHASE_ORDERS_EVENT = purchaseOrdersCollection.event;
export const readPurchaseOrders = () => purchaseOrdersCollection.read();
export const subscribePurchaseOrders = (listener: () => void) => subscribe(purchaseOrdersCollection, listener);

export type SavePoInput = PoDraft & {
    paymentTerms: string;
    notes: string;
    terms: string;
    /** From Settings → Business profile → purchase prefixes. */
    prefix: string;
};

export type SavePoResult =
    | { ok: true; order: PurchaseOrder }
    | { ok: false; errors: PoErrors }
    | { ok: false; reason: "notFound" | "notEditable" | "limit" | "storage" };

/**
 * Creates a PO, or updates `id`. A blank number is allocated from the prefix.
 * The supplier snapshot is refreshed from the live supplier on create, and on
 * edit only when the supplier was changed, so an old PO keeps the details it
 * was written with.
 */
export async function savePurchaseOrder(input: SavePoInput, id?: string, now: Date = new Date()): Promise<SavePoResult> {
    let failure: SavePoResult | null = null;
    const [suppliers, receipts] = await Promise.all([readSuppliers(), readReceipts()]);
    const res = await purchaseOrdersCollection.update<PurchaseOrder>((current) => {
        const errors = validatePurchaseOrder(input, suppliers, current, id);
        if (hasErrors(errors)) {
            failure = { ok: false, errors };
            return null;
        }
        const existing = id ? current.find((p) => p.id === id) : undefined;
        if (id && !existing) {
            failure = { ok: false, reason: "notFound" };
            return null;
        }
        if (existing && !canEdit(existing)) {
            failure = { ok: false, reason: "notEditable" };
            return null;
        }
        if (existing) {
            const got = receivedByLine(receipts, existing.id);
            if (got.size > 0) {
                const locked: PoErrors = { lineErrors: {} };
                if (input.supplierId !== existing.supplierId) locked.supplier = "supplierLocked";
                const check = checkEditAgainstReceipts(input.lines, got);
                for (const [lineId, code] of Object.entries(check.lineErrors)) locked.lineErrors[lineId] = { quantity: code };
                if (check.removed.length > 0) locked.lines = "receivedLineRemoved";
                if (hasErrors(locked)) {
                    failure = { ok: false, errors: locked };
                    return null;
                }
            }
        }
        if (!existing && current.length >= MAX_PURCHASE_ORDERS) {
            failure = { ok: false, reason: "limit" };
            return null;
        }
        const supplier = suppliers.find((s) => s.id === input.supplierId)!;
        const stamp = now.toISOString();
        const number = input.number.trim() || existing?.number || nextSequentialNumber(current.map((p) => p.number), { prefix: input.prefix });
        const keepSnapshot = existing && existing.supplierId === input.supplierId;
        const candidate = sanitizePurchaseOrder({
            id: existing?.id ?? newId("po"),
            number,
            supplierId: input.supplierId,
            supplier: keepSnapshot ? existing.supplier : snapshotOf(supplier),
            date: input.date,
            expectedDate: input.expectedDate,
            currency: input.currency,
            lines: input.lines,
            discount: input.discount,
            freight: input.freight,
            gstEnabled: input.gstEnabled,
            paymentTerms: input.paymentTerms,
            notes: input.notes,
            terms: input.terms,
            status: existing?.status ?? "draft",
            log: [...(existing?.log ?? []), { at: stamp, kind: existing ? "edited" : "created" }],
            createdAt: existing?.createdAt ?? stamp,
            updatedAt: stamp,
        });
        if (!candidate) {
            failure = { ok: false, reason: "storage" };
            return null;
        }
        const next = existing ? current.map((p) => (p.id === existing.id ? candidate : p)) : [...current, candidate];
        return { next, result: candidate };
    });
    if (res.ok) return { ok: true, order: res.result };
    return failure ?? { ok: false, reason: "storage" };
}

export type ChangeStatusResult = { ok: true; order: PurchaseOrder } | { ok: false; reason: "notFound" | "notAllowed" | "storage" };

/** Moves a PO to `to` if the status flow allows it. `hasReceipts` (from goods receipts) forbids going back to draft or cancelling. */
export async function changePurchaseOrderStatus(id: string, to: PoStatus, opts: { hasReceipts?: boolean } = {}, now: Date = new Date()): Promise<ChangeStatusResult> {
    let failure: ChangeStatusResult | null = null;
    // Whatever the caller says, goods already received settle it.
    // A posted bill is as final as a receipt: the order is no longer just a request.
    const billed = (await readBillsRaw()).some((b) => b.poId === id && b.status === "posted");
    const hasReceipts = opts.hasReceipts || billed || hasPostedReceipts(await readReceipts(), id);
    const res = await purchaseOrdersCollection.update<PurchaseOrder>((current) => {
        const po = current.find((p) => p.id === id);
        if (!po) {
            failure = { ok: false, reason: "notFound" };
            return null;
        }
        if (!canTransition(po.status, to, { hasReceipts })) {
            failure = { ok: false, reason: "notAllowed" };
            return null;
        }
        const stamp = now.toISOString();
        const changed: PurchaseOrder = { ...po, status: to, updatedAt: stamp, log: [...po.log, { at: stamp, kind: to }].slice(-50) };
        return { next: current.map((p) => (p.id === id ? changed : p)), result: changed };
    });
    if (res.ok) return { ok: true, order: res.result };
    return failure ?? { ok: false, reason: "storage" };
}

export type DeletePoResult = { ok: true } | { ok: false; reason: "notFound" | "notAllowed" | "storage" };

export async function deletePurchaseOrder(id: string, opts: { hasReceipts?: boolean } = {}): Promise<DeletePoResult> {
    let failure: DeletePoResult | null = null;
    const hasReceipts = opts.hasReceipts || hasAnyReceipts(await readReceipts(), id) || (await readBillsRaw()).some((b) => b.poId === id);
    const res = await purchaseOrdersCollection.update<void>((current) => {
        const po = current.find((p) => p.id === id);
        if (!po) {
            failure = { ok: false, reason: "notFound" };
            return null;
        }
        // Same rule the UI uses: only a draft or cancelled order that nothing refers to.
        if (!((po.status === "draft" || po.status === "cancelled") && !hasReceipts)) {
            failure = { ok: false, reason: "notAllowed" };
            return null;
        }
        return { next: current.filter((p) => p.id !== id), result: undefined };
    });
    if (res.ok) return { ok: true };
    return failure ?? { ok: false, reason: "storage" };
}

/** Replaces the whole list (backup restore). */
export const replacePurchaseOrders = (list: PurchaseOrder[]) => purchaseOrdersCollection.replace(list);
