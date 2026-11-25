import { test, expect } from "@playwright/test";

import { computeTotals, roundMoney } from "../lib/calculations";

/** Pure arithmetic checks; no browser needed. */
const none = { value: 0, type: "amount" };

test.describe("invoice calculations", () => {
    test("applies discount, then tax, then shipping", () => {
        const t = computeTotals({
            subTotal: 1000,
            discount: { value: 10, type: "percentage" }, // -100 -> 900
            tax: { value: 20, type: "percentage" }, // +180 -> 1080
            shipping: { value: 20, type: "amount" }, // -> 1100
        });
        expect(t).toMatchObject({ discountAmount: 100, taxAmount: 180, shippingAmount: 20, total: 1100 });
    });

    test("does not leak floating point error", () => {
        const t = computeTotals({ subTotal: 0.1 + 0.2, discount: none, tax: none, shipping: none });
        expect(t.total).toBe(0.3);
        expect(roundMoney(1.005)).toBe(1.01);
    });

    test("a discount larger than the subtotal cannot make the total negative", () => {
        const t = computeTotals({ subTotal: 50, discount: { value: 80, type: "amount" }, tax: none, shipping: none });
        expect(t.total).toBe(0);
    });

    test("ignores blank, negative and non-numeric charges", () => {
        const t = computeTotals({
            subTotal: 100,
            discount: { value: "", type: "amount" },
            tax: { value: "abc", type: "percentage" },
            shipping: { value: -5, type: "amount" },
        });
        expect(t.total).toBe(100);
    });

    test("rounds to the currency's decimals", () => {
        const jpy = computeTotals({ subTotal: 999, discount: none, tax: { value: 8, type: "percentage" }, shipping: none, decimals: 0 });
        expect(jpy.total).toBe(1079);
        const kwd = computeTotals({ subTotal: 10, discount: none, tax: { value: 5, type: "percentage" }, shipping: none, decimals: 3 });
        expect(kwd.total).toBe(10.5);
    });
});
