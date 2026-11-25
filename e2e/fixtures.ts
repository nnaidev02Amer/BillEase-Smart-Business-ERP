import { expect, type Page } from "@playwright/test";

/** Shared seed data and helpers for the management-area specs. */

export const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString();
};

export const isoDay = (offset: number) => day(offset).slice(0, 10);

export const party = (name: string, email: string) => ({
    name,
    address: "1 Main Street",
    zipCode: "12345",
    city: "Townsville",
    country: "Testland",
    email,
    phone: "555-0100",
});

type Opts = {
    status?: string;
    issued: number;
    due: number;
    currency?: string;
    payments?: { id: string; date: string; amount: number }[];
    recurring?: Record<string, unknown>;
};

export const invoice = (number: string, client: string, email: string, total: number, o: Opts) => ({
    sender: party("Sender Co", "sender@example.com"),
    receiver: party(client, email),
    details: {
        ...(o.status ? { status: o.status } : {}),
        ...(o.payments ? { payments: o.payments } : {}),
        ...(o.recurring ? { recurring: o.recurring } : {}),
        invoiceNumber: number,
        invoiceDate: day(o.issued),
        dueDate: day(o.due),
        currency: o.currency ?? "USD",
        language: "English",
        items: [{ name: "Work", quantity: 1, unitPrice: total, total }],
        subTotal: total,
        totalAmount: total,
        totalAmountInWords: "",
        paymentTerms: "Net 30",
        pdfTemplate: 1,
    },
});

/**
 * Expected figures for BASE_INVOICES (USD unless noted):
 *   INV-001 Acme    1000  legacy status "paid"          -> paid in full
 *   INV-002 Globex   250  no status, due 10 days ago     -> overdue, balance 250
 *   INV-003 Acme     500  sent, 200 paid, due in 28 days -> partial, balance 300
 *   INV-004 Initech  300 EUR draft                       -> not issued
 * collected 1200 · outstanding 550 · overdue 250 · invoiced 1750 · average 583.33
 */
export const BASE_INVOICES = [
    invoice("INV-001", "Acme Corp", "billing@acme.test", 1000, { status: "paid", issued: -20, due: -5 }),
    invoice("INV-002", "Globex Ltd", "ap@globex.test", 250, { issued: -40, due: -10 }),
    invoice("INV-003", "Acme Corp", "billing@acme.test", 500, {
        status: "sent",
        issued: -12,
        due: 28,
        payments: [{ id: "p1", date: isoDay(-1), amount: 200 }],
    }),
    invoice("INV-004", "Initech", "pay@initech.test", 300, { status: "draft", issued: -1, due: 29, currency: "EUR" }),
];

export const backupFile = (invoices: unknown[]) => ({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "invoify-backup", version: 1, invoices })),
});

/** Imports invoices through the real restore flow (validation preview included). */
export async function seed(page: Page, invoices: unknown[] = [...BASE_INVOICES, { not: "an invoice" }]) {
    await page.goto("/en/settings");
    await page.getByTestId("backup-file").setInputFiles(backupFile(invoices));
    await expect(page.getByRole("heading", { name: "Restore from backup" })).toBeVisible();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText("Backup restored", { exact: true }).first()).toBeVisible();
    // Close the dialog if it is still up.
    await page.keyboard.press("Escape");
}

/** The table and the phone cards both render; only one is visible per viewport. */
export const rows = (page: Page) => page.locator('[data-testid="invoice-row"]:visible');

export async function gotoInvoices(page: Page) {
    await page.goto("/en/invoices");
    await expect(rows(page).first()).toBeVisible();
}
