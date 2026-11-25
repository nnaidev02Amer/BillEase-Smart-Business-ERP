import { test, expect } from "@playwright/test";

import { loadBundled } from "./bundle";

/**
 * Fix 1 (email half): the outgoing invoice e-mail carries a text BillEase
 * wordmark, not a hosted image. The header must work in a client that blocks
 * remote images, and must not carry the old product's name.
 */

// The same call the mail service makes: render(SendPdfEmail({ invoiceNumber })).
const { renderEmail } = loadBundled<{ renderEmail: (invoiceNumber: string) => string }>(`
    import { render } from "@react-email/render";
    import SendPdfEmail from "./app/components/templates/email/SendPdfEmail";
    export const renderEmail = (invoiceNumber: string) => render(SendPdfEmail({ invoiceNumber }));
`);

const html = (invoiceNumber = "INV-0042") => renderEmail(invoiceNumber);
const text = (invoiceNumber?: string) =>
    html(invoiceNumber)
        .replace(/<[^>]*>/g, " ")
        .replace(/&#x27;|&apos;/g, "'")
        .replace(/\s+/g, " ");

test.describe("invoice e-mail header", () => {
    test("opens with a text BillEase wordmark in the brand colour", () => {
        const out = html();
        expect(out).toMatch(/<p[^>]*color:\s*#4F46E5[^>]*>\s*BillEase\s*<\/p>/i);
    });

    test("uses no image at all, so nothing depends on a hosted file or on images being allowed", () => {
        const out = html();
        expect(out).not.toMatch(/<img\b/i);
        expect(out).not.toMatch(/https?:\/\/[^"'\s]+\.(png|jpe?g|gif|svg|webp)/i);
    });

    test("greets and signs as BillEase, and never as the project it was built on", () => {
        const t = text();
        expect(t).toContain("Thanks for using BillEase!");
        expect(t).toContain("BillEase Team");
        expect(t).not.toMatch(/invoify/i);
    });

    test("names the invoice in the preview line and in the body", () => {
        const out = html("INV-0042");
        expect(out).toContain("Your invoice #INV-0042 is ready for download");
        expect(text("INV-0042")).toMatch(/invoice #INV-0042 is ready for download/);
    });

    test("an invoice number cannot inject markup into the message", () => {
        const out = html("<script>alert(1)</script>");
        expect(out).not.toContain("<script>");
        expect(out).toContain("&lt;script&gt;");
    });
});
