import { test, expect, type Page } from "@playwright/test";

import { gstinCheckChar } from "../lib/gst";
import { isoDay } from "./fixtures";

/** Purchase bills, supplier payments, payables and profit and loss, through the real UI and stores. */

const gstin = (state: string, pan: string) => {
    const first14 = `${state}${pan}1Z`;
    return `${first14}${gstinCheckChar(first14)}`;
};
const MH = gstin("27", "AAPFU0939F");
const NOW = "2026-01-01T00:00:00.000Z";

const supplier = (over: Record<string, unknown> = {}) => ({
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
    gstin: MH,
    pan: "",
    paymentTermsDays: 30,
    currency: "INR",
    openingBalance: 0,
    notes: "",
    inactive: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
});

const product = (id: string, name: string) => ({
    id, name, sku: id.toUpperCase(), category: "", description: "", type: "product", unit: "pcs", sellingPrice: 150, purchasePrice: 60, taxRate: 18, hsn: "8471", trackStock: true, minStock: 0, archived: false, createdAt: NOW, updatedAt: NOW,
});

const SNAP = { name: "Acme Traders", gstin: MH, state: "27", address: "5 Industrial Area", city: "Pune", zipCode: "411001", country: "India", email: "a@b.test", phone: "1" };

/** 10 × 100 at 18% = 1,180 (tax 180) unless overridden. */
const bill = (over: Record<string, unknown> = {}) => ({
    id: "bill-1",
    number: "PB-0001",
    supplierBillNo: "INV/77",
    supplierId: "sup-1",
    supplier: SNAP,
    grnIds: [],
    billDate: "2026-01-10",
    dueDate: "2026-02-09",
    currency: "INR",
    lines: [{ id: "bl1", name: "Widget", description: "", hsn: "8471", unit: "pcs", quantity: 10, unitPrice: 100, taxRate: 18 }],
    discount: { type: "amount", value: 0 },
    freight: 0,
    gstEnabled: true,
    itcEligible: true,
    notes: "",
    status: "posted",
    log: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
});

const payment = (over: Record<string, unknown> = {}) => ({
    id: "pay-1",
    number: "PAY-0001",
    supplierId: "sup-1",
    supplierName: "Acme Traders",
    date: "2026-01-20",
    currency: "INR",
    amount: 500,
    method: "bank",
    reference: "",
    note: "",
    allocations: [{ billId: "bill-1", amount: 500 }],
    status: "posted",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
});

const order = (over: Record<string, unknown> = {}) => ({
    id: "po-1",
    number: "PO-0001",
    supplierId: "sup-1",
    supplier: SNAP,
    date: "2026-03-01",
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

const receipt = (accepted: number, over: Record<string, unknown> = {}) => ({
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
    lines: [{ id: "gl1", poLineId: "l1", productId: "widget", name: "Widget", unit: "pcs", received: accepted, rejected: 0, unitPrice: 60 }],
    status: "posted",
    priceUpdates: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
});

const expense = (over: Record<string, unknown> = {}) => ({
    id: "exp-1", title: "Widgets for stock", category: "supplies", amount: 1180, currency: "INR", date: "2026-01-12", method: "bank", vendor: "Acme Traders", reference: "", notes: "", createdAt: NOW, updatedAt: NOW, ...over,
});

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

async function setBusiness(page: Page) {
    await page.goto("/en/settings");
    const form = page.getByTestId("business-form");
    await expect(form).toBeVisible();
    for (const [sel, v] of [["#b-name", "My Shop"], ["#b-gstin", MH], ["#b-address", "12 Market Road"], ["#b-city", "Mumbai"], ["#b-zip", "400001"], ["#b-country", "India"], ["#b-email", "me@shop.test"], ["#b-phone", "9999999999"]] as const) await form.locator(sel).fill(v);
    await page.getByTestId("business-save").click();
    await expect(page.getByTestId("business-save")).toBeDisabled();
}

const billCards = (page: Page) => page.getByTestId("bill-card");
const billCard = (page: Page, number = "PB-0001") => page.locator(`[data-testid="bill-card"][data-number="${number}"]`);
const payCards = (page: Page) => page.getByTestId("pay-card");
const money = (s: string) => new RegExp(s.replace(/[.,]/g, (c) => `\\${c}`));

const addDays = (day: string, n: number) => {
    const [y, m, d] = day.split("-").map(Number);
    const dt = new Date(y, m - 1, d + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};
const today = () => isoDay(0);

async function fillDirectBill(page: Page, { no = "INV/1", name = "Gadget", qty = "10", price = "100" } = {}) {
    await page.getByTestId("bill-supplier").selectOption({ label: "Acme Traders" });
    await page.getByTestId("bill-supplier-no").fill(no);
    await page.getByTestId("bill-line-name").first().fill(name);
    await page.getByTestId("bill-line-qty").first().fill(qty);
    await page.getByTestId("bill-line-price").first().fill(price);
}

const gotoBills = async (page: Page) => {
    await page.goto("/en/purchase-bills");
    await expect(page.getByTestId("purchase-bills-page")).toBeVisible();
};
const gotoPayables = async (page: Page) => {
    await page.goto("/en/payables");
    await expect(page.getByTestId("payables-page")).toBeVisible();
};

test.describe("entering a bill", () => {
    test("a direct bill posts, gets its due date from the supplier's terms, and shows the claimable tax", async ({ page }) => {
        await restore(page, { suppliers: [supplier()] });
        await setBusiness(page);
        await gotoBills(page);
        await expect(page.getByTestId("bill-empty")).toBeVisible();
        await page.getByTestId("bill-new").first().click();
        await expect(page.getByTestId("bill-mode-direct")).toBeChecked();
        await fillDirectBill(page);
        await expect(page.getByTestId("bill-due")).toHaveValue(addDays(today(), 30));
        await expect(page.getByTestId("bill-cgst")).toContainText("90.00");
        await expect(page.getByTestId("bill-sgst")).toContainText("90.00");
        await expect(page.getByTestId("bill-total")).toContainText("1,180.00");
        await expect(page.getByTestId("bill-match")).toContainText("A direct bill has no order to check against");
        await page.getByTestId("bill-save-post").click();

        const card = billCard(page);
        await expect(card).toHaveAttribute("data-status", "unpaid");
        await expect(card.getByTestId("bill-card-total")).toContainText("1,180.00");
        await expect(card.getByTestId("bill-card-owed")).toContainText("1,180.00 owed");
        await expect(card).toContainText("180.00 tax claimable");
    });

    test("the supplier's invoice number is required and the same one cannot be entered twice", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()] });
        await gotoBills(page);
        await page.getByTestId("bill-new").click();
        await page.getByTestId("bill-supplier").selectOption({ label: "Acme Traders" });
        await page.getByTestId("bill-line-name").first().fill("Gadget");
        await page.getByTestId("bill-line-price").first().fill("10");
        await page.getByTestId("bill-save").click();
        await expect(page.getByText("Enter the number on the supplier's invoice")).toBeVisible();
        await page.getByTestId("bill-supplier-no").fill("inv/77");
        await page.getByTestId("bill-save").click();
        await expect(page.getByText("This supplier invoice has already been entered")).toBeVisible();
        await expect(billCards(page)).toHaveCount(1);
        await page.getByTestId("bill-supplier-no").fill("INV/78");
        await page.getByTestId("bill-save").click();
        await expect(billCards(page)).toHaveCount(2);
    });

    test("a draft can be saved, edited, posted, sent back to draft, cancelled, restored and deleted", async ({ page }) => {
        await restore(page, { suppliers: [supplier()] });
        await setBusiness(page);
        await gotoBills(page);
        await page.getByTestId("bill-new").first().click();
        await fillDirectBill(page);
        await page.getByTestId("bill-save").click();
        const card = billCard(page);
        await expect(card).toHaveAttribute("data-status", "draft");

        await card.getByTestId("bill-edit").click();
        await page.getByTestId("bill-line-qty").first().fill("20");
        await expect(page.getByTestId("bill-total")).toContainText("2,360.00");
        await page.getByTestId("bill-save").click();
        await expect(card.getByTestId("bill-card-total")).toContainText("2,360.00");

        await card.getByTestId("bill-post").click();
        await expect(card).toHaveAttribute("data-status", "unpaid");
        // A posted bill is not editable; it goes back to draft first.
        await expect(card.getByTestId("bill-edit")).toHaveCount(0);
        await card.getByTestId("bill-to-draft").click();
        await expect(card).toHaveAttribute("data-status", "draft");

        await card.getByTestId("bill-cancel").click();
        await page.getByTestId("bill-confirm-action").click();
        await expect(card).toHaveAttribute("data-status", "cancelled");
        await card.getByTestId("bill-restore").click();
        await expect(card).toHaveAttribute("data-status", "draft");
        await card.getByTestId("bill-delete").click();
        await page.getByTestId("bill-confirm-action").click();
        await expect(billCards(page)).toHaveCount(0);
    });

    test("a cancelled bill frees its supplier invoice number", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill({ status: "cancelled" })] });
        await gotoBills(page);
        await page.getByTestId("bill-new").click();
        await fillDirectBill(page, { no: "INV/77" });
        await page.getByTestId("bill-save").click();
        await expect(billCards(page)).toHaveCount(2);
    });
});

test.describe("bills from orders and receipts", () => {
    const seed = (page: Page, accepted = 10, extra: Record<string, unknown> = {}) => restore(page, { suppliers: [supplier()], products: [product("widget", "Widget")], purchaseOrders: [order()], goodsReceipts: [receipt(accepted)], ...extra });

    test("'Bill this order' starts from what was received, at the order's price, and matches cleanly", async ({ page }) => {
        await seed(page);
        await setBusiness(page);
        await page.goto("/en/purchase-orders");
        await page.getByTestId("po-bill").click();
        await expect(page.getByTestId("bill-dialog")).toBeVisible();
        await expect(page.getByTestId("bill-order")).not.toHaveValue("");
        await expect(page.getByTestId("bill-line-qty")).toHaveValue("10");
        await expect(page.getByTestId("bill-line-price")).toHaveValue("60");
        await expect(page.getByTestId("bill-total")).toContainText("708.00");
        await expect(page.getByTestId("bill-match-ok")).toBeVisible();
        await page.getByTestId("bill-supplier-no").fill("INV/9");
        await page.getByTestId("bill-save-post").click();

        await expect(page.getByTestId("bill-dialog")).toHaveCount(0);
        const card = billCard(page);
        await expect(card).toHaveAttribute("data-status", "unpaid");
        await expect(card).toContainText("Order PO-0001");
        // Everything received has now been billed: the order stops offering to be billed, and a new bill has no order to start from.
        await page.goto("/en/purchase-orders");
        await expect(page.locator('[data-testid="po-card"][data-number="PO-0001"]')).toBeVisible();
        await expect(page.getByTestId("po-bill")).toHaveCount(0);
        await gotoBills(page);
        await page.getByTestId("bill-new").first().click();
        await expect(page.getByTestId("bill-mode-direct")).toBeChecked();
        await page.getByTestId("bill-mode-order").check();
        await expect(page.getByTestId("bill-no-orders")).toBeVisible();
    });

    test("billing more than was received, or at another price, is flagged and needs confirming", async ({ page }) => {
        await seed(page, 6);
        await setBusiness(page);
        await gotoBills(page);
        await page.getByTestId("bill-new").first().click();
        await page.getByTestId("bill-order").selectOption({ index: 1 });
        // Pre-filled with what was received, not what was ordered.
        await expect(page.getByTestId("bill-line-qty")).toHaveValue("6");
        await expect(page.getByTestId("bill-match-ok")).toBeVisible();

        await page.getByTestId("bill-line-qty").fill("10");
        await page.getByTestId("bill-line-price").fill("70");
        const issues = page.getByTestId("bill-match-issues");
        await expect(issues.locator('[data-kind="qtyOverReceived"]')).toContainText("billing 10, but only 6 received");
        await expect(issues.locator('[data-kind="priceDiffersFromOrder"]')).toContainText("70.00 on the bill");
        await page.getByTestId("bill-supplier-no").fill("INV/10");
        await page.getByTestId("bill-save-post").click();

        const confirm = page.getByTestId("bill-confirm");
        await expect(confirm).toContainText("Post despite differences?");
        await expect(confirm).toContainText("billing 10, but only 6 received");
        await confirm.getByRole("button", { name: "Go back" }).click();
        // Nothing was saved by going back.
        await expect(billCards(page)).toHaveCount(0);

        await page.getByTestId("bill-save-post").click();
        await page.getByTestId("bill-confirm-yes").click();
        await expect(billCard(page)).toHaveAttribute("data-status", "unpaid");
    });

    test("posting a saved draft that differs from its order asks first", async ({ page }) => {
        await seed(page, 6);
        await setBusiness(page);
        await gotoBills(page);
        await page.getByTestId("bill-new").first().click();
        await page.getByTestId("bill-order").selectOption({ index: 1 });
        await page.getByTestId("bill-line-qty").fill("10");
        await page.getByTestId("bill-supplier-no").fill("INV/11");
        await page.getByTestId("bill-save").click();
        const card = billCard(page);
        await expect(card).toHaveAttribute("data-status", "draft");
        await card.getByTestId("bill-post").click();
        await expect(page.getByTestId("bill-post-confirm")).toContainText("billing 10, but only 6 received");
        await page.getByTestId("bill-post-confirm").getByRole("button", { name: "Go back" }).click();
        await expect(card).toHaveAttribute("data-status", "draft");
        await card.getByTestId("bill-post").click();
        await page.getByTestId("bill-post-confirm-yes").click();
        await expect(card).toHaveAttribute("data-status", "unpaid");
    });

    test("a bill can be started from a goods receipt: accepted quantity at the receipt's price", async ({ page }) => {
        await seed(page, 8);
        await setBusiness(page);
        await gotoBills(page);
        await page.getByTestId("bill-new").first().click();
        await page.getByTestId("bill-mode-receipt").check();
        await page.getByTestId("bill-receipt").selectOption({ index: 1 });
        await expect(page.getByTestId("bill-line-name")).toHaveValue("Widget");
        await expect(page.getByTestId("bill-line-qty")).toHaveValue("8");
        await expect(page.getByTestId("bill-line-price")).toHaveValue("60");
        await expect(page.getByTestId("bill-supplier")).toHaveValue("sup-1");
        await page.getByTestId("bill-supplier-no").fill("INV/12");
        await page.getByTestId("bill-save-post").click();
        await expect(billCard(page)).toContainText("Order PO-0001");
    });

    test("an order with a posted bill can no longer be cancelled or deleted", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseOrders: [order()], purchaseBills: [bill({ poId: "po-1", poNumber: "PO-0001" })] });
        await page.goto("/en/purchase-orders");
        const card = page.locator('[data-testid="po-card"][data-number="PO-0001"]');
        await expect(card).toBeVisible();
        await expect(card.getByTestId("po-cancel")).toHaveCount(0);
        await expect(card.getByTestId("po-delete")).toHaveCount(0);
        await expect(card.getByRole("button", { name: "Back to draft" })).toHaveCount(0);
    });
});

test.describe("paying suppliers", () => {
    test("paying a bill in full from the bill settles it", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()] });
        await gotoBills(page);
        const card = billCard(page);
        await expect(card).toHaveAttribute("data-status", "overdue");
        await card.getByTestId("bill-pay").click();
        // Pre-filled with what is owed, and allocated to this bill.
        await expect(page.getByTestId("pay-amount")).toHaveValue("1180");
        await expect(page.getByTestId("pay-alloc")).toHaveValue("1180");
        await page.getByTestId("pay-reference").fill("UTR12345");
        await page.getByTestId("pay-save").click();
        await expect(page.getByTestId("pay-dialog")).toHaveCount(0);
        await expect(card).toHaveAttribute("data-status", "paid");
        await expect(card.getByTestId("bill-card-owed")).toContainText("0.00 owed");
        await expect(card.getByTestId("bill-pay")).toHaveCount(0);

        await gotoPayables(page);
        await expect(payCards(page).first()).toHaveAttribute("data-number", "PAY-0001");
        await expect(payCards(page).first()).toContainText("UTR12345");
        await expect(page.getByTestId("m-owed")).toContainText("0.00");
    });

    test("a part payment leaves the rest owed", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()] });
        await gotoBills(page);
        await billCard(page).getByTestId("bill-pay").click();
        await page.getByTestId("pay-amount").fill("500");
        await page.getByTestId("pay-alloc").fill("500");
        await page.getByTestId("pay-save").click();
        const card = billCard(page);
        await expect(card.getByTestId("bill-card-owed")).toContainText("500.00 paid");
        await expect(card.getByTestId("bill-card-owed")).toContainText("680.00 owed");
        await expect(card.getByTestId("bill-pay")).toBeVisible();
    });

    test("a bill cannot be allocated more than it owes, nor a payment more than it is", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()] });
        await gotoBills(page);
        await billCard(page).getByTestId("bill-pay").click();
        await page.getByTestId("pay-amount").fill("2000");
        await page.getByTestId("pay-alloc").fill("1500");
        await page.getByTestId("pay-save").click();
        await expect(page.getByText("More than this bill still owes")).toBeVisible();
        await page.getByTestId("pay-amount").fill("1000");
        await page.getByTestId("pay-alloc").fill("1180");
        await page.getByTestId("pay-save").click();
        await expect(page.getByText("The allocations add up to more than the payment")).toBeVisible();
        await expect(page.getByTestId("pay-dialog")).toBeVisible();
    });

    test("paying more than is owed keeps the rest as an advance, which can be put against a bill later", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()] });
        await gotoPayables(page);
        await page.getByTestId("pay-new").click();
        await page.getByTestId("pay-supplier").selectOption({ label: "Acme Traders" });
        await page.getByTestId("pay-amount").fill("2000");
        // Nothing allocated: the whole payment is an advance.
        await expect(page.getByTestId("pay-summary")).toContainText("2,000.00 will be kept as an advance");
        await page.getByTestId("pay-save").click();

        await expect(payCards(page).first().getByTestId("pay-advance")).toContainText("2,000.00 advance");
        await expect(page.getByTestId("m-advances")).toContainText("2,000.00");
        // Owed 1,180, advance 2,000: the supplier is ahead by 820.
        await expect(page.getByTestId("supplier-net")).toContainText("820.00");
        await expect(page.getByTestId("m-net")).toContainText("820.00");

        await payCards(page).first().getByTestId("pay-allocate").click();
        await page.getByTestId("pay-auto").click();
        await expect(page.getByTestId("pay-alloc")).toHaveValue("1180");
        await page.getByTestId("pay-save").click();
        await expect(payCards(page).first().getByTestId("pay-advance")).toContainText("820.00 advance");
        await expect(page.getByTestId("m-owed")).toContainText("0.00");
        await expect(page.getByTestId("m-advances")).toContainText("820.00");
    });

    test("voiding a payment makes the bill owed again and keeps the record", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()], supplierPayments: [payment({ amount: 1180, allocations: [{ billId: "bill-1", amount: 1180 }] })] });
        await gotoBills(page);
        await expect(billCard(page)).toHaveAttribute("data-status", "paid");
        await gotoPayables(page);
        await payCards(page).first().getByTestId("pay-void").click();
        await page.getByTestId("pay-void-reason").fill("Bounced");
        await page.getByTestId("pay-void-confirm").click();
        await expect(payCards(page).first()).toHaveAttribute("data-status", "void");
        await expect(payCards(page).first()).toContainText("Reason: Bounced");
        await expect(page.getByTestId("m-owed")).toContainText("1,180.00");
        await gotoBills(page);
        await expect(billCard(page)).toHaveAttribute("data-status", "overdue");
    });

    test("a bill that has been paid against can be neither reopened, cancelled nor deleted", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()], supplierPayments: [payment()] });
        await gotoBills(page);
        const card = billCard(page);
        await expect(card).toHaveAttribute("data-status", "overdue");
        await expect(card.getByTestId("bill-to-draft")).toHaveCount(0);
        await expect(card.getByTestId("bill-cancel")).toHaveCount(0);
        await expect(card.getByTestId("bill-delete")).toHaveCount(0);
    });

    test("a supplier with bills or payments cannot be deleted", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()] });
        await page.goto("/en/suppliers");
        await page.getByRole("button", { name: "Delete: Acme Traders" }).click();
        await page.getByTestId("supplier-delete-confirm").click();
        await expect(page.getByText("has purchase orders, so it cannot be deleted").first()).toBeVisible();
        await expect(page.getByTestId("supplier-card")).toHaveCount(1);
    });
});

test.describe("payables dashboard", () => {
    const due = (offset: number) => isoDay(offset);
    const aged = [
        bill({ id: "b-cur", number: "PB-0001", supplierBillNo: "A", billDate: due(-20), dueDate: due(10) }),
        bill({ id: "b-soon", number: "PB-0002", supplierBillNo: "B", billDate: due(-27), dueDate: due(3) }),
        bill({ id: "b-30", number: "PB-0003", supplierBillNo: "C", billDate: due(-35), dueDate: due(-5) }),
        bill({ id: "b-60", number: "PB-0004", supplierBillNo: "D", billDate: due(-75), dueDate: due(-45) }),
        bill({ id: "b-90", number: "PB-0005", supplierBillNo: "E", billDate: due(-105), dueDate: due(-75) }),
        bill({ id: "b-over", number: "PB-0006", supplierBillNo: "F", billDate: due(-150), dueDate: due(-120) }),
    ];

    test("groups what is owed by how late it is, and totals overdue and due-soon", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: aged });
        await gotoPayables(page);
        const bucket = (k: string) => page.getByTestId(`ageing-${k}`);
        await expect(bucket("current")).toHaveAttribute("data-count", "2");
        for (const k of ["d1_30", "d31_60", "d61_90", "d90plus"]) await expect(bucket(k)).toHaveAttribute("data-count", "1");
        await expect(bucket("current")).toHaveAttribute("data-amount", "2360");
        await expect(page.getByTestId("m-owed")).toContainText("7,080.00");
        await expect(page.getByTestId("m-overdue")).toContainText("4,720.00");
        await expect(page.getByTestId("m-soon")).toContainText("1,180.00");
        await expect(page.getByTestId("m-overdue")).toHaveClass(/text-destructive/);
        // Oldest due first in the "to pay" list.
        const order = await page.getByTestId("topay-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-number")));
        expect(order).toEqual(["PB-0006", "PB-0005", "PB-0004", "PB-0003", "PB-0002", "PB-0001"]);
    });

    test("a part payment moves only what is still owed", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: aged, supplierPayments: [payment({ allocations: [{ billId: "b-over", amount: 500 }], amount: 500 })] });
        await gotoPayables(page);
        await expect(page.getByTestId("ageing-d90plus")).toHaveAttribute("data-amount", "680");
        await expect(page.getByTestId("m-owed")).toContainText("6,580.00");
    });

    test("the dashboard says how many supplier bills are overdue or due soon", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: aged });
        await page.goto("/en/dashboard");
        const alert = page.getByTestId("payables-alert");
        await expect(alert).toBeVisible();
        await expect(alert).toHaveAttribute("data-urgent", "true");
        await expect(alert.getByTestId("payables-alert-overdue")).toContainText("4 bills are overdue");
        await expect(alert.getByTestId("payables-alert-overdue")).toContainText("4,720.00");
        await expect(alert.getByTestId("payables-alert-soon")).toContainText("1 bill falls due within 7 days");
        await alert.getByTestId("payables-alert-link").click();
        await expect(page.getByTestId("payables-page")).toBeVisible();
    });

    test("no alert for someone who has no supplier bills, and a calm one when nothing is late", async ({ page }) => {
        await page.goto("/en/dashboard");
        await expect(page.getByTestId("payables-alert")).toHaveCount(0);
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill({ billDate: due(-5), dueDate: due(40) })] });
        await page.goto("/en/dashboard");
        await expect(page.getByTestId("payables-alert")).toHaveAttribute("data-urgent", "false");
        await expect(page.getByTestId("payables-alert")).toContainText("No supplier bill is overdue or due in the next 7 days");
    });

    test("a supplier's statement runs from the opening balance to what they are owed", async ({ page }) => {
        await restore(page, { suppliers: [supplier({ openingBalance: 1000 })], purchaseBills: [bill()], supplierPayments: [payment()] });
        await gotoPayables(page);
        // 1,000 opening + 1,180 bill − 500 paid
        await expect(page.getByTestId("supplier-net")).toContainText("1,680.00");
        await page.getByTestId("supplier-ledger").click();
        const kinds = await page.getByTestId("ledger-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
        expect(kinds).toEqual(["opening", "bill", "payment"]);
        await expect(page.getByTestId("ledger-closing")).toContainText("1,680.00");
        await expect(page.getByTestId("ledger-balance").first()).toContainText("1,000.00");
    });

    test("different currencies are never added together", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill(), bill({ id: "b-usd", number: "PB-0002", supplierBillNo: "U1", currency: "USD" })] });
        await gotoPayables(page);
        await expect(page.getByTestId("m-owed")).toContainText("1,180.00");
        await page.getByTestId("payables-currency").selectOption("USD");
        await expect(page.getByTestId("m-owed")).toContainText("1,180.00");
        await expect(page.getByTestId("m-owed")).toContainText("$");
    });
});

test.describe("profit and loss", () => {
    const gotoReport = async (page: Page, from: string, to: string) => {
        await page.goto("/en/profit-loss");
        await expect(page.getByRole("heading", { name: "Profit & loss", level: 1 })).toBeVisible();
        await page.getByRole("combobox", { name: "Period" }).click();
        await page.getByRole("option", { name: "Custom range" }).click();
        await page.getByTestId("period-from").fill(from);
        await page.getByTestId("period-to").fill(to);
    };
    const value = (page: Page, id: string) => page.getByTestId(`pl-${id}-value`);

    test("invoice basis counts a bill on its bill date, cash basis counts the payment on its payment date", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()], supplierPayments: [payment({ date: "2026-02-15", amount: 1180, allocations: [{ billId: "bill-1", amount: 1180 }] })] });

        // January: the bill is a cost (less the 180 of claimable tax) and no money has left yet.
        await gotoReport(page, "2026-01-01", "2026-01-31");
        await expect(value(page, "purchases")).toContainText("1,180.00");
        await expect(value(page, "purchases-claimable")).toContainText("180.00");
        await expect(value(page, "purchase-cost")).toContainText("1,000.00");
        await expect(page.getByTestId("k-profit")).toContainText("1,000.00");
        await expect(page.getByTestId("k-profit")).toHaveClass(/text-destructive/);
        await expect(page.getByTestId("pl-paid-suppliers")).toHaveCount(0);
        await expect(page.getByTestId("k-netcash")).toContainText("0.00");

        // February: the bill is not a cost again, but the cash goes out.
        await gotoReport(page, "2026-02-01", "2026-02-28");
        await expect(page.getByTestId("pl-purchases")).toHaveCount(0);
        await expect(value(page, "paid-suppliers")).toContainText("1,180.00");
        await expect(page.getByTestId("k-netcash")).toContainText("1,180.00");
        await expect(page.getByTestId("k-netcash")).toHaveClass(/text-destructive/);
        await expect(page.getByTestId("k-profit")).not.toHaveClass(/text-destructive/);
    });

    test("tax that cannot be claimed is a real cost", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill({ itcEligible: false })] });
        await gotoReport(page, "2026-01-01", "2026-01-31");
        await expect(value(page, "purchases-claimable")).toContainText("0.00");
        await expect(value(page, "purchase-cost")).toContainText("1,180.00");
    });

    test("what is still owed to suppliers at the end date is shown, with how much is overdue", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()] });
        await gotoReport(page, "2026-01-01", "2026-03-31");
        await expect(value(page, "payables")).toContainText("1,180.00");
        await expect(value(page, "payables-overdue")).toContainText("1,180.00");
    });

    test("draft, cancelled bills and void payments change nothing", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill({ id: "d", number: "PB-0002", supplierBillNo: "d", status: "draft" }), bill({ id: "c", number: "PB-0003", supplierBillNo: "c", status: "cancelled" })], supplierPayments: [payment({ status: "void", allocations: [] })] });
        await gotoReport(page, "2026-01-01", "2026-03-31");
        await expect(page.getByTestId("pl-purchases")).toHaveCount(0);
        await expect(page.getByTestId("pl-paid-suppliers")).toHaveCount(0);
    });

    test("a manual expense and a bill for the same purchase are counted once, once the user links them", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()], expenses: [expense()] });

        // Not linked: both count, because only the user knows they are the same purchase.
        await gotoReport(page, "2026-01-01", "2026-01-31");
        await expect(value(page, "cost")).toContainText("1,180.00");
        await expect(value(page, "purchase-cost")).toContainText("1,000.00");
        await expect(page.getByTestId("k-profit")).toContainText("2,180.00");

        // The bill offers the likely duplicate; linking it is the user's call.
        await gotoBills(page);
        await billCard(page).getByTestId("bill-link-expense").click();
        const candidate = page.getByTestId("expense-candidate");
        await expect(candidate).toHaveCount(1);
        await expect(candidate).toContainText("Widgets for stock");
        await page.getByTestId("expense-link-toggle").click();
        await expect(candidate).toHaveAttribute("data-linked", "true");
        await page.keyboard.press("Escape");

        await gotoReport(page, "2026-01-01", "2026-01-31");
        await expect(value(page, "cost")).toContainText("0.00");
        await expect(value(page, "purchase-cost")).toContainText("1,000.00");
        await expect(page.getByTestId("k-profit")).toContainText("1,000.00");
        await expect(page.getByTestId("linked-note")).toContainText("1 expense is linked to a supplier bill");

        // The Expenses page says why it no longer counts there.
        await page.goto("/en/expenses");
        await expect(page.getByTestId("expense-linked").first()).toContainText("Counted through bill PB-0001");

        // Unlinking puts it back.
        await gotoBills(page);
        await billCard(page).getByTestId("bill-link-expense").click();
        await page.getByTestId("expense-link-toggle").click();
        await expect(page.getByTestId("expense-candidate")).toHaveAttribute("data-linked", "false");
        await page.keyboard.press("Escape");
        await gotoReport(page, "2026-01-01", "2026-01-31");
        await expect(value(page, "cost")).toContainText("1,180.00");
    });

    test("a link only protects while the bill is posted", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill({ status: "draft" })], expenses: [expense({ billId: "bill-1" })] });
        await gotoReport(page, "2026-01-01", "2026-01-31");
        await expect(value(page, "cost")).toContainText("1,180.00");
        await expect(page.getByTestId("linked-note")).toHaveCount(0);
    });

    test("editing a linked expense keeps its link", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()], expenses: [expense({ billId: "bill-1" })] });
        await page.goto("/en/expenses");
        await page.getByRole("button", { name: "Edit: Widgets for stock" }).first().click();
        await page.locator("#ex-notes").fill("edited");
        await page.getByTestId("save-expense").click();
        await expect(page.getByTestId("expense-linked").first()).toContainText("Counted through bill PB-0001");
    });
});

test.describe("backup and restore", () => {
    test("an exported backup carries bills and payments", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()], supplierPayments: [payment()] });
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).click()]);
        const file = JSON.parse((await (await download.createReadStream()).toArray()).map((c) => c.toString()).join(""));
        expect(file.counts).toMatchObject({ purchaseBills: 1, supplierPayments: 1 });
        expect(file.data.purchaseBills[0].number).toBe("PB-0001");
        expect(file.data.supplierPayments[0].allocations).toEqual([{ billId: "bill-1", amount: 500 }]);
        expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    test("restoring twice never duplicates, and what is owed stays right", async ({ page }) => {
        const data = { suppliers: [supplier()], purchaseBills: [bill()], supplierPayments: [payment()] };
        await restore(page, data);
        await restore(page, data);
        await restore(page, { purchaseBills: [bill()], supplierPayments: [payment()] });
        await gotoBills(page);
        await expect(billCards(page)).toHaveCount(1);
        await expect(billCard(page).getByTestId("bill-card-owed")).toContainText("680.00 owed");
        await gotoPayables(page);
        await expect(payCards(page)).toHaveCount(1);
    });

    test("a backup holding only bills, or only payments, can be restored", async ({ page }) => {
        const upload = async (d: Record<string, unknown>) => {
            await page.goto("/en/settings");
            await page.getByTestId("backup-file").setInputFiles({ name: "b.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: [], ...d } })) });
            return page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true });
        };
        await expect(await upload({ purchaseBills: [bill()] })).toBeEnabled();
        await expect(await upload({ supplierPayments: [payment()] })).toBeEnabled();
    });

    test("a payment that allocates more than it paid is reported and left out, never repaired", async ({ page }) => {
        await page.goto("/en/settings");
        await page.getByTestId("backup-file").setInputFiles({ name: "b.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 2, data: { invoices: [], supplierPayments: [payment(), payment({ id: "bad", number: "PAY-0009", amount: 100, allocations: [{ billId: "bill-1", amount: 101 }] })] } })) });
        await expect(page.getByRole("dialog").getByText("1 item(s) in this file are invalid")).toBeVisible();
    });

    test("a clashing bill number is renumbered, not dropped, and the supplier invoice is kept", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()] });
        await restore(page, { purchaseBills: [bill({ id: "bill-2", supplierBillNo: "INV/99" })] });
        await gotoBills(page);
        await expect(billCards(page)).toHaveCount(2);
        const numbers = await billCards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-number")));
        expect(new Set(numbers).size).toBe(2);
    });
});

test.describe("layout", () => {
    test("payables, bills and their dialogs fit the viewport", async ({ page }) => {
        await restore(page, { suppliers: [supplier()], purchaseBills: [bill()], supplierPayments: [payment()] });
        await setBusiness(page);
        const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        const within = async (id: string) => {
            const box = await page.getByTestId(id).boundingBox();
            const vp = page.viewportSize()!;
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
        };
        await gotoPayables(page);
        await fits();
        await page.getByTestId("pay-new").click();
        await within("pay-dialog");
        await fits();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.getByTestId("supplier-ledger").click();
        await within("ledger-dialog");
        await page.keyboard.press("Escape");

        await gotoBills(page);
        await fits();
        await page.getByTestId("bill-new").first().click();
        await within("bill-dialog");
        await fits();
    });
});
