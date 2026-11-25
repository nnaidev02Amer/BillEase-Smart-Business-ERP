import { readSecure, writeSecure } from "@/lib/secureStore";
import { stripControlChars } from "@/lib/schemas";
import { snapshotOf } from "@/lib/invoiceRecords";
import type { InvoiceType } from "@/types";

/**
 * Saved invoice templates: a reusable starting point (sender, client, items,
 * charges, notes, look) with none of the per-invoice facts — number, dates,
 * payments, history or schedule.
 */
export const TEMPLATES_KEY = "invoify:invoiceTemplates";

export type SavedTemplate = {
    id: string;
    name: string;
    createdAt: string;
    /** An invoice shape; numbering and dates are filled in when it is used. */
    data: InvoiceType;
};

const MAX_TEMPLATES = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Accepts only entries with the shape we can use; used on read and on import. */
export function normaliseTemplate(entry: unknown): SavedTemplate | null {
    if (!isRecord(entry) || !isRecord(entry.data)) return null;
    const data = entry.data as unknown as InvoiceType;
    if (!isRecord(data.details) || !isRecord(data.sender) || !isRecord(data.receiver)) return null;
    const name = typeof entry.name === "string" ? stripControlChars(entry.name).trim().slice(0, 80) : "";
    if (!name) return null;
    return {
        id: typeof entry.id === "string" && entry.id ? entry.id : crypto.randomUUID(),
        name,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
        data,
    };
}

export async function readTemplates(): Promise<SavedTemplate[]> {
    const parsed = await readSecure<unknown>(TEMPLATES_KEY);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normaliseTemplate).filter((t): t is SavedTemplate => t !== null);
}

export async function writeTemplates(list: SavedTemplate[]): Promise<boolean> {
    return writeSecure(TEMPLATES_KEY, list.slice(0, MAX_TEMPLATES));
}

/** Builds a template from the current invoice, dropping what must not be reused. */
export function templateFromInvoice(name: string, invoice: InvoiceType): SavedTemplate {
    const data = snapshotOf(invoice) as unknown as InvoiceType;
    // snapshotOf drops the logo to keep revisions small; a template should keep it.
    if (invoice.details.invoiceLogo) data.details.invoiceLogo = invoice.details.invoiceLogo;
    if (invoice.details.signature?.data) data.details.signature = invoice.details.signature;
    delete data.details.recurring;
    data.details.status = "draft";
    return {
        id: crypto.randomUUID(),
        name: stripControlChars(name).trim().slice(0, 80),
        createdAt: new Date().toISOString(),
        data,
    };
}
