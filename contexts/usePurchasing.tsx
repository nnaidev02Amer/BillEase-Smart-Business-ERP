"use client";

import { useCallback, useEffect, useState } from "react";

import type { GoodsReceipt } from "@/lib/goodsReceipts";
import { readGoodsReceipts, subscribeGoodsReceipts } from "@/lib/goodsReceiptStore";
import type { PurchaseBill } from "@/lib/purchaseBills";
import { readPurchaseBills, subscribePurchaseBills } from "@/lib/purchaseBillStore";
import { readPurchaseOrders, subscribePurchaseOrders } from "@/lib/purchaseOrderStore";
import type { PurchaseOrder } from "@/lib/purchaseOrders";
import { readSuppliers, subscribeSuppliers } from "@/lib/supplierStore";
import type { Supplier } from "@/lib/suppliers";
import type { SupplierPayment } from "@/lib/supplierPayments";
import { readSupplierPayments, subscribeSupplierPayments } from "@/lib/supplierPaymentStore";

/**
 * A stored list, kept fresh: reloads whenever anything in the app changes it
 * (a save on this page, a backup restore, a "clear data").
 */
function useStored<T>(read: () => Promise<T[]>, subscribeTo: (listener: () => void) => () => void) {
    const [items, setItems] = useState<T[]>([]);
    const [loaded, setLoaded] = useState(false);

    const reload = useCallback(async () => {
        try {
            setItems(await read());
        } finally {
            setLoaded(true);
        }
    }, [read]);

    useEffect(() => {
        void reload();
        return subscribeTo(reload);
    }, [reload, subscribeTo]);

    return { items, loaded, reload };
}

export function useSuppliers() {
    const { items, loaded, reload } = useStored<Supplier>(readSuppliers, subscribeSuppliers);
    return { suppliers: items, loaded, reload };
}

export function useGoodsReceipts() {
    const { items, loaded, reload } = useStored<GoodsReceipt>(readGoodsReceipts, subscribeGoodsReceipts);
    return { receipts: items, loaded, reload };
}

export function usePurchaseBills() {
    const { items, loaded, reload } = useStored<PurchaseBill>(readPurchaseBills, subscribePurchaseBills);
    return { bills: items, loaded, reload };
}

export function useSupplierPayments() {
    const { items, loaded, reload } = useStored<SupplierPayment>(readSupplierPayments, subscribeSupplierPayments);
    return { payments: items, loaded, reload };
}

export function usePurchaseOrders() {
    const { items, loaded, reload } = useStored<PurchaseOrder>(readPurchaseOrders, subscribePurchaseOrders);
    return { orders: items, loaded, reload };
}
