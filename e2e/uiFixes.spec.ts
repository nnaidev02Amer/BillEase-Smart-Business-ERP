import { test, expect, type Page } from "@playwright/test";

/**
 * Browser checks for the three late UI fixes. They run in both the desktop and
 * mobile projects (see playwright.config.ts). The matching pure-logic checks are
 * branding.logic.spec.ts, dates.logic.spec.ts and pnlPayables.logic.spec.ts.
 *
 *   1. BillEase header wordmark (the e-mail half is branding.logic.spec.ts).
 *   2. Localised display dates, with ISO kept for storage and sorting.
 *   3. A separate Payables heading in the profit and loss statement (the PDF
 *      half is pnlPayables.logic.spec.ts).
 */

const NOW = "2026-01-01T00:00:00.000Z";
const supplier = {
    id: "sup-1", name: "Acme Traders", contactPerson: "", email: "sup1@supplier.test", phone: "9876543210", address: "5 Industrial Area", city: "Pune", zipCode: "411001",
    country: "India", state: "", gstin: "", pan: "", paymentTermsDays: 30, currency: "INR", openingBalance: 0, notes: "", inactive: false, createdAt: NOW, updatedAt: NOW,
};
const SNAP = { name: "Acme Traders", gstin: "", state: "27", address: "5 Industrial Area", city: "Pune", zipCode: "411001", country: "India", email: "a@b.test", phone: "1" };
/** 10 x 100 at 18% = 1,180, billed 10 Jan 2026, due 9 Feb 2026. */
const bill = {
    id: "bill-1", number: "PB-0001", supplierBillNo: "INV/77", supplierId: "sup-1", supplier: SNAP, grnIds: [], billDate: "2026-01-10", dueDate: "2026-02-09", currency: "INR",
    lines: [{ id: "bl1", name: "Widget", description: "", hsn: "8471", unit: "pcs", quantity: 10, unitPrice: 100, taxRate: 18 }],
    discount: { type: "amount", value: 0 }, freight: 0, gstEnabled: true, itcEligible: true, notes: "", status: "posted", log: [], createdAt: NOW, updatedAt: NOW,
};

async function restore(page: Page, data: Record<string, unknown>) {
    const file = {
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: [], clients: [], senders: [], templates: [], settings: null, products: [], stockMovements: [], ...data } })),
    };
    await page.goto("/en/settings");
    await page.getByTestId("backup-file").setInputFiles(file);
    await expect(page.getByRole("heading", { name: "Restore from backup" })).toBeVisible();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText("Backup restored", { exact: true }).first()).toBeVisible();
    await page.keyboard.press("Escape");
}

test.describe("BillEase header", () => {
    test("the header wordmark is the BillEase name, as text, linking home", async ({ page }) => {
        await page.goto("/en");
        const brand = page.getByTestId("brand");
        await expect(brand).toBeVisible();
        await expect(brand).toHaveAttribute("aria-label", "BillEase");
        await expect(brand).toHaveAttribute("href", /\/(en)?\/?$/);
        await expect(brand).toContainText("BillEase");
        // a text wordmark: no hosted logo image to fail to load
        await expect(brand.locator("img")).toHaveCount(0);
        await expect(page).toHaveTitle(/BillEase/);
        await expect(page.locator("header").getByText(/invoify/i)).toHaveCount(0);
    });

    test("the wordmark stays on one line and inside the viewport", async ({ page }) => {
        await page.goto("/en");
        const box = await page.getByTestId("brand").boundingBox();
        const vw = page.viewportSize()!.width;
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(vw);
        expect(box!.height).toBeLessThan(64);
    });
});

test.describe("display dates", () => {
    test("a bill shows its dates localised, while the stored day stays the same ISO day", async ({ page }) => {
        await restore(page, { suppliers: [supplier], purchaseBills: [bill] });
        await page.goto("/en/purchase-bills");
        const card = page.locator('[data-testid="bill-card"][data-number="PB-0001"]');
        await expect(card).toBeVisible();
        await expect(card).toContainText("Billed Jan 10, 2026");
        await expect(card).toContainText("Due Feb 9, 2026");
        await expect(card).not.toContainText("2026-01-10");
        await expect(card).not.toContainText("2026-02-09");
        await expect(card).not.toContainText("Invalid Date");

        // The display is only a view: reloading renders the same days from the same stored values.
        await page.reload();
        await expect(card).toContainText("Billed Jan 10, 2026");
    });
});

test.describe("profit and loss: Payables", () => {
    const gotoReport = async (page: Page, from: string, to: string) => {
        await page.goto("/en/profit-loss");
        await expect(page.getByRole("heading", { name: "Profit & loss", level: 1 })).toBeVisible();
        await page.getByRole("combobox", { name: "Period" }).click();
        await page.getByRole("option", { name: "Custom range" }).click();
        await page.getByTestId("period-from").fill(from);
        await page.getByTestId("period-to").fill(to);
    };

    test("what is owed to suppliers sits under its own Payables heading in the statement", async ({ page }) => {
        await restore(page, { suppliers: [supplier], purchaseBills: [bill] });
        await gotoReport(page, "2026-01-01", "2026-03-31");

        const statement = page.getByTestId("pl-statement");
        const heading = statement.locator("th", { hasText: /^Payables$/ });
        await expect(heading).toHaveCount(1);
        await expect(heading).toBeVisible();
        await expect(page.getByTestId("pl-payables")).toContainText("Owed to suppliers at end date");
        await expect(page.getByTestId("pl-payables-value")).toContainText("1,180.00");
        await expect(page.getByTestId("pl-payables-overdue-value")).toContainText("1,180.00");

        // The heading comes first, then the two lines under it.
        const h = await heading.boundingBox();
        const row = await page.getByTestId("pl-payables").boundingBox();
        const overdue = await page.getByTestId("pl-payables-overdue").boundingBox();
        expect(h!.y).toBeLessThan(row!.y);
        expect(row!.y).toBeLessThan(overdue!.y);

        // It is not mixed into the receivables tiles, which keep their own labels.
        await expect(page.getByTestId("receivables")).not.toContainText("Payables");
    });

    test("with nothing owed there is no Payables heading at all", async ({ page }) => {
        await restore(page, { suppliers: [supplier] });
        await gotoReport(page, "2026-01-01", "2026-03-31");
        await expect(page.getByTestId("pl-statement")).toBeVisible();
        await expect(page.getByTestId("pl-statement").locator("th", { hasText: /^Payables$/ })).toHaveCount(0);
        await expect(page.getByTestId("pl-payables")).toHaveCount(0);
    });
});
