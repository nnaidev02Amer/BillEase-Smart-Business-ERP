/**
 * Storage for supplier payments, on the shared repository layer.
 *
 * Shares `purchasingQueue` with the rest of purchasing. Every allocation is
 * checked against what the bill really still owes, computed inside the queued
 * step from the payments actually stored, so two payments recorded in quick
 * succession can never both be allocated the same money.
 */

import { nextSequentialNumber } from "@/lib/docNumbers";
import { billTotal } from "@/lib/payables";
import { readBillsRaw } from "@/lib/purchasingRaw";
import { createCollection, newId, subscribe } from "@/lib/repository";
import {
    MAX_SUPPLIER_PAYMENTS,
    allocatedTo,
    hasPaymentErrors,
    roundTo,
    sanitizeSupplierPayment,
    validateSupplierPayment,
    type Allocation,
    type PaymentErrors,
    type SupplierPayment,
} from "@/lib/supplierPayments";
import { purchasingQueue, readSuppliers } from "@/lib/supplierStore";

export const supplierPaymentsCollection = createCollection<SupplierPayment>({
    name: "supplierPayments",
    sanitise: sanitizeSupplierPayment,
    max: MAX_SUPPLIER_PAYMENTS,
    queue: purchasingQueue,
});

export const SUPPLIER_PAYMENTS_KEY = supplierPaymentsCollection.key;
export const SUPPLIER_PAYMENTS_EVENT = supplierPaymentsCollection.event;
export const readSupplierPayments = () => supplierPaymentsCollection.read();
export const subscribeSupplierPayments = (listener: () => void) => subscribe(supplierPaymentsCollection, listener);

export type RecordPaymentInput = {
    number: string;
    supplierId: string;
    date: string;
    currency: string;
    amount: number;
    method: string;
    reference: string;
    note: string;
    allocations: Allocation[];
    /** From Settings → Business profile → purchase prefixes. */
    prefix: string;
};

export type RecordPaymentResult = { ok: true; payment: SupplierPayment } | { ok: false; errors: PaymentErrors } | { ok: false; reason: "limit" | "storage" };

/** Records a payment, optionally settling bills. Whatever is not allocated is an advance. */
export async function recordSupplierPayment(input: RecordPaymentInput, now: Date = new Date()): Promise<RecordPaymentResult> {
    let failure: RecordPaymentResult | null = null;
    const [suppliers, bills] = await Promise.all([readSuppliers(), readBillsRaw()]);

    const res = await supplierPaymentsCollection.update<SupplierPayment>((current) => {
        const owed = (billId: string) => {
            const b = bills.find((x) => x.id === billId);
            return b ? Math.max(0, roundTo(billTotal(b) - allocatedTo(current, billId), b.currency)) : 0;
        };
        const errors = validateSupplierPayment(input, { suppliers, bills, payments: current, outstandingOf: owed });
        if (hasPaymentErrors(errors)) {
            failure = { ok: false, errors };
            return null;
        }
        if (current.length >= MAX_SUPPLIER_PAYMENTS) {
            failure = { ok: false, reason: "limit" };
            return null;
        }
        const supplier = suppliers.find((s) => s.id === input.supplierId)!;
        const stamp = now.toISOString();
        const candidate = sanitizeSupplierPayment({
            id: newId("pay"),
            number: input.number.trim() || nextSequentialNumber(current.map((p) => p.number), { prefix: input.prefix }),
            supplierId: supplier.id,
            supplierName: supplier.name,
            date: input.date,
            currency: input.currency,
            amount: input.amount,
            method: input.method,
            reference: input.reference,
            note: input.note,
            allocations: input.allocations,
            status: "posted",
            createdAt: stamp,
            updatedAt: stamp,
        });
        if (!candidate) {
            failure = { ok: false, reason: "storage" };
            return null;
        }
        return { next: [...current, candidate], result: candidate };
    });
    if (res.ok) return { ok: true, payment: res.result };
    return failure ?? { ok: false, reason: "storage" };
}

export type AllocateResult = { ok: true; payment: SupplierPayment } | { ok: false; errors: PaymentErrors } | { ok: false; reason: "notFound" | "notAllowed" | "storage" };

/**
 * Sets which bills a posted payment settles, for example to put an advance
 * against a bill that arrived later. The payment's own allocations are not
 * counted against the bills while it is being changed.
 */
export async function allocateSupplierPayment(id: string, allocations: Allocation[], now: Date = new Date()): Promise<AllocateResult> {
    let failure: AllocateResult | null = null;
    const [suppliers, bills] = await Promise.all([readSuppliers(), readBillsRaw()]);

    const res = await supplierPaymentsCollection.update<SupplierPayment>((current) => {
        const p = current.find((x) => x.id === id);
        if (!p) {
            failure = { ok: false, reason: "notFound" };
            return null;
        }
        if (p.status !== "posted") {
            failure = { ok: false, reason: "notAllowed" };
            return null;
        }
        const owed = (billId: string) => {
            const b = bills.find((x) => x.id === billId);
            return b ? Math.max(0, roundTo(billTotal(b) - allocatedTo(current, billId, p.id), b.currency)) : 0;
        };
        const errors = validateSupplierPayment({ number: p.number, supplierId: p.supplierId, date: p.date, currency: p.currency, amount: p.amount, method: p.method, allocations }, { suppliers, bills, payments: current, outstandingOf: owed }, p.id);
        if (hasPaymentErrors(errors)) {
            failure = { ok: false, errors };
            return null;
        }
        const updated = sanitizeSupplierPayment({ ...p, allocations, updatedAt: now.toISOString() });
        if (!updated) {
            failure = { ok: false, reason: "storage" };
            return null;
        }
        return { next: current.map((x) => (x.id === id ? updated : x)), result: updated };
    });
    if (res.ok) return { ok: true, payment: res.result };
    return failure ?? { ok: false, reason: "storage" };
}

export type VoidPaymentResult = { ok: true; payment: SupplierPayment } | { ok: false; reason: "notFound" | "alreadyVoid" | "storage" };

/** Voids a payment: it keeps its record but settles nothing, so the bills it paid are owed again. */
export async function voidSupplierPayment(id: string, reason: string, now: Date = new Date()): Promise<VoidPaymentResult> {
    let failure: VoidPaymentResult | null = null;
    const res = await supplierPaymentsCollection.update<SupplierPayment>((current) => {
        const p = current.find((x) => x.id === id);
        if (!p) {
            failure = { ok: false, reason: "notFound" };
            return null;
        }
        if (p.status === "void") {
            failure = { ok: false, reason: "alreadyVoid" };
            return null;
        }
        const stamp = now.toISOString();
        const voided: SupplierPayment = { ...p, status: "void", voidedAt: stamp, updatedAt: stamp };
        const why = reason.trim().slice(0, 300);
        if (why) voided.voidReason = why;
        return { next: current.map((x) => (x.id === id ? voided : x)), result: voided };
    });
    if (res.ok) return { ok: true, payment: res.result };
    return failure ?? { ok: false, reason: "storage" };
}

/** Replaces the whole list (backup restore). */
export const replaceSupplierPayments = (list: SupplierPayment[]) => supplierPaymentsCollection.replace(list);
