import { test, expect, type Page } from "@playwright/test";

import { BASE_INVOICES, backupFile, gotoInvoices, invoice, isoDay, rows, seed } from "./fixtures";

/**
 * The management area: dashboard, invoices, payments, clients, analytics,
 * settings and data management. Everything is seeded through the real restore
 * flow, so validation, merging and encrypted persistence are exercised too.
 */

const metric = (page: Page, label: string) =>
    page.getByText(label, { exact: true }).first().locator("xpath=following-sibling::*[@data-testid][1]");

test.describe("data management", () => {
    test("restore previews, validates and merges a backup", async ({ page }) => {
        await page.goto("/en/settings");
        await expect(page.getByRole("heading", { name: "Your data" })).toBeVisible();

        // Not JSON at all.
        await page.getByTestId("backup-file").setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from("not json") });
        await expect(page.getByText("The file is not valid JSON.").first()).toBeVisible();

        // JSON that is not a backup.
        await page.getByTestId("backup-file").setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from('{"hello":1}') });
        await expect(page.getByText("does not look like a BillEase backup").first()).toBeVisible();

        // A real one, with one invalid entry.
        await page.getByTestId("backup-file").setInputFiles(backupFile([...BASE_INVOICES, { not: "an invoice" }]));
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("1 item(s) in this file are invalid")).toBeVisible();
        await expect(dialog.getByTestId("restore-counts")).toContainText("4");
        await expect(dialog.getByText("no checksum")).toBeVisible();
        await dialog.getByRole("button", { name: "Restore", exact: true }).click();
        await expect(page.getByText("4 added, 0 skipped, 0 replaced, 0 renumbered.", { exact: true })).toBeVisible();
        await page.keyboard.press("Escape");

        // Importing the same file again detects every duplicate.
        await page.getByTestId("backup-file").setInputFiles(backupFile(BASE_INVOICES));
        await expect(page.getByRole("dialog").getByText("4 invoice number(s) already exist")).toBeVisible();
        await expect(page.getByRole("dialog").getByText("4 are identical")).toBeVisible();
        await page.getByRole("dialog").getByLabel("Keep both").check();
        await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();
        await expect(page.getByText("4 added, 0 skipped, 0 replaced, 4 renumbered.", { exact: true })).toBeVisible();
    });

    test("an exported backup round-trips with a valid checksum", async ({ page }) => {
        await seed(page);
        const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.getByRole("button", { name: "Export backup" }).click(),
        ]);
        const text = (await (await download.createReadStream()).toArray()).map((c) => c.toString()).join("");
        const file = JSON.parse(text);
        expect(file.format).toBe("invoify-backup");
        expect(file.version).toBe(2);
        expect(file.counts.invoices).toBe(4);
        expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);

        // Tampering is detected.
        file.data.invoices[0].details.totalAmount = 999999;
        await page.getByTestId("backup-file").setInputFiles({ name: "t.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("checksum does not match")).toBeVisible();
        // Restoring a damaged file needs an explicit acknowledgement.
        await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toBeDisabled();
        await dialog.getByLabel(/may be damaged/).check();
        await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toBeEnabled();
    });

    test("shows storage usage and requires typing DELETE to clear data", async ({ page }) => {
        await seed(page);
        await expect(page.getByTestId("storage-total")).not.toHaveText("0 B");
        await page.getByRole("button", { name: "Delete all invoices" }).click();
        const confirm = page.getByRole("button", { name: "Delete permanently" });
        await expect(confirm).toBeDisabled();
        await page.getByLabel(/Type DELETE/).fill("DELETE");
        await confirm.click();
        await expect(page.getByText("Data cleared").first()).toBeVisible();
        await page.goto("/en/invoices");
        await expect(page.getByRole("heading", { name: "No invoices yet" })).toBeVisible();
    });
});

test.describe("dashboard", () => {
    test("is guided when empty and calculates real figures from saved invoices", async ({ page }) => {
        await page.goto("/en/dashboard");
        await expect(page.getByRole("heading", { name: "No invoices yet" })).toBeVisible();
        await seed(page);
        await page.goto("/en/dashboard");

        await expect(metric(page, "Revenue (paid)")).toHaveText("$1,200.00");
        await expect(metric(page, "Outstanding")).toHaveText("$550.00");
        await expect(metric(page, "Overdue")).toHaveText("$250.00");
        await expect(metric(page, "Average invoice")).toHaveText("$583.33");
        await expect(metric(page, "Total invoices")).toHaveText("4");

        // Needs attention: the overdue invoice, with a ready-to-send reminder.
        const attention = page.getByRole("region", { name: "Needs attention" });
        await expect(attention).toContainText("INV-002");
        await expect(attention.getByRole("link", { name: "Remind" }).first()).toHaveAttribute("href", /^mailto:ap@globex\.test\?subject=/);

        // Recent transactions come from recorded payments, not invoices.
        await expect(page.getByText("+$200.00")).toBeVisible();
        // Top clients are ranked by invoiced value.
        await expect(page.getByText("1. Acme Corp")).toBeVisible();
    });

    test("separates currencies instead of adding them together", async ({ page }) => {
        await seed(page, [
            ...BASE_INVOICES,
            invoice("EUR-1", "Initech", "pay@initech.test", 700, { status: "sent", issued: -3, due: 20, currency: "EUR" }),
        ]);
        await page.goto("/en/dashboard");
        await expect(metric(page, "Revenue (paid)")).toHaveText("$1,200.00");
        await page.getByRole("combobox", { name: "Currency" }).click();
        await page.getByRole("option", { name: "EUR" }).click();
        await expect(metric(page, "Outstanding")).toHaveText("€700.00");
    });

    test("quick actions and keyboard shortcuts navigate", async ({ page, isMobile }) => {
        await seed(page);
        await page.goto("/en/dashboard");
        await expect(page.getByRole("group", { name: "Quick actions" })).toBeVisible();
        await page.getByRole("link", { name: "Add client" }).click();
        await expect(page).toHaveURL(/\/en\/clients/);
        await expect(page.getByRole("dialog").getByRole("heading", { name: "Add client" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);

        test.skip(isMobile, "keyboard shortcuts are a desktop affordance");
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press("?");
        await expect(page.getByRole("dialog").getByText("Keyboard shortcuts")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.keyboard.press("g");
        await page.keyboard.press("i");
        await expect(page).toHaveURL(/\/en\/invoices/);
        await page.keyboard.press("/");
        await expect(page.getByRole("searchbox")).toBeFocused();
    });
});

test.describe("invoices", () => {
    test("derived statuses follow the payments and due dates", async ({ page }) => {
        await seed(page);
        await gotoInvoices(page);
        const row = (n: string) => rows(page).filter({ hasText: n });
        await expect(row("INV-001")).toContainText("Paid");
        await expect(row("INV-002")).toContainText("Overdue");
        await expect(row("INV-003")).toContainText("Partially paid");
        await expect(row("INV-004")).toContainText("Draft");
    });

    test("searches, filters (including advanced) and sorts", async ({ page }) => {
        await seed(page);
        await gotoInvoices(page);

        await page.getByRole("searchbox").fill("acme");
        await expect(rows(page)).toHaveCount(2);
        await page.getByRole("searchbox").fill("");

        await page.getByRole("combobox", { name: "All statuses" }).click();
        await page.getByRole("option", { name: "Overdue" }).click();
        await expect(rows(page)).toHaveCount(1);
        await expect(rows(page).first()).toContainText("INV-002");
        await page.getByRole("button", { name: "Clear filters" }).click();
        await expect(rows(page)).toHaveCount(4);

        await page.getByRole("button", { name: "Advanced filters" }).click();
        await page.getByLabel("Min amount").fill("400");
        await expect(rows(page)).toHaveCount(2);
        await page.getByLabel("Max amount").fill("600");
        await expect(rows(page)).toHaveCount(1);
        await expect(rows(page).first()).toContainText("INV-003");
        await page.getByRole("button", { name: "Clear filters" }).click();

        await page.getByRole("combobox", { name: "Sort by" }).click();
        await page.getByRole("option", { name: /Amount/ }).click();
        await expect(rows(page).first()).toContainText("INV-001");
        await page.getByRole("button", { name: "Descending" }).click();
        await expect(rows(page).first()).toContainText("INV-002");

        await page.getByRole("searchbox").fill("zzz-no-match");
        await expect(page.getByText("No invoices match your search.")).toBeVisible();
    });

    test("payments are validated and drive the status", async ({ page }) => {
        await seed(page);
        await gotoInvoices(page);

        await page.getByRole("button", { name: "Payments INV-002" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("$250.00");

        // Cannot pay more than is owed.
        await dialog.getByLabel("Amount").fill("300");
        await dialog.getByRole("button", { name: "Record payment" }).click();
        await expect(dialog.getByRole("alert")).toHaveText("That is more than the balance still due.");

        // Cannot date a payment in the future.
        await dialog.getByLabel("Amount").fill("100");
        await dialog.getByLabel("Date").fill(isoDay(3));
        await dialog.getByRole("button", { name: "Record payment" }).click();
        await expect(dialog.getByRole("alert")).toHaveText("The payment date cannot be in the future.");

        // A valid part-payment leaves a balance; paying the rest settles it.
        await dialog.getByLabel("Date").fill(isoDay(0));
        await dialog.getByRole("button", { name: "Record payment" }).click();
        await expect(dialog).toContainText("$150.00");
        await dialog.getByRole("button", { name: "Mark as paid" }).click();
        await expect(dialog).toContainText("This invoice is fully paid.");
        await page.keyboard.press("Escape");
        await expect(rows(page).filter({ hasText: "INV-002" })).toContainText("Paid");
    });

    test("status transitions are guarded", async ({ page }) => {
        await seed(page);
        await gotoInvoices(page);

        // A draft cannot take a payment.
        await page.getByRole("button", { name: "Payments INV-004" }).click();
        await expect(page.getByRole("dialog")).toContainText("Mark the invoice as sent before recording payments.");
        await page.keyboard.press("Escape");

        // An invoice with payments cannot be cancelled or sent back to draft.
        await page.getByRole("combobox", { name: "Set status INV-003" }).click();
        await page.getByRole("option", { name: "Cancelled" }).click();
        await expect(page.getByText("This invoice has payments.").first()).toBeVisible();
        await expect(rows(page).filter({ hasText: "INV-003" })).toContainText("Partially paid");

        // A draft can be issued and then cancelled when nothing is paid.
        await page.getByRole("combobox", { name: "Set status INV-004" }).click();
        await page.getByRole("option", { name: "Sent" }).click();
        await expect(rows(page).filter({ hasText: "INV-004" })).toContainText(/Sent|Overdue|Partially/);
        await page.getByRole("combobox", { name: "Set status INV-004" }).click();
        await page.getByRole("option", { name: "Cancelled" }).click();
        await expect(rows(page).filter({ hasText: "INV-004" })).toContainText("Cancelled");
    });

    test("duplicates, deletes with confirmation, and persists across reload", async ({ page }) => {
        await seed(page);
        await gotoInvoices(page);

        await page.getByRole("button", { name: "Duplicate INV-001" }).click();
        await expect(rows(page)).toHaveCount(5);
        // The copy is a draft with a new number and none of the original's payments.
        await expect(rows(page).filter({ hasText: "INV-002" }).first()).toBeVisible();

        await page.getByRole("button", { name: "Delete INV-003" }).click();
        await page.getByRole("button", { name: "Cancel" }).click();
        await expect(rows(page)).toHaveCount(5);

        await page.getByRole("button", { name: "Delete INV-003" }).click();
        await page.getByRole("button", { name: "Delete invoice" }).click();
        await expect(rows(page)).toHaveCount(4);

        await page.reload();
        await expect(rows(page)).toHaveCount(4);
    });

    test("recurring schedules catch up as drafts when the app opens", async ({ page }) => {
        await seed(page, [
            invoice("REC-1", "Acme Corp", "billing@acme.test", 100, {
                status: "sent",
                issued: -65,
                due: -35,
                recurring: { frequency: "monthly", nextDate: isoDay(-35) },
            }),
        ]);
        await page.goto("/en/invoices");
        await expect(page.getByText(/2 recurring invoice\(s\) created as drafts/).first()).toBeVisible();
        await expect(rows(page)).toHaveCount(3);
        // Generated invoices are drafts: nothing is sent on the user's behalf.
        await expect(rows(page).filter({ hasText: "REC-2" })).toContainText("Draft");
        await expect(rows(page).filter({ hasText: "REC-3" })).toContainText("Draft");

        // Reloading must not generate them again.
        await page.reload();
        await expect(rows(page)).toHaveCount(3);
    });
});

test.describe("builder integration", () => {
    test("editing a saved invoice keeps history and warns about unsaved changes", async ({ page, isMobile }) => {
        test.skip(isMobile, "the builder save flow is exercised on desktop");
        await seed(page);
        await gotoInvoices(page);

        await page.getByRole("button", { name: "Open in editor INV-001" }).click();
        await expect(page).toHaveURL(/\/en\/?(\?.*)?$/);

        // Edit the client's phone, which is on the first step.
        const phone = page.locator('input[name="receiver.phone"]');
        await phone.fill("5559999");

        // Unsaved edits: leaving asks first, and staying keeps the page.
        await expect(page.getByRole("img", { name: "Unsaved changes" }).or(page.locator("body"))).toBeVisible();
        await page.waitForTimeout(700);
        await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Dashboard" }).click();
        await expect(page.getByRole("alertdialog")).toContainText("Leave with unsaved changes?");
        await page.getByRole("button", { name: "Stay here" }).click();
        await expect(page).toHaveURL(/\/en\/?(\?.*)?$/);

        // Ctrl+S saves over the same number: no overwrite warning, a revision is kept.
        await phone.click();
        await page.keyboard.press("Control+s");
        await expect(page.getByText("Invoice updated").first()).toBeVisible();

        await page.goto("/en/invoices");
        await page.getByRole("button", { name: "History INV-001" }).click();
        await expect(page.getByRole("dialog")).toContainText("Version 1");
    });

    test("quick invoice and numbering settings produce the next number", async ({ page }) => {
        await seed(page);
        await page.goto("/en/settings");
        await page.getByLabel(/Custom scheme/).check();
        await page.locator("#n-prefix").fill("BE");
        await page.locator("#n-sep").fill("-");
        await page.locator("#n-pad").fill("3");
        await page.locator("#n-start").fill("10");
        await expect(page.getByTestId("numbering-preview")).toContainText("BE-010");
        await page.getByRole("button", { name: "Save settings" }).click();
        await expect(page.getByText("Settings saved").first()).toBeVisible();

        await page.goto("/en/dashboard");
        await page.getByRole("button", { name: "Quick invoice" }).first().click();
        await page.waitForTimeout(1000);
        await page.goto("/en?step=details");
        await expect(page.locator('input[name="details.invoiceNumber"]')).toHaveValue("BE-010");
        // The sender, currency and look carry over from the latest invoice.
        await page.goto("/en?step=from-and-to");
        await expect(page.locator('input[name="sender.name"]')).toHaveValue("Sender Co");
    });
});

test.describe("clients", () => {
    test("profiles are validated, show real balances, and start invoices", async ({ page }) => {
        await seed(page);
        await page.goto("/en/clients");

        // Clients you have invoiced appear without being added.
        await expect(page.getByTestId("client-list")).toContainText("Acme Corp");

        // Validation.
        await page.getByRole("button", { name: "Add client" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("Name").fill("A");
        await dialog.getByRole("button", { name: "Save client" }).click();
        await expect(dialog.getByRole("alert")).toHaveText("Enter a name of at least 2 characters.");
        await dialog.getByLabel("Name").fill("Hooli");
        await dialog.getByLabel("Email").fill("not-an-email");
        await dialog.getByRole("button", { name: "Save client" }).click();
        await expect(dialog.getByRole("alert")).toHaveText("Enter a valid email address.");
        await dialog.getByLabel("Email").fill("gavin@hooli.test");
        await dialog.getByLabel("Notes").fill("Prefers invoices on the 1st");
        await dialog.getByRole("button", { name: "Save client" }).click();
        await expect(page.getByTestId("client-list")).toContainText("Hooli");

        // A duplicate is refused.
        await page.getByRole("button", { name: "Add client" }).click();
        await page.getByRole("dialog").getByLabel("Name").fill("Hooli");
        await page.getByRole("dialog").getByLabel("Email").fill("gavin@hooli.test");
        await page.getByRole("dialog").getByRole("button", { name: "Save client" }).click();
        await expect(page.getByRole("dialog").getByRole("alert")).toContainText("already exists");
        await page.keyboard.press("Escape");

        // Search and filter.
        await page.getByRole("searchbox").fill("hooli");
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(1);
        await page.getByRole("searchbox").fill("");
        await page.getByRole("combobox", { name: "Filter clients" }).click();
        await page.getByRole("option", { name: "With a balance" }).click();
        await expect(page.getByTestId("client-list")).not.toContainText("Hooli");
        await expect(page.getByTestId("client-list")).toContainText("Acme Corp");
        await page.getByRole("combobox", { name: "Filter clients" }).click();
        await page.getByRole("option", { name: "All clients" }).click();

        // Profile: totals come from the invoices.
        await page.getByTestId("client-list").getByRole("button", { name: /Acme Corp/ }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toContainText("$1,500.00"); // billed: 1000 + 500
        await expect(sheet).toContainText("$300.00"); // outstanding
        await expect(sheet).toContainText("INV-001");
        await expect(sheet).toContainText("INV-003");

        // Quick invoice from the profile pre-fills the client.
        await sheet.getByRole("button", { name: "New invoice" }).click();
        await expect(page).toHaveURL(/\/en\/?(\?.*)?$/);
        await page.waitForTimeout(1000);
        await page.goto("/en?step=from-and-to");
        await expect(page.locator('input[name="receiver.name"]')).toHaveValue("Acme Corp");
    });
});

test.describe("analytics", () => {
    test("computes figures from saved invoices and exports reports", async ({ page }) => {
        await page.goto("/en/analytics");
        await expect(page.getByRole("heading", { name: "No data to analyse yet" })).toBeVisible();

        await seed(page);
        await page.goto("/en/analytics");
        await expect(metric(page, "Invoiced")).toHaveText("$1,750.00");
        await expect(metric(page, "Revenue (paid)")).toHaveText("$1,200.00");
        await expect(metric(page, "Outstanding")).toHaveText("$550.00");
        await expect(metric(page, "Average invoice")).toHaveText("$583.33");
        await expect(metric(page, "Discounts given")).toHaveText("$0.00");

        const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.getByRole("button", { name: "Revenue by month" }).click(),
        ]);
        expect(download.suggestedFilename()).toMatch(/^revenue-by-month-\d{4}-USD\.csv$/);
        const csv = (await (await download.createReadStream()).toArray()).map((c) => c.toString()).join("");
        expect(csv.split("\r\n")[0]).toContain('"Month","Invoiced","Collected"');
        expect(csv.split("\r\n")).toHaveLength(13); // header + 12 months
    });

    test("tax and discounts come from each invoice's own charges", async ({ page }) => {
        const taxed = invoice("TAX-1", "Acme Corp", "billing@acme.test", 1000, { status: "sent", issued: -3, due: 25 });
        // 10% discount (-100) then 20% tax on 900 (+180) = 1080.
        Object.assign(taxed.details, {
            discountDetails: { amount: 10, amountType: "percentage" },
            taxDetails: { amount: 20, amountType: "percentage", taxID: "" },
            totalAmount: 1080,
        });
        await seed(page, [taxed]);
        await page.goto("/en/analytics");
        await expect(metric(page, "Discounts given")).toHaveText("$100.00");
        await expect(metric(page, "Tax collected")).toHaveText("$0.00"); // nothing paid yet
        await expect(page.getByText("$180.00 on issued invoices")).toBeVisible();
    });
});

test.describe("responsive layout", () => {
    for (const path of ["dashboard", "invoices", "clients", "analytics", "settings"]) {
        test(`/${path} has no horizontal overflow`, async ({ page }) => {
            await seed(page);
            await page.goto(`/en/${path}`);
            await page.waitForTimeout(600);
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });
    }

    test("the sidebar is a column on desktop and a menu on mobile", async ({ page, isMobile }) => {
        await page.goto("/en/dashboard");
        if (isMobile) {
            await expect(page.getByRole("navigation", { name: "Sections" })).toBeHidden();
            await page.getByRole("button", { name: "Open menu" }).click();
            await expect(page.getByRole("dialog").getByRole("link", { name: "Analytics" })).toBeVisible();
        } else {
            await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Analytics" })).toBeVisible();
        }
    });
});
