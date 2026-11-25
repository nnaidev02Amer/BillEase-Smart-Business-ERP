import { test, expect } from "@playwright/test";

import { gstinCheckChar, validateGstin } from "../lib/gst";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../lib/settings";
import { formatSequence, isNumberTaken, nextSequentialNumber, sequenceOf } from "../lib/docNumbers";
import {
    EMPTY_SUPPLIER_DRAFT,
    EMPTY_SUPPLIER_QUERY,
    businessState,
    matchingCustomer,
    mergeSuppliers,
    purchaseSupplyType,
    querySuppliers,
    sanitizeSupplier,
    supplierState,
    suppliersCsv,
    validateSupplier,
    type Supplier,
    type SupplierDraft,
} from "../lib/suppliers";

/** Suppliers, Business Profile settings and document numbering: pure logic, no browser. */

/** A well-formed GSTIN for a state, with a correct check character. */
const gstin = (state: string, pan = "AAPFU0939F") => {
    const first14 = `${state}${pan}1Z`;
    return `${first14}${gstinCheckChar(first14)}`;
};
const MH = gstin("27");
const KA = gstin("29", "BBBPK1234C");

const supplier = (over: Partial<Supplier> & { id: string; name: string }): Supplier => sanitizeSupplier({ ...over })!;
const draft = (over: Partial<SupplierDraft> = {}): SupplierDraft => ({ ...EMPTY_SUPPLIER_DRAFT, name: "Acme Traders", ...over });

test.describe("test fixtures", () => {
    test("generated GSTINs are really valid", () => {
        expect(validateGstin(MH).valid).toBe(true);
        expect(validateGstin(KA).valid).toBe(true);
    });
});

test.describe("sanitizeSupplier", () => {
    test("drops records with no id or no name", () => {
        expect(sanitizeSupplier(null)).toBeNull();
        expect(sanitizeSupplier({ name: "x" })).toBeNull();
        expect(sanitizeSupplier({ id: "a", name: "   " })).toBeNull();
    });

    test("normalises the GSTIN and takes the state from it", () => {
        const s = supplier({ id: "s1", name: "Acme", gstin: ` ${MH.toLowerCase()} ` });
        expect(s.gstin).toBe(MH);
        expect(s.state).toBe("27");
    });

    test("bounds numbers and falls back to safe defaults", () => {
        const s = sanitizeSupplier({ id: "s1", name: "Acme", paymentTermsDays: 9999, openingBalance: -50, currency: "rupees" })!;
        expect(s.paymentTermsDays).toBe(365);
        expect(s.openingBalance).toBe(0);
        expect(s.currency).toBe("INR");
    });

    test("strips control characters and collapses whitespace in the name", () => {
        expect(supplier({ id: "s1", name: "Acme\u0000   Traders" }).name).toBe("Acme Traders");
    });

    test("an unknown state code is ignored, not stored", () => {
        expect(supplier({ id: "s1", name: "A", state: "00" }).state).toBe("");
    });
});

test.describe("validateSupplier", () => {
    const existing = [supplier({ id: "s1", name: "Acme Traders", gstin: MH })];

    test("a name is required and must be unique, ignoring case and spacing", () => {
        expect(validateSupplier(draft({ name: "" }), existing).name).toBe("nameRequired");
        expect(validateSupplier(draft({ name: "  acme   TRADERS " }), existing).name).toBe("nameTaken");
        expect(validateSupplier(draft({ name: "Acme Traders" }), existing, "s1").name).toBeUndefined();
    });

    test("a GSTIN must be well-formed and not already used by another supplier", () => {
        expect(validateSupplier(draft({ name: "B", gstin: "27AAAAA0000A1Z5" }), existing).gstin).toBe("gstinInvalid");
        expect(validateSupplier(draft({ name: "B", gstin: MH }), existing).gstin).toBe("gstinTaken");
        expect(validateSupplier(draft({ name: "B", gstin: KA }), existing).gstin).toBeUndefined();
        expect(validateSupplier(draft({ name: "B", gstin: "" }), existing).gstin).toBeUndefined();
    });

    test("PAN, e-mail, terms, opening balance and currency are checked", () => {
        const e = validateSupplier(draft({ name: "B", pan: "123", email: "nope", paymentTermsDays: 400, openingBalance: "abc", currency: "RS" }), existing);
        expect(e).toMatchObject({ pan: "panInvalid", email: "emailInvalid", paymentTermsDays: "termsRange", openingBalance: "openingInvalid", currency: "currencyInvalid" });
        expect(validateSupplier(draft({ name: "B", pan: "abcde1234f", email: "a@b.co", openingBalance: "1,250.50" }), existing)).toEqual({});
    });

    test("a state that contradicts the GSTIN is refused rather than guessed", () => {
        expect(validateSupplier(draft({ name: "B", gstin: KA, state: "27" }), existing).state).toBe("stateMismatch");
        expect(validateSupplier(draft({ name: "B", gstin: KA, state: "29" }), existing).state).toBeUndefined();
    });
});

test.describe("querySuppliers", () => {
    const list = [
        supplier({ id: "1", name: "Zeta Steel", gstin: KA, city: "Bengaluru" }),
        supplier({ id: "2", name: "alpha Paper", email: "sales@alpha.test" }),
        supplier({ id: "3", name: "Old Co", inactive: true }),
    ];

    test("active only by default, sorted by name regardless of case", () => {
        expect(querySuppliers(list, EMPTY_SUPPLIER_QUERY).map((s) => s.id)).toEqual(["2", "1"]);
    });

    test("searches name, e-mail, GSTIN and city", () => {
        const q = (text: string) => querySuppliers(list, { ...EMPTY_SUPPLIER_QUERY, status: "all", q: text }).map((s) => s.id);
        expect(q("alpha.test")).toEqual(["2"]);
        expect(q(KA.slice(0, 6))).toEqual(["1"]);
        expect(q("bengal")).toEqual(["1"]);
    });

    test("status and state filters", () => {
        expect(querySuppliers(list, { ...EMPTY_SUPPLIER_QUERY, status: "inactive" }).map((s) => s.id)).toEqual(["3"]);
        expect(querySuppliers(list, { ...EMPTY_SUPPLIER_QUERY, status: "all", state: "29" }).map((s) => s.id)).toEqual(["1"]);
    });
});

test.describe("GST supply type", () => {
    test("same state is intra, different is inter, unknown is not guessed", () => {
        expect(purchaseSupplyType("27", "27")).toBe("intra");
        expect(purchaseSupplyType("29", "27")).toBe("inter");
        expect(purchaseSupplyType("", "27")).toBeNull();
        expect(purchaseSupplyType("27", "")).toBeNull();
    });

    test("a supplier or business state comes from the field, else the GSTIN", () => {
        expect(supplierState({ state: "", gstin: KA })).toBe("29");
        expect(supplierState({ state: "07", gstin: KA })).toBe("07");
        expect(businessState({ state: "", gstin: MH })).toBe("27");
        expect(businessState({ state: "", gstin: "" })).toBe("");
    });
});

test.describe("CRM link", () => {
    const s = supplier({ id: "s1", name: "Acme", gstin: MH, email: "Buy@Acme.test" });

    test("a customer with the same GSTIN or e-mail is the same party", () => {
        expect(matchingCustomer(s, [{ gstin: MH.toLowerCase() }])).not.toBeNull();
        expect(matchingCustomer(s, [{ email: " buy@acme.TEST " }])).not.toBeNull();
        expect(matchingCustomer(s, [{ gstin: KA, email: "x@y.test" }])).toBeNull();
    });

    test("blank identifiers never match each other", () => {
        expect(matchingCustomer(supplier({ id: "s2", name: "Blank" }), [{ gstin: "", email: "" }])).toBeNull();
    });
});

test.describe("mergeSuppliers", () => {
    test("keeps existing, adds new, and maps a duplicate GSTIN to the supplier already held", () => {
        const have = [supplier({ id: "a", name: "Acme", gstin: MH })];
        const incoming = [
            supplier({ id: "a", name: "Acme (changed)" }),
            supplier({ id: "b", name: "Acme again", gstin: MH }),
            supplier({ id: "c", name: "New one", gstin: KA }),
        ];
        const r = mergeSuppliers(have, incoming);
        expect(r.list.map((s) => s.id)).toEqual(["a", "c"]);
        expect(r.list[0].name).toBe("Acme");
        expect(r).toMatchObject({ added: 1, skipped: 2 });
        expect(r.remap.get("b")).toBe("a");
        expect(r.remap.get("c")).toBe("c");
    });
});

test("suppliersCsv quotes commas and quotes", () => {
    const csv = suppliersCsv([supplier({ id: "1", name: 'Acme, "Best" Ltd' })]);
    expect(csv.split("\r\n")[0]).toContain("Name");
    expect(csv).toContain('"Acme, ""Best"" Ltd"');
});

test.describe("Business Profile and purchase settings", () => {
    test("older settings with neither load with safe defaults", () => {
        const s = sanitizeSettings({ numbering: { mode: "custom", prefix: "AB", separator: "-", includeYear: false, padding: 3, start: 5 }, defaultDueDays: 10 });
        expect(s.business).toEqual(DEFAULT_SETTINGS.business);
        expect(s.purchase).toEqual({ poPrefix: "PO", grnPrefix: "GRN", billPrefix: "PB", paymentPrefix: "PAY" });
        expect(s.numbering.prefix).toBe("AB");
        expect(s.defaultDueDays).toBe(10);
    });

    test("the GSTIN is normalised and a bad state is dropped", () => {
        const s = sanitizeSettings({ business: { name: " Me ", gstin: ` ${MH.toLowerCase()} `, state: "00" } });
        expect(s.business.name).toBe("Me");
        expect(s.business.gstin).toBe(MH);
        expect(s.business.state).toBe("");
    });

    test("prefixes keep only safe characters and never become empty", () => {
        const s = sanitizeSettings({ purchase: { poPrefix: "P/O #", grnPrefix: "", billPrefix: "B-1" } });
        expect(s.purchase).toEqual({ poPrefix: "PO", grnPrefix: "GRN", billPrefix: "B-1", paymentPrefix: "PAY" });
    });

    test("is idempotent", () => {
        const once = sanitizeSettings({ business: { name: "Me", gstin: MH } });
        expect(sanitizeSettings(once)).toEqual(once);
    });
});

test.describe("document numbers", () => {
    const scheme = { prefix: "PO" };

    test("start at 1 and continue from the highest, never reusing a gap", () => {
        expect(nextSequentialNumber([], scheme)).toBe("PO-0001");
        expect(nextSequentialNumber(["PO-0001", "PO-0002", "PO-0007"], scheme)).toBe("PO-0008");
    });

    test("other prefixes and malformed numbers are ignored", () => {
        expect(nextSequentialNumber(["GRN-0009", "PO-ABC", "PO-0003x", "po-0005"], scheme)).toBe("PO-0001");
    });

    test("grows past the padding and respects a start", () => {
        expect(nextSequentialNumber(["PO-9999"], scheme)).toBe("PO-10000");
        expect(nextSequentialNumber([], { prefix: "PO", start: 100 })).toBe("PO-0100");
    });

    test("prefixes with regex characters are matched literally", () => {
        expect(nextSequentialNumber(["A.B-0004", "AxB-0009"], { prefix: "A.B" })).toBe("A.B-0005");
        expect(sequenceOf("PO-0042", scheme)).toBe(42);
        expect(formatSequence({ prefix: "PB", padding: 3 }, 7)).toBe("PB-007");
    });

    test("number clash check ignores case and the document being edited", () => {
        const docs = [{ id: "1", number: "PO-0001" }];
        expect(isNumberTaken("po-0001", docs)).toBe(true);
        expect(isNumberTaken("PO-0001", docs, "1")).toBe(false);
    });
});
