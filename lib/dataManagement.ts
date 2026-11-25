/**
 * Everything the app keeps in this browser, and the operations on it as a
 * whole: collect it for a backup, restore a validated backup, measure it, and
 * clear it. Single-purpose stores (invoices, parties, templates, settings) own
 * their own reads and writes; this module is only the cross-cutting layer.
 */

import {
    mergeInvoices,
    mergeParties,
    mergeTemplates,
    type BackupAnalysis,
    type BackupData,
    type DuplicateStrategy,
} from "@/lib/backup";
import {
    MOVEMENTS_KEY,
    PRODUCTS_KEY,
    loadInventory,
    mergeInventory,
    readMovements,
    readProducts,
    replaceInventory,
} from "@/lib/inventory";
import { partyStorageKey, readParties, replaceParties } from "@/lib/partyStore";
import { EXPENSES_KEY, EXPENSE_CATEGORIES_KEY, loadExpenseData, mergeExpenseData, replaceExpenseData } from "@/lib/expenseStore";
import { QUOTATIONS_KEY, mergeQuotations, readQuotations, replaceQuotations } from "@/lib/quotationStore";
import { nextSequentialNumber } from "@/lib/docNumbers";
import { GOODS_RECEIPTS_KEY, mergeGoodsReceipts } from "@/lib/goodsReceipts";
import { readGoodsReceipts, replaceGoodsReceipts } from "@/lib/goodsReceiptStore";
import { syncGoodsReceiptStock } from "@/lib/inventory";
import { mergePurchaseBills } from "@/lib/purchaseBills";
import { PURCHASE_BILLS_KEY, readPurchaseBills, replacePurchaseBills } from "@/lib/purchaseBillStore";
import { mergePurchaseOrders } from "@/lib/purchaseOrders";
import { mergeSupplierPayments } from "@/lib/supplierPayments";
import { SUPPLIER_PAYMENTS_KEY, readSupplierPayments, replaceSupplierPayments } from "@/lib/supplierPaymentStore";
import { PURCHASE_ORDERS_KEY, readPurchaseOrders, replacePurchaseOrders } from "@/lib/purchaseOrderStore";
import { SUPPLIERS_KEY, readSuppliers, replaceSuppliers } from "@/lib/supplierStore";
import { mergeSuppliers } from "@/lib/suppliers";
import { readSecure, removeSecure, writeSecure } from "@/lib/secureStore";
import { readSettings, successorFn, writeSettings, SETTINGS_KEY } from "@/lib/settings";
import { readTemplates, writeTemplates, TEMPLATES_KEY } from "@/lib/templateStore";
import { LOCAL_STORAGE_INVOICE_DRAFT_KEY } from "@/lib/variables";
import type { InvoiceType } from "@/types";

/**
 * Unprefixed, unlike the newer invoify: keys — it predates that namespace and
 * renaming it would orphan every invoice anyone has saved.
 */
export const SAVED_INVOICES_KEY = "savedInvoices";
export const RECENT_KEY = "invoify:recentInvoices";

export type DataScope = "invoices" | "clients" | "senders" | "templates" | "settings" | "draft" | "products" | "stock" | "quotations" | "expenses" | "expenseCategories" | "suppliers" | "purchaseOrders" | "goodsReceipts" | "purchaseBills" | "supplierPayments" | "all";

export const SCOPE_KEYS: Record<Exclude<DataScope, "all">, string> = {
    invoices: SAVED_INVOICES_KEY,
    clients: partyStorageKey("receiver"),
    senders: partyStorageKey("sender"),
    templates: TEMPLATES_KEY,
    settings: SETTINGS_KEY,
    draft: LOCAL_STORAGE_INVOICE_DRAFT_KEY,
    products: PRODUCTS_KEY,
    stock: MOVEMENTS_KEY,
    quotations: QUOTATIONS_KEY,
    expenses: EXPENSES_KEY,
    expenseCategories: EXPENSE_CATEGORIES_KEY,
    suppliers: SUPPLIERS_KEY,
    purchaseOrders: PURCHASE_ORDERS_KEY,
    goodsReceipts: GOODS_RECEIPTS_KEY,
    purchaseBills: PURCHASE_BILLS_KEY,
    supplierPayments: SUPPLIER_PAYMENTS_KEY,
};

export async function readInvoices(): Promise<InvoiceType[]> {
    const stored = await readSecure<InvoiceType[]>(SAVED_INVOICES_KEY);
    return Array.isArray(stored) ? stored : [];
}

export const writeInvoices = (list: InvoiceType[]) => writeSecure(SAVED_INVOICES_KEY, list);

/** Reads every store. `invoices` may be passed when the caller holds a fresher copy. */
export async function collectBackupData(invoices?: InvoiceType[]): Promise<BackupData> {
    const [inv, clients, senders, templates, settings, products, stockMovements, quotations, expenseData, suppliers, purchaseOrders, goodsReceipts, purchaseBills, supplierPayments] = await Promise.all([
        invoices ? Promise.resolve(invoices) : readInvoices(),
        readParties("receiver"),
        readParties("sender"),
        readTemplates(),
        readSettings(),
        readProducts(),
        readMovements(),
        readQuotations(),
        loadExpenseData(),
        readSuppliers(),
        readPurchaseOrders(),
        readGoodsReceipts(),
        readPurchaseBills(),
        readSupplierPayments(),
    ]);
    return { invoices: inv, clients, senders, templates, settings, products, stockMovements, quotations, expenses: expenseData.expenses, expenseCategories: expenseData.categories, suppliers, purchaseOrders, goodsReceipts, purchaseBills, supplierPayments };
}

export type ApplyOptions = {
    strategy: DuplicateStrategy;
    restoreSettings: boolean;
};

export type ApplySummary = {
    invoices: { added: number; skipped: number; overwritten: number; renumbered: number };
    clients: { added: number; skipped: number; overwritten: number };
    senders: { added: number; skipped: number; overwritten: number };
    templates: { added: number; skipped: number };
    products: { added: number; skipped: number };
    quotations: { added: number; skipped: number };
    expenses: { added: number; skipped: number; refiled: number; categoriesAdded: number };
    suppliers: { added: number; skipped: number };
    purchaseOrders: { added: number; skipped: number; renumbered: number };
    goodsReceipts: { added: number; skipped: number; renumbered: number };
    purchaseBills: { added: number; skipped: number; renumbered: number };
    supplierPayments: { added: number; skipped: number; renumbered: number };
    settingsRestored: boolean;
    /** False if the browser refused a write (quota, disabled storage). */
    allWritten: boolean;
};

/**
 * Writes a validated backup into the stores. Callers must have run
 * `analyseBackup` first; this never accepts raw text.
 */
export async function applyBackup(
    analysis: Extract<BackupAnalysis, { ok: true }>,
    { strategy, restoreSettings }: ApplyOptions
): Promise<ApplySummary> {
    const { data } = analysis;
    const [existingInvoices, existingClients, existingSenders, existingTemplates, settings, existingInventory, existingQuotations, existingExpenses, existingSuppliers, existingOrders, existingReceipts, existingBills, existingPayments] =
        await Promise.all([
            readInvoices(),
            readParties("receiver"),
            readParties("sender"),
            readTemplates(),
            readSettings(),
            loadInventory(),
            readQuotations(),
            loadExpenseData(),
            readSuppliers(),
            readPurchaseOrders(),
            readGoodsReceipts(),
            readPurchaseBills(),
            readSupplierPayments(),
        ]);

    const inv = mergeInvoices(existingInvoices, data.invoices, strategy, successorFn(settings, existingInvoices));
    const cli = mergeParties(existingClients, data.clients, strategy);
    const sen = mergeParties(existingSenders, data.senders, strategy);
    const tpl = mergeTemplates(existingTemplates, data.templates);
    const quo = mergeQuotations(existingQuotations, data.quotations);
    const exp = mergeExpenseData(existingExpenses, { expenses: data.expenses, categories: data.expenseCategories });
    const sup = mergeSuppliers(existingSuppliers, data.suppliers);
    // Orders restored with a supplier that was recognised as one already held follow it to that supplier.
    const ord = mergePurchaseOrders(existingOrders, data.purchaseOrders, sup.remap, (taken) =>
        nextSequentialNumber(taken, { prefix: settings.purchase.poPrefix })
    );
    const rec = mergeGoodsReceipts(existingReceipts, data.goodsReceipts, sup.remap, (taken) =>
        nextSequentialNumber(taken, { prefix: settings.purchase.grnPrefix })
    );
    const bil = mergePurchaseBills(existingBills, data.purchaseBills, sup.remap, (taken) =>
        nextSequentialNumber(taken, { prefix: settings.purchase.billPrefix })
    );
    const spm = mergeSupplierPayments(existingPayments, data.supplierPayments, sup.remap, (taken) =>
        nextSequentialNumber(taken, { prefix: settings.purchase.paymentPrefix })
    );
    const stock = mergeInventory(existingInventory.products, existingInventory.movements, data.products, data.stockMovements);

    const writes: boolean[] = [];
    if (inv.added || inv.overwritten) writes.push(await writeInvoices(inv.list));
    if (cli.added || cli.overwritten) await replaceParties("receiver", cli.list);
    if (sen.added || sen.overwritten) await replaceParties("sender", sen.list);
    if (tpl.added) writes.push(await writeTemplates(tpl.list));
    // Catalogue before invoices are re-synced, so a restored issued invoice
    // finds its products and its recorded sales already in place.
    if (quo.added) writes.push(await replaceQuotations(quo.list));
    if (exp.added || exp.addedCategories) writes.push(await replaceExpenseData(exp.expenses, exp.categories));
    // Suppliers before the orders that point at them.
    if (sup.added) writes.push(await replaceSuppliers(sup.list));
    if (ord.added) writes.push(await replacePurchaseOrders(ord.list));
    if (rec.added) writes.push(await replaceGoodsReceipts(rec.list));
    // Bills before the payments that settle them.
    if (bil.added) writes.push(await replacePurchaseBills(bil.list));
    if (spm.added) writes.push(await replaceSupplierPayments(spm.list));
    if (stock.addedProducts || stock.addedMovements) {
        writes.push(await replaceInventory(stock.products, stock.movements));
    }

    // Stock for restored receipts. Products added by this restore arrive with their own history, which
    // already holds the receipts' movements; for products already held the receipts are applied once here.
    // Receipts and movements are matched by receipt id, so this never counts the same delivery twice.
    if (rec.added) await syncGoodsReceiptStock();

    let settingsRestored = false;
    if (restoreSettings && data.settings) {
        writes.push(await writeSettings(data.settings));
        settingsRestored = true;
    }

    return {
        invoices: { added: inv.added, skipped: inv.skipped, overwritten: inv.overwritten, renumbered: inv.renumbered },
        clients: { added: cli.added, skipped: cli.skipped, overwritten: cli.overwritten },
        senders: { added: sen.added, skipped: sen.skipped, overwritten: sen.overwritten },
        templates: { added: tpl.added, skipped: tpl.skipped },
        products: { added: stock.addedProducts, skipped: stock.skippedProducts },
        quotations: { added: quo.added, skipped: quo.skipped },
        expenses: { added: exp.added, skipped: exp.skipped, refiled: exp.refiled, categoriesAdded: exp.addedCategories },
        suppliers: { added: sup.added, skipped: sup.skipped },
        purchaseOrders: { added: ord.added, skipped: ord.skipped, renumbered: ord.renumbered },
        goodsReceipts: { added: rec.added, skipped: rec.skipped, renumbered: rec.renumbered },
        purchaseBills: { added: bil.added, skipped: bil.skipped, renumbered: bil.renumbered },
        supplierPayments: { added: spm.added, skipped: spm.skipped, renumbered: spm.renumbered },
        settingsRestored,
        allWritten: writes.every(Boolean),
    };
}

/* ------------------------------------------------------------------ usage */

export type StorageItem = { scope: Exclude<DataScope, "all">; count: number | null; bytes: number };

export type StorageReport = {
    items: StorageItem[];
    /** Sum of the items; what this app's own data weighs, uncompressed and unencrypted. */
    totalBytes: number;
    /** Browser-reported figures for the whole origin; absent where unsupported. */
    usage: number | null;
    quota: number | null;
    persisted: boolean | null;
};

const sizeOf = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    try {
        return new Blob([JSON.stringify(value)]).size;
    } catch {
        return 0;
    }
};

export async function storageReport(): Promise<StorageReport> {
    const items: StorageItem[] = [];
    for (const scope of Object.keys(SCOPE_KEYS) as Exclude<DataScope, "all">[]) {
        const value = await readSecure<unknown>(SCOPE_KEYS[scope]);
        items.push({
            scope,
            count: Array.isArray(value) ? value.length : value ? 1 : 0,
            bytes: sizeOf(value),
        });
    }

    let usage: number | null = null;
    let quota: number | null = null;
    let persisted: boolean | null = null;
    try {
        const est = await navigator.storage?.estimate?.();
        usage = est?.usage ?? null;
        quota = est?.quota ?? null;
        persisted = (await navigator.storage?.persisted?.()) ?? null;
    } catch {
        /* unsupported: the figures stay null and the UI says so */
    }

    return { items, totalBytes: items.reduce((s, i) => s + i.bytes, 0), usage, quota, persisted };
}

/** Asks the browser not to evict this origin's data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
    try {
        return (await navigator.storage?.persist?.()) ?? false;
    } catch {
        return false;
    }
}

/* ------------------------------------------------------------------ clear */

export async function clearData(scope: DataScope): Promise<void> {
    const scopes = scope === "all" ? (Object.keys(SCOPE_KEYS) as Exclude<DataScope, "all">[]) : [scope];
    for (const s of scopes) await removeSecure(SCOPE_KEYS[s]);
    if (scope === "all" || scope === "invoices") await removeSecure(RECENT_KEY);
}
