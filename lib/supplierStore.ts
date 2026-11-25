/**
 * Storage for suppliers, on the shared repository layer.
 *
 * Suppliers and purchase orders share ONE queue (`purchasingQueue`), so
 * "delete this supplier" and "save a PO for this supplier" can never
 * interleave: the check that a supplier is unused and the delete happen as one
 * step. Encrypted at rest through lib/secureStore, like every other store.
 */

import { createCollection, createQueue, newId, storageKey, subscribe } from "@/lib/repository";
import {
    MAX_SUPPLIERS,
    sanitizeSupplier,
    supplierState,
    validateSupplier,
    type Supplier,
    type SupplierDraft,
    type SupplierErrors,
} from "@/lib/suppliers";
import { readSecure, writeSecure } from "@/lib/secureStore";

export const purchasingQueue = createQueue();

/** Where purchase orders live. Named here, not imported, so the two stores never import each other. */
const PURCHASE_ORDERS_KEY = storageKey("purchaseOrders");
const GOODS_RECEIPTS_KEY = storageKey("goodsReceipts");
const PURCHASE_BILLS_KEY = storageKey("purchaseBills");
const SUPPLIER_PAYMENTS_KEY = storageKey("supplierPayments");

export const suppliersCollection = createCollection<Supplier>({
    name: "suppliers",
    sanitise: sanitizeSupplier,
    max: MAX_SUPPLIERS,
    queue: purchasingQueue,
});

export const SUPPLIERS_KEY = suppliersCollection.key;
export const SUPPLIERS_EVENT = suppliersCollection.event;
export const readSuppliers = () => suppliersCollection.read();
export const subscribeSuppliers = (listener: () => void) => subscribe(suppliersCollection, listener);

export type SaveSupplierResult =
    | { ok: true; supplier: Supplier }
    | { ok: false; errors: SupplierErrors }
    | { ok: false; storage: true }
    | { ok: false; limit: true };

/** Creates a supplier, or updates `id`. Validation happens inside the queue, against what is really stored. */
export async function saveSupplier(draft: SupplierDraft, id?: string, now: Date = new Date()): Promise<SaveSupplierResult> {
    let failure: SaveSupplierResult | null = null;
    const res = await suppliersCollection.update<Supplier>((current) => {
        const errors = validateSupplier(draft, current, id);
        if (Object.keys(errors).length > 0) {
            failure = { ok: false, errors };
            return null;
        }
        if (!id && current.length >= MAX_SUPPLIERS) {
            failure = { ok: false, limit: true };
            return null;
        }
        const existing = id ? current.find((s) => s.id === id) : undefined;
        if (id && !existing) {
            failure = { ok: false, errors: { name: "notFound" } };
            return null;
        }
        const stamp = now.toISOString();
        const candidate = sanitizeSupplier({
            ...draft,
            id: existing?.id ?? newId("sup"),
            inactive: existing?.inactive ?? false,
            createdAt: existing?.createdAt ?? stamp,
            updatedAt: stamp,
        });
        if (!candidate) {
            failure = { ok: false, errors: { name: "nameRequired" } };
            return null;
        }
        // Keep the state the user typed only if it agrees with the GSTIN (validated above).
        candidate.state = supplierState(candidate);
        const next = existing ? current.map((s) => (s.id === existing.id ? candidate : s)) : [...current, candidate];
        return { next, result: candidate };
    });
    if (res.ok) return { ok: true, supplier: res.result };
    return failure ?? { ok: false, storage: true };
}

export async function setSupplierInactive(id: string, inactive: boolean): Promise<boolean> {
    const res = await suppliersCollection.update<void>((current) => {
        if (!current.some((s) => s.id === id)) return null;
        const stamp = new Date().toISOString();
        return { next: current.map((s) => (s.id === id ? { ...s, inactive, updatedAt: stamp } : s)), result: undefined };
    });
    return res.ok;
}

export type DeleteSupplierResult = { ok: true } | { ok: false; reason: "inUse" | "notFound" | "storage" };

/** Deletes a supplier that nothing refers to. One that has purchase orders can only be made inactive. */
export function deleteSupplier(id: string): Promise<DeleteSupplierResult> {
    // One queued step: the "is it used?" check and the delete cannot be separated by a PO save.
    return purchasingQueue(async (): Promise<DeleteSupplierResult> => {
        const [suppliers, orders, receipts, bills, payments] = await Promise.all([
            suppliersCollection.read(),
            readSecure<unknown>(PURCHASE_ORDERS_KEY),
            readSecure<unknown>(GOODS_RECEIPTS_KEY),
            readSecure<unknown>(PURCHASE_BILLS_KEY),
            readSecure<unknown>(SUPPLIER_PAYMENTS_KEY),
        ]);
        if (!suppliers.some((s) => s.id === id)) return { ok: false, reason: "notFound" };
        const refersTo = (list: unknown) => Array.isArray(list) && list.some((o) => o && typeof o === "object" && (o as { supplierId?: unknown }).supplierId === id);
        const used = refersTo(orders) || refersTo(receipts) || refersTo(bills) || refersTo(payments);
        if (used) return { ok: false, reason: "inUse" };
        if (!(await writeSecure(SUPPLIERS_KEY, suppliers.filter((s) => s.id !== id)))) return { ok: false, reason: "storage" };
        suppliersCollection.announce();
        return { ok: true };
    });
}

/** Replaces the whole list (backup restore). */
export const replaceSuppliers = (list: Supplier[]) => suppliersCollection.replace(list);
