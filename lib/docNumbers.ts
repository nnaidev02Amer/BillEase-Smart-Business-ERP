/**
 * Sequential document numbers for purchase documents: PO-0001, GRN-0001, PB-0001.
 *
 * The next number is one past the highest sequence already used under the same
 * prefix, never "count + 1", so deleting or cancelling a document can never
 * cause a number to be handed out twice.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type NumberScheme = { prefix: string; separator?: string; padding?: number; start?: number };

export const formatSequence = ({ prefix, separator = "-", padding = 4 }: NumberScheme, seq: number) =>
    `${prefix}${separator}${String(seq).padStart(padding, "0")}`;

/** The numeric part of `number` if it follows the scheme, else null. */
export function sequenceOf(number: string, { prefix, separator = "-" }: NumberScheme): number | null {
    const m = new RegExp(`^${escapeRe(prefix)}${escapeRe(separator)}(\\d+)$`).exec(number);
    return m ? parseInt(m[1], 10) : null;
}

export function nextSequentialNumber(existing: string[], scheme: NumberScheme): string {
    let max = (scheme.start ?? 1) - 1;
    for (const n of existing) {
        const seq = sequenceOf(n, scheme);
        if (seq !== null && seq > max) max = seq;
    }
    return formatSequence(scheme, max + 1);
}

/** Whether `number` is already used by another document (case-insensitive). */
export function isNumberTaken(number: string, existing: { id: string; number: string }[], exceptId?: string): boolean {
    const n = number.trim().toLowerCase();
    return existing.some((d) => d.id !== exceptId && d.number.trim().toLowerCase() === n);
}
