/**
 * Read-only access to purchasing records straight from storage.
 *
 * The stores for orders, receipts, bills and payments each need to look at the
 * others before they allow a change (an order with bills cannot be cancelled; a
 * bill with payments cannot be edited). They cannot import each other without
 * creating a cycle, so the lookups live here: validated reads, no writes.
 */

import { sanitizeGoodsReceipt, type GoodsReceipt } from "@/lib/goodsReceipts";
import { sanitizePurchaseBill, type PurchaseBill } from "@/lib/purchaseBills";
import { storageKey } from "@/lib/repository";
import { readSecure } from "@/lib/secureStore";
import { sanitizeSupplierPayment, type SupplierPayment } from "@/lib/supplierPayments";

export const PURCHASE_BILLS_KEY = storageKey("purchaseBills");
export const SUPPLIER_PAYMENTS_KEY = storageKey("supplierPayments");
export const GOODS_RECEIPTS_STORAGE_KEY = storageKey("goodsReceipts");

async function readList<T>(key: string, sanitise: (raw: unknown) => T | null): Promise<T[]> {
    const raw = await readSecure<unknown>(key);
    return Array.isArray(raw) ? raw.map(sanitise).filter((x): x is T => x !== null) : [];
}

export const readBillsRaw = () => readList<PurchaseBill>(PURCHASE_BILLS_KEY, sanitizePurchaseBill);
export const readPaymentsRaw = () => readList<SupplierPayment>(SUPPLIER_PAYMENTS_KEY, sanitizeSupplierPayment);
export const readReceiptsRaw = () => readList<GoodsReceipt>(GOODS_RECEIPTS_STORAGE_KEY, sanitizeGoodsReceipt);
