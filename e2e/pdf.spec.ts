import { test, expect } from "@playwright/test";

import { invoice } from "./fixtures";

/**
 * PDF output through the real endpoint: paper sizes, the new designer fields,
 * and the server-side validation that guards the renderer.
 */

const base = () => {
    const inv = invoice("PDF-1", "Acme Corp", "billing@acme.test", 1000, { status: "sent", issued: -5, due: 25 });
    return JSON.parse(JSON.stringify(inv));
};

/** The first page's MediaBox, in PDF points (1/72 inch). */
const mediaBox = (pdf: Buffer): number[] => {
    const m = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString("latin1"));
    if (!m) throw new Error("no MediaBox found");
    return m.slice(1).map(Number);
};

const generate = (request: import("@playwright/test").APIRequestContext, body: unknown) =>
    request.post("/api/invoice/generate?locale=en", { data: body, headers: { "Content-Type": "application/json" } });

test.describe("PDF generation", () => {
    for (const [paper, w, h] of [
        ["a4", 595, 842],
        ["letter", 612, 792],
        ["legal", 612, 1008],
    ] as const) {
        test(`${paper} paper produces a ${w}x${h}pt page`, async ({ request }) => {
            const body = base();
            body.details.theme = { accentColor: "#4F46E5", fontId: "outfit", density: "comfortable", paper };
            const res = await generate(request, body);
            expect(res.status()).toBe(200);
            expect(res.headers()["content-type"]).toBe("application/pdf");
            const buf = await res.body();
            expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
            const [, , width, height] = mediaBox(buf);
            // Chromium rounds A4 to 595.x/596 by a hair; a point either way is the same page.
            expect(Math.abs(width - w)).toBeLessThanOrEqual(1);
            expect(Math.abs(height - h)).toBeLessThanOrEqual(1);
        });
    }

    test("every new designer field renders without breaking the document", async ({ request }) => {
        const body = base();
        Object.assign(body.details, {
            terms: "Late payments incur 2% monthly interest.",
            paymentInstructions: "Quote PDF-1 when paying.",
            payments: [{ id: "p1", date: new Date().toISOString().slice(0, 10), amount: 400, method: "bank" }],
            theme: { accentColor: "#0F766E", fontId: "sourceSerif", density: "compact", paper: "letter", headerText: "ACME LTD · Reg 12345", footerText: "Thank you for your business" },
        });
        body.receiver.shippingAddress = { address: "9 Dock Road", zipCode: "99999", city: "Harbour", country: "Testland" };
        const res = await generate(request, body);
        expect(res.status()).toBe(200);
        expect((await res.body()).byteLength).toBeGreaterThan(5_000);
    });

    test("a different paper size is not served from the cache of another", async ({ request }) => {
        const a = base();
        a.details.theme = { paper: "a4" };
        const b = base();
        b.details.theme = { paper: "legal" };
        const [ra, rb] = [await (await generate(request, a)).body(), await (await generate(request, b)).body()];
        expect(Math.round(mediaBox(ra)[3])).toBe(842);
        expect(Math.round(mediaBox(rb)[3])).toBe(1008);
    });
});

test.describe("PDF request validation", () => {
    test("rejects an unknown paper size", async ({ request }) => {
        const body = base();
        body.details.theme = { paper: "tabloid" };
        expect((await generate(request, body)).status()).toBe(400);
    });

    test("rejects a malformed invoice", async ({ request }) => {
        const body = base();
        delete body.receiver;
        expect((await generate(request, body)).status()).toBe(400);
        expect((await generate(request, "not an invoice")).status()).toBe(400);
    });

    test("rejects a logo that is a remote URL (server-side fetch)", async ({ request }) => {
        const body = base();
        body.details.invoiceLogo = "http://169.254.169.254/latest/meta-data/";
        expect((await generate(request, body)).status()).toBe(400);
    });

    test("rejects oversized free text", async ({ request }) => {
        const body = base();
        body.details.terms = "x".repeat(2001);
        expect((await generate(request, body)).status()).toBe(400);
    });

    test("a due date before the invoice date is refused", async ({ request }) => {
        const body = base();
        body.details.dueDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
        body.details.invoiceDate = new Date().toISOString();
        expect((await generate(request, body)).status()).toBe(400);
    });
});

test.describe("secrets", () => {
    test("mail credentials are not present in any client bundle or page", async ({ request }) => {
        const home = await (await request.get("/en")).text();
        expect(home).not.toMatch(/NODEMAILER_PW|NODEMAILER_EMAIL/);
        // Every script the page loads.
        const scripts = [...home.matchAll(/\/_next\/static\/[^"']+\.js/g)].map((m) => m[0]);
        expect(scripts.length).toBeGreaterThan(0);
        for (const src of new Set(scripts)) {
            const js = await (await request.get(src)).text();
            expect(js, src).not.toMatch(/NODEMAILER_PW|NODEMAILER_EMAIL/);
        }
    });
});
