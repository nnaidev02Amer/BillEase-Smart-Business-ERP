/**
 * Storage for purchase bills, on the shared repository layer.
 *
 * Shares `purchasingQueue` with the rest of purchasing, so a bill and the
 * payments, order or receipts around it cannot be changed at the same moment.
 *
 * WHAT A BILL MAY DO
 *   - Saving always keeps a bill a draft. Posting is its own step, because it is
 *     the point where the debt exists and the order is matched.
 *   - Posting checks the bill against its order and receipts. Differences are
 *     returned as warnings and the bill is not posted until the caller says it
 *     has seen them (`allowMismatch`); nothing is silently accepted.
 *   - A bill with payments against it cannot be sent back to draft, cancelled or
 *     deleted. These rules are enforced here, whatever the screen does.
 */

import { nextSequentialNumber } from "@/lib/docNumbers";
import { receivedByLine } from "@/lib/goodsReceipts";
import {
    MAX_PURCHASE_BILLS,
    billedByLine,
    canDelete,
    canEdit,
    canTransition,
    hasBillErrors,
    matchBill,
    sanitizePurchaseBill,
    validatePurchaseBill,
    type BillDraft,
    type BillErrors,
    type BillStatus,
    type MatchIssue,
    type PurchaseBill,
} from "@/lib/purchaseBills";
import { readPurchaseOrders } from "@/lib/purchaseOrderStore";
import { snapshotOf } from "@/lib/purchaseOrders";
import { readPaymentsRaw, readReceiptsRaw } from "@/lib/purchasingRaw";
import { allocatedTo } from "@/lib/supplierPayments";
import { createCollection, newId, subscribe } from "@/lib/repository";
import { purchasingQueue, readSuppliers } from "@/lib/supplierStore";


export const purchaseBillsCollection = createCollection<PurchaseBill>({
    name: "purchaseBills",
    sanitise: sanitizePurchaseBill,
    max: MAX_PURCHASE_BILLS,
    queue: purchasingQueue,
});

export const PURCHASE_BILLS_KEY = purchaseBillsCollection.key;
export const PURCHASE_BILLS_EVENT = purchaseBillsCollection.event;
export const readPurchaseBills = () => purchaseBillsCollection.read();
export const subscribePurchaseBills = (listener: () => void) => subscribe(purchaseBillsCollection, listener);

export type SaveBillInput = BillDraft & {
    poId?: string;
    grnIds?: string[];
    itcEligible: boolean;
    notes: string;
    /** From Settings → Business profile → purchase prefixes. */
    prefix: string;
};

export type SaveBillResult =
    | { ok: true; bill: PurchaseBill }
    | { ok: false; errors: BillErrors }
    | { ok: false; reason: "notFound" | "notEditable" | "limit" | "storage" };

/** Creates a draft bill, or updates the draft `id`. */
export async function savePurchaseBill(input: SaveBillInput, id?: string, now: Date = new Date()): Promise<SaveBillResult> {
    let failure: SaveBillResult | null = null;
    const [suppliers, orders] = await Promise.all([readSuppliers(), readPurchaseOrders()]);

    const res = await purchaseBillsCollection.update<PurchaseBill>((current) => {
        const errors = validatePurchaseBill(input, suppliers, current, id);
        if (hasBillErrors(errors)) {
            failure = { ok: false, errors };
            return null;
        }
        const existing = id ? current.find((b) => b.id === id) : undefined;
        if (id && !existing) {
            failure = { ok: false, reason: "notFound" };
            return null;
        }
        if (existing && !canEdit(existing)) {
            failure = { ok: false, reason: "notEditable" };
            return null;
        }
        if (!existing && current.length >= MAX_PURCHASE_BILLS) {
            failure = { ok: false, reason: "limit" };
            return null;
        }
        const supplier = suppliers.find((s) => s.id === input.supplierId)!;
        const po = input.poId ? orders.find((o) => o.id === input.poId) : undefined;
        const stamp = now.toISOString();
        const keepSnapshot = existing && existing.supplierId === input.supplierId;
        const candidate = sanitizePurchaseBill({
            id: existing?.id ?? newId("bill"),
            number: input.number.trim() || existing?.number || nextSequentialNumber(current.map((b) => b.number), { prefix: input.prefix }),
            supplierBillNo: input.supplierBillNo,
            supplierId: supplier.id,
            supplier: keepSnapshot ? existing.supplier : snapshotOf(supplier),
            ...(po ? { poId: po.id, poNumber: po.number } : {}),
            grnIds: input.grnIds ?? existing?.grnIds ?? [],
            billDate: input.billDate,
            dueDate: input.dueDate,
            currency: input.currency,
            lines: input.lines,
            discount: input.discount,
            freight: input.freight,
            gstEnabled: input.gstEnabled,
            itcEligible: input.itcEligible,
            notes: input.notes,
            status: existing?.status ?? "draft",
            log: [...(existing?.log ?? []), { at: stamp, kind: existing ? "edited" : "created" }],
            createdAt: existing?.createdAt ?? stamp,
            updatedAt: stamp,
        });
        if (!candidate) {
            failure = { ok: false, reason: "storage" };
            return null;
        }
        return { next: existing ? current.map((b) => (b.id === existing.id ? candidate : b)) : [...current, candidate], result: candidate };
    });
    if (res.ok) return { ok: true, bill: res.result };
    return failure ?? { ok: false, reason: "storage" };
}

export type ChangeBillStatusResult =
    | { ok: true; bill: PurchaseBill }
    | { ok: false; reason: "notFound" | "notAllowed" | "storage" }
    | { ok: false; reason: "mismatch"; issues: MatchIssue[] }
    | { ok: false; errors: BillErrors };

/**
 * Moves a bill to `to` if the lifecycle allows it. Posting re-checks the bill
 * and matches it against its order and receipts; differences come back as
 * `mismatch` unless `allowMismatch` says the user has seen them.
 */
export async function changePurchaseBillStatus(id: string, to: BillStatus, { allowMismatch = false }: { allowMismatch?: boolean } = {}, now: Date = new Date()): Promise<ChangeBillStatusResult> {
    let failure: ChangeBillStatusResult | null = null;
    // Payments and receipts decide what is allowed; read them from storage, not from the caller.
    const [payments, receipts, orders, suppliers] = await Promise.all([readPaymentsRaw(), readReceiptsRaw(), readPurchaseOrders(), readSuppliers()]);

    const res = await purchaseBillsCollection.update<PurchaseBill>((current) => {
        const bill = current.find((b) => b.id === id);
        if (!bill) {
            failure = { ok: false, reason: "notFound" };
            return null;
        }
        if (!canTransition(bill.status, to, { hasPayments: allocatedTo(payments, bill.id) > 0 })) {
            failure = { ok: false, reason: "notAllowed" };
            return null;
        }
        if (to === "posted") {
            const errors = validatePurchaseBill(
                { number: bill.number, supplierId: bill.supplierId, supplierBillNo: bill.supplierBillNo, billDate: bill.billDate, dueDate: bill.dueDate, currency: bill.currency, lines: bill.lines, discount: bill.discount, freight: bill.freight, gstEnabled: bill.gstEnabled },
                suppliers,
                current,
                bill.id
            );
            if (hasBillErrors(errors)) {
                failure = { ok: false, errors };
                return null;
            }
            const po = bill.poId ? orders.find((o) => o.id === bill.poId) : undefined;
            const issues = matchBill(bill, po, bill.poId ? receivedByLine(receipts, bill.poId) : new Map(), bill.poId ? billedByLine(current, bill.poId, bill.id) : new Map());
            if (issues.length > 0 && !allowMismatch) {
                failure = { ok: false, reason: "mismatch", issues };
                return null;
            }
        }
        const stamp = now.toISOString();
        const changed: PurchaseBill = { ...bill, status: to, updatedAt: stamp, log: [...bill.log, { at: stamp, kind: to }].slice(-50) };
        return { next: current.map((b) => (b.id === id ? changed : b)), result: changed };
    });
    if (res.ok) return { ok: true, bill: res.result };
    return failure ?? { ok: false, reason: "storage" };
}

export type DeleteBillResult = { ok: true } | { ok: false; reason: "notFound" | "notAllowed" | "storage" };

export async function deletePurchaseBill(id: string): Promise<DeleteBillResult> {
    let failure: DeleteBillResult | null = null;
    const payments = await readPaymentsRaw();
    const res = await purchaseBillsCollection.update<void>((current) => {
        const bill = current.find((b) => b.id === id);
        if (!bill) {
            failure = { ok: false, reason: "notFound" };
            return null;
        }
        if (!canDelete(bill, { hasPayments: payments.some((p) => p.allocations.some((a) => a.billId === id)) })) {
            failure = { ok: false, reason: "notAllowed" };
            return null;
        }
        return { next: current.filter((b) => b.id !== id), result: undefined };
    });
    if (res.ok) return { ok: true };
    return failure ?? { ok: false, reason: "storage" };
}

/** Replaces the whole list (backup restore). */
export const replacePurchaseBills = (list: PurchaseBill[]) => purchaseBillsCollection.replace(list);
