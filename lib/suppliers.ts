/**
 * Suppliers: pure logic, no React and no storage.
 *
 * A supplier is who you buy from. It is a record in its own right (purchase
 * orders, goods receipts, bills and payments all point at it by id), so it has
 * its own validation and everything built on it is computed from the saved
 * records and nothing else.
 *
 * GST: the supplier's state decides whether a purchase is intra-state
 * (CGST + SGST) or inter-state (IGST). It is taken from the supplier's GSTIN
 * when one is given, because the first two digits of a GSTIN *are* the state.
 * Identifiers are checked locally (format and check character); this never
 * contacts the GST portal.
 */

import { GST_STATES, normaliseGstin, stateOfGstin, validateGstin, type SupplyType } from "@/lib/gst";
import { toCsv } from "@/lib/invoiceRecords";
import { stripControlChars } from "@/lib/schemas";

/* ------------------------------------------------------------------ types */

export type Supplier = {
    id: string;
    name: string;
    contactPerson: string;
    email: string;
    phone: string;
    address: string;
    city: string;
    zipCode: string;
    country: string;
    /** GST state code, e.g. "27". Derived from the GSTIN when blank. */
    state: string;
    gstin: string;
    pan: string;
    /** Days from bill date to due date. */
    paymentTermsDays: number;
    currency: string;
    /** What you already owed this supplier when you started using the app. */
    openingBalance: number;
    notes: string;
    inactive: boolean;
    createdAt: string;
    updatedAt: string;
};

/** Form values: numbers may still be strings while the user types. */
export type SupplierDraft = Omit<Supplier, "id" | "paymentTermsDays" | "openingBalance" | "inactive" | "createdAt" | "updatedAt" | "state"> & {
    state: string;
    paymentTermsDays: string | number;
    openingBalance: string | number;
};

export const DEFAULT_CURRENCY = "INR";
export const MAX_SUPPLIERS = 5_000;
export const PAN_FORMAT = /^[A-Z]{5}\d{4}[A-Z]$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const EMPTY_SUPPLIER_DRAFT: SupplierDraft = {
    name: "",
    contactPerson: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    zipCode: "",
    country: "India",
    state: "",
    gstin: "",
    pan: "",
    paymentTermsDays: 30,
    currency: DEFAULT_CURRENCY,
    openingBalance: 0,
    notes: "",
};

/* ---------------------------------------------------------------- numbers */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const clip = (v: unknown, max: number) => (typeof v === "string" ? stripControlChars(v).trim().slice(0, max) : "");

const num = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const normaliseCurrencyCode = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : "");

/* -------------------------------------------------------------- sanitise */

/**
 * Rebuilds a well-formed supplier from anything, or returns null if it has no
 * usable id or name. Used on every read from storage and on backup import.
 */
export function sanitizeSupplier(input: unknown): Supplier | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const id = clip(o.id, 64);
    const name = clip(o.name, 120).replace(/\s+/g, " ");
    if (!id || !name) return null;

    const gstin = normaliseGstin(o.gstin).slice(0, 15);
    const rawState = typeof o.state === "string" ? o.state : "";
    const currency = normaliseCurrencyCode(o.currency);
    const now = new Date().toISOString();
    return {
        id,
        name,
        contactPerson: clip(o.contactPerson, 80),
        email: clip(o.email, 254),
        phone: clip(o.phone, 50),
        address: clip(o.address, 120),
        city: clip(o.city, 50),
        zipCode: clip(o.zipCode, 20),
        country: clip(o.country, 70),
        state: GST_STATES[rawState] ? rawState : stateOfGstin(gstin) ?? "",
        gstin,
        pan: clip(o.pan, 10).toUpperCase(),
        paymentTermsDays: Math.round(num(o.paymentTermsDays, 0, 365, 30)),
        currency: /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_CURRENCY,
        openingBalance: round2(num(o.openingBalance, 0, 1e12, 0)),
        notes: clip(o.notes, 1000),
        inactive: o.inactive === true,
        createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
        updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : now,
    };
}

/* ------------------------------------------------------------- validation */

export type SupplierField = "name" | "email" | "gstin" | "pan" | "paymentTermsDays" | "openingBalance" | "currency" | "state";
/** Error codes are `suppliers.errors.<code>` keys in the locale files. */
export type SupplierErrors = Partial<Record<SupplierField, string>>;

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

export function validateSupplier(draft: SupplierDraft, existing: Supplier[], id?: string): SupplierErrors {
    const errors: SupplierErrors = {};
    const name = clip(draft.name, 120);
    if (!name) errors.name = "nameRequired";
    else if (existing.some((s) => s.id !== id && sameName(s.name, name))) errors.name = "nameTaken";

    const email = clip(draft.email, 254);
    if (email && !EMAIL_FORMAT.test(email)) errors.email = "emailInvalid";

    const gstin = normaliseGstin(draft.gstin);
    if (gstin) {
        const check = validateGstin(gstin);
        if (!check.valid) errors.gstin = "gstinInvalid";
        else if (existing.some((s) => s.id !== id && s.gstin === gstin)) errors.gstin = "gstinTaken";
    }

    const pan = clip(draft.pan, 10).toUpperCase();
    if (pan && !PAN_FORMAT.test(pan)) errors.pan = "panInvalid";

    const terms = Number(String(draft.paymentTermsDays).trim() === "" ? 0 : draft.paymentTermsDays);
    if (!Number.isFinite(terms) || terms < 0 || terms > 365 || !Number.isInteger(terms)) errors.paymentTermsDays = "termsRange";

    const opening = Number(String(draft.openingBalance).trim() === "" ? 0 : String(draft.openingBalance).replace(/,/g, ""));
    if (!Number.isFinite(opening) || opening < 0 || opening > 1e12) errors.openingBalance = "openingInvalid";

    if (!/^[A-Z]{3}$/.test(normaliseCurrencyCode(draft.currency))) errors.currency = "currencyInvalid";

    // A GSTIN's own state and an explicitly chosen one must agree, or the
    // intra/inter-state decision (and so the tax split) would be a guess.
    const fromGstin = stateOfGstin(gstin);
    if (fromGstin && draft.state && draft.state !== fromGstin) errors.state = "stateMismatch";
    return errors;
}

/* ------------------------------------------------------------------ query */

export type SupplierQuery = { q: string; status: "active" | "inactive" | "all"; state: string };
export const EMPTY_SUPPLIER_QUERY: SupplierQuery = { q: "", status: "active", state: "" };

export function querySuppliers(list: Supplier[], query: SupplierQuery): Supplier[] {
    const q = query.q.trim().toLowerCase();
    return list
        .filter((s) => (query.status === "all" ? true : query.status === "active" ? !s.inactive : s.inactive))
        .filter((s) => !query.state || s.state === query.state)
        .filter(
            (s) =>
                !q ||
                [s.name, s.contactPerson, s.email, s.phone, s.gstin, s.city].some((f) => f.toLowerCase().includes(q))
        )
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/* -------------------------------------------------------------------- GST */

/** The state code to use for a supplier, from its own field or its GSTIN. */
export const supplierState = (s: Pick<Supplier, "state" | "gstin">): string => (GST_STATES[s.state] ? s.state : stateOfGstin(s.gstin) ?? "");

/**
 * Whether a purchase from `fromState` to a buyer in `buyerState` stays inside
 * one state. Null when either side is unknown, because guessing would put the
 * wrong tax heads on the document.
 */
export function purchaseSupplyType(fromState: string, buyerState: string): SupplyType | null {
    if (!GST_STATES[fromState] || !GST_STATES[buyerState]) return null;
    return fromState === buyerState ? "intra" : "inter";
}

/** The buyer's state: the one chosen in Business Profile, else the one in its GSTIN. */
export const businessState = (b: { state: string; gstin: string }): string => (GST_STATES[b.state] ? b.state : stateOfGstin(b.gstin) ?? "");

/* ------------------------------------------------------------------ misc */

/** An address-book customer that is the same party as this supplier (same GSTIN or e-mail), if any. */
export function matchingCustomer<T extends { gstin?: string; email?: string }>(supplier: Supplier, customers: T[]): T | null {
    const gstin = supplier.gstin;
    const email = supplier.email.trim().toLowerCase();
    return (
        customers.find(
            (c) => (gstin && normaliseGstin(c.gstin) === gstin) || (email && (c.email ?? "").trim().toLowerCase() === email)
        ) ?? null
    );
}

export function suppliersCsv(list: Supplier[]): string {
    return toCsv(
        ["Name", "Contact", "Email", "Phone", "Address", "City", "State code", "PIN", "Country", "GSTIN", "PAN", "Payment terms (days)", "Currency", "Opening balance", "Status"],
        list.map((s) => [s.name, s.contactPerson, s.email, s.phone, s.address, s.city, s.state, s.zipCode, s.country, s.gstin, s.pan, s.paymentTermsDays, s.currency, s.openingBalance, s.inactive ? "inactive" : "active"])
    );
}

/** Merge for backup restore: ids already present are kept, and a GSTIN already known maps to its existing supplier. */
export function mergeSuppliers(existing: Supplier[], incoming: Supplier[]) {
    const list = [...existing];
    const ids = new Set(existing.map((s) => s.id));
    const byGstin = new Map(existing.filter((s) => s.gstin).map((s) => [s.gstin, s.id]));
    /** incoming id → id it ended up as, so purchase orders restored with it still find their supplier. */
    const remap = new Map<string, string>();
    let added = 0;
    let skipped = 0;
    for (const s of incoming) {
        if (ids.has(s.id)) {
            remap.set(s.id, s.id);
            skipped++;
        } else if (s.gstin && byGstin.has(s.gstin)) {
            remap.set(s.id, byGstin.get(s.gstin)!);
            skipped++;
        } else if (list.length < MAX_SUPPLIERS) {
            list.push(s);
            ids.add(s.id);
            if (s.gstin) byGstin.set(s.gstin, s.id);
            remap.set(s.id, s.id);
            added++;
        } else skipped++;
    }
    return { list, added, skipped, remap };
}
