import { readSecure, writeSecure } from "@/lib/secureStore";

import { stripControlChars } from "@/lib/schemas";
import type { InvoiceType } from "@/types";

/**
 * Saved parties — the people at each end of an invoice — kept in the browser.
 *
 * This started as a receiver-only address book ("clients"). It is now keyed by
 * which end of the invoice the entry belongs to, because "Bill From" needs the
 * same thing: anyone invoicing from more than one entity, or simply on a second
 * device, retypes seven fields to identify themselves.
 *
 * Same place and same shape of storage as the saved invoices this app already
 * keeps — nothing is sent to a server, because there is no account to send it
 * to. Isolated here as plain functions so both pickers read one
 * implementation, and so the parsing stays defensive: this is user data that
 * may have been written by an older version of the app, or edited by hand in
 * devtools.
 *
 * Encrypted at rest through lib/secureStore, which is why every function here
 * is async. An address book is names, postal addresses, emails and phone
 * numbers; see that module for exactly what the encryption does and does not
 * protect.
 */

/** Which end of the invoice an entry belongs to. */
export type PartyKind = "sender" | "receiver";

/**
 * The receiver key is unchanged from when this was clients-only, so address
 * books saved by an earlier version are still found.
 */
const STORAGE_KEYS: Record<PartyKind, string> = {
    receiver: "invoify:clients",
    sender: "invoify:senders",
};

export const partyStorageKey = (kind: PartyKind) => STORAGE_KEYS[kind];

/**
 * Sender and receiver carry the same fields; one shape serves both.
 *
 * The optional CRM fields (`notes`, `shippingAddress`, `createdAt`) are only
 * ever set for clients. They are optional so address books written before the
 * client profile existed keep loading unchanged.
 */
export type SavedParty = InvoiceType["receiver"] & {
    /** Stable id, so renaming a party does not orphan it. */
    id: string;
    notes?: string;
    createdAt?: string;
    /*
     * Customer-relationship fields. Optional, and only ever set for customers:
     * an address book written before they existed loads unchanged, and a
     * customer is *active* unless `inactive` is set, so nothing needs migrating.
     */
    company?: string;
    contactPerson?: string;
    website?: string;
    category?: string;
    tags?: string[];
    inactive?: boolean;
    updatedAt?: string;
};

/**
 * Fields that describe the relationship, not the party as it appears on a
 * document. They are removed before a party is copied into an invoice or a
 * quotation, which are saved, exported and sent.
 */
export const CRM_ONLY_FIELDS = ["id", "notes", "createdAt", "company", "contactPerson", "website", "category", "tags", "inactive", "updatedAt"] as const;

/** A saved party as it belongs on a document (no CRM-only fields). */
export function toDocumentParty(party: SavedParty): InvoiceType["receiver"] {
    const copy: Record<string, unknown> = { ...party };
    for (const key of CRM_ONLY_FIELDS) delete copy[key];
    return copy as InvoiceType["receiver"];
}

export const MAX_TAGS = 20;

/** Trims, de-duplicates (case-insensitively) and bounds a list of tags. */
export function cleanTags(input: unknown): string[] {
    const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,;|]/) : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of raw) {
        if (typeof t !== "string") continue;
        const tag = stripControlChars(t).trim().replace(/\s+/g, " ").slice(0, 30);
        const k = tag.toLowerCase();
        if (!tag || seen.has(k)) continue;
        seen.add(k);
        out.push(tag);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

/** Notifies listeners (the customer directory, the profile page) that the address book changed. */
export const CUSTOMERS_EVENT = "invoify:customers-changed";
const announce = (kind: PartyKind) => {
    if (kind === "receiver" && typeof window !== "undefined") window.dispatchEvent(new Event(CUSTOMERS_EVENT));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

/** Accepts only entries that have the shape we can actually render. */
export function normalise(entry: unknown): SavedParty | null {
    if (!isRecord(entry)) return null;
    const name = entry.name;
    if (typeof name !== "string" || name.trim().length === 0) return null;

    const str = (key: string) =>
        typeof entry[key] === "string" ? (entry[key] as string) : "";

    const ship = isRecord(entry.shippingAddress) ? entry.shippingAddress : null;
    const shipStr = (key: string) =>
        ship && typeof ship[key] === "string" ? stripControlChars(ship[key] as string).slice(0, 120) : "";
    const shippingAddress = ship
        ? {
              address: shipStr("address"),
              zipCode: shipStr("zipCode"),
              city: shipStr("city"),
              country: shipStr("country"),
          }
        : undefined;

    return {
        id:
            typeof entry.id === "string" && entry.id
                ? entry.id
                : crypto.randomUUID(),
        ...(typeof entry.notes === "string" && entry.notes
            ? { notes: stripControlChars(entry.notes).slice(0, 2000) }
            : {}),
        ...(typeof entry.createdAt === "string" ? { createdAt: entry.createdAt } : {}),
        ...(str("company") ? { company: stripControlChars(str("company")).trim().slice(0, 100) } : {}),
        ...(str("contactPerson") ? { contactPerson: stripControlChars(str("contactPerson")).trim().slice(0, 60) } : {}),
        ...(str("website") ? { website: stripControlChars(str("website")).trim().slice(0, 200) } : {}),
        ...(str("category") ? { category: stripControlChars(str("category")).trim().slice(0, 40) } : {}),
        ...(cleanTags(entry.tags).length ? { tags: cleanTags(entry.tags) } : {}),
        ...(entry.inactive === true ? { inactive: true } : {}),
        ...(typeof entry.updatedAt === "string" ? { updatedAt: entry.updatedAt } : {}),
        ...(shippingAddress && Object.values(shippingAddress).some(Boolean) ? { shippingAddress } : {}),
        name,
        address: str("address"),
        zipCode: str("zipCode"),
        city: str("city"),
        country: str("country"),
        email: str("email"),
        phone: str("phone"),
        ...(str("gstin") ? { gstin: stripControlChars(str("gstin")).toUpperCase().slice(0, 20) } : {}),
        customInputs: Array.isArray(entry.customInputs)
            ? (entry.customInputs as SavedParty["customInputs"])
            : [],
    };
}

/** Replaces the whole list; used by backup restore and the client profile editor. */
export async function replaceParties(kind: PartyKind, parties: SavedParty[]): Promise<SavedParty[]> {
    return writeParties(kind, parties);
}

export async function readParties(kind: PartyKind): Promise<SavedParty[]> {
    const parsed = await readSecure<unknown>(STORAGE_KEYS[kind]);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalise).filter((p): p is SavedParty => p !== null);
}

async function writeParties(
    kind: PartyKind,
    parties: SavedParty[]
): Promise<SavedParty[]> {
    // A false result means quota, disabled storage, or no usable key. The
    // address book is a convenience; losing a write must not interrupt the
    // invoice being worked on, so the caller gets the list either way.
    await writeSecure(STORAGE_KEYS[kind], parties);
    announce(kind);
    return parties;
}

/**
 * Saves a party, replacing any existing entry with the same name.
 *
 * Matching on name rather than always appending, because the realistic mistake
 * is invoicing the same client twice and ending up with two near-identical
 * rows in the picker.
 */
export async function saveParty(
    kind: PartyKind,
    party: InvoiceType["receiver"] | InvoiceType["sender"]
): Promise<SavedParty[]> {
    const candidate = normalise({ ...party, id: undefined });
    if (!candidate) return readParties(kind);

    const existing = await readParties(kind);
    const index = existing.findIndex(
        (entry) =>
            entry.name.trim().toLowerCase() ===
            candidate.name.trim().toLowerCase()
    );

    if (index === -1) {
        return writeParties(kind, [
            ...existing,
            { ...candidate, createdAt: candidate.createdAt ?? new Date().toISOString() },
        ]);
    }

    const merged = [...existing];
    // Re-saving from an invoice must not wipe what was written in the profile.
    merged[index] = {
        ...existing[index],
        ...candidate,
        id: existing[index].id,
        notes: existing[index].notes ?? candidate.notes,
        shippingAddress: candidate.shippingAddress ?? existing[index].shippingAddress,
    };
    return writeParties(kind, merged);
}

export async function deleteParty(
    kind: PartyKind,
    id: string
): Promise<SavedParty[]> {
    const remaining = (await readParties(kind)).filter(
        (entry) => entry.id !== id
    );
    return writeParties(kind, remaining);
}
