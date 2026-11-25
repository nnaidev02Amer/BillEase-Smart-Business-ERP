import { readSecure, writeSecure } from "@/lib/secureStore";
import { incrementInvoiceNumber, nextInvoiceNumber } from "@/lib/invoiceNumber";
import { GST_STATES, normaliseGstin } from "@/lib/gst";
import { stripControlChars } from "@/lib/schemas";
import type { InvoiceType } from "@/types";

/**
 * App preferences, kept in the same encrypted browser store as everything else.
 * Every field is validated on read, because this is user-editable storage that
 * an older build — or a restored backup — may have written.
 */
export const SETTINGS_KEY = "invoify:settings";

export type NumberingSettings = {
    /**
     * "auto" keeps the original behaviour: continue whatever pattern the latest
     * saved invoice used. "custom" generates numbers from the scheme below.
     */
    mode: "auto" | "custom";
    prefix: string;
    separator: string;
    includeYear: boolean;
    padding: number;
    start: number;
};

/**
 * "My business": who the buyer is on purchase documents. The GSTIN and state
 * decide whether a purchase is intra-state (CGST + SGST) or inter-state (IGST),
 * and the rest fills the "from" block of a purchase order PDF.
 */
export type BusinessProfile = {
    name: string;
    address: string;
    city: string;
    zipCode: string;
    country: string;
    email: string;
    phone: string;
    gstin: string;
    /** GST state code ("27"), or "" to derive it from the GSTIN. */
    state: string;
};

/** Number prefixes for purchase documents: PO-0001, GRN-0001, PB-0001. */
export type PurchaseSettings = {
    poPrefix: string;
    grnPrefix: string;
    billPrefix: string;
    /** Supplier payments: PAY-0001. */
    paymentPrefix: string;
};

export type AppSettings = {
    numbering: NumberingSettings;
    business: BusinessProfile;
    purchase: PurchaseSettings;
    /** Days before the due date at which an invoice starts to need attention. */
    reminderLeadDays: number;
    /** Default payment term for quick invoices. */
    defaultDueDays: number;
};

export const DEFAULT_SETTINGS: AppSettings = {
    numbering: { mode: "auto", prefix: "INV", separator: "", includeYear: false, padding: 4, start: 1 },
    business: { name: "", address: "", city: "", zipCode: "", country: "", email: "", phone: "", gstin: "", state: "" },
    purchase: { poPrefix: "PO", grnPrefix: "GRN", billPrefix: "PB", paymentPrefix: "PAY" },
    reminderLeadDays: 3,
    defaultDueDays: 30,
};

const int = (v: unknown, min: number, max: number, fallback: number) => {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};

const text = (v: unknown, max: number, fallback: string) =>
    typeof v === "string" ? stripControlChars(v).slice(0, max) : fallback;

/** Accepts anything and returns a complete, in-range settings object. */
export function sanitizeSettings(input: unknown): AppSettings {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const n = (o.numbering && typeof o.numbering === "object" ? o.numbering : {}) as Record<string, unknown>;
    const d = DEFAULT_SETTINGS.numbering;
    const b = (o.business && typeof o.business === "object" ? o.business : {}) as Record<string, unknown>;
    const pu = (o.purchase && typeof o.purchase === "object" ? o.purchase : {}) as Record<string, unknown>;
    const dp = DEFAULT_SETTINGS.purchase;
    const prefix = (v: unknown, fallback: string) => text(v, 12, fallback).replace(/[^\w.-]/g, "") || fallback;
    const field = (v: unknown, max: number) => text(v, max, "").trim();
    return {
        business: {
            name: field(b.name, 50),
            address: field(b.address, 70),
            city: field(b.city, 50),
            zipCode: field(b.zipCode, 20),
            country: field(b.country, 70),
            email: field(b.email, 254),
            phone: field(b.phone, 50),
            gstin: normaliseGstin(b.gstin).slice(0, 15),
            state: typeof b.state === "string" && GST_STATES[b.state] ? b.state : "",
        },
        purchase: {
            poPrefix: prefix(pu.poPrefix, dp.poPrefix),
            grnPrefix: prefix(pu.grnPrefix, dp.grnPrefix),
            billPrefix: prefix(pu.billPrefix, dp.billPrefix),
            paymentPrefix: prefix(pu.paymentPrefix, dp.paymentPrefix),
        },
        numbering: {
            mode: n.mode === "custom" ? "custom" : "auto",
            // Letters, digits and a few separators only: numbers end up in file
            // names and e-mail subjects.
            prefix: text(n.prefix, 12, d.prefix).replace(/[^\w.-]/g, ""),
            separator: text(n.separator, 2, d.separator).replace(/[^\w.\-/]/g, ""),
            includeYear: n.includeYear === true,
            padding: int(n.padding, 1, 10, d.padding),
            start: int(n.start, 0, 999_999_999, d.start),
        },
        reminderLeadDays: int(o.reminderLeadDays, 0, 60, DEFAULT_SETTINGS.reminderLeadDays),
        defaultDueDays: int(o.defaultDueDays, 0, 365, DEFAULT_SETTINGS.defaultDueDays),
    };
}

export async function readSettings(): Promise<AppSettings> {
    return sanitizeSettings(await readSecure<unknown>(SETTINGS_KEY));
}

export async function writeSettings(settings: AppSettings): Promise<boolean> {
    return writeSecure(SETTINGS_KEY, sanitizeSettings(settings));
}

/* -------------------------------------------------------------- numbering */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The number the scheme produces for a given sequence value. */
export function formatInvoiceNumber(n: NumberingSettings, seq: number, now = new Date()): string {
    const year = n.includeYear ? `${now.getFullYear()}${n.separator}` : "";
    return `${n.prefix}${n.separator}${year}${String(seq).padStart(n.padding, "0")}`;
}

/**
 * Next number under the user's scheme: one past the highest sequence among
 * saved invoices that already follow it (or the configured start), so deleting
 * or editing an invoice never causes a number to be reused.
 */
export function nextNumberFromScheme(
    n: NumberingSettings,
    saved: Pick<InvoiceType, "details">[],
    now = new Date()
): string {
    const year = n.includeYear ? `${now.getFullYear()}${escapeRe(n.separator)}` : "";
    const re = new RegExp(`^${escapeRe(n.prefix)}${escapeRe(n.separator)}${year}(\\d+)$`);
    let max = n.start - 1;
    for (const inv of saved) {
        const m = re.exec(inv.details.invoiceNumber);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return formatInvoiceNumber(n, max + 1, now);
}

/** What a new invoice should be numbered, given settings and saved invoices. */
export function suggestInvoiceNumber(
    settings: AppSettings,
    saved: InvoiceType[],
    now = new Date()
): string {
    return settings.numbering.mode === "custom"
        ? nextNumberFromScheme(settings.numbering, saved, now)
        : nextInvoiceNumber(saved);
}

/** Successor function for duplicates and recurring copies. */
export function successorFn(settings: AppSettings, saved: InvoiceType[]) {
    return settings.numbering.mode === "custom"
        ? () => nextNumberFromScheme(settings.numbering, saved)
        : incrementInvoiceNumber;
}
