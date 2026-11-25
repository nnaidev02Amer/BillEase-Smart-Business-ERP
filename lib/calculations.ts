/**
 * Invoice arithmetic, kept pure so it can be unit-checked without React.
 *
 * Order of operations matches what the app has always done, so existing
 * invoices keep their totals: discount comes off the subtotal, tax is applied
 * to the discounted amount, and shipping is applied last (a percentage
 * shipping charge is a percentage of the running total).
 */

export type ChargeType = "amount" | "percentage";

export type Charge = {
    /** Raw value as typed — may be a string, empty or NaN. */
    value: unknown;
    type: ChargeType | string;
};

export type TotalsInput = {
    subTotal: number;
    discount: Charge;
    tax: Charge;
    shipping: Charge;
    /** Decimal places of the invoice currency (JPY 0, USD 2, KWD 3). */
    decimals?: number;
};

export type Totals = {
    subTotal: number;
    discountAmount: number;
    taxAmount: number;
    shippingAmount: number;
    total: number;
};

/**
 * Rounds half away from zero to `decimals` places.
 *
 * Plain `toFixed` / `Math.round(x * 100) / 100` is wrong for values such as
 * 1.005 because of binary floating point; the epsilon nudges it to 1.01.
 */
export function roundMoney(value: number, decimals = 2): number {
    if (!Number.isFinite(value)) return 0;
    const factor = Math.pow(10, decimals);
    const sign = value < 0 ? -1 : 1;
    return (sign * Math.round(Math.abs(value) * factor + Number.EPSILON * factor)) / factor;
}

/** Coerces user input to a finite, non-negative number; anything else is 0. */
export function toAmount(value: unknown): number {
    const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

const applyCharge = (base: number, charge: Charge): number => {
    const amount = toAmount(charge.value);
    return charge.type === "percentage" ? base * (amount / 100) : amount;
};

export function computeTotals({
    subTotal,
    discount,
    tax,
    shipping,
    decimals = 2,
}: TotalsInput): Totals {
    const sub = roundMoney(subTotal, decimals);

    // A discount can never exceed what it is applied to; otherwise the total
    // goes negative, which the schema rejects with an unhelpful message.
    const discountAmount = Math.min(applyCharge(sub, discount), sub);
    const afterDiscount = sub - discountAmount;

    const taxAmount = applyCharge(afterDiscount, tax);
    const afterTax = afterDiscount + taxAmount;

    const shippingAmount = applyCharge(afterTax, shipping);

    return {
        subTotal: sub,
        discountAmount: roundMoney(discountAmount, decimals),
        taxAmount: roundMoney(taxAmount, decimals),
        shippingAmount: roundMoney(shippingAmount, decimals),
        total: roundMoney(afterTax + shippingAmount, decimals),
    };
}
