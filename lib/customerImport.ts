/**
 * Customer import and export: pure logic, no React and no storage.
 *
 * Import is two steps on purpose, like backup restore. `planImport` only reads
 * and validates; it returns exactly what would happen (which rows are new,
 * which match an existing customer, which are invalid and why) and writes
 * nothing. The caller applies the plan only after the user has seen it.
 *
 * Matching an existing customer uses the same identity as everywhere else
 * (`clientKey`: the e-mail, else the name), so importing can never create a
 * second copy of someone who is already there. Fuzzier look-alikes (same
 * GSTIN, a typo in the name) are reported as warnings, never silently merged.
 */

import { type CustomerRecord, findPotentialDuplicates, identityOf, type DuplicateReason } from "@/lib/crm";
import { normaliseGstin, validateGstin } from "@/lib/gst";
import { clientKey, formatMoney, toCsv } from "@/lib/invoiceRecords";
import { cleanTags, type SavedParty } from "@/lib/partyStore";
import { stripControlChars } from "@/lib/schemas";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

/* -------------------------------------------------------------------- csv */

/**
 * RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes,
 * CRLF or LF. A leading byte-order mark (Excel adds one) is ignored.
 */
export function parseCsv(input: string): string[][] {
    const text = input.replace(/^﻿/, "");
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else quoted = false;
            } else field += ch;
        } else if (ch === '"' && field === "") {
            quoted = true;
        } else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            field = "";
            rows.push(row);
            row = [];
        } else field += ch;
    }
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    // A blank line is not a record.
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/* --------------------------------------------------------------- columns */

type Field =
    | "name" | "email" | "phone" | "company" | "contactPerson" | "gstin" | "address" | "zipCode" | "city" | "country"
    | "shipAddress" | "shipZip" | "shipCity" | "shipCountry" | "category" | "tags" | "status" | "website" | "notes";

const ALIASES: Record<Field, string[]> = {
    name: ["name", "customer", "customername", "client", "clientname", "fullname"],
    email: ["email", "emailaddress", "mail"],
    phone: ["phone", "phonenumber", "mobile", "telephone", "contactnumber", "tel"],
    company: ["company", "companyname", "businessname", "business", "organisation", "organization"],
    contactPerson: ["contactperson", "contact", "contactname"],
    gstin: ["gstin", "gst", "gstnumber", "gstno", "gstid"],
    address: ["address", "billingaddress", "street", "addressline1"],
    zipCode: ["zip", "zipcode", "pincode", "pin", "postalcode", "postcode"],
    city: ["city", "town"],
    country: ["country"],
    shipAddress: ["shippingaddress", "shipaddress", "shipto"],
    shipZip: ["shippingzip", "shipzip", "shippingpincode", "shippingpostalcode"],
    shipCity: ["shippingcity", "shipcity"],
    shipCountry: ["shippingcountry", "shipcountry"],
    category: ["category", "group", "segment", "type"],
    tags: ["tags", "labels", "tag"],
    status: ["status", "active"],
    website: ["website", "web", "url"],
    notes: ["notes", "note", "comments", "remarks"],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which column holds which field, for the header row given. */
export function mapColumns(header: string[]): Partial<Record<Field, number>> {
    const map: Partial<Record<Field, number>> = {};
    header.forEach((h, i) => {
        const n = norm(h);
        for (const [field, names] of Object.entries(ALIASES) as [Field, string[]][]) {
            if (map[field] === undefined && names.includes(n)) map[field] = i;
        }
    });
    return map;
}

/* ------------------------------------------------------------------- plan */

export type RowIssue = "name" | "nameTooLong" | "email" | "gstin" | "emailTooLong" | "inFile";

export type PlannedRow = {
    /** 1-based line in the file, counting the header as line 1. */
    line: number;
    outcome: "new" | "update" | "skip" | "invalid" | "duplicateInFile";
    name: string;
    issue?: RowIssue;
    party?: SavedParty;
    /** Existing customer this row matches, if any. */
    existingName?: string;
    /** Look-alikes that are not the same customer but might be. */
    similar: { name: string; reasons: DuplicateReason[] }[];
};

export type ImportStrategy = "skip" | "update";

export type ImportPlan =
    | { ok: false; error: "tooLarge" | "empty" | "noNameColumn" | "tooManyRows" }
    | {
          ok: true;
          rows: PlannedRow[];
          counts: { new: number; update: number; skip: number; invalid: number; duplicateInFile: number; similar: number };
          /** The address book as it would be after applying the plan. */
          result: SavedParty[];
      };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v: string | undefined, max: number) => stripControlChars(v ?? "").trim().slice(0, max);

const parseActive = (v: string | undefined): boolean | null => {
    const s = (v ?? "").trim().toLowerCase();
    if (!s) return null;
    if (["inactive", "no", "false", "0", "n", "disabled", "archived"].includes(s)) return false;
    if (["active", "yes", "true", "1", "y", "enabled"].includes(s)) return true;
    return null;
};

export function planImport(
    text: string,
    existing: SavedParty[],
    strategy: ImportStrategy,
    { newId = () => crypto.randomUUID(), now = new Date() }: { newId?: () => string; now?: Date } = {}
): ImportPlan {
    if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: "tooLarge" };
    const table = parseCsv(text);
    if (table.length === 0) return { ok: false, error: "empty" };

    const cols = mapColumns(table[0]);
    if (cols.name === undefined) return { ok: false, error: "noNameColumn" };
    const body = table.slice(1);
    if (body.length === 0) return { ok: false, error: "empty" };
    if (body.length > MAX_IMPORT_ROWS) return { ok: false, error: "tooManyRows" };

    // The exporter prefixes cells that start with = + - @ with an apostrophe so a
    // spreadsheet cannot run them as formulas; undo that so a phone number such
    // as "+91 98765 43210" survives a round trip unchanged.
    const unprotect = (v: string) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);
    const get = (r: string[], f: Field) => (cols[f] === undefined || r[cols[f]!] === undefined ? undefined : unprotect(r[cols[f]!]));

    const byKey = new Map(existing.map((p) => [clientKey(p), p]));
    const seenInFile = new Set<string>();
    const result = new Map(byKey);
    const identities = existing.map((p) => ({ key: clientKey(p), name: p.name, email: p.email, phone: p.phone, gstin: p.gstin ?? "" }));

    const rows: PlannedRow[] = [];
    body.forEach((r, i) => {
        const line = i + 2;
        const rawName = clip(get(r, "name"), 400);
        const base = { line, name: rawName, similar: [] as PlannedRow["similar"] };

        if (rawName.length < 2) return rows.push({ ...base, outcome: "invalid", issue: "name" });
        if (rawName.length > 50) return rows.push({ ...base, outcome: "invalid", issue: "nameTooLong" });

        const email = clip(get(r, "email"), 400);
        if (email && (email.length > 254 || !EMAIL_RE.test(email))) return rows.push({ ...base, outcome: "invalid", issue: email.length > 254 ? "emailTooLong" : "email" });

        const gstinRaw = clip(get(r, "gstin"), 40);
        const gstin = normaliseGstin(gstinRaw);
        if (gstin && !validateGstin(gstin).valid) return rows.push({ ...base, outcome: "invalid", issue: "gstin" });

        const key = clientKey({ name: rawName, email });
        if (seenInFile.has(key)) return rows.push({ ...base, outcome: "duplicateInFile", issue: "inFile" });
        seenInFile.add(key);

        const ship = {
            address: clip(get(r, "shipAddress"), 120),
            zipCode: clip(get(r, "shipZip"), 20),
            city: clip(get(r, "shipCity"), 50),
            country: clip(get(r, "shipCountry"), 70),
        };
        const active = parseActive(get(r, "status"));
        const tags = cleanTags(get(r, "tags") ?? "");
        const notes = clip(get(r, "notes"), 2000);

        const fields: Partial<SavedParty> = {
            name: rawName,
            email,
            phone: clip(get(r, "phone"), 50),
            address: clip(get(r, "address"), 70),
            zipCode: clip(get(r, "zipCode"), 20),
            city: clip(get(r, "city"), 50),
            country: clip(get(r, "country"), 70),
            ...(gstin ? { gstin } : {}),
            ...(clip(get(r, "company"), 100) ? { company: clip(get(r, "company"), 100) } : {}),
            ...(clip(get(r, "contactPerson"), 60) ? { contactPerson: clip(get(r, "contactPerson"), 60) } : {}),
            ...(clip(get(r, "website"), 200) ? { website: clip(get(r, "website"), 200) } : {}),
            ...(clip(get(r, "category"), 40) ? { category: clip(get(r, "category"), 40) } : {}),
            ...(tags.length ? { tags } : {}),
            ...(active === false ? { inactive: true } : {}),
            ...(notes ? { notes } : {}),
            ...(Object.values(ship).some(Boolean) ? { shippingAddress: ship } : {}),
        };

        const match = byKey.get(key);
        const identity = { key, name: rawName, email, phone: fields.phone ?? "", gstin };
        const similar = findPotentialDuplicates(identity, identities, key).map((m) => ({ name: m.record.name, reasons: m.reasons }));

        if (match) {
            if (strategy === "skip") return rows.push({ line, name: rawName, outcome: "skip", existingName: match.name, similar });
            // Update: what the file says wins; what it leaves blank keeps what we have.
            const merged: SavedParty = {
                ...match,
                ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== "" && v !== undefined)),
                id: match.id,
                createdAt: match.createdAt,
                updatedAt: now.toISOString(),
                customInputs: match.customInputs ?? [],
            } as SavedParty;
            if (active === true) delete merged.inactive;
            result.set(key, merged);
            return rows.push({ line, name: rawName, outcome: "update", existingName: match.name, party: merged, similar });
        }

        const party: SavedParty = {
            id: newId(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            customInputs: [],
            name: rawName,
            email,
            phone: "",
            address: "",
            zipCode: "",
            city: "",
            country: "",
            ...fields,
        } as SavedParty;
        result.set(key, party);
        identities.push(identity);
        rows.push({ line, name: rawName, outcome: "new", party, similar });
    });

    const count = (o: PlannedRow["outcome"]) => rows.filter((x) => x.outcome === o).length;
    return {
        ok: true,
        rows,
        counts: {
            new: count("new"),
            update: count("update"),
            skip: count("skip"),
            invalid: count("invalid"),
            duplicateInFile: count("duplicateInFile"),
            similar: rows.filter((x) => x.similar.length > 0 && (x.outcome === "new" || x.outcome === "update")).length,
        },
        result: [...result.values()],
    };
}

/* ----------------------------------------------------------------- export */

export const CUSTOMER_EXPORT_HEADER = [
    "Name", "Email", "Phone", "Company", "Contact person", "GSTIN", "Address", "Zip code", "City", "Country",
    "Shipping address", "Shipping zip", "Shipping city", "Shipping country", "Category", "Tags", "Status", "Website", "Notes",
    // Informational: derived from invoices, ignored on import.
    "Invoiced", "Outstanding", "Overdue",
];

const totals = (t: Record<string, number> | undefined, locale: string) =>
    Object.entries(t ?? {})
        .filter(([, v]) => v > 0)
        .map(([c, v]) => formatMoney(v, c, locale))
        .join("; ");

/**
 * Customers as CSV. Every profile field round-trips through `planImport`; the
 * last three columns are read-only context for whoever opens the file.
 */
export function customersToCsv(records: CustomerRecord[], locale = "en"): string {
    return toCsv(
        CUSTOMER_EXPORT_HEADER,
        records.map((r) => {
            const p = r.profile;
            return [
                r.name,
                r.email,
                r.phone,
                r.company,
                r.contactPerson,
                r.gstin,
                p?.address ?? "",
                p?.zipCode ?? "",
                r.city,
                p?.country ?? "",
                p?.shippingAddress?.address ?? "",
                p?.shippingAddress?.zipCode ?? "",
                p?.shippingAddress?.city ?? "",
                p?.shippingAddress?.country ?? "",
                r.category,
                r.tags.join("; "),
                r.active ? "Active" : "Inactive",
                r.website,
                p?.notes ?? "",
                totals(r.invoices?.billed, locale),
                totals(r.invoices?.outstanding, locale),
                totals(r.invoices?.overdue, locale),
            ];
        })
    );
}

/** Identity of an existing customer for duplicate checks, from a saved profile. */
export const identityOfProfile = (p: SavedParty) => ({ key: clientKey(p), name: p.name, email: p.email, phone: p.phone, gstin: p.gstin ?? "" });
export { identityOf };
