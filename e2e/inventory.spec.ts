import { test, expect, type Page } from "@playwright/test";

import { invoice } from "./fixtures";

/** Product catalogue and stock, through the real UI and the real stores. */

const product = (id: string, name: string, sku: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    sku,
    category: "Hardware",
    description: "",
    type: "product",
    unit: "pcs",
    sellingPrice: 100,
    purchasePrice: 60,
    taxRate: 18,
    hsn: "8471",
    trackStock: true,
    minStock: 3,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
});

const opening = (productId: string, qty: number) => ({
    id: `open-${productId}`,
    productId,
    date: "2026-01-02T00:00:00.000Z",
    qty,
    kind: "opening",
});

const withLines = (number: string, status: string, lines: { productId?: string; qty: number; name?: string }[]) => {
    const inv = invoice(number, "Acme Corp", "billing@acme.test", 100, { status, issued: -3, due: 25 });
    inv.details.items = lines.map((l) => ({
        name: l.name ?? "Widget",
        quantity: l.qty,
        unitPrice: 10,
        total: l.qty * 10,
        ...(l.productId ? { productId: l.productId } : {}),
    })) as typeof inv.details.items;
    return inv;
};

/** Restores a v2 backup through the real flow (validation preview included). */
async function restore(page: Page, data: Record<string, unknown>) {
    const file = {
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(
            JSON.stringify({
                format: "invoify-backup",
                version: 2,
                data: { invoices: [], clients: [], senders: [], templates: [], settings: null, products: [], stockMovements: [], ...data },
            })
        ),
    };
    await page.goto("/en/settings");
    await page.getByTestId("backup-file").setInputFiles(file);
    await expect(page.getByRole("heading", { name: "Restore from backup" })).toBeVisible();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText("Backup restored", { exact: true }).first()).toBeVisible();
    await page.keyboard.press("Escape");
}

const productRows = (page: Page) => page.locator('[data-testid="product-row"]:visible');
const rowOf = (page: Page, name: string) => productRows(page).filter({ hasText: name });

const stockOf = async (page: Page, name: string) => {
    await page.goto("/en/products");
    return (await rowOf(page, name).getByTestId("stock-badge").first().innerText()).trim();
};

const setStatus = async (page: Page, number: string, status: "Sent" | "Draft" | "Cancelled") => {
    await page.getByRole("combobox", { name: `Set status ${number}` }).click();
    await page.getByRole("option", { name: status }).click();
};

test.describe("products page", () => {
    test("empty state, then add a product with opening stock", async ({ page }) => {
        await page.goto("/en/products");
        await expect(page.getByRole("heading", { name: "No products yet" })).toBeVisible();

        await page.getByTestId("add-product").first().click();
        const dialog = page.getByRole("dialog");
        await dialog.locator('input[name="name"]').fill("Steel Bolt");
        await dialog.locator('input[name="sku"]').fill("bolt-1");
        await dialog.locator('input[name="sellingPrice"]').fill("12.5");
        await dialog.locator('input[name="openingStock"]').fill("10");
        await dialog.locator('input[name="minStock"]').fill("3");
        await dialog.getByRole("button", { name: "Save product" }).click();

        await expect(rowOf(page, "Steel Bolt")).toBeVisible();
        await expect(rowOf(page, "Steel Bolt").getByTestId("stock-badge").first()).toHaveText("10 pcs");
        // SKU is normalised to upper case
        await expect(rowOf(page, "Steel Bolt")).toContainText("BOLT-1");
    });

    test("validation: name, duplicate SKU, negative price", async ({ page }) => {
        await restore(page, { products: [product("p1", "Widget", "W-1")], stockMovements: [opening("p1", 10)] });
        await page.goto("/en/products");
        await page.getByTestId("add-product").first().click();
        const dialog = page.getByRole("dialog");

        await dialog.locator('input[name="name"]').fill("x");
        await dialog.locator('input[name="sku"]').fill("w-1");
        await dialog.locator('input[name="sellingPrice"]').fill("-5");
        await dialog.getByRole("button", { name: "Save product" }).click();

        await expect(dialog.getByText("Enter a name of at least 2 characters")).toBeVisible();
        await expect(dialog.getByText("Another product already uses this SKU")).toBeVisible();
        await expect(dialog.getByText("Enter a price of 0 or more")).toBeVisible();
        // nothing was created
        await page.keyboard.press("Escape");
        await expect(productRows(page)).toHaveCount(1);
    });

    test("adjusting stock updates the balance, is logged, and cannot go below zero", async ({ page }) => {
        await restore(page, { products: [product("p1", "Widget", "W-1")], stockMovements: [opening("p1", 10)] });
        await page.goto("/en/products");

        await rowOf(page, "Widget").getByRole("button", { name: "Adjust stock" }).click();
        let dialog = page.getByRole("dialog");
        await dialog.locator('input[name="quantity"]').fill("5");
        await dialog.locator('input[name="note"]').fill("Supplier delivery");
        await dialog.getByRole("button", { name: "Apply" }).click();
        await expect(rowOf(page, "Widget").getByTestId("stock-badge").first()).toHaveText("15 pcs");

        // Removing more than exists is refused and changes nothing.
        await rowOf(page, "Widget").getByRole("button", { name: "Adjust stock" }).click();
        dialog = page.getByRole("dialog");
        await dialog.getByRole("combobox").click();
        await page.getByRole("option", { name: /Damaged \/ lost/ }).click();
        await dialog.locator('input[name="quantity"]').fill("99");
        await dialog.getByRole("button", { name: "Apply" }).click();
        await expect(dialog.getByText(/would take stock below zero \(currently 15\)/)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(rowOf(page, "Widget").getByTestId("stock-badge").first()).toHaveText("15 pcs");

        // The history shows both movements with a running balance.
        await rowOf(page, "Widget").getByRole("button", { name: /History/ }).click();
        const history = page.getByTestId("stock-history");
        await expect(history).toContainText("Opening stock");
        await expect(history).toContainText("Stock received");
        await expect(history).toContainText("Supplier delivery");
        await expect(history).toContainText("15");
    });

    test("low and out-of-stock items are flagged and filterable", async ({ page }) => {
        await restore(page, {
            products: [product("a", "Alpha", "A-1"), product("b", "Beta", "B-1"), product("c", "Gamma", "C-1")],
            stockMovements: [opening("a", 2), opening("c", 50)], // a is low (min 3), b is out, c is fine
        });
        await page.goto("/en/products");
        await expect(page.getByTestId("low-stock-banner")).toContainText("2 item(s)"); // Alpha is low, Beta is out of stock with an alert set
        await expect(rowOf(page, "Alpha").getByTestId("stock-badge").first()).toHaveAttribute("data-status", "low");
        await expect(rowOf(page, "Beta").getByTestId("stock-badge").first()).toHaveAttribute("data-status", "out");
        await expect(rowOf(page, "Gamma").getByTestId("stock-badge").first()).toHaveAttribute("data-status", "ok");

        await page.getByRole("combobox", { name: "Stock" }).click();
        await page.getByRole("option", { name: "Low stock" }).click();
        await expect(productRows(page)).toHaveCount(1);
        await expect(productRows(page).first()).toContainText("Alpha");
    });

    test("search filters the list", async ({ page }) => {
        await restore(page, { products: [product("a", "Red Bolt", "BLT-R"), product("b", "Blue Nut", "NUT-B")], stockMovements: [] });
        await page.goto("/en/products");
        await page.getByRole("searchbox").fill("nut");
        await expect(productRows(page)).toHaveCount(1);
        await expect(productRows(page).first()).toContainText("Blue Nut");
    });

    test("services do not track stock", async ({ page }) => {
        await restore(page, { products: [product("s", "Consulting", "SVC-1", { type: "service", trackStock: false, unit: "hr" })], stockMovements: [] });
        await page.goto("/en/products");
        await expect(rowOf(page, "Consulting").getByTestId("stock-badge").first()).toHaveAttribute("data-status", "untracked");
        await expect(rowOf(page, "Consulting").getByRole("button", { name: "Adjust stock" })).toHaveCount(0);
    });

    test("an unused product can be deleted; a used one can only be archived", async ({ page }) => {
        await restore(page, {
            products: [product("used", "Used Item", "U-1"), product("free", "Free Item", "F-1")],
            stockMovements: [opening("used", 10), opening("free", 5)],
            invoices: [withLines("INV-1", "draft", [{ productId: "used", qty: 1 }])],
        });
        await page.goto("/en/products");

        await rowOf(page, "Used Item").getByRole("button", { name: /Delete/ }).click();
        let dialog = page.getByRole("alertdialog");
        await expect(dialog).toContainText("used on invoices");
        await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
        await dialog.getByRole("button", { name: "Cancel" }).click();

        await rowOf(page, "Free Item").getByRole("button", { name: /Delete/ }).click();
        dialog = page.getByRole("alertdialog");
        await dialog.getByRole("button", { name: "Delete", exact: true }).click();
        await expect(rowOf(page, "Free Item")).toHaveCount(0);
        await expect(rowOf(page, "Used Item")).toBeVisible();

        // Archiving hides it from the list until asked for.
        await rowOf(page, "Used Item").getByRole("button", { name: /Archive/ }).click();
        await expect(rowOf(page, "Used Item")).toHaveCount(0);
        await page.getByRole("switch", { name: "Show archived" }).click();
        await expect(rowOf(page, "Used Item")).toBeVisible();
    });
});

test.describe("invoices and stock", () => {
    test("issuing deducts once, blocks a shortfall, and cancelling restores stock", async ({ page }) => {
        await restore(page, {
            products: [product("w", "Widget", "W-1")],
            stockMovements: [opening("w", 10)],
            invoices: [
                withLines("D-1", "draft", [{ productId: "w", qty: 4 }]),
                withLines("D-2", "draft", [{ productId: "w", qty: 5 }]),
                // Issued before the ledger knew about it (e.g. an old backup): restoring
                // brings the ledger in line rather than ignoring it.
                withLines("S-1", "sent", [{ productId: "w", qty: 3 }]),
            ],
        });
        expect(await stockOf(page, "Widget")).toBe("7 pcs");

        await page.goto("/en/invoices");
        await setStatus(page, "D-1", "Sent");
        await expect(page.getByText("Status updated").first()).toBeVisible();
        expect(await stockOf(page, "Widget")).toBe("3 pcs");

        // D-2 needs 5 but only 3 remain: refused, and still a draft.
        await page.goto("/en/invoices");
        await setStatus(page, "D-2", "Sent");
        await expect(page.getByText("Not enough stock to issue this invoice.").first()).toBeVisible();
        await expect(page.getByText("Widget (have 3, need 5)").first()).toBeVisible();
        expect(await stockOf(page, "Widget")).toBe("3 pcs");

        // Cancel D-1: its 4 units come back.
        await page.goto("/en/invoices");
        await setStatus(page, "D-1", "Cancelled");
        expect(await stockOf(page, "Widget")).toBe("7 pcs");

        // Now D-2 fits.
        await page.goto("/en/invoices");
        await setStatus(page, "D-2", "Sent");
        expect(await stockOf(page, "Widget")).toBe("2 pcs");

        // Reloading and re-syncing must not deduct again.
        await page.reload();
        await page.goto("/en/products");
        await page.reload();
        await expect(rowOf(page, "Widget").getByTestId("stock-badge").first()).toHaveText("2 pcs");
    });

    test("restoring the same backup twice does not double the stock or the catalogue", async ({ page }) => {
        const data = {
            products: [product("w", "Widget", "W-1")],
            stockMovements: [opening("w", 10)],
            invoices: [withLines("S-1", "sent", [{ productId: "w", qty: 3 }])],
        };
        await restore(page, data);
        expect(await stockOf(page, "Widget")).toBe("7 pcs");

        // Second restore: everything is a duplicate. (The dialog reports skips.)
        await page.goto("/en/settings");
        await page.getByTestId("backup-file").setInputFiles({
            name: "backup.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: data.invoices, clients: [], senders: [], templates: [], settings: null, products: data.products, stockMovements: data.stockMovements } })),
        });
        await expect(page.getByRole("heading", { name: "Restore from backup" })).toBeVisible();
        await page.getByRole("button", { name: "Restore", exact: true }).click();
        await page.keyboard.press("Escape");

        expect(await stockOf(page, "Widget")).toBe("7 pcs");
        await expect(productRows(page)).toHaveCount(1);
    });

    test("deleting an issued invoice returns its stock", async ({ page }) => {
        await restore(page, {
            products: [product("w", "Widget", "W-1")],
            stockMovements: [opening("w", 10)],
            invoices: [withLines("S-1", "sent", [{ productId: "w", qty: 4 }])],
        });
        expect(await stockOf(page, "Widget")).toBe("6 pcs");

        await page.goto("/en/invoices");
        await page.getByRole("button", { name: /Delete S-1/ }).first().click();
        const confirm = page.getByRole("alertdialog");
        await confirm.getByRole("button", { name: /Delete/ }).last().click();
        expect(await stockOf(page, "Widget")).toBe("10 pcs");
    });

    test("service lines and free-text lines never move stock", async ({ page }) => {
        await restore(page, {
            products: [product("w", "Widget", "W-1"), product("s", "Consulting", "S-1", { type: "service", trackStock: false, unit: "hr" })],
            stockMovements: [opening("w", 10)],
            invoices: [withLines("S-1", "sent", [{ productId: "s", qty: 40, name: "Consulting" }, { qty: 99, name: "Typed by hand" }])],
        });
        expect(await stockOf(page, "Widget")).toBe("10 pcs");
    });
});

test.describe("catalogue picker on the invoice form", () => {
    const draft = {
        sender: { name: "Seller Co", address: "1 Main St", zipCode: "12345", city: "Town", country: "Land", email: "s@example.com", phone: "555-0100" },
        receiver: { name: "Buyer Co", address: "2 Side St", zipCode: "54321", city: "Burg", country: "Land", email: "b@example.com", phone: "555-0101" },
        details: {
            invoiceLogo: "",
            invoiceNumber: "PK-1",
            invoiceDate: "2026-04-10T00:00:00.000Z",
            dueDate: "2026-05-10T00:00:00.000Z",
            items: [{ name: "", description: "", quantity: 0, unitPrice: 0, total: 0 }],
            currency: "USD",
            language: "English",
            taxDetails: { amount: 0, amountType: "amount" },
            discountDetails: { amount: 0, amountType: "amount" },
            shippingDetails: { cost: 0, costType: "amount" },
            paymentInformation: { bankName: "B", accountName: "A", accountNumber: "1" },
            paymentTerms: "Net 30",
            subTotal: 0,
            totalAmount: 0,
            totalAmountInWords: "",
            pdfTemplate: 1,
            theme: { accentColor: "#4F46E5", fontId: "outfit", density: "comfortable" },
        },
    };

    test("picking a product fills the line and shows live stock", async ({ page }) => {
        await restore(page, {
            products: [product("w", "Widget", "W-1", { sellingPrice: 25, description: "A fine widget" })],
            stockMovements: [opening("w", 6)],
        });
        await page.addInitScript((d) => localStorage.setItem("invoify:invoiceDraft", JSON.stringify(d)), draft);
        await page.goto("/en?step=items");

        await page.getByTestId("pick-product").first().click();
        await page.getByRole("option", { name: /Widget/ }).click();

        await expect(page.locator('input[name="details.items[0].name"]')).toHaveValue("Widget");
        await expect(page.locator('input[name="details.items[0].unitPrice"]')).toHaveValue("25");
        await expect(page.locator('input[name="details.items[0].quantity"]')).toHaveValue("1");
        await expect(page.getByTestId("stock-hint")).toContainText("6 pcs in stock");

        // Asking for more than exists warns immediately.
        await page.locator('input[name="details.items[0].quantity"]').fill("9");
        await expect(page.getByTestId("stock-hint")).toContainText("Only 6 pcs in stock");
    });

    test("a service shows that it does not use stock", async ({ page }) => {
        await restore(page, { products: [product("s", "Consulting", "S-1", { type: "service", trackStock: false, unit: "hr" })], stockMovements: [] });
        await page.addInitScript((d) => localStorage.setItem("invoify:invoiceDraft", JSON.stringify(d)), draft);
        await page.goto("/en?step=items");
        await page.getByTestId("pick-product").first().click();
        await page.getByRole("option", { name: /Consulting/ }).click();
        await expect(page.getByText("Service: does not use stock")).toBeVisible();
    });

    test("archived products are not offered", async ({ page }) => {
        await restore(page, { products: [product("w", "Old Widget", "W-1", { archived: true })], stockMovements: [] });
        await page.addInitScript((d) => localStorage.setItem("invoify:invoiceDraft", JSON.stringify(d)), draft);
        await page.goto("/en?step=items");
        await page.getByTestId("pick-product").first().click();
        await expect(page.getByText("No products yet. Add them on the Products page.")).toBeVisible();
    });
});

test.describe("backup carries the catalogue", () => {
    test("an exported backup contains products and stock history", async ({ page }) => {
        await restore(page, { products: [product("w", "Widget", "W-1")], stockMovements: [opening("w", 10)] });
        await page.goto("/en/settings");
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Export backup|Download backup/i }).first().click()]);
        const text = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
        const json = JSON.parse(text);
        expect(json.data.products).toHaveLength(1);
        expect(json.data.products[0].sku).toBe("W-1");
        expect(json.data.stockMovements).toHaveLength(1);
        expect(json.counts.products).toBe(1);
    });
});
