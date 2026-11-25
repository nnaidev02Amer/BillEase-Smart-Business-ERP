"use client";

import { useCallback, useEffect, useState } from "react";

import { INVENTORY_EVENT, loadInventory } from "@/lib/inventory";
import type { Product, StockMovement } from "@/lib/products";

/**
 * The catalogue and stock ledger, kept fresh.
 *
 * Reloads whenever anything in the app changes inventory (the Products page,
 * an invoice being issued, a backup restore), so the picker on the invoice form
 * and the table on the Products page never show stale stock.
 */
export function useInventoryData() {
    const [data, setData] = useState<{ products: Product[]; movements: StockMovement[] }>({ products: [], movements: [] });
    const [loaded, setLoaded] = useState(false);

    const reload = useCallback(async () => {
        try {
            setData(await loadInventory());
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void reload();
        window.addEventListener(INVENTORY_EVENT, reload);
        return () => window.removeEventListener(INVENTORY_EVENT, reload);
    }, [reload]);

    return { ...data, loaded, reload };
}
