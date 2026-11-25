import { test, expect, type Page } from "@playwright/test";

import { gstinCheckChar } from "../lib/gst";
import { invoice } from "./fixtures";

/** Goods receipts and stock-in, through the real UI and the real stores. */

const gstin = (state: string, pan: string) => {
    const first14 = `${state}${pan}1Z`;
    return `${first14}${gstinCheckChar(first14)}`;
};
const NOW = "2026-01-01T00:00:00.000Z";

const supplier = {
    id: "sup-1",
    name: "Acme Traders",
    contactPerson: "",
    email: "sup1@supplier.test",
    phone: "9876543210",
    address: "5 Industrial Area",
    city: "Pune",
    zipCode: "411001",
    country: "India",
    state: "",
    gstin: gstin("27", "AAPFU0939F"),
    pan: "",
    paymentTermsDays: 30,
    currency: "INR",
    openingBalance: 0,
    notes: "",
    inactive: false,
    createdAt: NOW,
    updatedAt: NOW,
};

const product = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    sku: id.toUpperCase(),
    category: "Hardware",
    description: "",
    type: "product",
    unit: "pcs",
    sellingPrice: 150,
    purchasePrice: 60,
    taxRate: 18,
    hsn: "8471",
    trackStock: true,
    minStock: 0,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
});

const widget = product("widget", "Widget");
const opening = (productId: string, qty: number) => ({ id: `open-${productId}`, productId, date: "2026-01-02T00:00:00.000Z", qty, kind: "opening" });

const order = (over: Record<string, unknown> = {}) => ({
    id: "po-1",
    number: "PO-0001",
    supplierId: "sup-1",
    supplier: { name: "Acme Traders", gstin: supplier.gstin, state: "27", address: "5 Industrial Area", city: "Pune", zipCode: "411001", country: "India", email: "a@b.test", phone: "1" },
    date: "2026-03-01",
    // Far in the future so the derived status never turns "overdue" on the day this runs.
    expectedDate: "2099-12-31",
    currency: "INR",
    lines: [{ id: "l1", productId: "widget", name: "Widget", description: "", hsn: "8471", unit: "pcs", quantity: 10, unitPrice: 60, taxRate: 18 }],
    discount: { type: "amount", value: 0 },
    freight: 0,
    gstEnabled: true,
    paymentTerms: "Net 30 days",
    notes: "",
    terms: "",
    status: "sent",
    log: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
});

async function restore(page: Page, data: Record<string, unknown>) {
    const file = {
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(
            JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: [], clients: [], senders: [], templates: [], settings: null, products: [], stockMovements: [], ...data } })
        ),
    };
    await page.goto("/en/settings");
    await page.getByTestId("backup-file").setInputFiles(file);
    await expect(page.getByRole("heading", { name: "Restore from backup" })).toBeVisible();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText("Backup restored", { exact: true }).first()).toBeVisible();
    await page.keyboard.press("Escape");
}

/** The usual starting point: a supplier, Widget with 5 in stock, and a sent order for 10 Widgets. */
const seed = (page: Page, extra: Record<string, unknown> = {}) =>
    restore(page, { suppliers: [supplier], products: [widget], stockMovements: [opening("widget", 5)], purchaseOrders: [order()], ...extra });

const stockOf = async (page: Page, name = "Widget") => {
    await page.goto("/en/products");
    return (await page.locator('[data-testid="product-row"]:visible').filter({ hasText: name }).getByTestId("stock-badge").first().innerText()).trim();
};

const grnCards = (page: Page) => page.getByTestId("grn-card");
const poCard = (page: Page, number = "PO-0001") => page.locator(`[data-testid="po-card"][data-number="${number}"]`);

/** Opens the receipt dialog for the seeded order, the way a user would: from the order's own button. */
async function receiveFromOrder(page: Page) {
    await page.goto("/en/purchase-orders");
    await poCard(page).getByTestId("po-receive").click();
    await expect(page.getByTestId("grn-dialog")).toBeVisible();
    await expect(page.getByTestId("grn-order")).not.toHaveValue("");
}

const post = async (page: Page) => {
    await page.getByTestId("grn-save").click();
};

test.describe("receiving against an order", () => {
    test("a full delivery posts, completes the order and adds the stock", async ({ page }) => {
        await seed(page);
        expect(await stockOf(page)).toBe("5 pcs");

        await receiveFromOrder(page);
        // Pre-filled with what is still to come.
        await expect(page.getByTestId("grn-line-received")).toHaveValue("10");
        await expect(page.getByTestId("grn-total-in")).toContainText("10");
        await post(page);

        await expect(page.getByTestId("grn-dialog")).toHaveCount(0);
        await expect(grnCards(page)).toHaveCount(1);
        await expect(grnCards(page).first()).toHaveAttribute("data-number", "GRN-0001");
        await expect(grnCards(page).first()).toHaveAttribute("data-status", "posted");
        await expect(grnCards(page).first().getByTestId("grn-accepted")).toHaveText("10");
        await expect(grnCards(page).first()).toContainText("Against PO-0001");

        expect(await stockOf(page)).toBe("15 pcs");
        await page.goto("/en/purchase-orders");
        await expect(poCard(page)).toHaveAttribute("data-status", "received");
        await expect(poCard(page).getByTestId("po-progress")).toContainText("10 of 10 received");
        await expect(poCard(page).getByTestId("po-receive")).toHaveCount(0);
    });

    test("partial receipts accumulate: the second is pre-filled with what is left", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await page.getByTestId("grn-line-received").fill("4");
        await post(page);
        await expect(grnCards(page)).toHaveCount(1);

        await page.goto("/en/purchase-orders");
        await expect(poCard(page)).toHaveAttribute("data-status", "partiallyReceived");
        await expect(poCard(page).getByTestId("po-progress")).toContainText("4 of 10 received");
        expect(await stockOf(page)).toBe("9 pcs");

        await page.goto("/en/purchase-orders");
        await poCard(page).getByTestId("po-receive").click();
        await expect(page.getByTestId("grn-line-received")).toHaveValue("6");
        await post(page);
        await expect(grnCards(page)).toHaveCount(2);
        await expect(page.locator('[data-testid="grn-card"][data-number="GRN-0002"]')).toBeVisible();

        await page.goto("/en/purchase-orders");
        await expect(poCard(page)).toHaveAttribute("data-status", "received");
        await expect(poCard(page).getByTestId("po-receipts-link")).toContainText("2 receipts");
        expect(await stockOf(page)).toBe("15 pcs");
    });

    test("rejected goods never enter stock or count toward the order", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await page.getByTestId("grn-line-rejected").fill("3");
        await expect(page.getByTestId("grn-line-accepted")).toHaveText("7");
        await post(page);

        const card = grnCards(page).first();
        await expect(card.getByTestId("grn-received")).toHaveText("10");
        await expect(card.getByTestId("grn-rejected")).toHaveText("3");
        await expect(card.getByTestId("grn-accepted")).toHaveText("7");
        expect(await stockOf(page)).toBe("12 pcs");

        await page.goto("/en/purchase-orders");
        await expect(poCard(page).getByTestId("po-progress")).toContainText("7 of 10 received");
        await expect(poCard(page)).toHaveAttribute("data-status", "partiallyReceived");
    });

    test("receiving more than ordered asks first, and does nothing if you go back", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await page.getByTestId("grn-line-received").fill("12");
        await expect(page.getByTestId("grn-line-accepted")).toHaveAttribute("data-over", "true");
        await post(page);

        const confirm = page.getByTestId("grn-confirm");
        await expect(confirm).toContainText("Receive more than was ordered?");
        await expect(confirm).toContainText("over by 2");
        await confirm.getByRole("button", { name: "Go back" }).click();
        await expect(page.getByTestId("grn-dialog")).toBeVisible();
        await expect(grnCards(page)).toHaveCount(0);
        expect(await stockOf(page)).toBe("5 pcs");

        await page.goto("/en/purchase-orders");
        await poCard(page).getByTestId("po-receive").click();
        await page.getByTestId("grn-line-received").fill("12");
        await post(page);
        await page.getByTestId("grn-confirm-yes").click();
        await expect(grnCards(page)).toHaveCount(1);
        await expect(grnCards(page).first().getByTestId("grn-accepted")).toHaveText("12");
        expect(await stockOf(page)).toBe("17 pcs");
    });

    test("an order that is not sent cannot be received against", async ({ page }) => {
        await seed(page, { purchaseOrders: [order({ status: "draft" })] });
        await page.goto("/en/purchase-orders");
        await expect(poCard(page).getByTestId("po-receive")).toHaveCount(0);
        await page.goto("/en/goods-receipts");
        await page.getByTestId("grn-new").click();
        // With nothing waiting for goods the dialog opens as a direct receipt; asking for "against an order" explains why there is none.
        await expect(page.getByTestId("grn-mode-direct")).toBeChecked();
        await page.getByTestId("grn-mode-order").check();
        await expect(page.getByTestId("grn-no-orders")).toBeVisible();
    });
});

test.describe("direct receipts", () => {
    test("records stock for a product with no order, and notes a line that has no product", async ({ page }) => {
        await seed(page, { purchaseOrders: [] });
        await page.goto("/en/goods-receipts");
        await page.getByTestId("grn-new").click();
        // With no open order, the dialog starts as a direct receipt.
        await expect(page.getByTestId("grn-mode-direct")).toBeChecked();
        await page.getByTestId("grn-supplier").selectOption({ label: "Acme Traders" });
        await page.getByTestId("grn-reference").fill("DC-1001");
        await page.getByTestId("grn-add-product").selectOption({ label: "Widget (WIDGET)" });
        await page.getByTestId("grn-line-received").first().fill("3");
        await page.getByTestId("grn-add-line").click();
        await page.getByTestId("grn-line-name").last().fill("Packing tape");
        await page.getByTestId("grn-line-received").last().fill("2");
        await post(page);

        const card = grnCards(page).first();
        await expect(card).toContainText("Direct receipt");
        await expect(card).toContainText("Delivery note DC-1001");
        await expect(card).toContainText("Packing tape");
        expect(await stockOf(page)).toBe("8 pcs");
    });

    test("validates: a supplier, something received, and rejected within received", async ({ page }) => {
        await seed(page, { purchaseOrders: [] });
        await page.goto("/en/goods-receipts");
        await page.getByTestId("grn-new").click();
        await post(page);
        await expect(page.getByText("Choose a supplier")).toBeVisible();
        await expect(page.getByText("Add at least one item")).toBeVisible();

        await page.getByTestId("grn-supplier").selectOption({ label: "Acme Traders" });
        await page.getByTestId("grn-add-product").selectOption({ label: "Widget (WIDGET)" });
        await page.getByTestId("grn-line-received").fill("0");
        await post(page);
        await expect(page.getByText("Enter a received quantity on at least one line")).toBeVisible();

        await page.getByTestId("grn-line-received").fill("2");
        await page.getByTestId("grn-line-rejected").fill("5");
        await post(page);
        await expect(page.getByText("Cannot be more than was received")).toBeVisible();
        await expect(grnCards(page)).toHaveCount(0);
        expect(await stockOf(page)).toBe("5 pcs");
    });
});

test.describe("voiding", () => {
    test("reverses the stock exactly, reopens the order, and keeps the record", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await page.getByTestId("grn-line-rejected").fill("2");
        await post(page);
        expect(await stockOf(page)).toBe("13 pcs");

        await page.goto("/en/goods-receipts");
        await grnCards(page).first().getByTestId("grn-void").click();
        await expect(page.getByTestId("grn-void-dialog")).toContainText("takes 8 out of stock");
        await page.getByTestId("grn-void-reason").fill("Wrong delivery");
        await page.getByTestId("grn-void-confirm").click();

        await expect(grnCards(page).first()).toHaveAttribute("data-status", "void");
        await expect(grnCards(page).first()).toContainText("Reason: Wrong delivery");
        await expect(grnCards(page).first().getByTestId("grn-void")).toHaveCount(0);
        expect(await stockOf(page)).toBe("5 pcs");

        // The order is waiting for goods again.
        await page.goto("/en/purchase-orders");
        await expect(poCard(page)).toHaveAttribute("data-status", "sent");
        await expect(poCard(page).getByTestId("po-receive")).toBeVisible();
        await expect(poCard(page).getByTestId("po-progress")).toHaveCount(0);
    });

    test("the stock history shows the stock-in and its reversal", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await post(page);
        await page.goto("/en/goods-receipts");
        await grnCards(page).first().getByTestId("grn-void").click();
        await page.getByTestId("grn-void-confirm").click();
        await expect(grnCards(page).first()).toHaveAttribute("data-status", "void");

        await page.goto("/en/products");
        await page.getByRole("button", { name: /History: Widget/ }).first().click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("GRN-0001 · Acme Traders");
        await expect(dialog).toContainText("Reversal of GRN-0001");
    });

    test("is refused, naming the product, when the goods have already been used", async ({ page }) => {
        await seed(page, { stockMovements: [opening("widget", 0.001)] });
        await receiveFromOrder(page);
        await post(page);
        await expect(grnCards(page)).toHaveCount(1);

        // 12 Widgets are then sold on an issued invoice.
        const sale = invoice("INV-9", "Acme Corp", "billing@acme.test", 120, { status: "sent", issued: -1, due: 29 });
        sale.details.items = [{ name: "Widget", quantity: 10, unitPrice: 12, total: 120, productId: "widget" }] as unknown as typeof sale.details.items;
        await restore(page, { invoices: [sale], products: [], stockMovements: [] });
        expect(await stockOf(page)).toBe("0.001 pcs");

        await page.goto("/en/goods-receipts");
        await grnCards(page).first().getByTestId("grn-void").click();
        await page.getByTestId("grn-void-confirm").click();
        await expect(page.getByText("Cannot void: stock would go below zero")).toBeVisible();
        await expect(page.getByText("Widget: 0.001 in stock, 10 would be taken out")).toBeVisible();
        await expect(grnCards(page).first()).toHaveAttribute("data-status", "posted");
        expect(await stockOf(page)).toBe("0.001 pcs");
    });
});

test.describe("purchase price option", () => {
    test("is off by default and leaves the product price alone", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await page.getByTestId("grn-line-price").fill("75");
        await expect(page.getByTestId("grn-update-prices")).not.toBeChecked();
        await expect(page.getByTestId("grn-price-preview")).toHaveCount(0);
        await post(page);
        await expect(grnCards(page)).toHaveCount(1);
        await expect(grnCards(page).first().getByTestId("grn-price-updates")).toHaveCount(0);

        // A new order line for the product still starts at its old price, 60.
        await page.goto("/en/purchase-orders");
        await page.getByTestId("po-new").click();
        await page.getByTestId("po-add-product").selectOption({ label: "Widget (WIDGET)" });
        await expect(page.getByTestId("po-line-price")).toHaveValue("60");
    });

    test("shows what would change, asks to confirm, and only then updates", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await page.getByTestId("grn-line-price").fill("75");
        await page.getByTestId("grn-update-prices").click();
        await expect(page.getByTestId("grn-price-preview")).toContainText("Widget");
        await expect(page.getByTestId("grn-price-preview")).toContainText("75.00");
        await post(page);

        const confirm = page.getByTestId("grn-confirm");
        await expect(confirm).toContainText("Update purchase prices?");
        // Going back posts nothing and changes nothing.
        await confirm.getByRole("button", { name: "Go back" }).click();
        await expect(grnCards(page)).toHaveCount(0);

        await post(page);
        await page.getByTestId("grn-confirm-yes").click();
        await expect(grnCards(page)).toHaveCount(1);
        await expect(grnCards(page).first().getByTestId("grn-price-updates")).toContainText("Purchase price updated for 1 product");

        await page.goto("/en/purchase-orders");
        await page.getByTestId("po-new").click();
        await page.getByTestId("po-add-product").selectOption({ label: "Widget (WIDGET)" });
        await expect(page.getByTestId("po-line-price")).toHaveValue("75");
    });

    test("with no price difference there is nothing to confirm", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await page.getByTestId("grn-update-prices").click();
        await expect(page.getByTestId("grn-price-preview")).toContainText("No product price would change");
        await post(page);
        await expect(page.getByTestId("grn-confirm")).toHaveCount(0);
        await expect(grnCards(page)).toHaveCount(1);
    });
});

test.describe("orders that have received goods", () => {
    test("can no longer be cancelled, sent back to draft or deleted", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await page.getByTestId("grn-line-received").fill("4");
        await post(page);
        await expect(grnCards(page)).toHaveCount(1);

        await page.goto("/en/purchase-orders");
        const card = poCard(page);
        await expect(card.getByTestId("po-cancel")).toHaveCount(0);
        await expect(card.getByTestId("po-delete")).toHaveCount(0);
        await expect(card.getByRole("button", { name: "Back to draft" })).toHaveCount(0);
        // Closing it (stop expecting the rest) is still allowed.
        await expect(card.getByRole("button", { name: "Close order" })).toBeVisible();
    });

    test("cannot have a line cut below what has arrived", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await page.getByTestId("grn-line-received").fill("6");
        await post(page);
        await expect(grnCards(page)).toHaveCount(1);

        await page.goto("/en/purchase-orders");
        await poCard(page).getByTestId("po-edit").click();
        await page.getByTestId("po-line-qty").fill("5");
        await page.getByTestId("po-save").click();
        await expect(page.getByText("Cannot be less than the quantity already received")).toBeVisible();
        await page.getByTestId("po-line-qty").fill("8");
        await page.getByTestId("po-save").click();
        await expect(page.getByTestId("po-dialog")).toHaveCount(0);
        await expect(poCard(page).getByTestId("po-progress")).toContainText("6 of 8 received");
    });

    test("the supplier cannot be deleted while it has receipts", async ({ page }) => {
        await seed(page, { purchaseOrders: [] });
        await page.goto("/en/goods-receipts");
        await page.getByTestId("grn-new").click();
        await page.getByTestId("grn-supplier").selectOption({ label: "Acme Traders" });
        await page.getByTestId("grn-add-product").selectOption({ label: "Widget (WIDGET)" });
        await post(page);
        await expect(grnCards(page)).toHaveCount(1);

        await page.goto("/en/suppliers");
        await page.getByRole("button", { name: "Delete: Acme Traders" }).click();
        await page.getByTestId("supplier-delete-confirm").click();
        await expect(page.getByText("has purchase orders, so it cannot be deleted")).toBeVisible();
        await expect(page.getByTestId("supplier-card")).toHaveCount(1);
    });
});

test.describe("listing", () => {
    test("filters by status and searches by number, order and item", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await page.getByTestId("grn-line-received").fill("4");
        await post(page);
        await expect(grnCards(page)).toHaveCount(1);
        await page.goto("/en/purchase-orders");
        await poCard(page).getByTestId("po-receive").click();
        await post(page);
        await expect(grnCards(page)).toHaveCount(2);

        await grnCards(page).first().getByTestId("grn-void").click();
        await page.getByTestId("grn-void-confirm").click();
        await expect(page.getByTestId("grn-status").first()).toBeVisible();

        await page.getByTestId("grn-status-filter").selectOption("void");
        await expect(grnCards(page)).toHaveCount(1);
        await page.getByTestId("grn-status-filter").selectOption("all");
        await page.getByTestId("grn-search").fill("grn-0001");
        await expect(grnCards(page)).toHaveCount(1);
        await page.getByTestId("grn-search").fill("widget");
        await expect(grnCards(page)).toHaveCount(2);
        await page.getByTestId("grn-search").fill("nothing-like-this");
        await expect(page.getByTestId("grn-nomatch")).toBeVisible();
    });

    test("the order's 'receipts' link shows only that order's receipts", async ({ page }) => {
        await seed(page, { purchaseOrders: [order(), order({ id: "po-2", number: "PO-0002", lines: [{ id: "l9", productId: "widget", name: "Widget", description: "", hsn: "", unit: "pcs", quantity: 3, unitPrice: 60, taxRate: 18 }] })] });
        await receiveFromOrder(page);
        await post(page);
        await page.goto("/en/purchase-orders");
        await poCard(page, "PO-0002").getByTestId("po-receive").click();
        await post(page);
        await expect(grnCards(page)).toHaveCount(2);

        await page.goto("/en/purchase-orders");
        await poCard(page).getByTestId("po-receipts-link").click();
        await expect(grnCards(page)).toHaveCount(1);
        await expect(grnCards(page).first()).toContainText("Against PO-0001");
    });

    test("exports receipts as CSV, one row per line", async ({ page }) => {
        await seed(page);
        await receiveFromOrder(page);
        await post(page);
        await expect(grnCards(page)).toHaveCount(1);
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
        expect(download.suggestedFilename()).toBe("goods-receipt-GRN-0001.csv");
        const text = (await (await download.createReadStream()).toArray()).map((c) => c.toString()).join("");
        expect(text).toContain("GRN-0001");
        expect(text).toContain("Widget");
    });
});

test.describe("backup and restore", () => {
    const grn = (over: Record<string, unknown> = {}) => ({
        id: "grn-1",
        number: "GRN-0001",
        supplierId: "sup-1",
        supplierName: "Acme Traders",
        poId: "po-1",
        poNumber: "PO-0001",
        date: "2026-03-05",
        currency: "INR",
        reference: "",
        note: "",
        lines: [{ id: "gl1", poLineId: "l1", productId: "widget", name: "Widget", unit: "pcs", received: 10, rejected: 0, unitPrice: 60 }],
        status: "posted",
        priceUpdates: [],
        createdAt: NOW,
        updatedAt: NOW,
        ...over,
    });

    test("an exported backup carries goods receipts", async ({ page }) => {
        await restore(page, { suppliers: [supplier], purchaseOrders: [order()], goodsReceipts: [grn()], products: [widget], stockMovements: [opening("widget", 5)] });
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).click()]);
        const file = JSON.parse((await (await download.createReadStream()).toArray()).map((c) => c.toString()).join(""));
        expect(file.counts.goodsReceipts).toBe(1);
        expect(file.data.goodsReceipts[0].number).toBe("GRN-0001");
        expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    test("restoring a receipt into a browser that holds the product adds its stock once, however many times it is restored", async ({ page }) => {
        await restore(page, { suppliers: [supplier], products: [widget], stockMovements: [opening("widget", 5)], purchaseOrders: [order()] });
        expect(await stockOf(page)).toBe("5 pcs");
        await restore(page, { goodsReceipts: [grn()] });
        expect(await stockOf(page)).toBe("15 pcs");
        await restore(page, { goodsReceipts: [grn()] });
        await restore(page, { goodsReceipts: [grn()], purchaseOrders: [order()] });
        expect(await stockOf(page)).toBe("15 pcs");
        await page.goto("/en/goods-receipts");
        await expect(grnCards(page)).toHaveCount(1);
    });

    test("a receipt restored together with a product's own history is not counted twice", async ({ page }) => {
        const history = [opening("widget", 5), { id: "m-grn", productId: "widget", date: "2026-03-05T00:00:00.000Z", qty: 10, kind: "purchase", grnId: "grn-1", note: "GRN-0001 · Acme Traders" }];
        await restore(page, { suppliers: [supplier], products: [widget], stockMovements: history, purchaseOrders: [order()], goodsReceipts: [grn()] });
        expect(await stockOf(page)).toBe("15 pcs");
    });

    test("a void receipt restores as void and adds no stock", async ({ page }) => {
        await restore(page, { suppliers: [supplier], products: [widget], stockMovements: [opening("widget", 5)], purchaseOrders: [order()], goodsReceipts: [grn({ status: "void", voidedAt: NOW })] });
        expect(await stockOf(page)).toBe("5 pcs");
        await page.goto("/en/goods-receipts");
        await expect(grnCards(page).first()).toHaveAttribute("data-status", "void");
    });

    test("a clashing receipt number is renumbered, not dropped", async ({ page }) => {
        await restore(page, { suppliers: [supplier], products: [widget], stockMovements: [opening("widget", 5)], purchaseOrders: [order()], goodsReceipts: [grn()] });
        await restore(page, { goodsReceipts: [grn({ id: "grn-2" })] });
        await page.goto("/en/goods-receipts");
        await expect(grnCards(page)).toHaveCount(2);
        const numbers = await grnCards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-number")));
        expect(new Set(numbers).size).toBe(2);
    });

    test("a backup holding only goods receipts can be restored", async ({ page }) => {
        await page.goto("/en/settings");
        await page.getByTestId("backup-file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: [], goodsReceipts: [grn()] } })) });
        await expect(page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true })).toBeEnabled();
    });

    test("an invalid receipt in a backup is reported and left out", async ({ page }) => {
        await page.goto("/en/settings");
        await page.getByTestId("backup-file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: [], goodsReceipts: [grn(), { id: "bad", lines: [] }] } })) });
        await expect(page.getByRole("dialog").getByText("1 item(s) in this file are invalid")).toBeVisible();
    });
});

test.describe("layout", () => {
    test("the receipts page and dialog fit the viewport", async ({ page }) => {
        await seed(page);
        await page.goto("/en/purchase-orders");
        await poCard(page).getByTestId("po-receive").click();
        await expect(page.getByTestId("grn-dialog")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        const box = await page.getByTestId("grn-dialog").boundingBox();
        const viewport = page.viewportSize()!;
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
        await post(page);
        await expect(grnCards(page)).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
});
