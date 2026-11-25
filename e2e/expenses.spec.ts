import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { invoice } from "./fixtures";

/**
 * Expenses and profit & loss through the real UI, stores, backup flow and PDF
 * endpoint. Every figure below was worked out by hand; the arithmetic is in the
 * comments next to the seed data.
 */

/* ----------------------------------------------------------------- seeding */

type ExpenseSeed = {
    id: string;
    title: string;
    category: string;
    amount: number;
    currency?: string;
    date: string;
    method?: string;
    vendor?: string;
    reference?: string;
    notes?: string;
    tax?: { amount: number; rate?: number; recoverable: boolean };
};

const exp = (e: ExpenseSeed) => ({
    currency: "USD",
    method: "bank",
    vendor: "",
    reference: "",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...e,
});

/** An invoice on fixed calendar days, so the figures never depend on today's date. */
const inv = (
    number: string,
    client: string,
    total: number,
    o: { status: string; issued: string; due: string; currency?: string; payments?: { id: string; date: string; amount: number }[] }
) => {
    const base = invoice(number, client, `${client.split(" ")[0].toLowerCase()}@example.test`, total, {
        status: o.status,
        issued: 0,
        due: 0,
        currency: o.currency,
        payments: o.payments,
    });
    return { ...base, details: { ...base.details, invoiceDate: `${o.issued}T12:00:00.000Z`, dueDate: `${o.due}T12:00:00.000Z` } };
};

/**
 * Period 2026-01-01 to 2026-03-31.
 *
 * USD invoices
 *   INV-A  1000 sent, issued Jan 10, due Feb 10, paid 400 on Jan 20 and 100 on Apr 5 (after the period)
 *   INV-B   600 sent, issued Feb 15, due Mar 15, unpaid
 *   INV-D   300 draft (never issued: ignored)
 *   invoiced 1000 + 600 = 1600, no tax, revenue 1600
 *   collected = 400 (the April payment is outside the period)
 *   outstanding at Mar 31 = (1000 - 400) + 600 = 1200, all of it past due
 * EUR invoice  INV-C 200 sent, issued Feb 1, due Mar 1, unpaid
 *
 * USD expenses in the period
 *   rent 500 (Jan 5) + salaries 300 (Feb 10) + utilities 118 incl. 18 recoverable tax (Feb 20) + rent 200 (Mar 5) = 1118
 *   cost = 1118 - 18 = 1100
 * outside the period or in another currency: 999 (Dec 20, 2025), 50 EUR (Feb 2)
 *
 *   estimated profit = 1600 - 1100 = 500   (31% of revenue)
 *   net cash flow    = 400 - 1118  = -718
 */
const INVOICES = [
    inv("INV-A", "Acme Corp", 1000, {
        status: "sent",
        issued: "2026-01-10",
        due: "2026-02-10",
        payments: [
            { id: "p1", date: "2026-01-20", amount: 400 },
            { id: "p2", date: "2026-04-05", amount: 100 },
        ],
    }),
    inv("INV-B", "Globex Ltd", 600, { status: "sent", issued: "2026-02-15", due: "2026-03-15" }),
    inv("INV-C", "Initech", 200, { status: "sent", issued: "2026-02-01", due: "2026-03-01", currency: "EUR" }),
    inv("INV-D", "Umbrella", 300, { status: "draft", issued: "2026-02-02", due: "2026-03-02" }),
];

const EXPENSES = [
    exp({ id: "e1", title: "Office rent January", category: "rent", amount: 500, date: "2026-01-05", vendor: "Landlord LLC", reference: "R-001", method: "bank" }),
    exp({ id: "e2", title: "Staff payroll", category: "salaries", amount: 300, date: "2026-02-10", method: "cash" }),
    exp({ id: "e3", title: "Electricity bill", category: "utilities", amount: 118, date: "2026-02-20", method: "card", tax: { amount: 18, rate: 18, recoverable: true } }),
    exp({ id: "e4", title: "Office rent March", category: "rent", amount: 200, date: "2026-03-05", vendor: "Landlord LLC" }),
    exp({ id: "e5", title: "Old consulting bill", category: "miscellaneous", amount: 999, date: "2025-12-20" }),
    exp({ id: "e6", title: "Berlin trip", category: "transport", amount: 50, currency: "EUR", date: "2026-02-02" }),
];

async function restore(page: Page, data: Record<string, unknown>, version = 2) {
    const file = {
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(
            JSON.stringify({
                format: "invoify-backup",
                version,
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

const seedAll = (page: Page) => restore(page, { invoices: INVOICES, expenses: EXPENSES });

const rows = (page: Page) => page.locator('[data-testid="expense-row"]:visible');
const titles = (page: Page) => rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-title")));

const closeDialog = (page: Page, testId: string) => page.getByTestId(testId).getByRole("button", { name: "Close" }).click();

const gotoExpenses = async (page: Page) => {
    await page.goto("/en/expenses");
    await expect(page.getByRole("heading", { name: "Expenses", level: 1 })).toBeVisible();
};

async function setRange(page: Page, from: string, to: string) {
    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Custom range" }).click();
    await page.getByTestId("period-from").fill(from);
    await page.getByTestId("period-to").fill(to);
}

async function pickOption(page: Page, trigger: ReturnType<Page["locator"]>, option: string | RegExp) {
    await trigger.click();
    await page.getByRole("option", { name: option }).click();
}

const gotoReport = async (page: Page, from = "2026-01-01", to = "2026-03-31") => {
    await page.goto("/en/profit-loss");
    await expect(page.getByRole("heading", { name: "Profit & loss", level: 1 })).toBeVisible();
    await setRange(page, from, to);
};

/* ============================================================ expense CRUD */

test.describe("expense workflow", () => {
    test("starts empty, then an expense can be added with every field", async ({ page }) => {
        await gotoExpenses(page);
        await expect(page.getByRole("heading", { name: "No expenses yet" })).toBeVisible();
        await page.getByRole("button", { name: "Add your first expense" }).click();

        const dialog = page.getByTestId("expense-dialog");
        await dialog.locator("#ex-title").fill("Courier charges");
        await dialog.locator("#ex-amount").fill("250.50");
        await dialog.locator("#ex-date").fill("2026-02-14");
        await dialog.locator("#ex-vendor").fill("FastShip");
        await dialog.locator("#ex-ref").fill("FS-77");
        await dialog.locator("#ex-notes").fill("Quarterly dispatch");
        await pickOption(page, dialog.locator("#ex-category"), "Transport");
        await dialog.locator("#ex-tax").fill("30.50");
        await dialog.locator("#ex-rate").fill("14");
        await dialog.locator("#ex-recoverable").click();
        await dialog.getByTestId("save-expense").click();

        await expect(page.getByText("Expense saved", { exact: true }).first()).toBeVisible();
        await expect(dialog).toBeHidden();
        await expect(rows(page)).toHaveCount(1);
        await expect(rows(page).first()).toContainText("Courier charges");
        await expect(rows(page).first()).toContainText("Transport");
        await expect(page.getByTestId("es-total")).toContainText("250.50");
        await expect(page.getByTestId("es-tax")).toContainText("30.50");
        await expect(page.getByTestId("expense-summary")).toContainText("recoverable");

        // It is stored: a reload brings it back.
        await page.reload();
        await expect(rows(page)).toHaveCount(1);
        await expect(rows(page).first()).toContainText("FastShip");
    });

    test("required fields and bad values are explained, and nothing is saved", async ({ page }) => {
        await gotoExpenses(page);
        await page.getByRole("button", { name: "Add your first expense" }).click();
        const dialog = page.getByTestId("expense-dialog");

        await dialog.getByTestId("save-expense").click();
        await expect(dialog.getByText("Enter a title of at least 2 characters.")).toBeVisible();
        await expect(dialog.getByText("Enter an amount greater than zero.")).toBeVisible();
        await expect(dialog).toBeVisible();

        await dialog.locator("#ex-title").fill("Printer");
        await dialog.locator("#ex-amount").fill("-5");
        await dialog.locator("#ex-currency").fill("US");
        await dialog.locator("#ex-date").fill("2031-01-01");
        await dialog.getByTestId("save-expense").click();
        await expect(dialog.getByText("Enter an amount greater than zero.")).toBeVisible();
        await expect(dialog.getByText("Enter a three-letter currency code, such as USD.")).toBeVisible();
        await expect(dialog.getByText("That date is too far in the future.")).toBeVisible();

        await dialog.locator("#ex-amount").fill("100");
        await dialog.locator("#ex-currency").fill("USD");
        await dialog.locator("#ex-date").fill("2026-02-01");
        await dialog.locator("#ex-tax").fill("150");
        await dialog.getByTestId("save-expense").click();
        await expect(dialog.getByText("Tax cannot be more than the amount.")).toBeVisible();

        await dialog.locator("#ex-tax").fill("");
        await dialog.locator("#ex-vendor").fill("x");
        await dialog.locator("#ex-gstin").fill("NOTAGSTIN");
        await dialog.getByTestId("save-expense").click();
        await expect(dialog.getByText("That GSTIN is not valid.")).toBeVisible();
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(page.getByRole("heading", { name: "No expenses yet" })).toBeVisible();
    });

    test("an expense can be edited and then deleted after confirmation", async ({ page }) => {
        await restore(page, { expenses: [EXPENSES[0]] });
        await gotoExpenses(page);
        await expect(rows(page)).toHaveCount(1);

        await rows(page).first().getByTestId("edit-expense").click();
        const dialog = page.getByTestId("expense-dialog");
        await expect(dialog.locator("#ex-title")).toHaveValue("Office rent January");
        await dialog.locator("#ex-amount").fill("650");
        await dialog.getByTestId("save-expense").click();
        await expect(page.getByTestId("es-total")).toContainText("650.00");

        // Cancelling the confirmation keeps the record.
        await rows(page).first().getByTestId("delete-expense").click();
        await page.getByRole("button", { name: "Cancel" }).click();
        await expect(rows(page)).toHaveCount(1);

        await rows(page).first().getByTestId("delete-expense").click();
        await expect(page.getByRole("alertdialog")).toContainText("Office rent January");
        await page.getByTestId("confirm-delete-expense").click();
        await expect(page.getByText("Expense deleted", { exact: true }).first()).toBeVisible();
        await expect(page.getByRole("heading", { name: "No expenses yet" })).toBeVisible();
    });
});

/* ============================================================== categories */

test.describe("expense categories", () => {
    test("custom categories are validated, unique, renamable and usable", async ({ page }) => {
        await gotoExpenses(page);
        await page.getByTestId("manage-categories").click();
        const dialog = page.getByTestId("categories-dialog");
        await expect(dialog.getByTestId("builtin-categories")).toContainText("Rent");
        await expect(dialog.getByTestId("builtin-categories")).toContainText("Miscellaneous");

        await dialog.getByTestId("new-category").fill("a");
        await dialog.getByTestId("add-category").click();
        await expect(dialog.getByTestId("category-error")).toContainText("at least 2 characters");

        await dialog.getByTestId("new-category").fill("Fuel");
        await dialog.getByTestId("add-category").click();
        await expect(dialog.getByTestId("custom-category")).toHaveCount(1);

        // The same name again (any case) and a built-in name are both refused.
        await dialog.getByTestId("new-category").fill("fuel");
        await dialog.getByTestId("add-category").click();
        await expect(dialog.getByTestId("category-error")).toContainText("already exists");
        await dialog.getByTestId("new-category").fill("Rent");
        await dialog.getByTestId("add-category").click();
        await expect(dialog.getByTestId("category-error")).toContainText("already exists");

        await dialog.getByTestId("rename-category").click();
        await dialog.getByTestId("rename-input").fill("Fuel and gas");
        await dialog.getByTestId("rename-save").click();
        await expect(dialog.getByTestId("custom-category")).toContainText("Fuel and gas");
        await closeDialog(page, "categories-dialog");
        await expect(dialog).toBeHidden();

        // It is offered when adding an expense, and survives a reload.
        await page.getByTestId("add-expense").click();
        const form = page.getByTestId("expense-dialog");
        await form.locator("#ex-title").fill("Diesel");
        await form.locator("#ex-amount").fill("80");
        await pickOption(page, form.locator("#ex-category"), "Fuel and gas");
        await form.getByTestId("save-expense").click();
        await page.reload();
        await expect(rows(page).first()).toContainText("Fuel and gas");
    });

    test("a category in use cannot be removed until its expenses are moved", async ({ page }) => {
        await restore(page, {
            expenseCategories: [{ id: "cat-fuel", name: "Fuel" }, { id: "cat-spare", name: "Spare" }],
            expenses: [exp({ id: "f1", title: "Diesel", category: "cat-fuel", amount: 80, date: "2026-02-01" }), exp({ id: "f2", title: "Petrol", category: "cat-fuel", amount: 40, date: "2026-02-02" })],
        });
        await gotoExpenses(page);
        await page.getByTestId("manage-categories").click();
        const dialog = page.getByTestId("categories-dialog");
        await expect(dialog.locator('[data-testid="custom-category"][data-id="cat-fuel"]')).toContainText("2 expenses");

        await dialog.locator('[data-testid="custom-category"][data-id="cat-fuel"]').getByTestId("delete-category").click();
        const panel = dialog.getByTestId("category-delete");
        await expect(panel).toContainText("2 expenses use this category");
        await panel.getByTestId("reassign-to").click();
        await page.getByRole("option", { name: "Transport" }).click();
        await panel.getByTestId("confirm-delete-category").click();
        await expect(dialog.locator('[data-testid="custom-category"][data-id="cat-fuel"]')).toHaveCount(0);
        await closeDialog(page, "categories-dialog");
        await expect(dialog).toBeHidden();

        // Both expenses were moved, not lost.
        await expect(rows(page)).toHaveCount(2);
        for (let i = 0; i < 2; i++) await expect(rows(page).nth(i)).toContainText("Transport");

        // An unused category goes straight away, with no reassignment question.
        await page.getByTestId("manage-categories").click();
        await dialog.locator('[data-testid="custom-category"][data-id="cat-spare"]').getByTestId("delete-category").click();
        await expect(dialog.getByTestId("category-delete")).toContainText("No expense uses this category");
        await expect(dialog.getByTestId("reassign-to")).toHaveCount(0);
        await dialog.getByTestId("confirm-delete-category").click();
        await expect(dialog.getByTestId("custom-category")).toHaveCount(0);
    });
});

/* ============================================ search, filters, sort, ranges */

test.describe("finding expenses", () => {
    test.beforeEach(async ({ page }) => {
        await restore(page, { expenses: EXPENSES });
        await gotoExpenses(page);
        await expect(rows(page)).toHaveCount(6);
    });

    test("search covers title, vendor and reference", async ({ page }) => {
        const search = page.getByPlaceholder("Search title, vendor, reference or notes");
        await search.fill("landlord");
        expect((await titles(page)).sort()).toEqual(["Office rent January", "Office rent March"]);
        await search.fill("R-001");
        expect(await titles(page)).toEqual(["Office rent January"]);
        await search.fill("nothing matches this");
        await expect(page.getByText("No expenses match these filters.")).toBeVisible();
        await page.getByTestId("clear-filters").click();
        await expect(rows(page)).toHaveCount(6);
    });

    test("category, payment method and currency filters combine", async ({ page }) => {
        await pickOption(page, page.getByRole("combobox", { name: "Category", exact: true }), "Rent");
        await expect(rows(page)).toHaveCount(2);
        await pickOption(page, page.getByRole("combobox", { name: "Payment method" }), "Bank");
        await expect(rows(page)).toHaveCount(2);
        await pickOption(page, page.getByRole("combobox", { name: "Payment method" }), "Cash");
        await expect(page.getByText("No expenses match these filters.")).toBeVisible();
        await page.getByTestId("clear-filters").click();

        await pickOption(page, page.getByRole("combobox", { name: "Currency", exact: true }), "EUR");
        expect(await titles(page)).toEqual(["Berlin trip"]);
        await expect(page.getByTestId("es-total")).toContainText("50.00");
    });

    test("a date range keeps both ends, and an impossible one is flagged", async ({ page }) => {
        await setRange(page, "2026-02-10", "2026-02-20");
        expect((await titles(page)).sort()).toEqual(["Electricity bill", "Staff payroll"]);
        await expect(page.getByTestId("expense-count")).toContainText("Showing 2 of 6");

        await page.getByTestId("period-from").fill("2026-03-01");
        await page.getByTestId("period-to").fill("2026-02-01");
        await expect(page.getByRole("alert").filter({ hasText: "The start date must not be after the end date." })).toBeVisible();
    });

    test("sorting by amount works in both directions", async ({ page }) => {
        await pickOption(page, page.getByRole("combobox", { name: "Sort by" }), /Amount/);
        expect((await titles(page))[0]).toBe("Old consulting bill"); // 999
        await page.getByTestId("sort-dir").click();
        expect((await titles(page))[0]).toBe("Berlin trip"); // 50
        await pickOption(page, page.getByRole("combobox", { name: "Sort by" }), /Title/);
        expect((await titles(page))[0]).toBe("Berlin trip"); // ascending A-Z
    });
});

/* =============================================================== summaries */

test.describe("expense summaries", () => {
    test("by category and month, one currency at a time", async ({ page }) => {
        await restore(page, { expenses: EXPENSES });
        await gotoExpenses(page);

        // USD only, every date: 500 + 300 + 118 + 200 + 999 = 2117 over 5 expenses.
        await expect(page.getByTestId("es-total")).toContainText("2,117.00");
        await expect(page.getByTestId("es-count")).toHaveText("5");
        await expect(page.getByTestId("es-average")).toContainText("423.40");
        await expect(page.getByTestId("es-tax")).toContainText("18.00");
        await expect(page.getByTestId("es-largest")).toContainText("999.00");
        await expect(page.getByText("Currencies are never added together.", { exact: true })).toBeVisible();

        // miscellaneous 999 (47%), rent 700 (33%), salaries 300 (14%), utilities 118 (6%); largest first.
        const cats = page.getByTestId("by-category").getByTestId("category-row");
        await expect(cats).toHaveCount(4);
        await expect(cats.nth(0)).toContainText("Miscellaneous");
        await expect(cats.nth(0)).toContainText("47%");
        await expect(cats.nth(1)).toContainText("Rent");
        await expect(cats.nth(1)).toContainText("700.00");
        await expect(cats.nth(1)).toContainText("33%");
        await expect(cats.nth(2)).toContainText("Salaries");
        await expect(cats.nth(3)).toContainText("Utilities");

        // Switching the summary to EUR shows only the euro expense.
        await pickOption(page, page.getByRole("combobox", { name: "Summary in" }), "EUR");
        await expect(page.getByTestId("es-total")).toContainText("50.00");
        await expect(page.getByTestId("es-count")).toHaveText("1");
        await expect(page.getByTestId("by-category").getByTestId("category-row")).toHaveCount(1);
    });

    test("the summary follows the date range", async ({ page }) => {
        await restore(page, { expenses: EXPENSES });
        await gotoExpenses(page);
        await setRange(page, "2026-01-01", "2026-03-31");
        // 500 + 300 + 118 + 200 = 1118
        await expect(page.getByTestId("es-total")).toContainText("1,118.00");
        await expect(page.getByTestId("es-count")).toHaveText("4");
        await expect(page.getByTestId("by-month")).toBeVisible();
    });

    test("exports the visible expenses as CSV, safely", async ({ page }) => {
        await restore(page, { expenses: [...EXPENSES, exp({ id: "ex", title: "=HYPERLINK(\"http://evil\")", category: "miscellaneous", amount: 10, date: "2026-03-10" })] });
        await gotoExpenses(page);
        await setRange(page, "2026-03-01", "2026-03-31");
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-expenses").click()]);
        expect(download.suggestedFilename()).toMatch(/^expenses-\d{4}-\d{2}-\d{2}\.csv$/);
        const csv = await readFile((await download.path())!, "utf8");
        const lines = csv.trim().split(/\r?\n/);
        expect(lines[0]).toContain('"Date","Title","Category"');
        expect(lines).toHaveLength(3); // header + March rent + the formula row
        expect(csv).toContain("Office rent March");
        expect(csv).not.toContain("Office rent January");
        // A cell that starts with = is neutralised so a spreadsheet will not run it.
        expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
    });
});

/* ======================================================== profit and loss */

test.describe("profit and loss", () => {
    test("matches the hand-computed example, on both bases", async ({ page }) => {
        await seedAll(page);
        await gotoReport(page);

        // Cash basis: 400 collected - 1118 expenses = -718. The 100 paid in April is not in the period.
        await expect(page.getByTestId("k-collected")).toContainText("400.00");
        await expect(page.getByTestId("k-expenses")).toContainText("1,118.00");
        await expect(page.getByTestId("k-netcash")).toContainText("718.00");
        await expect(page.getByTestId("k-netcash")).toHaveClass(/text-destructive/);

        // Invoice basis: 1600 invoiced (the draft and the euro invoice are out), revenue 1600, profit 500.
        await expect(page.getByTestId("k-invoiced")).toContainText("1,600.00");
        await expect(page.getByTestId("k-revenue")).toContainText("1,600.00");
        await expect(page.getByTestId("k-profit")).toContainText("500.00");
        await expect(page.getByTestId("k-profit")).not.toHaveClass(/text-destructive/);
        await expect(page.getByTestId("invoice-basis")).toContainText("31% of revenue");

        // Receivables are their own block: 1200 owed at Mar 31, all of it overdue.
        await expect(page.getByTestId("k-outstanding")).toContainText("1,200.00");
        await expect(page.getByTestId("k-overdue")).toContainText("1,200.00");

        // The statement agrees line by line.
        await expect(page.getByTestId("pl-invoiced-value")).toContainText("1,600.00");
        await expect(page.getByTestId("pl-exp-total-value")).toContainText("1,118.00");
        await expect(page.getByTestId("pl-exp-recoverable-value")).toContainText("18.00");
        await expect(page.getByTestId("pl-cost-value")).toContainText("1,100.00");
        await expect(page.getByTestId("pl-profit-value")).toContainText("500.00");
        await expect(page.getByTestId("pl-netcash-value")).toContainText("718.00");
    });

    test("keeps cash, estimate and receivables visibly apart", async ({ page }) => {
        await seedAll(page);
        await gotoReport(page);
        await expect(page.getByTestId("basis-note")).toContainText("Cash basis counts money that actually moved");
        await expect(page.getByTestId("cash-basis")).toContainText("Cash basis");
        await expect(page.getByTestId("invoice-basis")).toContainText("Invoice basis (estimate)");
        // Receivables never appear inside the cash block.
        await expect(page.getByTestId("cash-basis")).not.toContainText("Outstanding");
        await expect(page.getByTestId("cash-basis")).not.toContainText("1,200.00");
    });

    test("an unpaid invoice is revenue and receivable, but not cash", async ({ page }) => {
        await restore(page, { invoices: [inv("INV-U", "Acme Corp", 1000, { status: "sent", issued: "2026-02-01", due: "2026-03-01" })] });
        await gotoReport(page);
        await expect(page.getByTestId("k-invoiced")).toContainText("1,000.00");
        await expect(page.getByTestId("k-profit")).toContainText("1,000.00");
        await expect(page.getByTestId("k-outstanding")).toContainText("1,000.00");
        await expect(page.getByTestId("k-collected")).toContainText("0.00");
        await expect(page.getByTestId("k-netcash")).toContainText("0.00");
        await expect(page.getByTestId("cash-basis")).not.toContainText("1,000.00");
        await expect(page.locator('[data-insight="noExpenses"]')).toBeVisible();
    });

    test("currencies are never combined: each is reported on its own", async ({ page }) => {
        await seedAll(page);
        await gotoReport(page);
        await expect(page.getByText("Currencies are never added together.").first()).toBeVisible();

        await pickOption(page, page.getByRole("combobox", { name: "Currency" }), "EUR");
        // EUR: invoice 200 unpaid, expense 50. Nothing from the USD figures leaks in.
        await expect(page.getByTestId("k-invoiced")).toContainText("200.00");
        await expect(page.getByTestId("k-expenses")).toContainText("50.00");
        await expect(page.getByTestId("k-collected")).toContainText("0.00");
        await expect(page.getByTestId("k-netcash")).toContainText("50.00"); // minus 50
        await expect(page.getByTestId("k-profit")).toContainText("150.00");
        await expect(page.getByTestId("k-outstanding")).toContainText("200.00");
        await expect(page.getByTestId("pl-statement")).not.toContainText("1,600.00");
    });

    test("top categories and rule-based observations come from the same numbers", async ({ page }) => {
        await seedAll(page);
        await gotoReport(page);

        // rent 700 (63%), salaries 300 (27%), utilities 118 (11%).
        const top = page.getByTestId("top-category");
        await expect(top).toHaveCount(3);
        await expect(top.nth(0)).toContainText("1. Rent");
        await expect(top.nth(0)).toContainText("700.00");
        await expect(top.nth(0)).toContainText("63%");
        await expect(top.nth(1)).toContainText("Salaries");

        const obs = page.getByTestId("observations");
        await expect(obs.locator('[data-insight="topCategory"]')).toContainText("Rent is the largest cost: 63%");
        await expect(obs.locator('[data-insight="profitEstimate"]')).toContainText("500.00");
        await expect(obs.locator('[data-insight="cashNegative"]')).toContainText("718.00");
        await expect(obs.locator('[data-insight="profitNotCash"]')).toContainText("1,200.00");
        await expect(obs.locator('[data-insight="receivablesHigh"]')).toContainText("75%");
        await expect(obs.locator('[data-insight="overdue"]')).toContainText("1,200.00");
    });

    test("the monthly chart can show either basis", async ({ page }) => {
        await seedAll(page);
        await gotoReport(page);
        await expect(page.getByTestId("monthly-note")).toContainText("An estimate, not money received");
        await page.getByTestId("basis-cash").click();
        await expect(page.getByTestId("monthly-note")).toContainText("Payments received each month");
        await expect(page.getByTestId("basis-cash")).toHaveAttribute("aria-pressed", "true");
    });

    test("a reversed range is flagged and exports are held back", async ({ page }) => {
        await seedAll(page);
        await gotoReport(page, "2026-03-31", "2026-01-01");
        await expect(page.getByRole("alert").filter({ hasText: "The start date must not be after the end date." })).toBeVisible();
        await expect(page.getByTestId("report-csv")).toBeDisabled();
        await expect(page.getByTestId("report-pdf")).toBeDisabled();
    });

    test("empty books show guidance, not zeros", async ({ page }) => {
        await page.goto("/en/profit-loss");
        await expect(page.getByTestId("profit-empty")).toBeVisible();
        await expect(page.getByRole("link", { name: "Record an expense" })).toBeVisible();
        await expect(page.getByTestId("report-pdf")).toBeDisabled();
    });

    test("exports the report as CSV", async ({ page }) => {
        await seedAll(page);
        await gotoReport(page);
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("report-csv").click()]);
        expect(download.suggestedFilename()).toBe("profit-and-loss-2026-01-01_to_2026-03-31-USD.csv");
        const csv = await readFile((await download.path())!, "utf8");
        // A negative figure stays a number (no formula-guard apostrophe).
        expect(csv).toContain('"Cash basis","Net cash flow","-718","USD"');
        expect(csv).toContain('"Cash basis","Collected (payments received)","400","USD"');
        expect(csv).toContain('"Invoice basis","Estimated profit","500","USD"');
        expect(csv).toContain('"Receivables","Outstanding at end date","1200","USD"');
        expect(csv).toContain('"Expenses by category","Rent","700","USD"');
        expect(csv).not.toContain("999"); // the December bill is outside the period
        expect(csv).not.toContain("EUR");
    });

    test("downloads the report as a PDF", async ({ page }) => {
        await seedAll(page);
        await gotoReport(page);
        const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByTestId("report-pdf").click()]);
        expect(download.suggestedFilename()).toBe("profit-and-loss-2026-01-01_to_2026-03-31-USD.pdf");
        const bytes = await readFile((await download.path())!);
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        expect(bytes.length).toBeGreaterThan(2000);
    });

    test("the print action asks the PDF endpoint for the same report", async ({ page }) => {
        await seedAll(page);
        await gotoReport(page);
        const [response] = await Promise.all([
            page.waitForResponse((r) => r.url().includes("/api/report/profit-loss"), { timeout: 60_000 }),
            page.getByTestId("report-print").click(),
        ]);
        expect(response.status()).toBe(200);
        expect(response.headers()["content-type"]).toContain("application/pdf");
        const sent = JSON.parse(response.request().postData() ?? "{}");
        expect(sent.pnl.netCashFlow).toBe(-718);
        expect(sent.pnl.estimatedProfit).toBe(500);
        expect(sent.pnl.currency).toBe("USD");
    });

    test("the PDF endpoint refuses malformed input", async ({ request }) => {
        const bad = await request.post("/api/report/profit-loss", { data: { pnl: { currency: "USD" } } });
        expect(bad.status()).toBe(400);
        const notJson = await request.post("/api/report/profit-loss", { headers: { "content-type": "application/json" }, data: "{nope" });
        expect(notJson.status()).toBeGreaterThanOrEqual(400);
    });
});

/* ============================================================== dashboard */

test.describe("dashboard integration", () => {
    const today = () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };

    test("shows cash and profit for the year without disturbing the existing cards", async ({ page }) => {
        // 1000 invoiced today, 400 paid today, 150 spent today:
        // collected 400, expenses 150, net cash 250, estimated profit 1000 - 150 = 850.
        const t = today();
        await restore(page, {
            invoices: [inv("INV-T", "Acme Corp", 1000, { status: "sent", issued: t, due: t, payments: [{ id: "p", date: t, amount: 400 }] })],
            expenses: [exp({ id: "t1", title: "Hosting", category: "utilities", amount: 150, date: t })],
        });
        await page.goto("/en/dashboard");
        const card = page.getByTestId("profit-snapshot");
        await expect(card).toBeVisible();
        await expect(page.getByTestId("ps-collected")).toContainText("400.00");
        await expect(page.getByTestId("ps-expenses")).toContainText("150.00");
        await expect(page.getByTestId("ps-netcash")).toContainText("250.00");
        await expect(page.getByTestId("ps-profit")).toContainText("850.00");
        await expect(page.getByTestId("ps-top")).toContainText("Utilities");
        await expect(card.getByRole("link", { name: "Full report" })).toBeVisible();

        // The dashboard that was already there is still there.
        await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
        await expect(page.getByTestId("stat-value").first()).toBeVisible();
        await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
    });

    test("with invoices but no expenses it says so rather than showing a profit as fact", async ({ page }) => {
        const t = today();
        await restore(page, { invoices: [inv("INV-T", "Acme Corp", 500, { status: "sent", issued: t, due: t })] });
        await page.goto("/en/dashboard");
        await expect(page.getByTestId("ps-no-expenses")).toContainText("No expenses recorded this year");
        await expect(page.getByTestId("ps-collected")).toContainText("0.00");
    });

    test("the dashboard is unchanged for someone with no expenses and no invoices", async ({ page }) => {
        await page.goto("/en/dashboard");
        await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
        await expect(page.getByTestId("profit-snapshot")).toHaveCount(0);
    });
});

/* ================================================================= backup */

test.describe("backup and restore", () => {
    test("an older backup with no expense data still restores", async ({ page }) => {
        await restore(page, { invoices: [inv("INV-OLD", "Acme Corp", 100, { status: "sent", issued: "2026-01-02", due: "2026-02-02" })] }, 1);
        await page.goto("/en/invoices");
        await expect(page.getByText("INV-OLD").locator("visible=true").first()).toBeVisible();
        await gotoExpenses(page);
        await expect(page.getByRole("heading", { name: "No expenses yet" })).toBeVisible();
    });

    test("restoring expenses adds the categories they need and counts them", async ({ page }) => {
        await restore(page, {
            expenseCategories: [{ id: "cat-fuel", name: "Fuel" }],
            expenses: [exp({ id: "a", title: "Diesel", category: "cat-fuel", amount: 80, date: "2026-02-01" }), exp({ id: "b", title: "Parcel", category: "ghost-category", amount: 20, date: "2026-02-02" })],
        });
        await expect(page.getByText(/filed under Miscellaneous/).first()).toBeVisible();
        await gotoExpenses(page);
        await expect(rows(page)).toHaveCount(2);
        const diesel = page.locator('[data-testid="expense-row"]:visible[data-title="Diesel"]');
        const parcel = page.locator('[data-testid="expense-row"]:visible[data-title="Parcel"]');
        await expect(diesel).toContainText("Fuel");
        // The unknown category never survives: the expense is filed under Miscellaneous.
        await expect(parcel).toContainText("Miscellaneous");
    });

    test("invalid expense records are reported and never saved", async ({ page }) => {
        const file = {
            name: "backup.json",
            mimeType: "application/json",
            buffer: Buffer.from(
                JSON.stringify({
                    format: "invoify-backup",
                    version: 2,
                    data: {
                        invoices: [],
                        expenses: [
                            exp({ id: "ok", title: "Valid expense", category: "rent", amount: 10, date: "2026-02-01" }),
                            { id: "neg", title: "Negative", category: "rent", amount: -5, currency: "USD", date: "2026-02-01" },
                            { id: "date", title: "Bad date", category: "rent", amount: 5, currency: "USD", date: "2026-02-31" },
                            "not an object",
                        ],
                        expenseCategories: [{ id: "x" }, { id: "good", name: "Good one" }],
                    },
                })
            ),
        };
        await page.goto("/en/settings");
        await page.getByTestId("backup-file").setInputFiles(file);
        await expect(page.getByRole("heading", { name: "Restore from backup" })).toBeVisible();
        await expect(page.getByText(/item\(s\) in this file are invalid/)).toBeVisible();
        await expect(page.getByTestId("restore-counts")).toContainText("Expenses");
        await page.getByRole("button", { name: "Restore", exact: true }).click();
        await expect(page.getByText("Backup restored", { exact: true }).first()).toBeVisible();
        await page.keyboard.press("Escape");

        await gotoExpenses(page);
        expect(await titles(page)).toEqual(["Valid expense"]);
        await page.getByTestId("manage-categories").click();
        await expect(page.getByTestId("custom-category")).toHaveCount(1);
        await expect(page.getByTestId("custom-category")).toContainText("Good one");
    });

    test("an exported backup carries expenses and categories, and restores into a clean browser", async ({ page, browser }, testInfo) => {
        await restore(page, {
            invoices: INVOICES,
            expenseCategories: [{ id: "cat-fuel", name: "Fuel" }],
            expenses: [...EXPENSES, exp({ id: "e7", title: "Diesel", category: "cat-fuel", amount: 80, date: "2026-03-20" })],
        });
        await page.goto("/en/settings");
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).click()]);
        const path = (await download.path())!;
        const backup = JSON.parse(await readFile(path, "utf8"));
        expect(backup.format).toBe("invoify-backup");
        expect(backup.data.expenses).toHaveLength(7);
        expect(backup.data.expenseCategories).toEqual([{ id: "cat-fuel", name: "Fuel" }]);
        expect(backup.data.expenses.find((e: { id: string }) => e.id === "e3").tax).toMatchObject({ amount: 18, recoverable: true });

        // Importing it again changes nothing: the expenses are recognised, not duplicated.
        await page.getByTestId("backup-file").setInputFiles(path);
        await page.getByRole("button", { name: "Restore", exact: true }).click();
        await expect(page.getByText("Backup restored", { exact: true }).first()).toBeVisible();
        await page.keyboard.press("Escape");
        await gotoExpenses(page);
        await expect(rows(page)).toHaveCount(7);

        // A completely clean browser gets everything back.
        const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: testInfo.project.use.viewport ?? undefined });
        try {
            const fresh = await context.newPage();
            await fresh.goto("/en/settings");
            await fresh.getByTestId("backup-file").setInputFiles(path);
            await expect(fresh.getByRole("heading", { name: "Restore from backup" })).toBeVisible();
            await fresh.getByRole("button", { name: "Restore", exact: true }).click();
            await expect(fresh.getByText("Backup restored", { exact: true }).first()).toBeVisible();
            await fresh.keyboard.press("Escape");
            await fresh.goto("/en/expenses");
            await expect(rows(fresh)).toHaveCount(7);
            await expect(fresh.locator('[data-testid="expense-row"]:visible[data-title="Diesel"]')).toContainText("Fuel");
            await fresh.goto("/en/profit-loss");
            await setRange(fresh, "2026-01-01", "2026-03-31");
            // 400 collected - (1118 + 80 diesel) = -798
            await expect(fresh.getByTestId("k-netcash")).toContainText("798.00");
        } finally {
            await context.close();
        }
    });
});

/* ================================================================== layout */

test.describe("layout", () => {
    const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    for (const width of [320, 375, 768, 1280]) {
        test(`no horizontal scrolling at ${width}px on expenses, profit & loss and the dashboard`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            await seedAll(page);

            await gotoExpenses(page);
            await expect(rows(page).first()).toBeVisible();
            expect(await overflow(page)).toBeLessThanOrEqual(1);

            await gotoReport(page);
            await expect(page.getByTestId("k-profit")).toBeVisible();
            expect(await overflow(page)).toBeLessThanOrEqual(1);

            await page.goto("/en/dashboard");
            await expect(page.getByTestId("profit-snapshot")).toBeVisible();
            expect(await overflow(page)).toBeLessThanOrEqual(1);
        });
    }

    test("the expense form and category manager fit a narrow screen", async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 640 });
        await restore(page, { expenses: [EXPENSES[0]] });
        await gotoExpenses(page);

        await page.getByTestId("add-expense").click();
        const form = page.getByTestId("expense-dialog");
        await expect(form).toBeVisible();
        const box = await form.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320 + 1);
        // The Save button can be reached by scrolling inside the dialog.
        await form.getByTestId("save-expense").scrollIntoViewIfNeeded();
        await expect(form.getByTestId("save-expense")).toBeVisible();
        await page.keyboard.press("Escape");

        await page.getByTestId("manage-categories").click();
        const cats = page.getByTestId("categories-dialog");
        const catBox = await cats.boundingBox();
        expect(catBox!.x + catBox!.width).toBeLessThanOrEqual(320 + 1);
    });

    test("phones get cards, wide screens get a table, and never both", async ({ page }) => {
        await restore(page, { expenses: EXPENSES });
        await page.setViewportSize({ width: 390, height: 800 });
        await gotoExpenses(page);
        await expect(page.getByTestId("expense-cards")).toBeVisible();
        await expect(page.getByTestId("expense-table")).toBeHidden();
        await page.setViewportSize({ width: 1280, height: 800 });
        await expect(page.getByTestId("expense-table")).toBeVisible();
        await expect(page.getByTestId("expense-cards")).toBeHidden();
    });
});

/* ============================================================== navigation */

test.describe("navigation", () => {
    for (const [name, path, heading] of [
        ["Expenses", "/en/expenses", "Expenses"],
        ["Profit & loss", "/en/profit-loss", "Profit & loss"],
    ] as const) {
        test(`the menu leads to ${name}`, async ({ page }) => {
            await page.goto("/en/dashboard");
            const menu = page.getByRole("button", { name: "Open menu" });
            if (await menu.isVisible()) await menu.click();
            await page.locator("nav:visible a", { hasText: name }).first().click();
            await expect(page).toHaveURL(new RegExp(`${path}$`));
            await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
        });
    }
});
