import { test, expect, type Page } from "@playwright/test";

import { gstinCheckChar } from "../lib/gst";

/** Business profile, suppliers and purchase orders, through the real UI and the real stores. */

const gstin = (state: string, pan: string) => {
    const first14 = `${state}${pan}1Z`;
    return `${first14}${gstinCheckChar(first14)}`;
};
const MH = gstin("27", "AAPFU0939F"); // Maharashtra
const KA = gstin("29", "BBBPK1234C"); // Karnataka

const NOW = "2026-01-01T00:00:00.000Z";

const supplier = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    contactPerson: "Riya",
    email: `${id}@supplier.test`,
    phone: "9876543210",
    address: "5 Industrial Area",
    city: "Pune",
    zipCode: "411001",
    country: "India",
    state: "",
    gstin: MH,
    pan: "",
    paymentTermsDays: 30,
    currency: "INR",
    openingBalance: 0,
    notes: "",
    inactive: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
});

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
    minStock: 3,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
});

const opening = (productId: string, qty: number) => ({ id: `open-${productId}`, productId, date: "2026-01-02T00:00:00.000Z", qty, kind: "opening" });

const sup1 = supplier("sup-1", "Acme Traders");
const sup2 = supplier("sup-2", "Bangalore Bolts", { gstin: KA, email: "bb@supplier.test" });
const widget = product("widget", "Widget");

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

type Business = Partial<Record<"name" | "address" | "city" | "zipCode" | "country" | "email" | "phone" | "gstin", string>>;
const COMPLETE: Business = { name: "My Shop", gstin: MH, address: "12 Market Road", city: "Mumbai", zipCode: "400001", country: "India", email: "me@shop.test", phone: "9999999999" };

async function setBusiness(page: Page, b: Business = COMPLETE) {
    await page.goto("/en/settings");
    const form = page.getByTestId("business-form");
    await expect(form).toBeVisible();
    const ids = { name: "#b-name", gstin: "#b-gstin", address: "#b-address", city: "#b-city", zipCode: "#b-zip", country: "#b-country", email: "#b-email", phone: "#b-phone" } as const;
    for (const [k, v] of Object.entries(b)) await form.locator(ids[k as keyof typeof ids]).fill(v);
    await page.getByTestId("business-save").click();
    // Saved once the button goes back to disabled (nothing left to save).
    await expect(page.getByTestId("business-save")).toBeDisabled();
}

const cards = (page: Page) => page.getByTestId("supplier-card");
const poCards = (page: Page) => page.getByTestId("po-card");
const noHorizontalScroll = async (page: Page) =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

async function newOrder(page: Page, supplierName: string) {
    await page.goto("/en/purchase-orders");
    await page.getByTestId("po-new").click();
    await expect(page.getByTestId("po-dialog")).toBeVisible();
    await page.getByTestId("po-supplier").selectOption({ label: supplierName });
}

async function addWidgetLine(page: Page, qty: string, price: string) {
    await page.getByTestId("po-add-product").selectOption({ label: "Widget (WIDGET)" });
    const line = page.getByTestId("po-line").last();
    await line.getByTestId("po-line-qty").fill(qty);
    await line.getByTestId("po-line-price").fill(price);
    return line;
}

test.describe("business profile", () => {
    test("saves, derives the state from the GSTIN and survives a reload", async ({ page }) => {
        await setBusiness(page);
        await page.reload();
        await expect(page.getByTestId("business-gstin")).toHaveValue(MH);
        await expect(page.getByTestId("business-name")).toHaveValue("My Shop");
        // The state follows the GSTIN and cannot contradict it.
        await expect(page.getByTestId("business-state")).toHaveValue("27");
        await expect(page.getByTestId("business-state")).toBeDisabled();
    });

    test("a malformed GSTIN is flagged and cannot be saved", async ({ page }) => {
        await page.goto("/en/settings");
        await page.getByTestId("business-gstin").fill("27AAAAA0000A1Z5");
        await expect(page.getByText("This is not a valid GSTIN")).toBeVisible();
        await expect(page.getByTestId("business-save")).toBeDisabled();
    });

    test("purchase number prefixes are saved and used for new orders", async ({ page }) => {
        await restore(page, { suppliers: [sup1] });
        await setBusiness(page, COMPLETE);
        await page.getByTestId("business-po-prefix").fill("BUY");
        await page.getByTestId("business-save").click();
        await expect(page.getByTestId("business-save")).toBeDisabled();
        await newOrder(page, "Acme Traders");
        await page.getByTestId("po-line-name").fill("Gadget");
        await page.getByTestId("po-line-price").fill("10");
        await page.getByTestId("po-save").click();
        await expect(poCards(page).first()).toHaveAttribute("data-number", "BUY-0001");
    });
});

test.describe("suppliers", () => {
    test("shows an empty state, then creates a supplier with a valid GSTIN", async ({ page }) => {
        await page.goto("/en/suppliers");
        await expect(page.getByTestId("suppliers-empty")).toBeVisible();

        await page.getByTestId("supplier-new").first().click();
        await page.getByTestId("supplier-name").fill("Acme Traders");
        await page.getByTestId("supplier-gstin").fill(MH.toLowerCase());
        // The state is read from the GSTIN.
        await expect(page.getByTestId("supplier-state")).toHaveValue("27");
        await expect(page.getByText("Valid format · Maharashtra")).toBeVisible();
        await page.getByTestId("supplier-terms").fill("45");
        await page.getByTestId("supplier-save").click();

        await expect(cards(page)).toHaveCount(1);
        await expect(cards(page).first()).toContainText("Acme Traders");
        await expect(cards(page).first()).toContainText(MH);
        await expect(cards(page).first()).toContainText("Net 45 days");
    });

    test("refuses a missing name, a bad GSTIN, a duplicate GSTIN and a duplicate name", async ({ page }) => {
        await restore(page, { suppliers: [sup1] });
        await page.goto("/en/suppliers");
        await page.getByTestId("supplier-new").click();
        await page.getByTestId("supplier-save").click();
        await expect(page.getByText("Enter the supplier's name")).toBeVisible();

        await page.getByTestId("supplier-name").fill("Other Co");
        await page.getByTestId("supplier-gstin").fill("27AAAAA0000A1Z5");
        await page.getByTestId("supplier-save").click();
        await expect(page.getByText("This is not a valid GSTIN")).toBeVisible();

        await page.getByTestId("supplier-gstin").fill(MH);
        await page.getByTestId("supplier-save").click();
        await expect(page.getByText("Another supplier already has this GSTIN")).toBeVisible();

        await page.getByTestId("supplier-gstin").fill(KA);
        await page.getByTestId("supplier-name").fill("  acme   TRADERS ");
        await page.getByTestId("supplier-save").click();
        await expect(page.getByText("A supplier with this name already exists")).toBeVisible();
        await expect(cards(page)).toHaveCount(1);
    });

    test("edits, deactivates (hidden from the default view) and reactivates", async ({ page }) => {
        await restore(page, { suppliers: [sup1, sup2] });
        await page.goto("/en/suppliers");
        await expect(cards(page)).toHaveCount(2);

        await page.getByRole("button", { name: "Edit: Acme Traders" }).click();
        await page.getByTestId("supplier-name").fill("Acme Traders Ltd");
        await page.getByTestId("supplier-save").click();
        await expect(cards(page).filter({ hasText: "Acme Traders Ltd" })).toHaveCount(1);

        await page.getByRole("button", { name: "Make inactive: Acme Traders Ltd" }).click();
        await expect(cards(page)).toHaveCount(1);
        await page.getByTestId("suppliers-status").selectOption("inactive");
        await expect(cards(page)).toHaveCount(1);
        await expect(cards(page).first()).toContainText("Inactive");
        await page.getByRole("button", { name: "Make active: Acme Traders Ltd" }).click();
        await page.getByTestId("suppliers-status").selectOption("all");
        await expect(cards(page)).toHaveCount(2);
    });

    test("searches by name and GSTIN", async ({ page }) => {
        await restore(page, { suppliers: [sup1, sup2] });
        await page.goto("/en/suppliers");
        await page.getByTestId("suppliers-search").fill("bangalore");
        await expect(cards(page)).toHaveCount(1);
        await page.getByTestId("suppliers-search").fill(MH.slice(0, 8));
        await expect(cards(page)).toHaveCount(1);
        await expect(cards(page).first()).toContainText("Acme Traders");
        await page.getByTestId("suppliers-search").fill("zzzz");
        await expect(page.getByTestId("suppliers-nomatch")).toBeVisible();
    });

    test("deletes a supplier nothing refers to", async ({ page }) => {
        await restore(page, { suppliers: [sup1] });
        await page.goto("/en/suppliers");
        await page.getByRole("button", { name: "Delete: Acme Traders" }).click();
        await page.getByTestId("supplier-delete-confirm").click();
        await expect(page.getByTestId("suppliers-empty")).toBeVisible();
    });

    test("flags a supplier that is also a customer, by GSTIN", async ({ page }) => {
        await restore(page, { suppliers: [sup1], clients: [{ name: "Acme Traders", address: "1 Road", zipCode: "1234", city: "Pune", country: "India", email: "x@y.test", phone: "1", gstin: MH }] });
        await page.goto("/en/suppliers");
        await expect(cards(page).first().getByTestId("also-customer")).toBeVisible();
    });

    test("exports the list as CSV", async ({ page }) => {
        await restore(page, { suppliers: [sup1, sup2] });
        await page.goto("/en/suppliers");
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("suppliers-export").click()]);
        expect(download.suggestedFilename()).toBe("suppliers.csv");
        const text = (await (await download.createReadStream()).toArray()).map((c) => c.toString()).join("");
        expect(text).toContain("Acme Traders");
        expect(text).toContain("Bangalore Bolts");
    });
});

test.describe("purchase orders", () => {
    test("asks for a supplier first when there are none", async ({ page }) => {
        await page.goto("/en/purchase-orders");
        await expect(page.getByTestId("po-empty")).toContainText("Add a supplier first");
        await expect(page.getByTestId("po-new")).toBeDisabled();
    });

    test("nudges you to complete the Business profile when the state is unknown", async ({ page }) => {
        await restore(page, { suppliers: [sup1] });
        await page.goto("/en/purchase-orders");
        await expect(page.getByTestId("po-business-banner")).toBeVisible();
        await setBusiness(page, { name: "My Shop", gstin: MH });
        await page.goto("/en/purchase-orders");
        await expect(page.getByTestId("po-business-banner")).toHaveCount(0);
    });

    test("an intra-state order splits the tax into CGST and SGST and totals correctly", async ({ page }) => {
        await restore(page, { suppliers: [sup1], products: [widget], stockMovements: [opening("widget", 50)] });
        await setBusiness(page);
        await newOrder(page, "Acme Traders");
        const line = await addWidgetLine(page, "10", "100");
        await expect(line.getByTestId("po-line-amount")).toContainText("1,000.00");
        const totals = page.getByTestId("po-totals");
        await expect(totals.getByTestId("po-cgst")).toContainText("90.00");
        await expect(totals.getByTestId("po-sgst")).toContainText("90.00");
        await expect(totals.getByTestId("po-igst")).toHaveCount(0);
        await expect(page.getByTestId("po-total")).toContainText("1,180.00");
        await expect(page.getByTestId("po-supply")).toContainText("Intra-state");
    });

    test("an inter-state order uses IGST", async ({ page }) => {
        await restore(page, { suppliers: [sup2], products: [widget], stockMovements: [opening("widget", 50)] });
        await setBusiness(page);
        await newOrder(page, "Bangalore Bolts");
        await addWidgetLine(page, "10", "100");
        await expect(page.getByTestId("po-igst")).toContainText("180.00");
        await expect(page.getByTestId("po-cgst")).toHaveCount(0);
        await expect(page.getByTestId("po-supply")).toContainText("Inter-state");
    });

    test("an unknown state is flagged, not guessed", async ({ page }) => {
        await restore(page, { suppliers: [sup1], products: [widget], stockMovements: [opening("widget", 50)] });
        await newOrder(page, "Acme Traders");
        await addWidgetLine(page, "1", "100");
        await expect(page.getByTestId("po-supply")).toContainText("State not known");
    });

    test("validates before saving: a supplier, an item name, a price", async ({ page }) => {
        await restore(page, { suppliers: [sup1] });
        await page.goto("/en/purchase-orders");
        await page.getByTestId("po-new").click();
        await page.getByTestId("po-save").click();
        await expect(page.getByText("Choose a supplier")).toBeVisible();
        await expect(page.getByText("Enter the item name")).toBeVisible();
        await expect(page.getByText("Price must be more than 0")).toBeVisible();
        await page.getByTestId("po-supplier").selectOption({ label: "Acme Traders" });
        await page.getByTestId("po-expected").fill("2000-01-01");
        await page.getByTestId("po-save").click();
        await expect(page.getByText("Cannot be before the order date")).toBeVisible();
        await expect(poCards(page)).toHaveCount(0);
    });

    test("creates a draft, numbers it automatically and runs the whole status flow", async ({ page }) => {
        await restore(page, { suppliers: [sup1], products: [widget], stockMovements: [opening("widget", 50)] });
        await setBusiness(page);
        await newOrder(page, "Acme Traders");
        await addWidgetLine(page, "10", "100");
        await page.getByTestId("po-save").click();

        const card = poCards(page).first();
        await expect(card).toHaveAttribute("data-number", "PO-0001");
        await expect(card).toHaveAttribute("data-status", "draft");
        await expect(card.getByTestId("po-card-total")).toContainText("1,180.00");

        await card.getByTestId("po-mark-sent").click();
        await expect(card).toHaveAttribute("data-status", "sent");

        // A second order continues the sequence.
        await page.getByTestId("po-new").click();
        await page.getByTestId("po-supplier").selectOption({ label: "Acme Traders" });
        await page.getByTestId("po-line-name").fill("Gadget");
        await page.getByTestId("po-line-price").fill("10");
        await page.getByTestId("po-save-send").click();
        await expect(poCards(page)).toHaveCount(2);
        await expect(poCards(page).filter({ has: page.locator('[data-testid="po-status"]', { hasText: "Sent" }) })).toHaveCount(2);
        await expect(page.locator('[data-testid="po-card"][data-number="PO-0002"]')).toBeVisible();

        // Cancel (with confirmation), restore as draft, then delete.
        const first = page.locator('[data-testid="po-card"][data-number="PO-0001"]');
        await first.getByTestId("po-cancel").click();
        await page.getByTestId("po-confirm").click();
        await expect(first).toHaveAttribute("data-status", "cancelled");
        await first.getByTestId("po-restore").click();
        await expect(first).toHaveAttribute("data-status", "draft");
        await first.getByTestId("po-delete").click();
        await page.getByTestId("po-confirm").click();
        await expect(poCards(page)).toHaveCount(1);

        // A deleted number is never handed out again.
        await page.getByTestId("po-new").click();
        await page.getByTestId("po-supplier").selectOption({ label: "Acme Traders" });
        await page.getByTestId("po-line-name").fill("Third");
        await page.getByTestId("po-line-price").fill("5");
        await page.getByTestId("po-save").click();
        await expect(page.locator('[data-testid="po-card"][data-number="PO-0003"]')).toBeVisible();
    });

    test("editing keeps the number and recalculates; a sent order stays editable", async ({ page }) => {
        await restore(page, { suppliers: [sup1], products: [widget], stockMovements: [opening("widget", 50)] });
        await setBusiness(page);
        await newOrder(page, "Acme Traders");
        await addWidgetLine(page, "10", "100");
        await page.getByTestId("po-save-send").click();
        const card = poCards(page).first();
        await card.getByTestId("po-edit").click();
        await expect(page.getByTestId("po-number")).toHaveValue("PO-0001");
        await page.getByTestId("po-line-qty").fill("20");
        await expect(page.getByTestId("po-total")).toContainText("2,360.00");
        await page.getByTestId("po-save").click();
        await expect(card.getByTestId("po-card-total")).toContainText("2,360.00");
        await expect(card).toHaveAttribute("data-status", "sent");
    });

    test("a supplier with orders cannot be deleted, only made inactive", async ({ page }) => {
        await restore(page, { suppliers: [sup1] });
        await newOrder(page, "Acme Traders");
        await page.getByTestId("po-line-name").fill("Gadget");
        await page.getByTestId("po-line-price").fill("10");
        await page.getByTestId("po-save").click();
        await expect(poCards(page)).toHaveCount(1);

        await page.goto("/en/suppliers");
        await page.getByRole("button", { name: "Delete: Acme Traders" }).click();
        await page.getByTestId("supplier-delete-confirm").click();
        await expect(page.getByText("has purchase orders, so it cannot be deleted").first()).toBeVisible();
        await expect(cards(page)).toHaveCount(1);
        await expect(cards(page).first()).toContainText("1 purchase order");
    });

    test("'Add low-stock products' proposes a restock quantity for what is at or below its minimum", async ({ page }) => {
        const low = product("low", "Low Thing", { minStock: 10 });
        const fine = product("fine", "Fine Thing", { minStock: 2 });
        await restore(page, { suppliers: [sup1], products: [low, fine], stockMovements: [opening("low", 4), opening("fine", 50)] });
        await newOrder(page, "Acme Traders");
        await page.getByTestId("po-add-lowstock").click();
        await expect(page.getByTestId("po-line")).toHaveCount(1);
        await expect(page.getByTestId("po-line-name")).toHaveValue("Low Thing");
        // twice the minimum, less what is on hand: 2 × 10 − 4
        await expect(page.getByTestId("po-line-qty")).toHaveValue("16");
        // Clicking again does not duplicate the product.
        await page.getByTestId("po-add-lowstock").click();
        await expect(page.getByTestId("po-line")).toHaveCount(1);
    });

    test("filters by status and searches", async ({ page }) => {
        await restore(page, { suppliers: [sup1] });
        await newOrder(page, "Acme Traders");
        await page.getByTestId("po-line-name").fill("Gadget");
        await page.getByTestId("po-line-price").fill("10");
        await page.getByTestId("po-save-send").click();
        await page.getByTestId("po-new").click();
        await page.getByTestId("po-supplier").selectOption({ label: "Acme Traders" });
        await page.getByTestId("po-line-name").fill("Sprocket");
        await page.getByTestId("po-line-price").fill("10");
        await page.getByTestId("po-save").click();
        await expect(poCards(page)).toHaveCount(2);

        await page.getByTestId("po-status-filter").selectOption("draft");
        await expect(poCards(page)).toHaveCount(1);
        await expect(poCards(page).first()).toContainText("PO-0002");
        await page.getByTestId("po-status-filter").selectOption("all");
        await page.getByTestId("po-search").fill("sprocket");
        await expect(poCards(page)).toHaveCount(1);
        await page.getByTestId("po-search").fill("nothing-like-this");
        await expect(page.getByTestId("po-nomatch")).toBeVisible();
    });
});

test.describe("purchase order PDF", () => {
    const fullSupplier = supplier("sup-1", "Acme Traders");

    test("downloads a real PDF named after the order", async ({ page }) => {
        await restore(page, { suppliers: [fullSupplier], products: [widget], stockMovements: [opening("widget", 50)] });
        await setBusiness(page);
        await newOrder(page, "Acme Traders");
        await addWidgetLine(page, "10", "100");
        await page.getByTestId("po-save-send").click();

        const [download] = await Promise.all([page.waitForEvent("download"), poCards(page).first().getByTestId("po-pdf").click()]);
        expect(download.suggestedFilename()).toBe("purchase-order-PO-0001.pdf");
        const bytes = Buffer.concat((await (await download.createReadStream()).toArray()) as Buffer[]);
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        expect(bytes.length).toBeGreaterThan(2000);
    });

    test("says which party to complete when details are missing, and makes no PDF", async ({ page }) => {
        await restore(page, { suppliers: [fullSupplier] });
        await setBusiness(page, { name: "My Shop", gstin: MH });
        await newOrder(page, "Acme Traders");
        await page.getByTestId("po-line-name").fill("Gadget");
        await page.getByTestId("po-line-price").fill("10");
        await page.getByTestId("po-save").click();
        await poCards(page).first().getByTestId("po-pdf").click();
        await expect(page.getByText(/Complete your Business profile/).first()).toBeVisible();
    });
});

test.describe("backup and restore", () => {
    const order = (over: Record<string, unknown> = {}) => ({
        id: "po-1",
        number: "PO-0001",
        supplierId: "sup-1",
        supplier: { name: "Acme Traders", gstin: MH, state: "27", address: "5 Industrial Area", city: "Pune", zipCode: "411001", country: "India", email: "a@b.test", phone: "1" },
        date: "2026-03-01",
        // Far in the future so the derived status stays "sent" whatever day this runs.
        expectedDate: "2099-12-31",
        currency: "INR",
        lines: [{ id: "l1", name: "Widget", description: "", hsn: "8471", unit: "pcs", quantity: 10, unitPrice: 100, taxRate: 18 }],
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

    test("a backup holding only suppliers, or only purchase orders, can be restored", async ({ page }) => {
        const upload = async (data: Record<string, unknown>) => {
            await page.goto("/en/settings");
            await page.getByTestId("backup-file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: [], ...data } })) });
            return page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true });
        };
        await expect(await upload({ suppliers: [sup1] })).toBeEnabled();
        await expect(await upload({ purchaseOrders: [order()] })).toBeEnabled();
        // A file with nothing in it still cannot be "restored".
        await expect(await upload({})).toBeDisabled();
    });

    test("an exported backup carries suppliers and purchase orders", async ({ page }) => {
        await restore(page, { suppliers: [sup1], purchaseOrders: [order()] });
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).click()]);
        const file = JSON.parse((await (await download.createReadStream()).toArray()).map((c) => c.toString()).join(""));
        expect(file.version).toBe(2);
        expect(file.counts).toMatchObject({ suppliers: 1, purchaseOrders: 1 });
        expect(file.data.suppliers[0].name).toBe("Acme Traders");
        expect(file.data.purchaseOrders[0].number).toBe("PO-0001");
        expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    test("restoring twice never duplicates, and an older backup leaves existing suppliers alone", async ({ page }) => {
        await restore(page, { suppliers: [sup1], purchaseOrders: [order()] });
        await restore(page, { suppliers: [sup1], purchaseOrders: [order()] });
        await restore(page, { products: [widget] }); // a backup from before purchasing existed: products, but no suppliers key
        await page.goto("/en/suppliers");
        await expect(cards(page)).toHaveCount(1);
        await page.goto("/en/purchase-orders");
        await expect(poCards(page)).toHaveCount(1);
        await expect(poCards(page).first()).toHaveAttribute("data-status", "sent");
    });

    test("an order restored with a supplier that is already held follows that supplier, and a clashing number is renumbered", async ({ page }) => {
        await restore(page, { suppliers: [sup1], purchaseOrders: [order()] });
        // Same GSTIN under a different id, and an order with the same number but a different id.
        await restore(page, { suppliers: [{ ...sup1, id: "sup-other" }], purchaseOrders: [order({ id: "po-2", supplierId: "sup-other" })] });
        await page.goto("/en/suppliers");
        await expect(cards(page)).toHaveCount(1);
        await page.goto("/en/purchase-orders");
        await expect(poCards(page)).toHaveCount(2);
        const numbers = await poCards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-number")));
        expect(new Set(numbers).size).toBe(2);
        // The order is attached to the supplier we hold, so the supplier cannot be deleted.
        await page.goto("/en/suppliers");
        await page.getByRole("button", { name: "Delete: Acme Traders" }).click();
        await page.getByTestId("supplier-delete-confirm").click();
        await expect(cards(page)).toHaveCount(1);
    });

    test("invalid purchasing records are reported and left out, not repaired", async ({ page }) => {
        const file = {
            name: "backup.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: [], suppliers: [sup1, { nope: true }], purchaseOrders: [{ id: "x" }] } })),
        };
        await page.goto("/en/settings");
        await page.getByTestId("backup-file").setInputFiles(file);
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("2 item(s) in this file are invalid")).toBeVisible();
        await dialog.getByRole("button", { name: "Restore", exact: true }).click();
        await expect(page.getByText("Backup restored", { exact: true }).first()).toBeVisible();
        await page.keyboard.press("Escape");
        await page.goto("/en/suppliers");
        await expect(cards(page)).toHaveCount(1);
    });
});

test.describe("layout", () => {
    test("suppliers, purchase orders and the order dialog fit the viewport", async ({ page }) => {
        await restore(page, { suppliers: [sup1, sup2], products: [widget], stockMovements: [opening("widget", 50)] });
        await setBusiness(page);
        await page.goto("/en/suppliers");
        await expect(cards(page).first()).toBeVisible();
        await noHorizontalScroll(page);

        await newOrder(page, "Acme Traders");
        await addWidgetLine(page, "10", "100");
        await noHorizontalScroll(page);
        const box = await page.getByTestId("po-dialog").boundingBox();
        const viewport = page.viewportSize()!;
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.goto("/en/purchase-orders");
        await noHorizontalScroll(page);
    });
});
