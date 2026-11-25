import { test, expect, type Page } from "@playwright/test";

import { gstinCheckChar } from "../lib/gst";
import { day, party } from "./fixtures";

/** Quotations through the real UI, stores and PDF endpoint. */

const SELLER_GSTIN = "27AAPFU0939F1ZV";
const gstin = (state: string) => {
    const first14 = `${state}AABCT1332L1Z`;
    return first14 + gstinCheckChar(first14);
};

type Rec = {
    id: string;
    number: string;
    status: "draft" | "sent" | "accepted" | "rejected";
    issued?: number;
    validIn?: number;
    customer?: string;
    email?: string;
    total?: number;
    currency?: string;
    items?: Record<string, unknown>[];
    gst?: boolean;
    place?: string;
};

/** A stored quotation, as the app itself would have written it. */
const rec = (o: Rec) => {
    const total = o.total ?? 1180;
    const gstOn = o.gst !== false;
    return {
        id: o.id,
        status: o.status,
        createdAt: day(-10),
        updatedAt: day(-10),
        events: [{ at: day(-10), kind: "created" }],
        doc: {
            sender: { ...party("Sharma Traders", "sharma@example.com"), gstin: SELLER_GSTIN },
            receiver: { ...party(o.customer ?? "Acme Corp", o.email ?? "buyer@acme.test"), gstin: "" },
            details: {
                invoiceNumber: o.number,
                // Issued before it expires: the document rule is valid-until >= issue date.
                invoiceDate: day(o.issued ?? Math.min(-1, (o.validIn ?? 20) - 1)),
                dueDate: day(o.validIn ?? 20),
                currency: o.currency ?? "USD",
                language: "English",
                status: "draft",
                items: o.items ?? [{ name: "Laptop", quantity: 1, unitPrice: 1000, total: 1000, hsn: "8471", gstRate: 18 }],
                ...(gstOn ? { gst: { enabled: true, pricing: "exclusive", placeOfSupply: o.place ?? "27", taxableValue: 1000, cgst: 90, sgst: 90, igst: 0, totalTax: 180 } } : {}),
                taxDetails: { amount: 0, amountType: "amount" },
                discountDetails: { amount: 0, amountType: "amount" },
                shippingDetails: { cost: 0, costType: "amount" },
                subTotal: 1000,
                totalAmount: total,
                totalAmountInWords: "",
                paymentTerms: "Net 30",
                pdfTemplate: 1,
                theme: { accentColor: "#4F46E5", fontId: "outfit", density: "comfortable" },
            },
        },
    };
};

const product = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    sku: id.toUpperCase(),
    category: "Hardware",
    description: "",
    type: "product",
    unit: "pcs",
    sellingPrice: 1000,
    purchasePrice: 600,
    taxRate: 18,
    hsn: "8471",
    trackStock: true,
    minStock: 2,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
});
const opening = (productId: string, qty: number) => ({ id: `open-${productId}`, productId, date: "2026-01-02T00:00:00.000Z", qty, kind: "opening" });
const clientRec = (name: string, email: string) => ({ id: `c-${name}`, ...party(name, email) });

async function restore(page: Page, data: Record<string, unknown>) {
    const file = {
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(
            JSON.stringify({
                format: "invoify-backup",
                version: 2,
                data: { invoices: [], clients: [], senders: [], templates: [], settings: null, products: [], stockMovements: [], quotations: [], ...data },
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

const qrows = (page: Page) => page.locator('[data-testid="quotation-row"]:visible');
const qrow = (page: Page, number: string) => page.locator(`[data-testid="quotation-row"][data-number="${number}"]:visible`);
const statusOf = (page: Page, number: string) => qrow(page, number).getByTestId("quotation-status").first();
const gotoList = async (page: Page) => {
    await page.goto("/en/quotations");
    await expect(page.getByRole("heading", { name: "Quotations", level: 1 })).toBeVisible();
};

/** A representative set: every status, one expiring soon, one expired, one in another currency. */
const SET = [
    rec({ id: "d", number: "QUO-D", status: "draft", total: 500 }),
    rec({ id: "s1", number: "QUO-S1", status: "sent", validIn: 20, total: 1000 }),
    rec({ id: "s2", number: "QUO-S2", status: "sent", validIn: 3, total: 2000 }),
    rec({ id: "x", number: "QUO-X", status: "sent", validIn: -2, total: 400 }),
    rec({ id: "a", number: "QUO-A", status: "accepted", total: 3000 }),
    rec({ id: "r", number: "QUO-R", status: "rejected", total: 700 }),
    rec({ id: "a2", number: "QUO-A2", status: "accepted", total: 1000, currency: "EUR" }),
];

/* ================================================================= list */

test.describe("quotation list", () => {
    test("empty state offers to create the first quotation", async ({ page }) => {
        await page.goto("/en/quotations");
        await expect(page.getByRole("heading", { name: "No quotations yet" })).toBeVisible();
        await expect(page.getByRole("link", { name: /Create your first quotation/ })).toBeVisible();
    });

    test("every status is shown, expiry is derived, and warnings appear", async ({ page }) => {
        await restore(page, { quotations: SET });
        await gotoList(page);
        await expect(qrows(page)).toHaveCount(7);

        await expect(statusOf(page, "QUO-D")).toHaveAttribute("data-status", "draft");
        await expect(statusOf(page, "QUO-S1")).toHaveAttribute("data-status", "sent");
        await expect(statusOf(page, "QUO-A")).toHaveAttribute("data-status", "accepted");
        await expect(statusOf(page, "QUO-R")).toHaveAttribute("data-status", "rejected");
        // Stored as "sent", shown as expired because its valid-until date has passed.
        await expect(statusOf(page, "QUO-X")).toHaveAttribute("data-status", "expired");

        await expect(qrow(page, "QUO-S2").getByTestId("expiry-note")).toContainText("Expires in 3 day(s)");
        await expect(qrow(page, "QUO-X").getByTestId("expiry-note")).toContainText("Expired 2 day(s) ago");
        // Nothing to warn about when there is plenty of time, or once decided.
        await expect(qrow(page, "QUO-S1").getByTestId("expiry-note")).toHaveCount(0);
        await expect(qrow(page, "QUO-A").getByTestId("expiry-note")).toHaveCount(0);
    });

    test("metrics are computed from the stored quotations", async ({ page }) => {
        await restore(page, { quotations: SET });
        await gotoList(page);
        await expect(page.getByTestId("m-total")).toHaveText("7");
        await expect(page.getByTestId("m-accepted")).toHaveText("2");
        await expect(page.getByTestId("m-rejected")).toHaveText("1");
        await expect(page.getByTestId("m-pending")).toHaveText("2"); // sent and still valid
        // 2 accepted of 6 issued (the draft is excluded)
        await expect(page.getByTestId("m-rate")).toHaveText("33%");
        // 1000 + 2000 + 400 + 3000 + 700 in USD; 1000 in EUR; the draft is excluded; currencies stay separate
        await expect(page.getByTestId("m-value")).toContainText("$7,100.00");
        await expect(page.getByTestId("m-value")).toContainText("€1,000.00");
    });

    test("search, status filters and sorting", async ({ page }) => {
        await restore(page, { quotations: [...SET, rec({ id: "g", number: "QUO-G", status: "sent", customer: "Globex Ltd", email: "ap@globex.test", total: 150 })] });
        await gotoList(page);

        await page.getByRole("searchbox").fill("globex");
        await expect(qrows(page)).toHaveCount(1);
        await expect(qrow(page, "QUO-G")).toBeVisible();
        await page.getByRole("searchbox").fill("");

        await page.getByRole("combobox", { name: "Status" }).click();
        await page.getByRole("option", { name: "Expired", exact: true }).click();
        await expect(qrows(page)).toHaveCount(1);
        await expect(qrow(page, "QUO-X")).toBeVisible();

        await page.getByRole("combobox", { name: "Status" }).click();
        await page.getByRole("option", { name: "Expiring soon" }).click();
        await expect(qrows(page)).toHaveCount(1);
        await expect(qrow(page, "QUO-S2")).toBeVisible();

        await page.getByRole("combobox", { name: "Status" }).click();
        await page.getByRole("option", { name: "All statuses" }).click();
        await page.getByRole("combobox", { name: "Sort" }).click();
        await page.getByRole("option", { name: "Sort: Amount" }).click();
        // newest-first default direction: largest amount on top
        await expect(qrows(page).first()).toHaveAttribute("data-number", "QUO-A");
        await page.getByTestId("sort-dir").click();
        await expect(qrows(page).first()).toHaveAttribute("data-number", "QUO-G");
    });

    test("the view sheet shows the document, GST breakdown and activity", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "a", number: "QUO-A", status: "accepted", total: 1180 })] });
        await gotoList(page);
        await qrow(page, "QUO-A").locator("button", { hasText: "QUO-A" }).first().click();
        const sheet = page.getByTestId("quotation-view");
        await expect(sheet).toContainText("QUO-A");
        await expect(sheet.getByTestId("view-cgst")).toContainText("90.00");
        await expect(sheet.getByTestId("view-sgst")).toContainText("90.00");
        await expect(sheet.getByTestId("view-total")).toContainText("$1,180.00");
        await expect(sheet.getByTestId("quotation-items")).toContainText("Laptop");
        await expect(sheet.getByTestId("quotation-timeline")).toContainText("Created");
        await expect(sheet).toContainText(SELLER_GSTIN);
    });

    test("CSV export contains one line per quotation", async ({ page }) => {
        await restore(page, { quotations: SET });
        await gotoList(page);
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-quotations").click()]);
        const text = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
        const lines = text.trim().split(/\r?\n/);
        expect(lines).toHaveLength(8);
        expect(text).toContain("QUO-X");
        expect(lines.find((l) => l.includes("QUO-X"))).toContain("expired");
    });
});

/* ============================================================== status */

test.describe("status workflow", () => {
    test("send, then accept; accepted quotations offer conversion", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "d", number: "QUO-D", status: "draft" })] });
        await gotoList(page);
        await qrow(page, "QUO-D").getByRole("button", { name: "Mark as sent" }).click();
        await expect(statusOf(page, "QUO-D")).toHaveAttribute("data-status", "sent");
        await qrow(page, "QUO-D").getByRole("button", { name: "Accept", exact: true }).click();
        await expect(statusOf(page, "QUO-D")).toHaveAttribute("data-status", "accepted");
        await expect(qrow(page, "QUO-D").getByTestId("convert")).toBeVisible();
        // a decision is not a draft: no accept/reject buttons remain
        await expect(qrow(page, "QUO-D").getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    });

    test("reject, then reopen", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "s", number: "QUO-S", status: "sent" })] });
        await gotoList(page);
        await qrow(page, "QUO-S").getByRole("button", { name: "Reject" }).click();
        await expect(statusOf(page, "QUO-S")).toHaveAttribute("data-status", "rejected");
        await expect(qrow(page, "QUO-S").getByTestId("convert")).toHaveCount(0);
        await qrow(page, "QUO-S").getByRole("button", { name: "Reopen" }).click();
        await expect(statusOf(page, "QUO-S")).toHaveAttribute("data-status", "sent");
    });

    test("an expired quotation cannot be accepted, only rejected", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "x", number: "QUO-X", status: "sent", validIn: -2 })] });
        await gotoList(page);
        await expect(qrow(page, "QUO-X").getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
        await expect(qrow(page, "QUO-X").getByRole("button", { name: "Reject" })).toBeVisible();
    });

    test("a draft already past its validity cannot be sent", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "d", number: "QUO-D", status: "draft", validIn: -3 })] });
        await gotoList(page);
        await qrow(page, "QUO-D").getByRole("button", { name: "Mark as sent" }).click();
        await expect(page.getByText("The valid-until date has passed. Choose a later date first.").first()).toBeVisible();
        await expect(statusOf(page, "QUO-D")).toHaveAttribute("data-status", "draft");
    });

    test("a stale screen cannot make an illegal change", async ({ page, context }) => {
        await restore(page, { quotations: [rec({ id: "s", number: "QUO-S", status: "sent" })] });
        await gotoList(page);
        // Another tab accepts it first.
        const other = await context.newPage();
        await gotoList(other);
        await qrow(other, "QUO-S").getByRole("button", { name: "Accept", exact: true }).click();
        await expect(statusOf(other, "QUO-S")).toHaveAttribute("data-status", "accepted");
        // This tab still believes it is "sent" and tries to reject: the store refuses.
        await qrow(page, "QUO-S").getByRole("button", { name: "Reject" }).click();
        await expect(page.getByText("Reopen it first (mark as sent).").first()).toBeVisible();
    });

    test("deleting asks first, and only unconverted quotations can be deleted", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "d", number: "QUO-D", status: "draft" }), rec({ id: "k", number: "QUO-K", status: "draft" })] });
        await gotoList(page);
        await qrow(page, "QUO-D").getByRole("button", { name: "Delete: QUO-D" }).click();
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toContainText("Delete quotation QUO-D?");
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(qrow(page, "QUO-D")).toBeVisible();

        await qrow(page, "QUO-D").getByRole("button", { name: "Delete: QUO-D" }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
        await expect(qrow(page, "QUO-D")).toHaveCount(0);
        await expect(qrow(page, "QUO-K")).toBeVisible();
    });
});

/* ============================================================== builder */

const fillParty = async (page: Page, side: "sender" | "receiver", p: { name: string; gstin?: string }) => {
    await page.locator(`input[name="${side}.name"]`).fill(p.name);
    await page.locator(`input[name="${side}.address"]`).fill("12 MG Road");
    await page.locator(`input[name="${side}.zipCode"]`).fill("400001");
    await page.locator(`input[name="${side}.city"]`).fill("Mumbai");
    await page.locator(`input[name="${side}.country"]`).fill("India");
    await page.locator(`input[name="${side}.email"]`).fill(`${side}@example.com`);
    await page.locator(`input[name="${side}.phone"]`).fill("9876543210");
    if (p.gstin) await page.locator(`input[name="${side}.gstin"]`).fill(p.gstin);
};

test.describe("quotation builder", () => {
    test("creates a GST quotation, calculates the tax, and lists it as sent", async ({ page, isMobile }) => {
        await page.goto("/en/quotations/builder?new=1");
        await expect(page.getByTestId("quotation-builder")).toBeVisible();
        // numbering starts at QUO-0001
        await expect(page.locator('input[name="details.invoiceNumber"]')).toHaveValue("QUO-0001");

        await fillParty(page, "sender", { name: "Sharma Traders", gstin: SELLER_GSTIN });
        await fillParty(page, "receiver", { name: "Patel Stores" });

        // GST on: place of supply defaults to the seller's state, so this is intra-state.
        await page.getByRole("switch", { name: "Charge GST on this invoice" }).click();
        await expect(page.getByTestId("gst-supply-note")).toContainText("CGST + SGST");

        await page.locator('input[name="details.items[0].name"]').fill("Laptop");
        await page.locator('input[name="details.items[0].quantity"]').fill("2");
        await page.locator('input[name="details.items[0].unitPrice"]').fill("500");
        await page.locator('input[name="details.items[0].hsn"]').fill("8471");

        const breakdown = page.getByTestId("gst-breakdown");
        await expect(breakdown).toContainText("CGST");
        await expect(breakdown).toContainText("SGST");
        await expect(breakdown).not.toContainText("IGST");
        await expect(breakdown).toContainText("180"); // 18% of 1000

        // The preview uses quotation wording on the same templates.
        if (!isMobile) {
            const preview = page.getByTestId("quotation-preview");
            await expect(preview).toContainText("Quotation #");
            await expect(preview).toContainText("Valid until");
            await expect(preview).toContainText("Prepared for");
            await expect(preview).not.toContainText("Due date");
        } else {
            await page.getByTestId("open-preview").click();
            await expect(page.getByRole("dialog").getByTestId("quotation-preview")).toContainText("Prepared for");
            await page.keyboard.press("Escape");
        }

        await page.getByTestId("save-send-quotation").click();
        await expect(page).toHaveURL(/\/quotations$/);
        await expect(qrow(page, "QUO-0001")).toBeVisible();
        await expect(statusOf(page, "QUO-0001")).toHaveAttribute("data-status", "sent");
        await expect(qrow(page, "QUO-0001")).toContainText("$1,180.00"); // 1000 + 180 GST
        await expect(qrow(page, "QUO-0001")).toContainText("Patel Stores");
    });

    test("saving a draft, then editing it, updates the same quotation", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "s", number: "QUO-S", status: "sent", items: [{ name: "Laptop", quantity: 2, unitPrice: 500, total: 1000, hsn: "8471", gstRate: 18 }] })] });
        await gotoList(page);
        await qrow(page, "QUO-S").getByRole("button", { name: "Edit: QUO-S" }).click();
        await expect(page).toHaveURL(/builder\?id=s/);
        await expect(page.locator('input[name="details.invoiceNumber"]')).toHaveValue("QUO-S");
        await expect(page.locator('input[name="details.items[0].name"]')).toHaveValue("Laptop");

        await page.locator('input[name="details.items[0].quantity"]').fill("3");
        await expect(page.getByTestId("gst-breakdown")).toContainText("270"); // 18% of 1500
        await page.getByTestId("save-quotation").click();

        await expect(page).toHaveURL(/\/quotations$/);
        await expect(qrows(page)).toHaveCount(1);
        await expect(qrow(page, "QUO-S")).toContainText("$1,770.00");
        // saving changes does not change the status
        await expect(statusOf(page, "QUO-S")).toHaveAttribute("data-status", "sent");
    });

    test("an incomplete quotation is refused with a pointer to the problem", async ({ page }) => {
        await page.goto("/en/quotations/builder?new=1");
        await expect(page.getByTestId("quotation-builder")).toBeVisible();
        await page.getByTestId("save-quotation").click();
        await expect(page.getByText(/Fix this before saving/).first()).toBeVisible();
        await expect(page).toHaveURL(/builder/);
    });

    test("quotation numbers are unique", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "s", number: "QUO-0001", status: "sent" })] });
        await page.goto("/en/quotations/builder?new=1");
        // suggestion skips the one in use
        await expect(page.locator('input[name="details.invoiceNumber"]')).toHaveValue("QUO-0002");
        await fillParty(page, "sender", { name: "Sharma Traders" });
        await fillParty(page, "receiver", { name: "Patel Stores" });
        await page.locator('input[name="details.items[0].name"]').fill("Thing");
        await page.locator('input[name="details.items[0].quantity"]').fill("1");
        await page.locator('input[name="details.items[0].unitPrice"]').fill("10");

        await page.locator('input[name="details.invoiceNumber"]').fill("quo-0001"); // differs only in case
        await page.getByTestId("save-quotation").click();
        await expect(page.getByText("Another quotation already uses this number.").first()).toBeVisible();
        await expect(page).toHaveURL(/builder/);
    });

    test("validity presets move the valid-until date", async ({ page }) => {
        await page.goto("/en/quotations/builder?new=1");
        await expect(page.getByTestId("quotation-builder")).toBeVisible();
        const before = await page.getByTestId("q-details").innerText();
        await page.getByTestId("validity-7").click();
        const after = await page.getByTestId("q-details").innerText();
        expect(after).not.toBe(before);
    });

    test("an accepted quotation cannot be edited, even by URL", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "a", number: "QUO-A", status: "accepted" })] });
        await page.goto("/en/quotations/builder?id=a");
        await expect(page.getByTestId("builder-readonly")).toContainText("can no longer be edited");
        await gotoList(page);
        await expect(qrow(page, "QUO-A").getByRole("button", { name: "Edit: QUO-A" })).toHaveCount(0);
    });

    test("an unknown quotation id says so", async ({ page }) => {
        await page.goto("/en/quotations/builder?id=nope");
        await expect(page.getByTestId("builder-missing")).toBeVisible();
    });

    test("products from the catalogue can be added, with live stock", async ({ page }) => {
        await restore(page, { products: [product("w", "Widget")], stockMovements: [opening("w", 6)] });
        await page.goto("/en/quotations/builder?new=1");
        await page.getByTestId("pick-product").first().click();
        await page.getByRole("option", { name: /Widget/ }).click();
        await expect(page.locator('input[name="details.items[0].name"]')).toHaveValue("Widget");
        await expect(page.locator('input[name="details.items[0].unitPrice"]')).toHaveValue("1000");
        await expect(page.getByTestId("stock-hint")).toContainText("6 pcs in stock");
    });
});

/* ============================================================ conversion */

test.describe("conversion to an invoice", () => {
    const seed = {
        clients: [clientRec("Acme Corp", "buyer@acme.test")],
        products: [product("w", "Widget")],
        stockMovements: [opening("w", 10)],
        quotations: [
            rec({
                id: "a",
                number: "QUO-A",
                status: "accepted",
                total: 4720,
                items: [{ name: "Widget", quantity: 4, unitPrice: 1000, total: 4000, hsn: "8471", gstRate: 18, productId: "w", unit: "pcs" }],
            }),
        ],
    };

    const stockOf = async (page: Page) => {
        await page.goto("/en/products");
        return (await page.locator('[data-testid="product-row"]:visible').first().getByTestId("stock-badge").first().innerText()).trim();
    };
    const productCount = async (page: Page) => {
        await page.goto("/en/products");
        await expect(page.getByTestId("product-metrics")).toBeVisible();
        return page.locator('[data-testid="product-row"]:visible').count();
    };
    const clientCount = async (page: Page) => {
        await page.goto("/en/clients");
        await expect(page.getByTestId("client-list")).toBeVisible();
        return page.getByTestId("client-list").locator("li").count();
    };

    test("creates a draft invoice, keeps the reference, and touches no other record", async ({ page }) => {
        await restore(page, seed);
        expect(await stockOf(page)).toBe("10 pcs");
        expect(await productCount(page)).toBe(1);
        expect(await clientCount(page)).toBe(1);

        await gotoList(page);
        await qrow(page, "QUO-A").getByTestId("convert").click();
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toContainText("Convert QUO-A to an invoice?");
        await expect(dialog).toContainText("No customer or product is duplicated");
        await dialog.getByTestId("confirm-convert").click();

        await expect(page.getByText(/Invoice .* created as a draft/).first()).toBeVisible();
        await expect(qrow(page, "QUO-A").getByTestId("invoiced-badge")).toContainText("Invoiced");
        // the convert button is gone, and the quotation is now frozen
        await expect(qrow(page, "QUO-A").getByTestId("convert")).toHaveCount(0);
        await expect(qrow(page, "QUO-A").getByRole("button", { name: "Delete: QUO-A" })).toHaveCount(0);
        await expect(qrow(page, "QUO-A").getByRole("button", { name: "Edit: QUO-A" })).toHaveCount(0);
        await expect(qrow(page, "QUO-A").getByTestId("open-invoice")).toBeVisible();

        // exactly one invoice was made, as a draft, with the same total
        await page.goto("/en/invoices");
        const invoiceRows = page.locator('[data-testid="invoice-row"]:visible');
        await expect(invoiceRows).toHaveCount(1);
        await expect(invoiceRows.first()).toContainText("$4,720.00");
        await expect(invoiceRows.first()).toContainText("Draft");

        // No new customer, no new product; stock is untouched by a draft.
        expect(await clientCount(page)).toBe(1);
        expect(await productCount(page)).toBe(1);
        expect(await stockOf(page)).toBe("10 pcs");
    });

    test("stock moves only when the converted invoice is issued, through the normal flow", async ({ page }) => {
        await restore(page, seed);
        await gotoList(page);
        await qrow(page, "QUO-A").getByTestId("convert").click();
        await page.getByRole("alertdialog").getByTestId("confirm-convert").click();
        await expect(qrow(page, "QUO-A").getByTestId("invoiced-badge")).toBeVisible();

        await page.goto("/en/invoices");
        const row = page.locator('[data-testid="invoice-row"]:visible').first();
        const number = (await row.getByRole("combobox").first().getAttribute("aria-label"))!.replace("Set status ", "");
        await page.getByRole("combobox", { name: `Set status ${number}` }).click();
        await page.getByRole("option", { name: "Sent" }).click();
        await expect(page.getByText("Status updated").first()).toBeVisible();

        await page.goto("/en/products");
        await expect(page.locator('[data-testid="product-row"]:visible').first().getByTestId("stock-badge").first()).toHaveText("6 pcs");
    });

    test("issuing the converted invoice is blocked when stock is short, like any invoice", async ({ page }) => {
        await restore(page, { ...seed, stockMovements: [opening("w", 3)] }); // quotation wants 4
        await gotoList(page);
        await qrow(page, "QUO-A").getByTestId("convert").click();
        await page.getByRole("alertdialog").getByTestId("confirm-convert").click();
        await expect(qrow(page, "QUO-A").getByTestId("invoiced-badge")).toBeVisible();

        await page.goto("/en/invoices");
        const number = (await page.locator('[data-testid="invoice-row"]:visible').first().getByRole("combobox").first().getAttribute("aria-label"))!.replace("Set status ", "");
        await page.getByRole("combobox", { name: `Set status ${number}` }).click();
        await page.getByRole("option", { name: "Sent" }).click();
        await expect(page.getByText("Widget (have 3, need 4)").first()).toBeVisible();
    });

    test("a stale second tab cannot convert it twice", async ({ page, context }) => {
        await restore(page, seed);
        await gotoList(page);

        const other = await context.newPage();
        await gotoList(other);
        await qrow(other, "QUO-A").getByTestId("convert").click();
        await other.getByRole("alertdialog").getByTestId("confirm-convert").click();
        await expect(qrow(other, "QUO-A").getByTestId("invoiced-badge")).toBeVisible();

        // This tab never saw that: it still offers Convert.
        await qrow(page, "QUO-A").getByTestId("convert").click();
        await page.getByRole("alertdialog").getByTestId("confirm-convert").click();
        await expect(page.getByText("This quotation has already been converted to an invoice.").first()).toBeVisible();

        await page.goto("/en/invoices");
        await expect(page.locator('[data-testid="invoice-row"]:visible')).toHaveCount(1);
    });

    test("a quotation that is not accepted cannot be converted", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "s", number: "QUO-S", status: "sent" }), rec({ id: "d", number: "QUO-D", status: "draft" })] });
        await gotoList(page);
        await expect(page.getByTestId("convert")).toHaveCount(0);
    });

    test("duplicating the converted invoice does not count as a second conversion", async ({ page }) => {
        await restore(page, seed);
        await gotoList(page);
        await qrow(page, "QUO-A").getByTestId("convert").click();
        await page.getByRole("alertdialog").getByTestId("confirm-convert").click();
        await expect(qrow(page, "QUO-A").getByTestId("invoiced-badge")).toBeVisible();

        await page.goto("/en/invoices");
        await page.getByRole("button", { name: /Duplicate/ }).first().click();
        await expect(page.locator('[data-testid="invoice-row"]:visible')).toHaveCount(2);

        // The quotation still points at exactly one invoice.
        await gotoList(page);
        await expect(qrow(page, "QUO-A").getByTestId("invoiced-badge")).toBeVisible();
    });

    test("deleting the converted invoice makes the quotation convertible again", async ({ page }) => {
        await restore(page, seed);
        await gotoList(page);
        await qrow(page, "QUO-A").getByTestId("convert").click();
        await page.getByRole("alertdialog").getByTestId("confirm-convert").click();
        await expect(qrow(page, "QUO-A").getByTestId("invoiced-badge")).toBeVisible();

        await page.goto("/en/invoices");
        await page.getByRole("button", { name: /^Delete / }).first().click();
        await page.getByRole("alertdialog").getByRole("button", { name: /Delete/ }).last().click();
        await expect(page.locator('[data-testid="invoice-row"]:visible')).toHaveCount(0);

        await gotoList(page);
        await expect(qrow(page, "QUO-A").getByTestId("convert")).toBeVisible();
    });

    test("the invoice names the quotation it came from", async ({ page, isMobile }) => {
        await restore(page, seed);
        await gotoList(page);
        await qrow(page, "QUO-A").getByTestId("convert").click();
        await page.getByRole("alertdialog").getByTestId("confirm-convert").click();
        await expect(qrow(page, "QUO-A").getByTestId("invoiced-badge")).toBeVisible();
        // Open the invoice in the builder: the reference is part of the live document.
        await qrow(page, "QUO-A").getByTestId("open-invoice").click();
        await expect(page).toHaveURL(/\/en\/?(\?.*)?$/);
        // Below xl the preview lives in a sheet that mounts only when opened.
        if (isMobile) await page.getByRole("button", { name: "Preview" }).first().click();
        await expect(page.getByText("Quotation ref").first()).toBeVisible({ timeout: 15000 });
        await expect(page.getByText("QUO-A").first()).toBeVisible();
    });
});

/* ================================================================== pdf */

test.describe("quotation PDF", () => {
    // Unique per test: the server's PDF cache outlives a test and is shared across projects.
    const body = () => JSON.parse(JSON.stringify(rec({ id: "a", number: `QUO-PDF-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, status: "sent" }).doc));

    test("renders to a real PDF named as a quotation", async ({ request }) => {
        const res = await request.post("/api/invoice/generate?locale=en&kind=quotation", { data: body() });
        expect(res.status(), await res.text().catch(() => "")).toBe(200);
        expect(res.headers()["content-type"]).toBe("application/pdf");
        expect(res.headers()["content-disposition"]).toContain("quotation.pdf");
        const buf = await res.body();
        expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
        expect(buf.length).toBeGreaterThan(5000);
    });

    test("is a different document from the same data rendered as an invoice, and cached separately", async ({ request }) => {
        const doc = body(); // one document, rendered three times
        const q = await request.post("/api/invoice/generate?locale=en&kind=quotation", { data: doc });
        const i = await request.post("/api/invoice/generate?locale=en", { data: doc });
        expect(i.headers()["content-disposition"]).toContain("invoice.pdf");
        // the quotation wording is not served from the invoice's cache entry
        expect(i.headers()["x-pdf-cache"]).toBe("miss");
        expect((await q.body()).equals(await i.body())).toBe(false);
        // and asking for the quotation again is a cache hit
        const again = await request.post("/api/invoice/generate?locale=en&kind=quotation", { data: doc });
        expect(again.headers()["x-pdf-cache"]).toBe("hit");
    });

    test("enforces the same GST rules as an invoice", async ({ request }) => {
        const bad = body();
        bad.sender.gstin = "";
        const res = await request.post("/api/invoice/generate?locale=en&kind=quotation", { data: bad });
        expect(res.status()).toBe(400);
    });

    test("an unknown kind falls back to an invoice rather than failing", async ({ request }) => {
        const res = await request.post("/api/invoice/generate?locale=en&kind=banana", { data: body() });
        expect(res.status()).toBe(200);
        expect(res.headers()["content-disposition"]).toContain("invoice.pdf");
    });

    test("downloads from the list and from the builder", async ({ page }) => {
        await restore(page, { quotations: [rec({ id: "a", number: "QUO-A", status: "sent" })] });
        await gotoList(page);
        const [dl] = await Promise.all([page.waitForEvent("download"), qrow(page, "QUO-A").getByRole("button", { name: "Download PDF: QUO-A" }).click()]);
        expect(dl.suggestedFilename()).toBe("quotation-QUO-A.pdf");

        await qrow(page, "QUO-A").getByRole("button", { name: "Edit: QUO-A" }).click();
        await expect(page.getByTestId("quotation-builder")).toBeVisible();
        const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByTestId("builder-pdf").click()]);
        expect(dl2.suggestedFilename()).toBe("quotation-QUO-A.pdf");
    });

    test("print opens the PDF in a new tab", async ({ page, context }) => {
        await restore(page, { quotations: [rec({ id: "a", number: "QUO-A", status: "sent" })] });
        await gotoList(page);
        const [popup] = await Promise.all([context.waitForEvent("page"), qrow(page, "QUO-A").getByRole("button", { name: "Print: QUO-A" }).click()]);
        expect(popup).toBeTruthy();
        await popup.close();
    });
});

/* ============================================================ customers */

test.describe("customer profile", () => {
    const seed = {
        clients: [clientRec("Acme Corp", "buyer@acme.test"), clientRec("Globex Ltd", "ap@globex.test")],
        quotations: [
            rec({ id: "s2", number: "QUO-S2", status: "sent", validIn: 3 }),
            rec({ id: "a", number: "QUO-A", status: "accepted" }),
            rec({ id: "g", number: "QUO-G", status: "sent", customer: "Globex Ltd", email: "ap@globex.test" }),
        ],
    };

    test("shows that customer's quotations with status and expiry", async ({ page }) => {
        await restore(page, seed);
        await page.goto("/en/clients");
        await page.getByTestId("client-list").getByRole("button", { name: /Acme Corp/ }).click();
        const section = page.getByTestId("client-quotations");
        await expect(section.getByTestId("client-quotation")).toHaveCount(2);
        await expect(section).toContainText("QUO-S2");
        await expect(section).toContainText("QUO-A");
        await expect(section).not.toContainText("QUO-G");
        await expect(section.getByTestId("expiry-note")).toContainText("Expires in 3 day(s)");
    });

    test("a quotation can be started from the profile with the customer filled in", async ({ page }) => {
        await restore(page, seed);
        await page.goto("/en/clients");
        await page.getByTestId("client-list").getByRole("button", { name: /Globex Ltd/ }).click();
        await page.getByTestId("client-new-quotation").click();
        await expect(page).toHaveURL(/builder\?customer=/);
        await expect(page.locator('input[name="receiver.name"]')).toHaveValue("Globex Ltd");
        await expect(page.locator('input[name="receiver.email"]')).toHaveValue("ap@globex.test");
    });

    test("the list can be filtered to one customer", async ({ page }) => {
        await restore(page, seed);
        await page.goto("/en/quotations?customer=ap%40globex.test");
        await expect(qrows(page)).toHaveCount(1);
        await expect(qrow(page, "QUO-G")).toBeVisible();
    });
});

/* ============================================================ dashboard */

test.describe("dashboard", () => {
    test("shows the quotation pipeline from the stored data", async ({ page }) => {
        await restore(page, { quotations: SET });
        await page.goto("/en/dashboard");
        const card = page.getByTestId("dashboard-quotations");
        await expect(card.getByTestId("dq-total")).toHaveText("7");
        await expect(card.getByTestId("dq-pending")).toHaveText("2");
        await expect(card.getByTestId("dq-accepted")).toHaveText("2");
        await expect(card.getByTestId("dq-rejected")).toHaveText("1");
        await expect(card.getByTestId("dq-rate")).toHaveText("33%");
        await expect(card.getByTestId("dq-expiring")).toContainText("1 expiring within 7 days");
    });
});

/* =========================================================== integrity */

test.describe("data integrity", () => {
    test("a product used only on a quotation cannot be deleted", async ({ page }) => {
        await restore(page, {
            products: [product("w", "Widget")],
            stockMovements: [opening("w", 5)],
            quotations: [rec({ id: "d", number: "QUO-D", status: "draft", items: [{ name: "Widget", quantity: 1, unitPrice: 1000, total: 1000, productId: "w", gstRate: 18 }] })],
        });
        await page.goto("/en/products");
        await page.locator('[data-testid="product-row"]:visible').first().getByRole("button", { name: /Delete/ }).click();
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toContainText("used on invoices or quotations");
        await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    });

    test("quotations are part of backups, and restoring twice does not duplicate them", async ({ page }) => {
        await restore(page, { quotations: SET });
        await page.goto("/en/settings");
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).first().click()]);
        const text = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
        const json = JSON.parse(text);
        expect(json.data.quotations).toHaveLength(7);
        expect(json.counts.quotations).toBe(7);

        // Restore the very same file: everything is a duplicate.
        await page.getByTestId("backup-file").setInputFiles({ name: "again.json", mimeType: "application/json", buffer: Buffer.from(text) });
        await page.getByRole("button", { name: "Restore", exact: true }).click();
        await page.keyboard.press("Escape");
        await gotoList(page);
        await expect(qrows(page)).toHaveCount(7);
    });

    test("an imported quotation that is not a valid document is rejected, not stored", async ({ page }) => {
        const broken = rec({ id: "bad", number: "QUO-BAD", status: "sent" });
        (broken.doc.details as Record<string, unknown>).items = [{ name: "", quantity: 1, unitPrice: 5, total: 5 }];
        await page.goto("/en/settings");
        await page.getByTestId("backup-file").setInputFiles({
            name: "bad.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: [], clients: [], senders: [], templates: [], settings: null, products: [], stockMovements: [], quotations: [broken, rec({ id: "ok", number: "QUO-OK", status: "draft" })] } })),
        });
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("1 item(s) in this file are invalid")).toBeVisible();
        await dialog.getByRole("button", { name: "Restore", exact: true }).click();
        await page.keyboard.press("Escape");
        await gotoList(page);
        await expect(qrows(page)).toHaveCount(1);
        await expect(qrow(page, "QUO-OK")).toBeVisible();
    });
});

/* ========================================================== responsive */

test.describe("responsive layouts", () => {
    test.skip(({ isMobile }) => isMobile, "sizes are set explicitly; one project is enough");

    const WIDTHS = [320, 375, 390, 480, 768, 1024, 1366, 1920];

    const overflow = (page: Page) =>
        page.evaluate(() => {
            const w = document.documentElement.clientWidth;
            const bad: string[] = [];
            document.querySelectorAll<HTMLElement>("*").forEach((el) => {
                const s = getComputedStyle(el);
                if (s.overflowX === "auto" || s.overflowX === "scroll" || el.closest("[data-allow-x-overflow]")) return;
                const r = el.getBoundingClientRect();
                if (r.width && r.right > w + 1) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} +${Math.round(r.right - w)}`);
            });
            return { w, scroll: document.documentElement.scrollWidth, bad: bad.slice(0, 4) };
        });

    for (const width of WIDTHS) {
        test(`list and builder fit at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await restore(page, { quotations: SET });

            await gotoList(page);
            await expect(qrows(page)).toHaveCount(7);
            let o = await overflow(page);
            expect(o.scroll, `list overflow at ${width}: ${JSON.stringify(o.bad)}`).toBeLessThanOrEqual(o.w);
            expect(o.bad).toEqual([]);

            // the table on wide screens, cards on phones
            await expect(page.getByTestId(width >= 768 ? "quotation-table" : "quotation-cards")).toBeVisible();

            await page.goto("/en/quotations/builder?new=1");
            await expect(page.getByTestId("quotation-builder")).toBeVisible();
            o = await overflow(page);
            expect(o.scroll, `builder overflow at ${width}: ${JSON.stringify(o.bad)}`).toBeLessThanOrEqual(o.w);
            expect(o.bad).toEqual([]);

            // the live preview is beside the form on wide screens and behind a button otherwise
            if (width >= 1280) await expect(page.getByTestId("quotation-preview")).toBeVisible();
            else await expect(page.getByTestId("open-preview")).toBeVisible();
        });
    }

    test("the view sheet fits a phone", async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 800 });
        await restore(page, { quotations: [rec({ id: "a", number: "QUO-A", status: "accepted" })] });
        await gotoList(page);
        await qrow(page, "QUO-A").locator("button", { hasText: "QUO-A" }).first().click();
        await expect(page.getByTestId("quotation-view")).toBeVisible();
        const o = await overflow(page);
        expect(o.scroll).toBeLessThanOrEqual(o.w);
    });
});
