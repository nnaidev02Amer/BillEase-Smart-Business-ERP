import { test, expect } from "@playwright/test";

import { gstinCheckChar } from "../lib/gst";

/** GST through the real UI and the real PDF endpoint. */

const gstin = (state: string, pan: string) => {
    const first14 = `${state}${pan}1Z`;
    return first14 + gstinCheckChar(first14);
};
const SELLER = gstin("27", "AAPFU0939F"); // Maharashtra

const draft = (place: string) => ({
    sender: {
        name: "Sharma Traders",
        address: "12 MG Road",
        zipCode: "400001",
        city: "Mumbai",
        country: "India",
        email: "sharma@example.com",
        phone: "9876543210",
        gstin: SELLER,
    },
    receiver: {
        name: "Patel Stores",
        address: "4 Park Street",
        zipCode: "380001",
        city: "Ahmedabad",
        country: "India",
        email: "patel@example.com",
        phone: "9123456780",
        gstin: "",
    },
    details: {
        invoiceLogo: "",
        invoiceNumber: "GST-0001",
        invoiceDate: "2026-04-10T00:00:00.000Z",
        dueDate: "2026-05-10T00:00:00.000Z",
        gst: { enabled: true, pricing: "exclusive", placeOfSupply: place },
        items: [
            { name: "Laptop", quantity: 2, unitPrice: 500, total: 1000, hsn: "8471", gstRate: 18 },
            { name: "Cable", quantity: 1, unitPrice: 100, total: 100, hsn: "8544", gstRate: 5 },
        ],
        currency: "INR",
        language: "English",
        taxDetails: { amount: 0, amountType: "amount" },
        discountDetails: { amount: 0, amountType: "amount" },
        shippingDetails: { cost: 0, costType: "amount" },
        paymentInformation: { bankName: "HDFC", accountName: "Sharma Traders", accountNumber: "5020001" },
        paymentTerms: "Net 30",
        subTotal: 1100,
        totalAmount: 1285,
        totalAmountInWords: "",
        pdfTemplate: 1,
        theme: { accentColor: "#4F46E5", fontId: "outfit", density: "comfortable" },
    },
});

const seedDraft = (page: import("@playwright/test").Page, invoice: unknown) =>
    page.addInitScript((inv) => {
        window.localStorage.setItem("invoify:invoiceDraft", JSON.stringify(inv));
    }, invoice);

test.describe("GST in the invoice form", () => {
    test("intra-state: summary shows CGST + SGST, no IGST, and the right total", async ({ page }) => {
        await seedDraft(page, draft("27"));
        await page.goto("/en?step=summary");
        const box = page.getByTestId("gst-breakdown");
        await expect(box).toBeVisible();
        // 1000×18% + 100×5% = 185 → 92.50 + 92.50
        await expect(box).toContainText("Taxable value");
        await expect(box).toContainText("CGST");
        await expect(box).toContainText("SGST");
        await expect(box).not.toContainText("IGST");
        await expect(box).toContainText("185");
        // 1100 + 185
        await expect(page.getByText("1,285").first()).toBeVisible();
    });

    test("inter-state: the same lines produce IGST only", async ({ page }) => {
        await seedDraft(page, draft("29"));
        await page.goto("/en?step=summary");
        const box = page.getByTestId("gst-breakdown");
        await expect(box).toContainText("IGST");
        await expect(box).not.toContainText("CGST");
        await expect(box).not.toContainText("SGST");
    });

    test("with GST on, lines show HSN and rate", async ({ page }) => {
        await seedDraft(page, draft("27"));
        await page.goto("/en?step=items");
        const hsn = page.locator('input[name="details.items[0].hsn"]');
        await expect(hsn).toBeVisible();
        await expect(hsn).toHaveValue("8471");
    });

    test("switching GST off in the form removes HSN and rate and the flat tax option returns", async ({ page }) => {
        await seedDraft(page, draft("27"));
        await page.goto("/en?step=details");
        const toggle = page.getByRole("switch", { name: "Charge GST on this invoice" });
        await expect(toggle).toBeChecked();
        await toggle.click();
        await expect(toggle).not.toBeChecked();

        // Move on within the app (no reload) so this exercises live state.
        await page.getByRole("button", { name: /Line Items/ }).first().click();
        await expect(page.locator('input[name="details.items[0].name"]')).toBeVisible();
        await expect(page.locator('input[name="details.items[0].hsn"]')).toHaveCount(0);

        await page.getByRole("button", { name: /Step 5:/ }).first().click();
        await expect(page.getByTestId("gst-breakdown")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Tax", exact: true })).toBeVisible();
    });

    test("the GSTIN field says whether the number is well-formed", async ({ page }) => {
        await seedDraft(page, draft("27"));
        await page.goto("/en?step=from-and-to");
        await expect(page.getByText("Valid format · Maharashtra")).toBeVisible();
        const field = page.locator('input[name="sender.gstin"]');
        await field.fill("27AAPFU0939F1ZA");
        await expect(page.getByText("Not a valid GSTIN")).toBeVisible();
    });

    test("the live preview is labelled a Tax Invoice with the tax summary", async ({ page, isMobile }) => {
        await seedDraft(page, draft("27"));
        await page.goto("/en");
        // Below xl the preview lives in a sheet that mounts only when opened.
        if (isMobile) await page.getByRole("button", { name: "Preview" }).first().click();
        await expect(page.getByText("Tax Invoice").first()).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("tax-summary").first()).toContainText("8471");
    });
});

test.describe("GST PDF", () => {
    test("a GST invoice renders to a real PDF", async ({ request }) => {
        const res = await request.post("/api/invoice/generate?locale=en", { data: draft("27") });
        expect(res.status(), await res.text().catch(() => "")).toBe(200);
        const body = await res.body();
        expect(body.subarray(0, 5).toString()).toBe("%PDF-");
        expect(body.length).toBeGreaterThan(5000);
    });

    test("the server rejects GST without the seller GSTIN", async ({ request }) => {
        const bad = draft("27");
        bad.sender.gstin = "";
        const res = await request.post("/api/invoice/generate?locale=en", { data: bad });
        expect(res.status()).toBe(400);
    });

    test("the server rejects a malformed GSTIN", async ({ request }) => {
        const bad = draft("27");
        bad.receiver.gstin = "NOTAGSTIN";
        const res = await request.post("/api/invoice/generate?locale=en", { data: bad });
        expect(res.status()).toBe(400);
    });
});
