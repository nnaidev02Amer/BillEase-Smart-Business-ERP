/**
 * Storage and operations for quotations.
 *
 * Same shape as the product store: the encrypted browser store, validated on
 * every read, behind plain async functions so it can later be swapped for a
 * database without touching the UI, and every read-modify-write goes through
 * one queue so two quick actions cannot lose each other's update.
 */

import { readSecure, writeSecure } from "@/lib/secureStore";
import {
    canDelete,
    canEdit,
    canTransition,
    isNumberTaken,
    numberOf,
    sanitizeQuotation,
    withStatus,
    type Quotation,
    type StoredQuotationStatus,
} from "@/lib/quotations";
import { InvoiceSchema } from "@/lib/schemas";
import type { InvoiceType } from "@/types";

export const QUOTATIONS_KEY = "invoify:quotations";
export const QUOTATIONS_EVENT = "invoify:quotations-changed";
const MAX_QUOTATIONS = 5_000;

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
}

const announce = () => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(QUOTATIONS_EVENT));
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export async function readQuotations(): Promise<Quotation[]> {
    const raw = await readSecure<unknown>(QUOTATIONS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeQuotation).filter((q): q is Quotation => q !== null);
}

const write = (list: Quotation[]) => writeSecure(QUOTATIONS_KEY, list);

/** The reasons an operation can be refused, as `quotations.errors.<reason>` keys. */
export type StoreFailure =
    | { ok: false; reason: "invalid"; path: string; message: string }
    | { ok: false; reason: "numberTaken" | "notFound" | "storage" | "limit" | string };

export type SaveResult = { ok: true; quotation: Quotation } | StoreFailure;

export type SaveInput = {
    /** Omit to create. */
    id?: string;
    /** The quotation as an invoice-shaped document (form values). */
    doc: InvoiceType;
    /** Also move to this status as part of the save (e.g. "Save and send"). */
    status?: StoredQuotationStatus;
};

/**
 * Creates or updates a quotation. The document is validated with the same
 * schema as an invoice, so a quotation that is saved can always be rendered to
 * a PDF and converted. Numbers are unique, ignoring case.
 */
export function saveQuotation(input: SaveInput, converted: Map<string, string> = new Map(), now: Date = new Date()): Promise<SaveResult> {
    return enqueue(async () => {
        const parsed = InvoiceSchema.safeParse(input.doc);
        if (!parsed.success) {
            const first = parsed.error.issues[0];
            return { ok: false as const, reason: "invalid" as const, path: first.path.join("."), message: first.message };
        }

        const list = await readQuotations();
        const doc = clone(input.doc);
        // A quotation is not payable and has no lifecycle of its own on the document.
        const d = doc.details as Record<string, unknown>;
        d.status = "draft";
        delete d.payments;
        delete d.revisions;
        delete d.recurring;
        delete d.quotationRef;

        const number = doc.details.invoiceNumber.trim();
        doc.details.invoiceNumber = number;

        const existing = input.id ? list.find((q) => q.id === input.id) : undefined;
        if (input.id && !existing) return { ok: false as const, reason: "notFound" };
        if (isNumberTaken(list, number, existing?.id)) return { ok: false as const, reason: "numberTaken" };
        if (!existing && list.length >= MAX_QUOTATIONS) return { ok: false as const, reason: "limit" };

        const at = now.toISOString();
        let next: Quotation;
        if (existing) {
            const edit = canEdit(existing, converted.has(existing.id));
            if (!edit.ok) return edit;
            next = { ...existing, doc, updatedAt: at, events: [...existing.events, { at, kind: "edited" as const }].slice(-40) };
        } else {
            next = { id: crypto.randomUUID(), status: "draft", doc, createdAt: at, updatedAt: at, events: [{ at, kind: "created" }] };
        }

        if (input.status && input.status !== next.status) {
            const check = canTransition(next, input.status, { now, converted: existing ? converted.has(existing.id) : false });
            if (!check.ok) return check;
            next = withStatus(next, input.status, now);
        }

        const out = existing ? list.map((q) => (q.id === next.id ? next : q)) : [...list, next];
        if (!(await write(out))) return { ok: false as const, reason: "storage" };
        announce();
        return { ok: true as const, quotation: next };
    });
}

export function changeQuotationStatus(
    id: string,
    to: StoredQuotationStatus,
    converted: Map<string, string> = new Map(),
    now: Date = new Date()
): Promise<SaveResult> {
    return enqueue(async () => {
        const list = await readQuotations();
        const q = list.find((x) => x.id === id);
        if (!q) return { ok: false as const, reason: "notFound" };
        const check = canTransition(q, to, { now, converted: converted.has(id) });
        if (!check.ok) return check;
        const next = withStatus(q, to, now);
        if (!(await write(list.map((x) => (x.id === id ? next : x))))) return { ok: false as const, reason: "storage" };
        announce();
        return { ok: true as const, quotation: next };
    });
}

export function deleteQuotation(id: string, converted: Map<string, string> = new Map()): Promise<{ ok: true } | StoreFailure> {
    return enqueue(async () => {
        const list = await readQuotations();
        const q = list.find((x) => x.id === id);
        if (!q) return { ok: false as const, reason: "notFound" };
        const check = canDelete(q, converted.has(id));
        if (!check.ok) return check;
        if (!(await write(list.filter((x) => x.id !== id)))) return { ok: false as const, reason: "storage" };
        announce();
        return { ok: true as const };
    });
}

/** Replaces the whole list (backup restore). */
export function replaceQuotations(list: Quotation[]) {
    return enqueue(async () => {
        const ok = await write(list.slice(0, MAX_QUOTATIONS));
        announce();
        return ok;
    });
}

/**
 * Merges imported quotations. One that already exists (same id, or same
 * number) is skipped, never overwritten: a restore must not silently replace
 * a quotation you have since changed or accepted.
 */
export function mergeQuotations(existing: Quotation[], incoming: Quotation[]) {
    const list = [...existing];
    const ids = new Set(list.map((q) => q.id));
    const numbers = new Set(list.map((q) => numberOf(q).trim().toLowerCase()));
    let added = 0;
    let skipped = 0;
    for (const q of incoming) {
        const n = numberOf(q).trim().toLowerCase();
        if (ids.has(q.id) || numbers.has(n)) {
            skipped++;
            continue;
        }
        list.push(q);
        ids.add(q.id);
        numbers.add(n);
        added++;
    }
    return { list, added, skipped };
}
