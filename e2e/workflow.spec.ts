import { test, expect, type Page } from "@playwright/test";

import { gstinCheckChar } from "../lib/gst";
import { isoDay } from "./fixtures";

/**
 * The whole purchasing chain, driven only through the screens a person would use:
 * supplier → purchase order → two goods receipts → bill → two payments, then the
 * books (payables, profit and loss, stock), persistence across reloads, and a
 * backup restored into a completely fresh browser.
 *
 * Only the product catalogue is seeded (with 5 Widgets in stock), because
 * creating one is a different module's job.
 */

const gstin = (state: string, pan: string) => {
    const first14 = `${state}${pan}1Z`;
    return `${first14}${gstinCheckChar(first14)}`;
};
const MH = gstin("27", "AAPFU0939F");
const NOW = "2026-01-01T00:00:00.000Z";

const widget = { id: "widget", name: "Widget", sku: "WIDGET", category: "", description: "", type: "product", unit: "pcs", sellingPrice: 150, purchasePrice: 60, taxRate: 18, hsn: "8471", trackStock: true, minStock: 0, archived: false, createdAt: NOW, updatedAt: NOW };

async function seedProduct(page: Page) {
    const file = {
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: [], products: [widget], stockMovements: [{ id: "o1", productId: "widget", date: "2026-01-02T00:00:00.000Z", qty: 5, kind: "opening" }] } })),
    };
    await page.goto("/en/settings");
    await page.getByTestId("backup-file").setInputFiles(file);
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText("Backup restored", { exact: true }).first()).toBeVisible();
    await page.keyboard.press("Escape");
}

async function setBusiness(page: Page) {
    await page.goto("/en/settings");
    const form = page.getByTestId("business-form");
    for (const [sel, v] of [["#b-name", "My Shop"], ["#b-gstin", MH], ["#b-address", "12 Market Road"], ["#b-city", "Mumbai"], ["#b-zip", "400001"], ["#b-country", "India"], ["#b-email", "me@shop.test"], ["#b-phone", "9999999999"]] as const) await form.locator(sel).fill(v);
    await page.getByTestId("business-save").click();
    await expect(page.getByTestId("business-save")).toBeDisabled();
}

const stockOf = async (page: Page) => {
    await page.goto("/en/products");
    return (await page.locator('[data-testid="product-row"]:visible').filter({ hasText: "Widget" }).getByTestId("stock-badge").first().innerText()).trim();
};
const poCard = (page: Page) => page.locator('[data-testid="po-card"][data-number="PO-0001"]');
const billCard = (page: Page) => page.locator('[data-testid="bill-card"][data-number="PB-0001"]');

/** Everything that must be true at the end of the chain, checked the same way before and after a restore. */
async function expectBooksSettled(page: Page) {
    // stock: 5 on hand + 10 received (2 rejected on the first delivery, so 8 + 2 accepted)
    expect(await stockOf(page)).toBe("15 pcs");

    await page.goto("/en/purchase-orders");
    await expect(poCard(page)).toHaveAttribute("data-status", "received");
    await expect(poCard(page).getByTestId("po-progress")).toContainText("10 of 10 received");
    await expect(poCard(page).getByTestId("po-card-total")).toContainText("708.00");

    await page.goto("/en/goods-receipts");
    await expect(page.getByTestId("grn-card")).toHaveCount(2);

    await page.goto("/en/purchase-bills");
    await expect(billCard(page)).toHaveAttribute("data-status", "paid");
    await expect(billCard(page).getByTestId("bill-card-total")).toContainText("708.00");
    await expect(billCard(page).getByTestId("bill-card-owed")).toContainText("0.00 owed");

    await page.goto("/en/payables");
    await expect(page.getByTestId("m-owed")).toContainText("0.00");
    await expect(page.getByTestId("m-overdue")).toContainText("0.00");
    await expect(page.getByTestId("pay-card")).toHaveCount(2);
    await page.getByTestId("supplier-ledger").click();
    await expect(page.getByTestId("ledger-closing")).toContainText("0.00");
    await page.keyboard.press("Escape");
}

test("supplier → order → receipts → bill → payments, and the books agree", async ({ page, browser }, testInfo) => {
    test.setTimeout(150_000);
    await seedProduct(page);
    await setBusiness(page);
    expect(await stockOf(page)).toBe("5 pcs");

    // 1. A supplier, with a real GSTIN and 30-day terms.
    await page.goto("/en/suppliers");
    await page.getByTestId("supplier-new").first().click();
    await page.getByTestId("supplier-name").fill("Acme Traders");
    await page.getByTestId("supplier-gstin").fill(MH);
    await expect(page.getByText("Valid format · Maharashtra")).toBeVisible();
    await page.getByTestId("supplier-terms").fill("30");
    await page.getByTestId("supplier-save").click();
    await expect(page.getByTestId("supplier-card")).toHaveCount(1);

    // 2. A purchase order for 10 Widgets at 60 + 18% GST = 708, sent to the supplier.
    await page.getByRole("link", { name: "New purchase order" }).click();
    await expect(page.getByTestId("po-dialog")).toBeVisible();
    await expect(page.getByTestId("po-supplier")).not.toHaveValue("");
    await page.getByTestId("po-add-product").selectOption({ label: "Widget (WIDGET)" });
    await page.getByTestId("po-line-qty").fill("10");
    await expect(page.getByTestId("po-line-price")).toHaveValue("60");
    await expect(page.getByTestId("po-cgst")).toContainText("54.00");
    await expect(page.getByTestId("po-sgst")).toContainText("54.00");
    await expect(page.getByTestId("po-total")).toContainText("708.00");
    await page.getByTestId("po-save-send").click();
    await expect(poCard(page)).toHaveAttribute("data-status", "sent");
    // Nothing is owed and no stock has moved just because an order was placed.
    expect(await stockOf(page)).toBe("5 pcs");

    // 3. First delivery: 10 arrive, 2 are rejected. Only 8 go into stock and count toward the order.
    await page.goto("/en/purchase-orders");
    await poCard(page).getByTestId("po-receive").click();
    await expect(page.getByTestId("grn-line-received")).toHaveValue("10");
    await page.getByTestId("grn-line-received").fill("10");
    await page.getByTestId("grn-line-rejected").fill("2");
    await page.getByTestId("grn-save").click();
    await expect(page.getByTestId("grn-card")).toHaveCount(1);
    expect(await stockOf(page)).toBe("13 pcs");
    await page.goto("/en/purchase-orders");
    await expect(poCard(page)).toHaveAttribute("data-status", "partiallyReceived");
    await expect(poCard(page).getByTestId("po-progress")).toContainText("8 of 10 received");

    // 4. Second delivery: the 2 still owed arrive, pre-filled.
    await poCard(page).getByTestId("po-receive").click();
    await expect(page.getByTestId("grn-line-received")).toHaveValue("2");
    await page.getByTestId("grn-save").click();
    await expect(page.getByTestId("grn-card")).toHaveCount(2);
    expect(await stockOf(page)).toBe("15 pcs");
    await page.goto("/en/purchase-orders");
    await expect(poCard(page)).toHaveAttribute("data-status", "received");

    // 5. The supplier's bill, from the order: everything received, at the order's price, matching cleanly.
    await poCard(page).getByTestId("po-bill").click();
    await expect(page.getByTestId("bill-line-qty")).toHaveValue("10");
    await expect(page.getByTestId("bill-line-price")).toHaveValue("60");
    await expect(page.getByTestId("bill-total")).toContainText("708.00");
    await expect(page.getByTestId("bill-match-ok")).toBeVisible();
    await expect(page.getByTestId("bill-due")).toHaveValue(
        (() => {
            const d = new Date();
            d.setDate(d.getDate() + 30);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        })()
    );
    await page.getByTestId("bill-supplier-no").fill("ACME/2026/0042");
    await page.getByTestId("bill-save-post").click();
    await expect(billCard(page)).toHaveAttribute("data-status", "unpaid");
    await expect(billCard(page).getByTestId("bill-card-owed")).toContainText("708.00 owed");
    // Once billed in full the order is no longer offered for billing.
    await page.goto("/en/purchase-orders");
    await expect(page.getByTestId("po-bill")).toHaveCount(0);

    // 6. A part payment of 400 from the bill, then the rest from the payables screen.
    await page.goto("/en/purchase-bills");
    await billCard(page).getByTestId("bill-pay").click();
    await expect(page.getByTestId("pay-amount")).toHaveValue("708");
    await page.getByTestId("pay-amount").fill("400");
    await page.getByTestId("pay-alloc").fill("400");
    await page.getByTestId("pay-save").click();
    await expect(billCard(page)).toHaveAttribute("data-status", "partial");
    await expect(billCard(page).getByTestId("bill-card-owed")).toContainText("308.00 owed");

    await page.goto("/en/payables");
    await expect(page.getByTestId("m-owed")).toContainText("308.00");
    await page.getByTestId("topay-pay").click();
    await expect(page.getByTestId("pay-amount")).toHaveValue("308");
    await page.getByTestId("pay-save").click();
    await expect(page.getByTestId("m-owed")).toContainText("0.00");
    await expect(page.getByTestId("pay-card")).toHaveCount(2);

    // 7. Profit and loss: the 708 bill is a 600 cost (108 of GST is claimable) and 708 of cash has gone out.
    await page.goto("/en/profit-loss");
    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Custom range" }).click();
    await page.getByTestId("period-from").fill(isoDay(-5));
    await page.getByTestId("period-to").fill(isoDay(0));
    await expect(page.getByTestId("pl-purchases-value")).toContainText("708.00");
    await expect(page.getByTestId("pl-purchases-claimable-value")).toContainText("108.00");
    await expect(page.getByTestId("pl-purchase-cost-value")).toContainText("600.00");
    await expect(page.getByTestId("pl-paid-suppliers-value")).toContainText("708.00");
    await expect(page.getByTestId("k-profit")).toContainText("600.00");
    await expect(page.getByTestId("k-netcash")).toContainText("708.00");
    await expect(page.getByTestId("pl-payables")).toHaveCount(0);

    // 8. Everything is as it should be now...
    await expectBooksSettled(page);

    // 9. ...and still is after a full reload of every screen (encrypted browser storage persists).
    await page.reload();
    await expectBooksSettled(page);

    // 10. A backup of all of it, restored into a brand-new browser, gives the same books.
    await page.goto("/en/settings");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).click()]);
    const backup = Buffer.concat((await (await download.createReadStream()).toArray()) as Buffer[]);
    const file = JSON.parse(backup.toString());
    expect(file.counts).toMatchObject({ suppliers: 1, purchaseOrders: 1, goodsReceipts: 2, purchaseBills: 1, supplierPayments: 2 });

    const fresh = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: testInfo.project.use.viewport ?? undefined, isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch });
    const page2 = await fresh.newPage();
    try {
        await page2.goto("/en/suppliers");
        await expect(page2.getByTestId("suppliers-empty")).toBeVisible();
        await page2.goto("/en/settings");
        await page2.getByTestId("backup-file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: backup });
        await expect(page2.getByRole("heading", { name: "Restore from backup" })).toBeVisible();
        await page2.getByRole("button", { name: "Restore", exact: true }).click();
        await expect(page2.getByText("Backup restored", { exact: true }).first()).toBeVisible();
        await page2.keyboard.press("Escape");
        await expectBooksSettled(page2);
    } finally {
        await fresh.close();
    }
});
