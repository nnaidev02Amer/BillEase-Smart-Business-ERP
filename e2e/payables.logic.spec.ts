import { test, expect } from "@playwright/test";

import { sanitizeExpense, type Expense } from "../lib/expenses";
import { sanitizeGoodsReceipt, type GoodsReceipt } from "../lib/goodsReceipts";
import {
    AGEING_BUCKETS,
    ageing,
    billDisplayStatus,
    bucketOf,
    hasPayments,
    owedOn,
    payablesSummary,
    purchaseFigures,
    reconcileExpenses,
    supplierBalances,
    supplierLedger,
} from "../lib/payables";
import { monthlySeries, pnlInsights, profitAndLoss, profitLossCsv } from "../lib/profit";
import { summariseExpenses } from "../lib/expenses";
import {
    billAmounts,
    billedByLine,
    canDelete,
    canEdit,
    canTransition,
    dueDateFor,
    expenseCandidates,
    hasBillErrors,
    linesFromOrder,
    linesFromReceipt,
    matchBill,
    mergePurchaseBills,
    purchaseBillsCsv,
    queryPurchaseBills,
    sanitizePurchaseBill,
    validatePurchaseBill,
    EMPTY_BILL_QUERY,
    type BillDraft,
    type BillLine,
    type PurchaseBill,
} from "../lib/purchaseBills";
import { sanitizePurchaseOrder, type PurchaseOrder } from "../lib/purchaseOrders";
import { sanitizeSupplier, type Supplier } from "../lib/suppliers";
import {
    allocateOldestFirst,
    allocatedTo,
    hasPaymentErrors,
    mergeSupplierPayments,
    sanitizeSupplierPayment,
    supplierPaymentsCsv,
    unallocated,
    validateSupplierPayment,
    type PaymentDraft,
    type SupplierPayment,
} from "../lib/supplierPayments";
import type { InvoiceType } from "../types";
import { invoice } from "./fixtures";

/** Purchase bills, supplier payments, payables and their effect on profit and loss. Pure logic. */

const SNAP = { name: "Acme Traders", gstin: "", state: "27", address: "", city: "", zipCode: "", country: "", email: "", phone: "" };

const line = (id: string, over: Partial<BillLine> = {}): BillLine => ({ id, name: "Widget", description: "", hsn: "8471", unit: "pcs", quantity: 10, unitPrice: 100, taxRate: 18, ...over });

let n = 0;
const bill = (over: Record<string, unknown> = {}): PurchaseBill => {
    n += 1;
    return sanitizePurchaseBill({
        id: `b${n}`,
        number: `PB-${String(n).padStart(4, "0")}`,
        supplierBillNo: `INV/${n}`,
        supplierId: "s1",
        supplier: SNAP,
        billDate: "2026-01-10",
        dueDate: "2026-02-09",
        currency: "INR",
        lines: [line("l")],
        discount: { type: "amount", value: 0 },
        freight: 0,
        gstEnabled: true,
        itcEligible: true,
        status: "posted",
        ...over,
    })!;
};
// 10 × 100 at 18% = 1180 (tax 180)

const pay = (over: Record<string, unknown> = {}): SupplierPayment => {
    n += 1;
    return sanitizeSupplierPayment({ id: `p${n}`, number: `PAY-${String(n).padStart(4, "0")}`, supplierId: "s1", supplierName: "Acme Traders", date: "2026-01-20", currency: "INR", amount: 500, method: "bank", allocations: [], status: "posted", ...over })!;
};

const supplier = (over: Record<string, unknown> = {}): Supplier => sanitizeSupplier({ id: "s1", name: "Acme Traders", currency: "INR", ...over })!;
const day = (s: string) => new Date(`${s}T12:00:00`);

test.describe("bill basics", () => {
    test("drops what cannot be a bill, and is idempotent", () => {
        expect(sanitizePurchaseBill(null)).toBeNull();
        expect(sanitizePurchaseBill({ id: "x", number: "PB", supplierId: "s", billDate: "2026-02-31", dueDate: "2026-03-01", status: "posted" })).toBeNull();
        expect(sanitizePurchaseBill({ id: "x", number: "PB", supplierId: "s", billDate: "2026-01-01", dueDate: "2026-03-01", status: "weird" })).toBeNull();
        const b = bill();
        expect(sanitizePurchaseBill(b)).toEqual(b);
    });

    test("GST and input-tax-credit flags default sensibly", () => {
        const b = sanitizePurchaseBill({ id: "x", number: "PB", supplierId: "s", billDate: "2026-01-01", dueDate: "2026-02-01", status: "draft", lines: [line("l")] })!;
        expect(b.gstEnabled).toBe(true);
        expect(b.itcEligible).toBe(true);
    });

    test("totals come from the lines through the GST engine", () => {
        expect(billAmounts(bill(), "27")).toEqual({ total: 1180, tax: 180, taxable: 1000, recoverableTax: 180 });
    });

    test("claimable tax is zero when not ITC-eligible or when GST is off", () => {
        expect(billAmounts(bill({ itcEligible: false }), "27")).toMatchObject({ tax: 180, recoverableTax: 0 });
        expect(billAmounts(bill({ gstEnabled: false }), "27")).toMatchObject({ total: 1000, tax: 0, recoverableTax: 0 });
    });

    test("discount reduces the taxable value; freight is added after tax", () => {
        const a = billAmounts(bill({ discount: { type: "percentage", value: 10 }, freight: 50 }), "27");
        expect(a).toMatchObject({ taxable: 900, tax: 162, total: 1112 });
    });

    test("the due date is the bill date plus the supplier's terms", () => {
        expect(dueDateFor("2026-01-10", 30)).toBe("2026-02-09");
        expect(dueDateFor("2026-01-31", 1)).toBe("2026-02-01");
        expect(dueDateFor("2026-01-10", 0)).toBe("2026-01-10");
    });
});

test.describe("bill validation", () => {
    const suppliers = [{ id: "s1" }, { id: "s2" }];
    const draftOf = (b: PurchaseBill): BillDraft => ({ number: b.number, supplierId: b.supplierId, supplierBillNo: b.supplierBillNo, billDate: b.billDate, dueDate: b.dueDate, currency: b.currency, lines: b.lines, discount: b.discount, freight: b.freight, gstEnabled: b.gstEnabled });

    test("a good bill has no errors", () => {
        const b = bill();
        expect(hasBillErrors(validatePurchaseBill(draftOf(b), suppliers, [], b.id))).toBe(false);
    });

    test("the supplier's invoice number is required", () => {
        expect(validatePurchaseBill({ ...draftOf(bill()), supplierBillNo: "  " }, suppliers, []).supplierBillNo).toBe("supplierBillNoRequired");
    });

    test("the same supplier invoice entered twice is refused (it is how a bill gets paid twice)", () => {
        const existing = bill({ supplierBillNo: "INV-77" });
        const dup = { ...draftOf(bill()), supplierBillNo: "inv-77" };
        expect(validatePurchaseBill(dup, suppliers, [existing]).supplierBillNo).toBe("supplierBillNoTaken");
        // another supplier may use the same number, a cancelled bill frees it, and a bill is not a duplicate of itself
        expect(validatePurchaseBill({ ...dup, supplierId: "s2" }, suppliers, [existing]).supplierBillNo).toBeUndefined();
        expect(validatePurchaseBill(dup, suppliers, [{ ...existing, status: "cancelled" }]).supplierBillNo).toBeUndefined();
        expect(validatePurchaseBill({ ...dup }, suppliers, [existing], existing.id).supplierBillNo).toBeUndefined();
    });

    test("dates, numbers, currency and lines are checked", () => {
        const b = bill();
        const e = validatePurchaseBill({ ...draftOf(b), billDate: "2026-13-01", dueDate: "2026-01-01", currency: "RS", lines: [] }, suppliers, []);
        expect(e).toMatchObject({ billDate: "dateInvalid", currency: "currencyInvalid", lines: "linesRequired" });
        expect(validatePurchaseBill({ ...draftOf(b), dueDate: "2026-01-09" }, suppliers, []).dueDate).toBe("dueBeforeBill");
        expect(validatePurchaseBill({ ...draftOf(b), number: "pb-0001" }, suppliers, [bill({ number: "PB-0001" })]).number).toBe("numberTaken");
        const bad = validatePurchaseBill({ ...draftOf(b), lines: [line("x", { name: "", quantity: 0, unitPrice: 0, taxRate: 200, hsn: "9" })] }, suppliers, []);
        expect(bad.lineErrors.x).toMatchObject({ name: "nameRequired", quantity: "quantityInvalid", unitPrice: "priceInvalid", taxRate: "rateInvalid", hsn: "hsnInvalid" });
    });
});

test.describe("bill lifecycle", () => {
    test("moves between draft, posted and cancelled", () => {
        expect(canTransition("draft", "posted")).toBe(true);
        expect(canTransition("posted", "draft")).toBe(true);
        expect(canTransition("posted", "cancelled")).toBe(true);
        expect(canTransition("cancelled", "draft")).toBe(true);
        expect(canTransition("cancelled", "posted")).toBe(false);
        expect(canTransition("draft", "draft")).toBe(false);
    });

    test("once paid against, a bill can be neither reopened nor cancelled", () => {
        expect(canTransition("posted", "draft", { hasPayments: true })).toBe(false);
        expect(canTransition("posted", "cancelled", { hasPayments: true })).toBe(false);
    });

    test("only a draft is editable; only an unpaid draft or cancelled bill can be deleted", () => {
        expect(canEdit({ status: "draft" })).toBe(true);
        expect(canEdit({ status: "posted" })).toBe(false);
        expect(canDelete({ status: "draft" })).toBe(true);
        expect(canDelete({ status: "cancelled" })).toBe(true);
        expect(canDelete({ status: "posted" })).toBe(false);
        expect(canDelete({ status: "cancelled" }, { hasPayments: true })).toBe(false);
    });
});

test.describe("three-way match", () => {
    const po: PurchaseOrder = sanitizePurchaseOrder({
        id: "po1",
        number: "PO-0001",
        supplierId: "s1",
        supplier: SNAP,
        date: "2026-01-01",
        currency: "INR",
        status: "sent",
        lines: [{ id: "ol1", name: "Widget", quantity: 10, unitPrice: 100, taxRate: 18 }],
    })!;
    const onOrder = (over: Partial<BillLine> = {}) => line("bl", { poLineId: "ol1", ...over });
    const forPo = (lines: BillLine[]) => ({ poId: "po1", lines });
    const got = (q: number) => new Map([["ol1", q]]);

    test("a bill with no order has nothing to be matched against", () => {
        expect(matchBill({ lines: [line("x")] }, undefined, new Map(), new Map())).toEqual([]);
        expect(matchBill({ lines: [line("x")] }, po, got(10), new Map())).toEqual([]);
    });

    test("a bill that matches the order and what was received raises nothing", () => {
        expect(matchBill(forPo([onOrder()]), po, got(10), new Map())).toEqual([]);
    });

    test("billing more than was received is flagged", () => {
        const issues = matchBill(forPo([onOrder({ quantity: 10 })]), po, got(6), new Map());
        expect(issues).toEqual([{ kind: "qtyOverReceived", lineId: "bl", name: "Widget", billed: 10, received: 6 }]);
    });

    test("earlier bills count: billing the rest of a partly billed line is fine, billing it twice is not", () => {
        expect(matchBill(forPo([onOrder({ quantity: 4 })]), po, got(10), new Map([["ol1", 6]]))).toEqual([]);
        const again = matchBill(forPo([onOrder({ quantity: 10 })]), po, got(10), new Map([["ol1", 6]]));
        expect(again.map((i) => i.kind)).toEqual(expect.arrayContaining(["qtyOverReceived", "qtyOverOrdered"]));
    });

    test("billing more than was ordered is flagged", () => {
        const issues = matchBill(forPo([onOrder({ quantity: 12 })]), po, got(12), new Map());
        expect(issues.find((i) => i.kind === "qtyOverOrdered")).toMatchObject({ billed: 12, ordered: 10 });
    });

    test("a price different from the order is flagged, within a tolerance", () => {
        const issues = matchBill(forPo([onOrder({ unitPrice: 110 })]), po, got(10), new Map());
        expect(issues).toEqual([{ kind: "priceDiffersFromOrder", lineId: "bl", name: "Widget", billPrice: 110, orderPrice: 100 }]);
        expect(matchBill(forPo([onOrder({ unitPrice: 100.004 })]), po, got(10), new Map())).toEqual([]);
    });

    test("a line that is not on the order is flagged", () => {
        expect(matchBill(forPo([line("x")]), po, got(10), new Map()).map((i) => i.kind)).toEqual(["lineNotOnOrder"]);
    });

    test("nothing received at all is flagged once, for the bill as a whole", () => {
        const issues = matchBill(forPo([onOrder()]), po, new Map(), new Map());
        expect(issues.map((i) => i.kind)).toEqual(["noReceipts"]);
    });

    test("two bill lines for the same order line are counted together", () => {
        const issues = matchBill(forPo([onOrder({ id: "a", quantity: 6 }), onOrder({ id: "b", quantity: 6 })]), po, got(10), new Map());
        expect(issues.filter((i) => i.kind === "qtyOverReceived")).toHaveLength(1);
        expect(issues[0].billed).toBe(12);
    });

    test("quantities already billed come from other posted bills only", () => {
        const a = bill({ poId: "po1", lines: [onOrder({ quantity: 6 })] });
        const draft = bill({ poId: "po1", status: "draft", lines: [onOrder({ quantity: 9 })] });
        const cancelled = bill({ poId: "po1", status: "cancelled", lines: [onOrder({ quantity: 9 })] });
        const other = bill({ poId: "po2", lines: [onOrder({ quantity: 9 })] });
        expect(billedByLine([a, draft, cancelled, other], "po1").get("ol1")).toBe(6);
        expect(billedByLine([a], "po1", a.id).size).toBe(0);
    });

    test("bill lines from an order are what was received and not yet billed, at the order's price", () => {
        const lines = linesFromOrder(po, got(8), new Map([["ol1", 3]]), () => "new");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ poLineId: "ol1", quantity: 5, unitPrice: 100, taxRate: 18 });
        expect(linesFromOrder(po, got(3), new Map([["ol1", 3]]), () => "new")).toEqual([]);
    });

    test("bill lines from a receipt are what was accepted, at the receipt's price", () => {
        const grn: GoodsReceipt = sanitizeGoodsReceipt({
            id: "g1",
            number: "GRN-1",
            supplierId: "s1",
            supplierName: "Acme",
            poId: "po1",
            date: "2026-01-05",
            status: "posted",
            lines: [
                { id: "gl1", poLineId: "ol1", name: "Widget", unit: "pcs", received: 10, rejected: 2, unitPrice: 95 },
                { id: "gl2", name: "Tape", unit: "pcs", received: 3, rejected: 3, unitPrice: 5 },
                { id: "gl3", productId: "px", name: "Loose", unit: "kg", received: 1, rejected: 0, unitPrice: 0 },
            ],
        })!;
        const lines = linesFromReceipt(grn, po, (id) => (id === "px" ? 12 : 18), () => "n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ poLineId: "ol1", quantity: 8, unitPrice: 95, taxRate: 18 });
        // a fully rejected line is not billed; an unpriced one with no order falls back to 0 for the user to fill in
        expect(lines[1]).toMatchObject({ name: "Loose", quantity: 1, unitPrice: 0, taxRate: 12 });
    });
});

test.describe("manual expenses that may be the same spend", () => {
    const exp = (over: Record<string, unknown> = {}): Expense =>
        sanitizeExpense({ id: "e1", title: "Widgets", category: "supplies", amount: 1180, currency: "INR", date: "2026-01-12", vendor: "acme traders", ...over })!;

    test("suggests an expense with the same vendor, currency and total", () => {
        const b = bill();
        expect(expenseCandidates(b, 1180, [exp()])).toHaveLength(1);
        expect(expenseCandidates(b, 1180, [exp({ amount: 1000 })])).toHaveLength(0);
        expect(expenseCandidates(b, 1180, [exp({ vendor: "Someone else" })])).toHaveLength(0);
        expect(expenseCandidates(b, 1180, [exp({ currency: "USD" })])).toHaveLength(0);
    });

    test("one already linked to another bill is not suggested, one linked to this bill is", () => {
        const b = bill();
        expect(expenseCandidates(b, 1180, [exp({ billId: "other" })])).toHaveLength(0);
        expect(expenseCandidates(b, 1180, [exp({ billId: b.id })])).toHaveLength(1);
    });

    test("the link survives sanitising", () => {
        expect(exp({ billId: "b9" }).billId).toBe("b9");
        expect(exp().billId).toBeUndefined();
    });
});

test.describe("payments", () => {
    test("drops what cannot be a payment, and never repairs over-allocation into a figure", () => {
        expect(sanitizeSupplierPayment(null)).toBeNull();
        expect(sanitizeSupplierPayment({ id: "x", number: "P", supplierId: "s", date: "2026-01-01", currency: "INR", amount: 0, status: "posted" })).toBeNull();
        expect(sanitizeSupplierPayment({ id: "x", number: "P", supplierId: "s", date: "2026-01-01", currency: "RS", amount: 5, status: "posted" })).toBeNull();
        expect(sanitizeSupplierPayment({ id: "x", number: "P", supplierId: "s", date: "2026-01-01", currency: "INR", amount: 100, status: "posted", allocations: [{ billId: "a", amount: 101 }] })).toBeNull();
        expect(sanitizeSupplierPayment({ id: "x", number: "P", supplierId: "s", date: "2026-01-01", currency: "INR", amount: 100, status: "posted", allocations: [{ billId: "a", amount: 100 }] })).not.toBeNull();
    });

    test("allocations to the same bill are merged and junk is dropped", () => {
        const p = pay({ amount: 100, allocations: [{ billId: "a", amount: 30 }, { billId: "a", amount: 20 }, { billId: "", amount: 5 }, { billId: "b", amount: -4 }] });
        expect(p.allocations).toEqual([{ billId: "a", amount: 50 }]);
    });

    test("the part not allocated is an advance, and a void payment has none", () => {
        expect(unallocated(pay({ amount: 500, allocations: [{ billId: "a", amount: 200 }] }))).toBe(300);
        expect(unallocated(pay({ amount: 500, allocations: [{ billId: "a", amount: 500 }] }))).toBe(0);
        expect(unallocated(pay({ amount: 500, status: "void" }))).toBe(0);
    });

    test("what is allocated to a bill ignores void payments and the one being edited", () => {
        const a = pay({ id: "pa", allocations: [{ billId: "b", amount: 100 }] });
        const v = pay({ id: "pv", status: "void", allocations: [{ billId: "b", amount: 100 }] });
        const c = pay({ id: "pc", allocations: [{ billId: "b", amount: 50 }] });
        expect(allocatedTo([a, v, c], "b")).toBe(150);
        expect(allocatedTo([a, v, c], "b", "pa")).toBe(50);
    });

    test("oldest-due bills are settled first and the rest is the advance", () => {
        const open = [
            { id: "late", dueDate: "2026-03-01", outstanding: 100 },
            { id: "early", dueDate: "2026-01-01", outstanding: 100 },
            { id: "mid", dueDate: "2026-02-01", outstanding: 100 },
        ];
        expect(allocateOldestFirst(250, open, "INR")).toEqual({ allocations: [{ billId: "early", amount: 100 }, { billId: "mid", amount: 100 }, { billId: "late", amount: 50 }], remainder: 0 });
        expect(allocateOldestFirst(350, open, "INR").remainder).toBe(50);
        expect(allocateOldestFirst(40, open, "INR").allocations).toEqual([{ billId: "early", amount: 40 }]);
        expect(allocateOldestFirst(0, open, "INR")).toEqual({ allocations: [], remainder: 0 });
    });

    const b1 = bill({ id: "bill1" });
    const ctx = (over: Partial<Parameters<typeof validateSupplierPayment>[1]> = {}) => ({
        suppliers: [{ id: "s1" }, { id: "s2" }],
        bills: [b1, bill({ id: "draft1", status: "draft" }), bill({ id: "usd1", currency: "USD" }), bill({ id: "other1", supplierId: "s2" })],
        payments: [] as SupplierPayment[],
        outstandingOf: () => 1180,
        ...over,
    });
    const draft = (over: Partial<PaymentDraft> = {}): PaymentDraft => ({ number: "", supplierId: "s1", date: "2026-01-20", currency: "INR", amount: 1180, method: "bank", allocations: [{ billId: "bill1", amount: 1180 }], ...over });

    test("a good payment has no errors", () => expect(hasPaymentErrors(validateSupplierPayment(draft(), ctx()))).toBe(false));

    test("needs a supplier, a real date, a positive amount and a known method", () => {
        const e = validateSupplierPayment(draft({ supplierId: "x", date: "2026-13-13", amount: 0, method: "carrier-pigeon" }), ctx());
        expect(e).toMatchObject({ supplier: "supplierRequired", date: "dateInvalid", amount: "amountInvalid", method: "methodInvalid" });
    });

    test("allocations must be to posted bills of the same supplier and currency", () => {
        const e = (billId: string) => validateSupplierPayment(draft({ allocations: [{ billId, amount: 10 }] }), ctx()).allocationErrors[billId];
        expect(e("draft1")).toBe("billNotPosted");
        expect(e("usd1")).toBe("billOtherCurrency");
        expect(e("other1")).toBe("billOtherSupplier");
        expect(e("ghost")).toBe("billNotFound");
    });

    test("a bill cannot be allocated more than it owes, and a payment cannot allocate more than it is", () => {
        expect(validateSupplierPayment(draft({ allocations: [{ billId: "bill1", amount: 1181 }], amount: 2000 }), ctx()).allocationErrors.bill1).toBe("overBill");
        expect(validateSupplierPayment(draft({ amount: 1000, allocations: [{ billId: "bill1", amount: 1180 }] }), ctx()).allocations).toBe("overPayment");
    });

    test("allocating nothing is allowed: the whole payment is an advance", () => {
        expect(hasPaymentErrors(validateSupplierPayment(draft({ allocations: [] }), ctx()))).toBe(false);
    });

    test("a number already used is refused", () => {
        expect(validateSupplierPayment(draft({ number: "pay-1" }), ctx({ payments: [pay({ number: "PAY-1" })] })).number).toBe("numberTaken");
    });

    test("merge keeps held ids and renumbers a clash", () => {
        const held = pay({ id: "keep", number: "PAY-0001" });
        const r = mergeSupplierPayments([held], [pay({ id: "keep" }), pay({ id: "n1", number: "PAY-0001", supplierId: "old" }), pay({ id: "n2", number: "PAY-0009" })], new Map([["old", "s9"]]), (t) => `PAY-${100 + t.length}`);
        expect(r).toMatchObject({ added: 2, skipped: 1, renumbered: 1 });
        expect(r.list.find((p) => p.id === "n1")).toMatchObject({ supplierId: "s9", number: "PAY-101" });
    });

    test("CSV shows the allocated and advance parts", () => {
        const row = supplierPaymentsCsv([pay({ amount: 500, allocations: [{ billId: "a", amount: 200 }] })]).split("\r\n")[1];
        expect(row).toContain('"200"');
        expect(row.endsWith(',"300"')).toBe(true);
    });
});

test.describe("what is owed", () => {
    const b = bill({ id: "B", billDate: "2026-01-10", dueDate: "2026-02-09" });

    test("a bill owes its total less posted allocations", () => {
        expect(owedOn(b, [])).toBe(1180);
        expect(owedOn(b, [pay({ allocations: [{ billId: "B", amount: 480 }] })])).toBe(700);
        expect(owedOn(b, [pay({ amount: 1180, allocations: [{ billId: "B", amount: 1180 }] })])).toBe(0);
    });

    test("a void payment settles nothing: the bill is owed again", () => {
        expect(owedOn(b, [pay({ status: "void", amount: 1180, allocations: [{ billId: "B", amount: 1180 }] })])).toBe(1180);
    });

    test("a draft or cancelled bill owes nothing", () => {
        expect(owedOn(bill({ status: "draft" }), [])).toBe(0);
        expect(owedOn(bill({ status: "cancelled" }), [])).toBe(0);
    });

    test("status runs unpaid, partial, paid, and overdue after the due date", () => {
        const before = day("2026-02-01");
        const after = day("2026-02-10");
        const part = [pay({ allocations: [{ billId: "B", amount: 100 }] })];
        const all = [pay({ amount: 1180, allocations: [{ billId: "B", amount: 1180 }] })];
        expect(billDisplayStatus(b, [], before)).toBe("unpaid");
        expect(billDisplayStatus(b, part, before)).toBe("partial");
        expect(billDisplayStatus(b, all, before)).toBe("paid");
        expect(billDisplayStatus(b, [], after)).toBe("overdue");
        expect(billDisplayStatus(b, part, after)).toBe("overdue");
        expect(billDisplayStatus(b, all, after)).toBe("paid");
        expect(billDisplayStatus(bill({ status: "draft" }), [], after)).toBe("draft");
    });

    test("a bill is not overdue on its due date, only the day after", () => {
        expect(billDisplayStatus(b, [], day("2026-02-09"))).toBe("unpaid");
        expect(billDisplayStatus(b, [], day("2026-02-10"))).toBe("overdue");
    });

    test("whether anything has been paid against a bill", () => {
        expect(hasPayments(b, [pay({ allocations: [{ billId: "B", amount: 1 }] })])).toBe(true);
        expect(hasPayments(b, [pay({ status: "void", allocations: [{ billId: "B", amount: 1 }] })])).toBe(false);
        expect(hasPayments(b, [pay({ allocations: [] })])).toBe(false);
    });
});

test.describe("ageing", () => {
    test("buckets by days past the due date, with the boundaries in the right place", () => {
        expect([0, -5, 1, 30, 31, 60, 61, 90, 91].map(bucketOf)).toEqual(["current", "current", "d1_30", "d1_30", "d31_60", "d31_60", "d61_90", "d61_90", "d90plus"]);
    });

    test("groups what is owed, per currency, and splits overdue from not yet due", () => {
        const now = day("2026-03-10");
        const bills = [
            bill({ id: "a", dueDate: "2026-03-20" }), // current
            bill({ id: "b", dueDate: "2026-03-01" }), // 9 days
            bill({ id: "c", dueDate: "2026-02-01" }), // 37 days
            bill({ id: "d", dueDate: "2025-11-01" }), // 129 days
            bill({ id: "e", dueDate: "2026-03-01", currency: "USD" }),
            bill({ id: "f", status: "draft", dueDate: "2025-01-01" }),
        ];
        const a = ageing(bills, [pay({ allocations: [{ billId: "d", amount: 180 }], amount: 180 })], { currency: "INR", now });
        const by = Object.fromEntries(a.rows.map((r) => [r.bucket, r]));
        expect(AGEING_BUCKETS.map((k) => by[k].count)).toEqual([1, 1, 1, 0, 1]);
        expect(by.d90plus.amount).toBe(1000); // 1180 less 180 paid
        expect(a.total).toBe(1180 * 3 + 1000);
        expect(a.overdue).toBe(a.total - 1180);
    });

    test("fully paid bills are not in any bucket", () => {
        const b = bill({ id: "a" });
        const a = ageing([b], [pay({ amount: 1180, allocations: [{ billId: "a", amount: 1180 }] })], { currency: "INR", now: day("2027-01-01") });
        expect(a.total).toBe(0);
    });
});

test.describe("summary, balances and ledger", () => {
    const now = day("2026-03-10");
    const s1 = supplier({ id: "s1", openingBalance: 1000 });
    const bills = [
        bill({ id: "a", dueDate: "2026-03-12", billDate: "2026-02-10" }), // due in 2 days
        bill({ id: "b", dueDate: "2026-03-01", billDate: "2026-02-01" }), // overdue
        bill({ id: "c", dueDate: "2026-04-30", billDate: "2026-03-01" }), // later
    ];
    const payments = [pay({ id: "p1", date: "2026-02-20", amount: 2000, allocations: [{ billId: "b", amount: 600 }] })]; // 1400 advance

    test("outstanding, overdue, due soon, advances and opening, per currency", () => {
        const [s] = payablesSummary([s1], bills, payments, { now });
        expect(s).toMatchObject({ currency: "INR", outstanding: 1180 * 3 - 600, overdue: 580, overdueCount: 1, dueSoon: 1180, dueSoonCount: 1, advances: 1400, opening: 1000 });
        expect(s.netPayable).toBe(1000 + (1180 * 3 - 600) - 1400);
    });

    test("different currencies are reported separately, never added", () => {
        const usd = bill({ id: "u", currency: "USD", dueDate: "2026-03-01" });
        const rows = payablesSummary([], [usd, ...bills], [], { now });
        expect(rows.map((r) => r.currency)).toEqual(["INR", "USD"]);
        expect(rows[1].outstanding).toBe(1180);
    });

    test("a supplier's balance is opening + owed on bills − advances", () => {
        const [row] = supplierBalances([s1], bills, payments, { now });
        expect(row).toMatchObject({ supplierId: "s1", opening: 1000, billed: 3540, paid: 2000, advances: 1400, outstanding: 2940, overdue: 580, nextDue: "2026-03-01" });
        expect(row.netPayable).toBe(1000 + 2940 - 1400);
    });

    test("the ledger runs from the opening balance to exactly the supplier's net payable", () => {
        const ledger = supplierLedger(s1, bills, payments, "INR");
        expect(ledger[0]).toMatchObject({ kind: "opening", debit: 1000, balance: 1000 });
        expect(ledger.map((e) => e.kind)).toEqual(["opening", "bill", "bill", "payment", "bill"]);
        expect(ledger.at(-1)!.balance).toBe(supplierBalances([s1], bills, payments, { now })[0].netPayable);
    });

    test("draft, cancelled and void records are not in the ledger or the balance", () => {
        const noise = [bill({ id: "x", status: "draft" }), bill({ id: "y", status: "cancelled" })];
        const voided = [pay({ id: "v", status: "void", amount: 999 })];
        expect(supplierLedger(s1, noise, voided, "INR").map((e) => e.kind)).toEqual(["opening"]);
        expect(supplierBalances([supplier({ id: "s1" })], noise, voided, { now })).toEqual([]);
    });
});

test.describe("profit and loss", () => {
    const expense = (over: Record<string, unknown> = {}): Expense =>
        sanitizeExpense({ id: "e1", title: "Widgets", category: "supplies", amount: 1180, currency: "INR", date: "2026-01-12", vendor: "Acme Traders", ...over })!;
    const opts = { currency: "INR", from: "2026-01-01", to: "2026-01-31" };

    test("with no purchase data the report is exactly what it was before purchasing existed", () => {
        const base = profitAndLoss([], [expense()], opts);
        const withEmpty = profitAndLoss([], [expense()], { ...opts, purchases: { bills: [], payments: [] } });
        expect(withEmpty).toEqual({ ...base });
        expect(base).toMatchObject({ purchases: 0, purchasesNet: 0, supplierPaid: 0, payables: 0, linkedExpenses: 0 });
    });

    test("invoice basis: a posted bill is a cost on its bill date, less the tax that can be claimed, paid or not", () => {
        const p = profitAndLoss([], [], { ...opts, purchases: { bills: [bill()], payments: [] } });
        expect(p).toMatchObject({ purchases: 1180, purchasesTax: 180, purchasesRecoverableTax: 180, purchasesNet: 1000, purchaseCount: 1 });
        expect(p.estimatedProfit).toBe(-1000);
        // nothing has been paid, so no cash has left
        expect(p.netCashFlow).toBe(0);
        expect(p.supplierPaid).toBe(0);
    });

    test("a bill whose tax is not claimable costs the whole amount", () => {
        const p = profitAndLoss([], [], { ...opts, purchases: { bills: [bill({ itcEligible: false })], payments: [] } });
        expect(p.purchasesNet).toBe(1180);
        expect(p.estimatedProfit).toBe(-1180);
    });

    test("cash basis: money leaves on the payment date, whatever the bill's date", () => {
        const b = bill({ id: "B" });
        const paid = pay({ date: "2026-02-15", amount: 1180, allocations: [{ billId: "B", amount: 1180 }] });
        const data = { bills: [b], payments: [paid] };
        const jan = profitAndLoss([], [], { ...opts, purchases: data });
        expect(jan).toMatchObject({ purchasesNet: 1000, supplierPaid: 0, netCashFlow: 0, estimatedProfit: -1000 });
        const feb = profitAndLoss([], [], { currency: "INR", from: "2026-02-01", to: "2026-02-28", purchases: data });
        expect(feb).toMatchObject({ purchases: 0, purchasesNet: 0, supplierPaid: 1180, netCashFlow: -1180, estimatedProfit: 0 });
    });

    test("an advance is money out on cash basis but not yet a cost", () => {
        const p = profitAndLoss([], [], { ...opts, purchases: { bills: [], payments: [pay({ date: "2026-01-20", amount: 700 })] } });
        expect(p).toMatchObject({ supplierPaid: 700, netCashFlow: -700, purchasesNet: 0, estimatedProfit: 0 });
    });

    test("a draft or cancelled bill and a void payment change nothing", () => {
        const p = profitAndLoss([], [], { ...opts, purchases: { bills: [bill({ status: "draft" }), bill({ status: "cancelled" })], payments: [pay({ status: "void", amount: 999 })] } });
        expect(p).toMatchObject({ purchases: 0, supplierPaid: 0, estimatedProfit: 0, netCashFlow: 0 });
    });

    test("payables as at the end date, with how much of it is overdue", () => {
        const b = bill({ id: "B", billDate: "2026-01-10", dueDate: "2026-01-20" });
        const part = pay({ date: "2026-01-25", amount: 180, allocations: [{ billId: "B", amount: 180 }] });
        expect(profitAndLoss([], [], { ...opts, purchases: { bills: [b], payments: [part] } })).toMatchObject({ payables: 1000, payablesOverdue: 1000 });
        // before that payment was made, the whole bill was owed
        expect(profitAndLoss([], [], { currency: "INR", from: "2026-01-01", to: "2026-01-22", purchases: { bills: [b], payments: [part] } })).toMatchObject({ payables: 1180, payablesOverdue: 1180 });
    });

    test("a manual expense linked to a posted bill is not counted twice", () => {
        const b = bill({ id: "B" });
        const e = expense({ billId: "B" });
        const both = profitAndLoss([], [e], { ...opts, purchases: { bills: [b], payments: [] } });
        const billOnly = profitAndLoss([], [], { ...opts, purchases: { bills: [b], payments: [] } });
        expect(both.expenses).toBe(0);
        expect(both.linkedExpenses).toBe(1);
        expect(both.estimatedProfit).toBe(billOnly.estimatedProfit);
        expect(both.netCashFlow).toBe(billOnly.netCashFlow);
    });

    test("an unlinked expense and a bill are both counted: only the user knows they are the same", () => {
        const p = profitAndLoss([], [expense()], { ...opts, purchases: { bills: [bill()], payments: [] } });
        expect(p.expenses).toBe(1180);
        expect(p.purchases).toBe(1180);
    });

    test("the link only protects while the bill is posted", () => {
        const e = expense({ billId: "B" });
        for (const status of ["draft", "cancelled"]) {
            const p = profitAndLoss([], [e], { ...opts, purchases: { bills: [bill({ id: "B", status })], payments: [] } });
            expect(p.expenses).toBe(1180);
            expect(p.linkedExpenses).toBe(0);
        }
        expect(reconcileExpenses([e], [bill({ id: "B" })]).linked).toHaveLength(1);
        expect(reconcileExpenses([e], []).linked).toHaveLength(0);
    });

    test("revenue less manual cost less purchase cost is the estimated profit", () => {
        const inv = invoice("INV-1", "Acme", "a@b.test", 5000, { status: "sent", issued: 0, due: 30, currency: "INR" });
        inv.details.invoiceDate = "2026-01-05T00:00:00.000Z";
        inv.details.dueDate = "2026-02-05T00:00:00.000Z";
        const p = profitAndLoss([inv as unknown as InvoiceType], [expense({ id: "m", amount: 300, vendor: "Cafe" })], { ...opts, purchases: { bills: [bill()], payments: [] } });
        expect(p.revenue).toBe(5000);
        expect(p.estimatedProfit).toBe(5000 - 300 - 1000);
    });

    test("months add up to the period totals, purchases included", () => {
        const bills = [bill({ id: "B1", billDate: "2026-01-10" }), bill({ id: "B2", billDate: "2026-02-10", itcEligible: false })];
        const payments = [pay({ date: "2026-02-01", amount: 1180, allocations: [{ billId: "B1", amount: 1180 }] }), pay({ date: "2026-03-05", amount: 400 })];
        const o = { currency: "INR", from: "2026-01-01", to: "2026-03-31", purchases: { bills, payments } };
        const total = profitAndLoss([], [], o);
        const months = monthlySeries([], [], o);
        expect(months.map((m) => m.ym)).toEqual(["2026-01", "2026-02", "2026-03"]);
        const sum = (k: "estimatedProfit" | "netCashFlow" | "purchasesNet" | "supplierPaid") => Math.round(months.reduce((s, m) => s + m[k], 0) * 100) / 100;
        expect(sum("estimatedProfit")).toBe(total.estimatedProfit);
        expect(sum("netCashFlow")).toBe(total.netCashFlow);
        expect(sum("purchasesNet")).toBe(total.purchasesNet);
        expect(sum("supplierPaid")).toBe(total.supplierPaid);
        expect(months[0]).toMatchObject({ purchasesNet: 1000, supplierPaid: 0 });
        expect(months[1]).toMatchObject({ purchasesNet: 1180, supplierPaid: 1180 });
    });

    test("insights do not claim there are no expenses when there are purchases, and flag overdue payables", () => {
        const inv = invoice("INV-1", "Acme", "a@b.test", 5000, { status: "sent", issued: 0, due: 30, currency: "INR" });
        inv.details.invoiceDate = "2026-01-05T00:00:00.000Z";
        const only = { ...opts, purchases: { bills: [bill({ dueDate: "2026-01-15" })], payments: [] } };
        const p = profitAndLoss([inv as unknown as InvoiceType], [], only);
        const ids = pnlInsights(p, summariseExpenses([], { currency: "INR" })).map((i) => i.id);
        expect(ids).not.toContain("noExpenses");
        expect(ids).toContain("payablesOverdue");
        expect(pnlInsights(profitAndLoss([inv as unknown as InvoiceType], [], opts), summariseExpenses([], { currency: "INR" })).map((i) => i.id)).toContain("noExpenses");
    });

    test("the CSV gains supplier lines only when there are purchases", () => {
        const plain = profitLossCsv(profitAndLoss([], [], opts), summariseExpenses([], { currency: "INR" }), [], (c) => c).csv;
        expect(plain).not.toContain("supplier");
        const withBills = profitLossCsv(profitAndLoss([], [], { ...opts, purchases: { bills: [bill()], payments: [pay({ date: "2026-01-20", amount: 100 })] } }), summariseExpenses([], { currency: "INR" }), [], (c) => c).csv;
        expect(withBills).toContain("Supplier bills (incl. tax)");
        expect(withBills).toContain("Paid to suppliers");
        expect(withBills).toContain("Owed to suppliers at end date");
    });

    test("supplier figures for a currency never include another's", () => {
        const f = purchaseFigures({ bills: [bill(), bill({ currency: "USD" })], payments: [pay({ currency: "USD", amount: 5 })] }, { currency: "INR", from: "", to: "2026-12-31" });
        expect(f).toMatchObject({ purchases: 1180, supplierPaid: 0, count: 1 });
    });
});

test.describe("listing and export", () => {
    const a = bill({ id: "a", number: "PB-0001", supplierBillNo: "X-1", billDate: "2026-01-01" });
    const b = bill({ id: "b", number: "PB-0002", supplierBillNo: "Y-2", billDate: "2026-02-01", status: "draft", supplier: { ...SNAP, name: "Bolts Co" } });

    test("filters by status, supplier and text, newest first", () => {
        expect(queryPurchaseBills([a, b], EMPTY_BILL_QUERY).map((x) => x.id)).toEqual(["b", "a"]);
        expect(queryPurchaseBills([a, b], { ...EMPTY_BILL_QUERY, status: "draft" }).map((x) => x.id)).toEqual(["b"]);
        expect(queryPurchaseBills([a, b], { ...EMPTY_BILL_QUERY, q: "x-1" }).map((x) => x.id)).toEqual(["a"]);
        expect(queryPurchaseBills([a, b], { ...EMPTY_BILL_QUERY, q: "bolts" }).map((x) => x.id)).toEqual(["b"]);
    });

    test("CSV carries the claimable tax and the total", () => {
        const row = purchaseBillsCsv([a], "27").split("\r\n")[1];
        expect(row).toContain("X-1");
        expect(row.endsWith(',"1180"')).toBe(true);
    });

    test("merge keeps held ids, remaps a supplier and renumbers a clash", () => {
        const held = bill({ id: "keep", number: "PB-0001" });
        const r = mergePurchaseBills([held], [bill({ id: "keep" }), bill({ id: "n1", number: "PB-0001", supplierId: "old" }), bill({ id: "n2", number: "PB-0050" })], new Map([["old", "s9"]]), (t) => `PB-${100 + t.length}`);
        expect(r).toMatchObject({ added: 2, skipped: 1, renumbered: 1 });
        expect(r.list.find((x) => x.id === "n1")).toMatchObject({ supplierId: "s9", number: "PB-101" });
    });
});
