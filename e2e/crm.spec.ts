import { test, expect, type Page } from "@playwright/test";

import { gstinCheckChar } from "../lib/gst";
import { day, isoDay } from "./fixtures";

/** Customer CRM through the real UI, stores and PDF endpoint. */

const gstin = (state: string, pan = "AAPFU0939F") => {
    const first14 = `${state}${pan}1Z`;
    return first14 + gstinCheckChar(first14);
};
const ACME_GSTIN = gstin("27");

const party = (name: string, email: string, extra: Record<string, unknown> = {}) => ({
    name,
    address: "12 MG Road",
    zipCode: "400001",
    city: "Mumbai",
    country: "India",
    email,
    phone: "555-0100",
    ...extra,
});

type Inv = {
    number: string;
    client: string;
    email: string;
    issued: number;
    due: number;
    total: number;
    status?: string;
    currency?: string;
    pays?: [number, number][];
    gstin?: string;
};

const inv = (o: Inv) => ({
    sender: party("Sharma Traders", "sharma@example.com", { gstin: gstin("29", "AABCT1332L") }),
    receiver: party(o.client, o.email, o.gstin ? { gstin: o.gstin } : {}),
    details: {
        invoiceNumber: o.number,
        invoiceDate: day(o.issued),
        dueDate: day(o.due),
        currency: o.currency ?? "USD",
        language: "English",
        status: o.status ?? "sent",
        items: [{ name: "Work", quantity: 1, unitPrice: o.total, total: o.total }],
        subTotal: o.total,
        totalAmount: o.total,
        totalAmountInWords: "",
        paymentTerms: "Net 30",
        pdfTemplate: 1,
        ...(o.pays ? { payments: o.pays.map(([d, amount], i) => ({ id: `${o.number}-p${i}`, date: isoDay(d), amount })) } : {}),
    },
});

const quote = (id: string, number: string, status: string, client: string, email: string, o: { total?: number; validIn?: number } = {}) => ({
    id,
    status,
    createdAt: day(-20),
    updatedAt: day(-20),
    events: [{ at: day(-20), kind: "created" }, ...(status !== "draft" ? [{ at: day(-19), kind: "sent" }] : []), ...(status === "accepted" ? [{ at: day(-15), kind: "accepted" }] : [])],
    doc: {
        sender: party("Sharma Traders", "sharma@example.com"),
        receiver: party(client, email),
        details: {
            invoiceNumber: number,
            invoiceDate: day(-25),
            dueDate: day(o.validIn ?? 20),
            currency: "USD",
            language: "English",
            items: [{ name: "Thing", quantity: 1, unitPrice: 1, total: 1 }],
            subTotal: 1,
            totalAmount: o.total ?? 1000,
            totalAmountInWords: "",
            paymentTerms: "Net 30",
            pdfTemplate: 1,
        },
    },
});

const profile = (name: string, email: string, extra: Record<string, unknown> = {}) => ({ id: `id-${name}`, ...party(name, email), customInputs: [], createdAt: "2026-01-01T00:00:00.000Z", ...extra });

/**
 * The reference scenario. Acme, in USD:
 *   A0  issued -120 due -90   100   paid in full on day -100      (on time)
 *   A1  issued  -60 due -30  1000   paid in full on day  -40      (on time)
 *   A2  issued  -40 due -10   500   unpaid                          (overdue)
 *   A3  issued  -10 due +20   800   300 paid on day -5              (500 owed, not yet due)
 *   A4  draft 999 · A5 cancelled 777        (never counted)
 *   A6  EUR 200
 * => USD invoiced 2400, paid 1400, outstanding 1000, overdue 500.
 */
const ACME = [
    inv({ number: "A0", client: "Acme Corp", email: "buyer@acme.test", issued: -120, due: -90, total: 100, pays: [[-100, 100]], gstin: ACME_GSTIN }),
    inv({ number: "A1", client: "Acme Corp", email: "buyer@acme.test", issued: -60, due: -30, total: 1000, pays: [[-40, 1000]], gstin: ACME_GSTIN }),
    inv({ number: "A2", client: "Acme Corp", email: "buyer@acme.test", issued: -40, due: -10, total: 500, gstin: ACME_GSTIN }),
    inv({ number: "A3", client: "Acme Corp", email: "buyer@acme.test", issued: -10, due: 20, total: 800, pays: [[-5, 300]], gstin: ACME_GSTIN }),
    inv({ number: "A4", client: "Acme Corp", email: "buyer@acme.test", issued: -5, due: 25, total: 999, status: "draft" }),
    inv({ number: "A5", client: "Acme Corp", email: "buyer@acme.test", issued: -50, due: -20, total: 777, status: "cancelled" }),
    inv({ number: "A6", client: "Acme Corp", email: "buyer@acme.test", issued: -3, due: 27, total: 200, currency: "EUR" }),
];
const OTHERS = [
    inv({ number: "G1", client: "Globex Ltd", email: "ap@globex.test", issued: -30, due: 0, total: 5000, pays: [[-10, 1000]] }),
    inv({ number: "I1", client: "Initech", email: "pay@initech.test", issued: -20, due: 10, total: 300, pays: [[-18, 300]] }),
    // quiet for over a year, used to order regularly
    ...[-500, -470, -440, -410].map((o, i) => inv({ number: `D${i}`, client: "Dormant Co", email: "d@dormant.test", issued: o, due: o + 30, total: 100, pays: [[o + 5, 100]] })),
    // pays 15 days late, every time, and owes more now
    ...[-200, -150, -100].map((o, i) => inv({ number: `L${i}`, client: "Latecomer", email: "l@late.test", issued: o, due: o + 30, total: 100, pays: [[o + 45, 100]] })),
    inv({ number: "L9", client: "Latecomer", email: "l@late.test", issued: -20, due: 10, total: 400 }),
];
const QUOTES = [
    quote("qa", "QA", "accepted", "Acme Corp", "buyer@acme.test", { total: 3000 }),
    quote("qs", "QS", "sent", "Acme Corp", "buyer@acme.test", { total: 500, validIn: 3 }),
    quote("qr", "QR", "rejected", "Acme Corp", "buyer@acme.test", { total: 200 }),
];
const PROFILES = [
    profile("Acme Corp", "buyer@acme.test", { gstin: ACME_GSTIN, company: "Acme Pvt Ltd", contactPerson: "Asha Rao", website: "acme.test", category: "Wholesale", tags: ["vip", "north"], notes: "Prefers invoices on the 1st", shippingAddress: { address: "Dock 4", zipCode: "400002", city: "Pune", country: "India" } }),
    profile("Hooli", "gavin@hooli.test", { category: "Retail", tags: ["north"], inactive: true }),
];

type Data = Record<string, unknown>;

async function restore(page: Page, data: Data) {
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
    // A fixture the app rejects would otherwise be dropped silently and fail later, elsewhere.
    await expect(page.getByText(/item\(s\) in this file are invalid/)).toHaveCount(0);
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText("Backup restored", { exact: true }).first()).toBeVisible();
    await page.keyboard.press("Escape");
}

const SEED: Data = { invoices: [...ACME, ...OTHERS], clients: PROFILES, quotations: QUOTES };

const card = (page: Page, name: string) => page.locator('[data-testid="client-card"]').filter({ hasText: name });
const gotoDir = async (page: Page) => {
    await page.goto("/en/clients");
    await expect(page.getByTestId("client-list")).toBeVisible();
};
const gotoProfile = async (page: Page, key = "buyer@acme.test", tab = "overview") => {
    await page.goto(`/en/clients/profile?key=${encodeURIComponent(key)}&tab=${tab}`);
    await expect(page.getByTestId("customer-profile")).toBeVisible();
};
const tile = (page: Page, id: string) => page.getByTestId(id);

/* ============================================================= directory */

test.describe("customer directory", () => {
    test("shows each customer once, with category, tags, status and real figures", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        // Acme (profile + invoices + quotations) is one card, not three.
        await expect(card(page, "Acme Corp")).toHaveCount(1);
        await expect(card(page, "Acme Corp")).toContainText("Wholesale");
        await expect(card(page, "Acme Corp")).toContainText("vip");
        await expect(card(page, "Acme Corp")).toContainText("$2,400.00");
        await expect(card(page, "Acme Corp")).toContainText("3 quotations");
        await expect(card(page, "Hooli")).toContainText("Inactive");
        // customers known only from invoices are still listed
        await expect(card(page, "Globex Ltd")).toContainText("From invoices");
    });

    test("summary tiles come from the records", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        await expect(tile(page, "cm-total")).toHaveText("6");
        // Acme 1000 + Globex 4000 + Latecomer 400, in USD (EUR shown separately)
        await expect(tile(page, "cm-outstanding")).toContainText("$5,400.00");
        await expect(tile(page, "cm-outstanding")).toContainText("€200.00");
        // overdue customers: Acme (A2), Latecomer (L9 due +10 is not overdue) => Acme only; Globex due 0 is not overdue
        await expect(tile(page, "cm-overdue")).toHaveText(/^1/);
        // QS pending + QA accepted-not-invoiced
        await expect(tile(page, "cm-awaiting")).toHaveText("2");
    });

    test("search covers GSTIN, company, tags and notes", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        const search = page.getByRole("searchbox");
        for (const term of [ACME_GSTIN.slice(0, 9), "acme pvt", "vip", "prefers invoices", "asha"]) {
            await search.fill(term);
            await expect(page.getByTestId("client-list").locator("li")).toHaveCount(1);
            await expect(card(page, "Acme Corp")).toBeVisible();
        }
        await search.fill("zzz-no-such");
        await expect(page.getByText("No clients match.")).toBeVisible();
    });

    test("status, category and tag filters, and clearing them", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);

        await page.getByRole("combobox", { name: "Customer status" }).click();
        await page.getByRole("option", { name: "Inactive only", exact: true }).click();
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(1);
        await expect(card(page, "Hooli")).toBeVisible();

        await page.getByTestId("clear-filters").click();
        await page.getByRole("combobox", { name: "Category" }).click();
        await page.getByRole("option", { name: "Retail" }).click();
        await expect(card(page, "Hooli")).toBeVisible();
        await expect(card(page, "Acme Corp")).toHaveCount(0);

        await page.getByTestId("clear-filters").click();
        await page.getByRole("combobox", { name: "Tag" }).click();
        await page.getByRole("option", { name: "vip" }).click();
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(1);
        await expect(card(page, "Acme Corp")).toBeVisible();

        await page.getByTestId("clear-filters").click();
        await expect(page.getByTestId("customer-count")).toContainText("Showing 6 of 6");
    });

    test("financial filters use the real balances", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        await page.getByRole("combobox", { name: "Filter clients" }).click();
        await page.getByRole("option", { name: "With overdue invoices" }).click();
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(1);
        await expect(card(page, "Acme Corp")).toBeVisible();

        await page.getByRole("combobox", { name: "Filter clients" }).click();
        await page.getByRole("option", { name: "Quotations awaiting action" }).click();
        await expect(card(page, "Acme Corp")).toBeVisible();
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(1);
    });
});

/* ======================================================== customer CRUD */

test.describe("customer management", () => {
    const openAdd = async (page: Page) => {
        await page.getByRole("button", { name: "Add client" }).first().click();
        return page.getByRole("dialog");
    };

    test("creates a customer with business details, a GSTIN, a category and tags", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        const d = await openAdd(page);
        await d.getByLabel("Name").fill("Nova Retail");
        await d.getByLabel("Email").fill("hello@nova.test");
        await d.getByLabel("Company").fill("Nova Retail Pvt Ltd");
        await d.getByLabel("Contact person").fill("Dev Patel");
        await d.getByLabel("GSTIN").fill(gstin("07").toLowerCase());
        await d.getByLabel("Category").fill("Retail");
        await d.getByLabel("Tags").fill("new, delhi, NEW");
        await d.getByLabel("Notes").fill("Met at the trade fair");
        await d.getByTestId("save-customer").click();

        await expect(card(page, "Nova Retail")).toBeVisible();
        await expect(card(page, "Nova Retail")).toContainText("Retail");
        await expect(card(page, "Nova Retail")).toContainText("delhi");
        // tags are de-duplicated case-insensitively
        await expect(card(page, "Nova Retail").getByText("new", { exact: true })).toHaveCount(1);

        await page.getByRole("searchbox").fill(gstin("07").slice(0, 8));
        await expect(card(page, "Nova Retail")).toBeVisible();
    });

    test("an invalid GSTIN is refused, with a message", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        const d = await openAdd(page);
        await d.getByLabel("Name").fill("Nova Retail");
        await d.getByLabel("GSTIN").fill("27AAPFU0939F1ZA"); // right shape, wrong check character
        await d.getByTestId("save-customer").click();
        await expect(d.getByRole("alert")).toHaveText("Enter a valid 15-character GSTIN.");
        await expect(card(page, "Nova Retail")).toHaveCount(0);
    });

    test("the same email is refused outright; a look-alike is warned about and can be saved anyway", async ({ page }) => {
        await restore(page, { clients: [profile("Initech Solutions", "i@initech.test", { phone: "9876543210" })] });
        await gotoDir(page);

        // exact: same email => same customer => refused
        let d = await openAdd(page);
        await d.getByLabel("Name").fill("Totally Different Name");
        await d.getByLabel("Email").fill("I@INITECH.test");
        await d.getByTestId("save-customer").click();
        await expect(d.getByRole("alert")).toContainText("already exists");
        await page.keyboard.press("Escape");

        // look-alike: a typo in the name
        d = await openAdd(page);
        await d.getByLabel("Name").fill("Initech Solutons");
        await d.getByLabel("Email").fill("new@initech.test");
        await d.getByTestId("save-customer").click();
        const warn = d.getByTestId("duplicate-warning");
        await expect(warn).toContainText("Initech Solutions");
        await expect(warn).toContainText("very similar name");
        await expect(card(page, "Initech Solutons")).toHaveCount(0);

        // the user decides
        await d.getByTestId("save-customer").click(); // now reads "Save anyway"
        await expect(card(page, "Initech Solutons")).toBeVisible();
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(2);
    });

    test("the same phone number or GSTIN raises a warning too", async ({ page }) => {
        await restore(page, { clients: [profile("Acme Corp", "a@acme.test", { phone: "+91 98765 43210", gstin: ACME_GSTIN })] });
        await gotoDir(page);
        const d = await openAdd(page);
        await d.getByLabel("Name").fill("Branch Office");
        await d.getByLabel("Email").fill("branch@x.test");
        await d.getByLabel("Phone").fill("098765-43210");
        await d.getByLabel("GSTIN").fill(ACME_GSTIN);
        await d.getByTestId("save-customer").click();
        const warn = d.getByTestId("duplicate-warning");
        await expect(warn).toContainText("same phone number");
        await expect(warn).toContainText("same GSTIN");
    });

    test("editing keeps the same customer, and removing a profile keeps their invoices", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        await card(page, "Acme Corp").click();
        await page.getByRole("dialog").getByRole("button", { name: "Edit client" }).click();
        const d = page.getByRole("dialog");
        await expect(d.getByLabel("Company")).toHaveValue("Acme Pvt Ltd");
        await expect(d.getByLabel("Tags")).toHaveValue("vip, north");
        await d.getByLabel("Category").fill("Key account");
        await d.getByTestId("save-customer").click();
        await expect(card(page, "Acme Corp")).toHaveCount(1);
        await expect(card(page, "Acme Corp")).toContainText("Key account");

        // The quick view stays open behind the editor, as it always has; wait for the editor
        // to finish closing, then close the quick view too.
        await expect(page.getByTestId("save-customer")).toBeHidden();
        await expect(page.getByTestId("open-profile")).toBeVisible();
        // (After the editor closes, the first Escape is absorbed by the dialog's own layer.)
        await expect(async () => {
            await page.keyboard.press("Escape");
            await expect(page.getByTestId("open-profile")).toBeHidden({ timeout: 1000 });
        }).toPass({ timeout: 8000 });
        await card(page, "Acme Corp").click();
        await page.getByRole("dialog").getByRole("button", { name: "Remove client" }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "Remove client" }).click();
        // The profile is gone, the customer is not: their invoices still name them.
        await expect(card(page, "Acme Corp")).toContainText("From invoices");
        await expect(card(page, "Acme Corp")).toContainText("$2,400.00");
    });
});

/* ===================================================== duplicates banner */

test.describe("duplicate review", () => {
    test("groups look-alikes with the reasons, and opens a profile", async ({ page }) => {
        await restore(page, {
            clients: [
                profile("Globex Corporation", "g@globex.test"),
                profile("Globex Corporaton", "typo@globex.test"),
                profile("Wayne", "w@wayne.test", { phone: "9123456780" }),
                profile("Bruce", "b@wayne.test", { phone: "09123456780" }),
                profile("Unrelated", "u@x.test"),
            ],
        });
        await gotoDir(page);
        await expect(page.getByTestId("duplicates-banner")).toContainText("2 groups");
        await page.getByTestId("review-duplicates").click();
        const dialog = page.getByTestId("duplicates-dialog");
        await expect(dialog.getByTestId("duplicate-group")).toHaveCount(2);
        await expect(dialog).toContainText("very similar name");
        await expect(dialog).toContainText("same phone number");
        await expect(dialog).not.toContainText("Unrelated");
        await dialog.getByRole("link", { name: "Open profile" }).first().click();
        await expect(page).toHaveURL(/clients\/profile\?key=/);
        await expect(page.getByTestId("customer-profile")).toBeVisible();
    });

    test("no banner when there is nothing to review", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        await expect(page.getByTestId("duplicates-banner")).toHaveCount(0);
    });
});

/* ========================================================= import/export */

const csvFile = (text: string, name = "customers.csv") => ({ name, mimeType: "text/csv", buffer: Buffer.from(text) });

test.describe("import and export", () => {
    test("previews before it writes: new, duplicate, invalid and look-alike rows", async ({ page }) => {
        await restore(page, { clients: [profile("Acme Corp", "buyer@acme.test", { phone: "111" })] });
        await gotoDir(page);
        await page.getByTestId("import-customers").click();
        const dialog = page.getByTestId("import-dialog");
        await dialog.getByTestId("import-file").setInputFiles(
            csvFile(
                [
                    "Name,Email,Phone,GSTIN,Category,Tags",
                    `Nova Retail,hello@nova.test,555-0101,${gstin("07")},Retail,"new; delhi"`,
                    "Acme Corp,BUYER@acme.test,999,,,",
                    "X,x@x.test,,,,",
                    "Bad Email,not-an-email,,,,",
                    "Bad Gstin,g@x.test,,27AAPFU0939F1ZA,,",
                    "Nova Retail Again,HELLO@nova.test,,,,",
                    "Acme Crop,other@acme.test,,,,",
                ].join("\n")
            )
        );
        await expect(dialog.getByTestId("import-count-new")).toHaveText("2"); // Nova + the Acme typo
        await expect(dialog.getByTestId("import-count-skip")).toHaveText("2"); // Acme exists + repeated Nova
        await expect(dialog.getByTestId("import-count-invalid")).toHaveText("3");
        await expect(dialog.getByTestId("import-count-similar")).toHaveText("1");
        await expect(dialog.locator('[data-testid="import-row"][data-outcome="invalid"]')).toHaveCount(3);
        await expect(dialog).toContainText("Not a valid GSTIN");
        await expect(dialog).toContainText("looks like Acme Corp");

        // nothing has been written yet
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(1);

        await page.getByTestId("import-customers").click();
        await page.getByTestId("import-dialog").getByTestId("import-file").setInputFiles(csvFile(`Name,Email,Category\nNova Retail,hello@nova.test,Retail\nZeta,z@z.test,`));
        await page.getByTestId("import-apply").click();
        await expect(card(page, "Nova Retail")).toBeVisible();
        await expect(card(page, "Zeta")).toBeVisible();
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(3);
    });

    test("updating existing customers fills in blanks and keeps what the file leaves empty", async ({ page }) => {
        await restore(page, { clients: [profile("Acme Corp", "buyer@acme.test", { phone: "111", notes: "keep me" })] });
        await gotoDir(page);
        await page.getByTestId("import-customers").click();
        const dialog = page.getByTestId("import-dialog");
        await dialog.getByTestId("import-file").setInputFiles(csvFile("Name,Email,Phone,Category\nAcme Corp,buyer@acme.test,,Wholesale"));
        await dialog.getByRole("combobox", { name: "Customers already in your list" }).click();
        await page.getByRole("option", { name: "Update them from the file" }).click();
        await expect(dialog.getByTestId("import-count-update")).toHaveText("1");
        await dialog.getByTestId("import-apply").click();
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(1);
        await expect(card(page, "Acme Corp")).toContainText("Wholesale");
        await card(page, "Acme Corp").click();
        await expect(page.getByRole("dialog")).toContainText("111"); // phone kept
        await expect(page.getByRole("dialog")).toContainText("keep me"); // notes kept
    });

    test("unusable files are explained, not half-imported", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        await page.getByTestId("import-customers").click();
        const dialog = page.getByTestId("import-dialog");
        await dialog.getByTestId("import-file").setInputFiles(csvFile("Email,Phone\na@x.test,1"));
        await expect(dialog.getByTestId("import-error")).toHaveText("The file needs a Name column.");
        await expect(dialog.getByTestId("import-apply")).toBeDisabled();
        await dialog.getByTestId("import-file").setInputFiles(csvFile(""));
        await expect(dialog.getByTestId("import-error")).toHaveText("The file has no customer rows.");
    });

    test("the template downloads and imports cleanly", async ({ page }) => {
        await page.goto("/en/clients");
        await page.getByRole("button", { name: "Import" }).first().click();
        const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("import-template").click()]);
        expect(dl.suggestedFilename()).toBe("customers-template.csv");
        const text = await (await import("node:fs/promises")).readFile((await dl.path())!, "utf8");
        await page.getByTestId("import-dialog").getByTestId("import-file").setInputFiles(csvFile(text));
        await expect(page.getByTestId("import-count-new")).toHaveText("1");
        await expect(page.getByTestId("import-count-invalid")).toHaveText("0");
    });

    test("an export imports back into an empty workspace unchanged", async ({ page, browser }) => {
        await restore(page, SEED);
        await gotoDir(page);
        const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-customers").click()]);
        expect(dl.suggestedFilename()).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/);
        const text = await (await import("node:fs/promises")).readFile((await dl.path())!, "utf8");
        const lines = text.trim().split(/\r\n/);
        expect(lines[0]).toContain('"Name","Email","Phone","Company"');
        expect(lines).toHaveLength(7); // header + 6 customers
        expect(text).toContain(ACME_GSTIN);
        expect(text).toContain("$2,400.00"); // real invoiced figure, informational

        const fresh = await (await browser.newContext()).newPage();
        await gotoDir(fresh).catch(() => undefined);
        await fresh.goto("/en/clients");
        await fresh.getByRole("button", { name: "Import" }).first().click();
        await fresh.getByTestId("import-dialog").getByTestId("import-file").setInputFiles(csvFile(text));
        await expect(fresh.getByTestId("import-count-new")).toHaveText("6");
        await expect(fresh.getByTestId("import-count-invalid")).toHaveText("0");
        await fresh.getByTestId("import-apply").click();
        await expect(card(fresh, "Acme Corp")).toContainText("Wholesale");
        await expect(card(fresh, "Acme Corp")).toContainText("vip");
        await expect(card(fresh, "Hooli")).toContainText("Inactive");
        await fresh.context().close();
    });
});

/* ====================================================== customer intelligence */

test.describe("customer intelligence", () => {
    test("top customers by revenue, with their share", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        const rows = page.getByTestId("intel-top-row");
        // USD invoiced: Globex 5000, Acme 2400, Initech 300, Latecomer 700, Dormant 400
        await expect(rows.first()).toContainText("Globex Ltd");
        await expect(rows.first()).toContainText("$5,000.00");
        await expect(rows.nth(1)).toContainText("Acme Corp");
        await expect(rows.first()).toContainText(/\d+% of invoiced revenue/);
    });

    test("who owes money, who buys often, and who needs attention", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        const owing = page.getByTestId("intel-owing");
        await expect(owing.getByTestId("intel-owing-row").first()).toContainText("Globex Ltd");
        await expect(owing.getByTestId("intel-owing-row").first()).toContainText("$4,000.00");
        // a customer who has paid everything does not appear
        await expect(owing).not.toContainText("Dormant Co");
        await expect(owing).not.toContainText("Initech");

        await expect(page.getByTestId("intel-frequent")).toContainText("Acme Corp");
        await expect(page.getByTestId("intel-dormant-row")).toContainText("Dormant Co");
        await expect(page.getByTestId("intel-late-row")).toContainText("Latecomer");
    });
});

/* =============================================================== profile */

test.describe("customer profile", () => {
    test("opens from the directory and shows the complete record", async ({ page }) => {
        await restore(page, SEED);
        await gotoDir(page);
        await card(page, "Acme Corp").click();
        await page.getByTestId("open-profile").click();
        await expect(page).toHaveURL(/clients\/profile\?key=buyer%40acme\.test/);
        await expect(page.getByTestId("profile-name")).toHaveText("Acme Corp");

        const details = page.getByTestId("profile-details");
        await expect(details).toContainText("Asha Rao");
        await expect(details).toContainText("buyer@acme.test");
        await expect(details).toContainText("acme.test");
        await expect(details.getByTestId("profile-gstin")).toContainText(ACME_GSTIN);
        await expect(details).toContainText("12 MG Road");
        await expect(details).toContainText("Dock 4"); // shipping address
        await expect(page.getByTestId("profile-notes")).toContainText("Prefers invoices on the 1st");
        await expect(page.getByText("Acme Pvt Ltd").first()).toBeVisible();
        await expect(page.getByText("Wholesale").first()).toBeVisible();
    });

    test("financial overview: invoiced, paid, outstanding, overdue and quotations", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await expect(tile(page, "fo-invoiced")).toHaveText("$2,400.00");
        await expect(tile(page, "fo-paid")).toHaveText("$1,400.00");
        await expect(tile(page, "fo-outstanding")).toHaveText("$1,000.00");
        await expect(tile(page, "fo-overdue")).toHaveText("$500.00");
        await expect(tile(page, "fo-quotes")).toHaveText("3");
        await expect(tile(page, "fo-accepted")).toHaveText("$3,000.00");
        // draft (999) and cancelled (777) invoices are not in any of it
        await expect(page.getByTestId("financial-overview")).not.toContainText("999");
    });

    test("another currency is shown separately, never added in", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await page.getByRole("combobox", { name: "Currency" }).click();
        await page.getByRole("option", { name: "EUR" }).click();
        await expect(tile(page, "fo-invoiced")).toHaveText("€200.00");
        await expect(tile(page, "fo-paid")).toHaveText("€0.00");
        await expect(tile(page, "fo-outstanding")).toHaveText("€200.00");
    });

    test("payment behaviour, frequency and insights come from the records", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        // Acme has two fully paid invoices, both before their due dates.
        await expect(page.getByTestId("beh-ontime")).toHaveText("100%");
        await expect(page.getByText("Pays on time").first()).toBeVisible();
        await expect(page.getByTestId("freq-year")).toHaveText("5"); // A0-A3 and the EUR invoice A6

        const insights = page.getByTestId("profile-insights");
        const overdue = insights.locator('[data-insight="overdue"]');
        await expect(overdue).toContainText("1 invoice is overdue");
        await expect(overdue).toContainText("$500.00");
        await expect(overdue).toContainText("10 days past due");
        await expect(insights.locator('[data-insight="paysOnTime"]')).toBeVisible();
        await expect(insights.locator('[data-insight="acceptedNotInvoiced"]')).toContainText("QA");
        await expect(insights.locator('[data-insight="acceptedNotInvoiced"]')).toContainText("$3,000.00");
        await expect(insights.locator('[data-insight="quotesExpiring"]')).toContainText("1 quotation expires");
    });

    test("a customer without enough history is not given a payment label", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "pay@initech.test");
        await expect(page.getByTestId("behaviour-unknown")).toContainText("at least 2 fully paid invoices");
    });

    test("a late payer is identified from how late they actually pay", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "l@late.test");
        await expect(page.getByTestId("beh-ontime")).toHaveText("0%");
        await expect(page.getByText("Usually late").first()).toBeVisible();
        await expect(page.getByTestId("profile-insights").locator('[data-insight="paysLate"]')).toContainText("15 days after the due date");
    });

    test("the documents tab lists invoices and quotations with their status", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "documents");
        const invoices = page.getByTestId("doc-invoice");
        await expect(invoices).toHaveCount(7);
        await expect(invoices.filter({ hasText: "A2" })).toContainText("Overdue");
        await expect(invoices.filter({ hasText: "A3" })).toContainText("Partially paid");
        await expect(invoices.filter({ hasText: "A1" })).toContainText("Paid");
        await expect(invoices.filter({ hasText: "A4" })).toContainText("Draft");
        const quotes = page.getByTestId("doc-quotation");
        await expect(quotes).toHaveCount(3);
        await expect(quotes.filter({ hasText: "QA" })).toContainText("Accepted");
        await expect(quotes.filter({ hasText: "QS" })).toContainText("Expires in 3 day(s)");
    });

    test("the activity timeline records what actually happened, newest first", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "activity");
        const events = page.getByTestId("timeline-event");
        await expect(events.filter({ hasText: "Invoice A2 became overdue" })).toHaveCount(1);
        await expect(events.filter({ hasText: "Payment of $300.00 received on A3" })).toHaveCount(1);
        await expect(events.filter({ hasText: "Invoice A1 issued" })).toHaveCount(1);
        await expect(events.filter({ hasText: "Quotation QA accepted" })).toHaveCount(1);
        await expect(events.filter({ hasText: "Quotation QS sent" })).toHaveCount(1);
        await expect(events.filter({ hasText: "Added to your address book" })).toHaveCount(1);
        // drafts and cancelled invoices are not events
        await expect(page.getByTestId("timeline")).not.toContainText("A4");
        await expect(page.getByTestId("timeline")).not.toContainText("A5");
        // newest first: the A3 payment (day -5) comes before the A1 payment (day -40)
        const text = await page.getByTestId("timeline").innerText();
        expect(text.indexOf("received on A3")).toBeLessThan(text.indexOf("received on A1"));
    });

    test("an unknown customer says so", async ({ page }) => {
        await restore(page, SEED);
        await page.goto("/en/clients/profile?key=nobody%40nowhere.test");
        await expect(page.getByTestId("profile-missing")).toBeVisible();
    });

    test("marking a customer inactive is reflected everywhere", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await page.getByTestId("toggle-active").click();
        await expect(page.getByText("Inactive").first()).toBeVisible();
        await gotoDir(page);
        await expect(card(page, "Acme Corp")).toContainText("Inactive");
        await page.getByRole("combobox", { name: "Customer status" }).click();
        await page.getByRole("option", { name: "Active only", exact: true }).click();
        await expect(card(page, "Acme Corp")).toHaveCount(0);
    });

    test("a customer known only from invoices can be saved to the address book from the profile", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "ap@globex.test");
        await expect(page.getByText("From invoices").first()).toBeVisible();
        await page.getByTestId("qa-edit").click();
        const d = page.getByRole("dialog");
        await d.getByLabel("Category").fill("Enterprise");
        await d.getByTestId("save-customer").click();
        await expect(page.getByText("Enterprise").first()).toBeVisible();
        await gotoDir(page);
        await expect(card(page, "Globex Ltd")).toHaveCount(1);
        await expect(card(page, "Globex Ltd")).not.toContainText("From invoices");
    });
});

/* ============================================================ quick actions */

test.describe("quick actions", () => {
    test("a new invoice starts with the customer, including their GSTIN", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await page.getByTestId("qa-invoice").click();
        await expect(page).toHaveURL(/\/en\/?(\?.*)?$/);
        await page.waitForTimeout(1200);
        await page.goto("/en?step=from-and-to");
        await expect(page.locator('input[name="receiver.name"]')).toHaveValue("Acme Corp");
        await expect(page.locator('input[name="receiver.gstin"]')).toHaveValue(ACME_GSTIN);
    });

    test("a new quotation starts with the customer", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await page.getByTestId("qa-quotation").click();
        await expect(page).toHaveURL(/quotations\/builder\?customer=/);
        await expect(page.locator('input[name="receiver.name"]')).toHaveValue("Acme Corp");
        await expect(page.locator('input[name="receiver.gstin"]')).toHaveValue(ACME_GSTIN);
    });

    test("the statement and documents shortcuts switch tabs", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await page.getByTestId("qa-statement").click();
        await expect(page.getByTestId("statement-panel")).toBeVisible();
        await page.getByTestId("qa-documents").click();
        await expect(page.getByTestId("documents-invoices")).toBeVisible();
    });

    test("recording a payment splits it across open invoices, oldest due first", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await page.getByTestId("qa-payment").click();
        const dialog = page.getByTestId("record-payment");
        await expect(dialog.getByTestId("pay-owed")).toContainText("$1,000.00 owed across 2 open invoices");

        await dialog.locator('input[name="amount"]').fill("700");
        const allocations = dialog.getByTestId("allocation");
        await expect(allocations).toHaveCount(2);
        // A2 (due 10 days ago) first, in full; the rest to A3
        await expect(allocations.nth(0)).toContainText("A2");
        await expect(allocations.nth(0)).toContainText("$500.00");
        await expect(allocations.nth(0)).toContainText("settles it");
        await expect(allocations.nth(1)).toContainText("A3");
        await expect(allocations.nth(1)).toContainText("$200.00");
        await expect(allocations.nth(1)).toContainText("leaves $300.00");

        await dialog.getByTestId("submit-payment").click();
        await expect(page.getByText("Payment recorded").first()).toBeVisible();
        await expect(tile(page, "fo-paid")).toHaveText("$2,100.00");
        await expect(tile(page, "fo-outstanding")).toHaveText("$300.00");
        // A2 was the only overdue invoice and is now settled
        await expect(tile(page, "fo-overdue")).toHaveText("$0.00");

        await page.getByRole("tab", { name: "Documents" }).click();
        await expect(page.getByTestId("doc-invoice").filter({ hasText: "A2" })).toContainText("Paid");
        await expect(page.getByTestId("doc-invoice").filter({ hasText: "A3" })).toContainText("Partially paid");
    });

    test("a payment can be aimed at one invoice", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await page.getByTestId("qa-payment").click();
        const dialog = page.getByTestId("record-payment");
        await dialog.getByRole("combobox", { name: "Apply to" }).click();
        await page.getByRole("option", { name: /^A3/ }).click();
        await dialog.locator('input[name="amount"]').fill("500");
        await expect(dialog.getByTestId("allocation")).toHaveCount(1);
        await dialog.getByTestId("submit-payment").click();
        await expect(tile(page, "fo-outstanding")).toHaveText("$500.00");
        await expect(tile(page, "fo-overdue")).toHaveText("$500.00"); // A2 untouched
    });

    test("paying more than is owed is refused and nothing changes", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await page.getByTestId("qa-payment").click();
        const dialog = page.getByTestId("record-payment");
        await dialog.locator('input[name="amount"]').fill("1000.01");
        await dialog.getByTestId("submit-payment").click();
        await expect(dialog.getByRole("alert")).toContainText("more than is owed ($1,000.00)");
        await page.keyboard.press("Escape");
        await expect(tile(page, "fo-outstanding")).toHaveText("$1,000.00");
        await expect(tile(page, "fo-paid")).toHaveText("$1,400.00");
    });

    test("a payment dated before an invoice was issued is refused, all or nothing", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await page.getByTestId("qa-payment").click();
        const dialog = page.getByTestId("record-payment");
        await dialog.locator('input[name="amount"]').fill("700");
        await dialog.locator('input[name="date"]').fill(isoDay(-45)); // A2 was issued 40 days ago
        await dialog.getByTestId("submit-payment").click();
        await expect(dialog.getByRole("alert")).toContainText("A2:");
        await page.keyboard.press("Escape");
        await expect(tile(page, "fo-paid")).toHaveText("$1,400.00");
        await expect(tile(page, "fo-outstanding")).toHaveText("$1,000.00");
    });

    test("a customer who owes nothing cannot be sent a payment form", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "pay@initech.test");
        await expect(page.getByTestId("qa-payment")).toBeDisabled();
    });
});

/* ============================================================== statements */

const fy = (n: number) => isoDay(n);

test.describe("customer statements", () => {
    test("the whole history: balances, rows and ageing add up", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "statement");
        await expect(tile(page, "st-opening")).toHaveText("$0.00");
        await expect(tile(page, "st-invoiced")).toHaveText("$2,400.00");
        await expect(tile(page, "st-paid")).toHaveText("$1,400.00");
        await expect(tile(page, "st-closing")).toHaveText("$1,000.00");
        await expect(page.getByTestId("statement-closing-row")).toHaveText("$1,000.00");

        // 5 issued invoices in USD (A0,A1,A2,A3 = 4 invoices) + 3 payments (A0,A1,A3) = 7 rows
        await expect(page.getByTestId("statement-row")).toHaveCount(7);
        await expect(page.locator('[data-testid="statement-row"][data-kind="invoice"]')).toHaveCount(4);
        await expect(page.locator('[data-testid="statement-row"][data-kind="payment"]')).toHaveCount(3);
        // never the draft, the cancelled invoice or the other currency
        const table = page.getByTestId("statement-table");
        for (const no of ["A4", "A5", "A6"]) await expect(table).not.toContainText(no);

        const open = page.getByTestId("open-item");
        await expect(open).toHaveCount(2);
        await expect(open.filter({ hasText: "A2" })).toContainText("$500.00");
        await expect(open.filter({ hasText: "A2" })).toContainText("10"); // days overdue
        await expect(open.filter({ hasText: "A3" })).toContainText("$500.00");
        const aging = page.getByTestId("statement-aging");
        await expect(aging).toContainText("$500.00");
    });

    test("a date range starts from the right opening balance", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "statement");
        await page.getByRole("combobox", { name: "Period" }).click();
        await page.getByRole("option", { name: "Custom range" }).click();
        await page.locator('input[type="date"]').first().fill(fy(-45));
        await page.locator('input[type="date"]').nth(1).fill(fy(-1));

        // before day -45: A0 invoiced and paid (net 0) + A1 invoiced 1000
        await expect(tile(page, "st-opening")).toHaveText("$1,000.00");
        // in range: A2 500 + A3 800 invoiced; A1 1000 + A3 300 paid
        await expect(tile(page, "st-invoiced")).toHaveText("$1,300.00");
        await expect(tile(page, "st-paid")).toHaveText("$1,300.00");
        await expect(tile(page, "st-closing")).toHaveText("$1,000.00");
        await expect(page.getByTestId("statement-row")).toHaveCount(4);
        await expect(page.getByTestId("statement-opening-row")).toContainText("$1,000.00");
    });

    test("a range with nothing in it shows the balance carried forward", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "statement");
        await page.getByRole("combobox", { name: "Period" }).click();
        await page.getByRole("option", { name: "Custom range" }).click();
        await page.locator('input[type="date"]').first().fill(fy(-95));
        await page.locator('input[type="date"]').nth(1).fill(fy(-90));
        await expect(page.getByTestId("statement-no-rows")).toBeVisible();
        // A0 is invoiced (100) and was paid on day -100, so by day -95 nothing is owed
        await expect(tile(page, "st-opening")).toHaveText("$0.00");
        await expect(tile(page, "st-closing")).toHaveText("$0.00");
    });

    test("a reversed range is rejected and cannot be exported", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "statement");
        await page.getByRole("combobox", { name: "Period" }).click();
        await page.getByRole("option", { name: "Custom range" }).click();
        // the pickers constrain each other, so set the end first, then a later start
        await page.locator('input[type="date"]').nth(1).fill(fy(-50));
        await page.locator('input[type="date"]').first().evaluate((el: HTMLInputElement, v) => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            set.call(el, v);
            el.dispatchEvent(new Event("input", { bubbles: true }));
        }, fy(-10));
        await expect(page.getByText("The start date must be on or before the end date.")).toBeVisible();
        await expect(page.getByTestId("statement-csv")).toBeDisabled();
        await expect(page.getByTestId("statement-pdf")).toBeDisabled();
    });

    test("the financial-year and month presets work", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "statement");
        for (const name of ["This month", "Last 3 months", "This financial year (Apr–Mar)", "This calendar year", "All time"]) {
            await page.getByRole("combobox", { name: "Period" }).click();
            await page.getByRole("option", { name }).click();
            await expect(page.getByTestId("statement-opening-row")).toBeVisible();
        }
        // whatever the period, the closing balance is today's balance when the end is today
        await expect(tile(page, "st-closing")).toHaveText("$1,000.00");
    });

    test("another currency has its own statement", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "statement");
        await page.getByRole("combobox", { name: "Currency" }).click();
        await page.getByRole("option", { name: "EUR" }).click();
        await expect(tile(page, "st-invoiced")).toHaveText("€200.00");
        await expect(tile(page, "st-closing")).toHaveText("€200.00");
        await expect(page.getByTestId("statement-row")).toHaveCount(1);
    });

    test("recording a payment changes the statement", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page);
        await page.getByTestId("qa-payment").click();
        await page.getByTestId("record-payment").locator('input[name="amount"]').fill("1000");
        await page.getByTestId("submit-payment").click();
        await page.getByRole("tab", { name: "Statement" }).click();
        await expect(tile(page, "st-closing")).toHaveText("$0.00");
        await expect(tile(page, "st-paid")).toHaveText("$2,400.00");
        await expect(page.getByTestId("open-item")).toHaveCount(0);
    });

    test("the CSV export matches the screen", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "statement");
        const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("statement-csv").click()]);
        expect(dl.suggestedFilename()).toMatch(/^statement-Acme_Corp-USD-start_to_\d{4}-\d{2}-\d{2}\.csv$/);
        const text = await (await import("node:fs/promises")).readFile((await dl.path())!, "utf8");
        const lines = text.trim().split(/\r\n/);
        expect(lines[0]).toBe('"Date","Type","Reference","Description","Debit","Credit","Balance","Currency"');
        expect(lines).toHaveLength(1 + 1 + 7 + 1); // header, opening, 7 rows, closing
        expect(lines[1]).toContain("Opening balance");
        expect(lines.at(-1)).toContain("Closing balance");
        expect(lines.at(-1)).toContain('"1000"');
        for (const no of ["A0", "A1", "A2", "A3"]) expect(text).toContain(no);
        for (const no of ["A4", "A5", "A6"]) expect(text).not.toContain(no);
    });

    test("the PDF downloads as a real statement", async ({ page }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "statement");
        const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("statement-pdf").click()]);
        expect(dl.suggestedFilename()).toMatch(/^statement-Acme_Corp-USD-start_to_\d{4}-\d{2}-\d{2}\.pdf$/);
        const bytes = await (await import("node:fs/promises")).readFile((await dl.path())!);
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        expect(bytes.length).toBeGreaterThan(5000);
    });

    test("print opens the statement PDF in a new tab", async ({ page, context }) => {
        await restore(page, SEED);
        await gotoProfile(page, "buyer@acme.test", "statement");
        const [popup] = await Promise.all([context.waitForEvent("page"), page.getByTestId("statement-print").click()]);
        expect(popup).toBeTruthy();
        await popup.close();
    });

    test("a customer with no issued invoices has no statement to show", async ({ page }) => {
        await restore(page, { clients: [profile("Newbie", "n@new.test")], invoices: [inv({ number: "N1", client: "Newbie", email: "n@new.test", issued: -2, due: 28, total: 50, status: "draft" })] });
        await gotoProfile(page, "n@new.test", "statement");
        await expect(page.getByTestId("statement-empty")).toBeVisible();
    });
});

test.describe("statement PDF endpoint", () => {
    const payload = () => ({
        generatedAt: "2026-06-15",
        business: { name: "Sharma Traders", address: "12 MG Road", city: "Mumbai", country: "India", gstin: gstin("29", "AABCT1332L") },
        customer: { name: "Acme Corp", email: "buyer@acme.test" },
        statement: {
            currency: "USD",
            from: null,
            to: "2026-06-15",
            opening: 0,
            closing: 700,
            totals: { invoiced: 1000, paid: 300 },
            rows: [
                { date: "2026-05-01", kind: "invoice", ref: "A1", description: "", debit: 1000, credit: 0, balance: 1000 },
                { date: "2026-05-20", kind: "payment", ref: "A1", description: "bank", debit: 0, credit: 300, balance: 700 },
            ],
            openItems: [{ number: "A1", date: "2026-05-01", due: "2026-05-31", total: 1000, paid: 300, balance: 700, daysOverdue: 15 }],
            aging: { current: 0, d1_30: 700, d31_60: 0, d61_90: 0, d90plus: 0 },
        },
    });

    test("renders a valid statement", async ({ request }) => {
        const res = await request.post("/api/statement/generate?locale=en", { data: payload() });
        expect(res.status(), await res.text().catch(() => "")).toBe(200);
        expect(res.headers()["content-type"]).toBe("application/pdf");
        const buf = await res.body();
        expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
        expect(buf.length).toBeGreaterThan(5000);
    });

    test("renders an empty and a credit-balance statement", async ({ request }) => {
        const empty = payload();
        empty.statement.rows = [];
        empty.statement.openItems = [];
        expect((await request.post("/api/statement/generate", { data: empty })).status()).toBe(200);
        const credit = payload();
        credit.statement.closing = -50;
        expect((await request.post("/api/statement/generate", { data: credit })).status()).toBe(200);
    });

    test("refuses malformed, oversize and unsafe input", async ({ request }) => {
        const post = (data: unknown) => request.post("/api/statement/generate", { data });
        expect((await post({})).status()).toBe(400);
        const bad = payload();
        (bad.statement.rows[0] as { kind: string }).kind = "refund";
        expect((await post(bad)).status()).toBe(400);
        const many = payload();
        many.statement.rows = Array(2001).fill(many.statement.rows[0]);
        expect((await post(many)).status()).toBe(400);
        const logo = { ...payload(), logo: "http://169.254.169.254/latest/meta-data" };
        expect((await post(logo)).status()).toBe(400);
        const date = payload();
        date.generatedAt = "yesterday";
        expect((await post(date)).status()).toBe(400);
    });
});

/* ================================================== relationships & backup */

test.describe("invoice, quotation and customer relationships", () => {
    test("converting a quotation never creates a customer", async ({ page }) => {
        await restore(page, { clients: [profile("Acme Corp", "buyer@acme.test")], quotations: [quote("qa", "QA", "accepted", "Acme Corp", "buyer@acme.test", { total: 3000 })] });
        await gotoDir(page);
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(1);

        await page.goto("/en/quotations");
        await page.locator('[data-testid="quotation-row"][data-number="QA"]:visible').getByTestId("convert").click();
        await page.getByRole("alertdialog").getByTestId("confirm-convert").click();
        await expect(page.locator('[data-testid="quotation-row"][data-number="QA"]:visible').getByTestId("invoiced-badge")).toBeVisible();

        await gotoDir(page);
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(1);
        await expect(card(page, "Acme Corp")).toContainText("1"); // the new draft invoice counts as one

        // and the conversion shows up in this customer's story
        await gotoProfile(page, "buyer@acme.test", "activity");
        await expect(page.getByTestId("timeline-event").filter({ hasText: "Quotation QA converted to invoice" })).toHaveCount(1);
        await page.getByRole("tab", { name: "Documents" }).click();
        await expect(page.getByTestId("doc-invoice")).toHaveCount(1);
        await expect(page.getByTestId("doc-invoice")).toContainText("from QA");
    });

    test("a customer appears from quotations alone, and the profile reflects them", async ({ page }) => {
        await restore(page, { quotations: [quote("q1", "Q1", "sent", "Quote Only Ltd", "q@only.test", { total: 800, validIn: 20 })] });
        await gotoDir(page);
        await expect(card(page, "Quote Only Ltd")).toBeVisible();
        await expect(card(page, "Quote Only Ltd")).toContainText("1 quotation");
        await gotoProfile(page, "q@only.test");
        await expect(tile(page, "fo-quotes")).toHaveText("1");
        await expect(tile(page, "fo-invoiced")).toHaveText("$0.00");
    });

    test("picking a customer on an invoice brings their GSTIN, and saving the invoice's client keeps their CRM fields", async ({ page }) => {
        await restore(page, { clients: [profile("Acme Corp", "buyer@acme.test", { gstin: ACME_GSTIN, category: "Wholesale", tags: ["vip"] })] });
        await page.goto("/en?step=from-and-to");
        await page.getByRole("button", { name: /^clients/i }).click();
        await page.getByRole("option", { name: /Acme Corp/ }).or(page.getByRole("button", { name: /Acme Corp/ })).first().click();
        await expect(page.locator('input[name="receiver.gstin"]')).toHaveValue(ACME_GSTIN);

        // Saving this client again (as the invoice form does) must not wipe the category or tags.
        await page.locator('input[name="receiver.phone"]').fill("555-9999");
        await page.getByRole("button", { name: /save client/i }).first().click();
        await gotoDir(page);
        await expect(card(page, "Acme Corp")).toContainText("Wholesale");
        await expect(card(page, "Acme Corp")).toContainText("vip");
    });
});

test.describe("backup compatibility", () => {
    test("CRM fields survive a backup and a restore", async ({ page }) => {
        await restore(page, SEED);
        await page.goto("/en/settings");
        const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).first().click()]);
        const text = await (await import("node:fs/promises")).readFile((await dl.path())!, "utf8");
        const json = JSON.parse(text);
        const acme = json.data.clients.find((c: { name: string }) => c.name === "Acme Corp");
        expect(acme).toMatchObject({ category: "Wholesale", tags: ["vip", "north"], company: "Acme Pvt Ltd", contactPerson: "Asha Rao", gstin: ACME_GSTIN });
        expect(json.data.clients.find((c: { name: string }) => c.name === "Hooli").inactive).toBe(true);

        // into a fresh workspace
        const fresh = await page.context().browser()!.newContext();
        const p2 = await fresh.newPage();
        await p2.goto("/en/settings");
        await p2.getByTestId("backup-file").setInputFiles({ name: "b.json", mimeType: "application/json", buffer: Buffer.from(text) });
        await p2.getByRole("button", { name: "Restore", exact: true }).click();
        await expect(p2.getByText("Backup restored", { exact: true }).first()).toBeVisible();
        await gotoDir(p2);
        await expect(card(p2, "Acme Corp")).toContainText("Wholesale");
        await expect(card(p2, "Acme Corp")).toContainText("$2,400.00");
        await expect(card(p2, "Hooli")).toContainText("Inactive");
        await fresh.close();
    });

    test("a backup from before the CRM fields existed restores, and those customers are active", async ({ page }) => {
        await page.goto("/en/settings");
        const old = {
            format: "invoify-backup",
            version: 2,
            data: { invoices: [], clients: [{ id: "old-1", name: "Old Client", email: "old@x.test", phone: "1", address: "a", zipCode: "1", city: "c", country: "x", customInputs: [] }], senders: [], templates: [], settings: null },
        };
        await page.getByTestId("backup-file").setInputFiles({ name: "old.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(old)) });
        await page.getByRole("button", { name: "Restore", exact: true }).click();
        await expect(page.getByText("Backup restored", { exact: true }).first()).toBeVisible();
        await gotoDir(page);
        await expect(card(page, "Old Client")).toBeVisible();
        await expect(card(page, "Old Client")).not.toContainText("Inactive");
        await page.getByRole("combobox", { name: "Customer status" }).click();
        await page.getByRole("option", { name: "Active only", exact: true }).click();
        await expect(card(page, "Old Client")).toBeVisible();
    });

    test("restoring the same backup twice does not duplicate customers", async ({ page }) => {
        await restore(page, SEED);
        await restore(page, SEED);
        await gotoDir(page);
        await expect(page.getByTestId("client-list").locator("li")).toHaveCount(6);
    });
});

/* ============================================================= responsive */

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
                // Content inside a horizontally scrollable region is meant to extend past the edge.
                for (let a = el.parentElement; a; a = a.parentElement) {
                    const ax = getComputedStyle(a).overflowX;
                    if (ax === "auto" || ax === "scroll") return;
                }
                const r = el.getBoundingClientRect();
                if (r.width && r.right > w + 1) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} +${Math.round(r.right - w)}`);
            });
            return { w, scroll: document.documentElement.scrollWidth, bad: bad.slice(0, 4) };
        });

    for (const width of WIDTHS) {
        test(`directory and profile fit at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await restore(page, SEED);

            await gotoDir(page);
            let o = await overflow(page);
            expect(o.scroll, `directory overflow at ${width}: ${JSON.stringify(o.bad)}`).toBeLessThanOrEqual(o.w);
            expect(o.bad).toEqual([]);

            for (const tab of ["overview", "documents", "statement", "activity"]) {
                await gotoProfile(page, "buyer@acme.test", tab);
                await page.waitForTimeout(250);
                o = await overflow(page);
                expect(o.scroll, `profile ${tab} overflow at ${width}: ${JSON.stringify(o.bad)}`).toBeLessThanOrEqual(o.w);
                expect(o.bad).toEqual([]);
            }
        });
    }

    test("the dialogs fit a phone", async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 700 });
        await restore(page, SEED);
        await gotoDir(page);
        await page.getByRole("button", { name: "Add client" }).first().click();
        let o = await overflow(page);
        expect(o.scroll).toBeLessThanOrEqual(o.w);
        await page.keyboard.press("Escape");

        await page.getByTestId("import-customers").click();
        await page.getByTestId("import-dialog").getByTestId("import-file").setInputFiles(csvFile("Name,Email\nA B,a@b.test\nC D,c@d.test"));
        o = await overflow(page);
        expect(o.scroll).toBeLessThanOrEqual(o.w);
        await page.keyboard.press("Escape");

        await gotoProfile(page);
        await page.getByTestId("qa-payment").click();
        await page.getByTestId("record-payment").locator('input[name="amount"]').fill("700");
        o = await overflow(page);
        expect(o.scroll).toBeLessThanOrEqual(o.w);
    });
});
