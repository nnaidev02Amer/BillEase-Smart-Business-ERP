import enMessages from "@/i18n/locales/en.json";

/**
 * The words on a customer statement, passed to the document as a plain prop for
 * the same reason the invoice labels are: the template is rendered through
 * renderToStaticMarkup on the server, where next-intl's hooks do not exist.
 */
export type StatementLabelKey = keyof typeof enMessages.statementDocument;
export type StatementLabels = Record<StatementLabelKey, string>;

export const DEFAULT_STATEMENT_LABELS = enMessages.statementDocument as StatementLabels;

/** A locale's labels over English, per key, so an untranslated string never renders blank. */
export function buildStatementLabels(messages: Record<string, unknown> | undefined): StatementLabels {
    const section = (messages?.statementDocument ?? {}) as Partial<StatementLabels>;
    const labels = { ...DEFAULT_STATEMENT_LABELS };
    for (const key of Object.keys(labels) as StatementLabelKey[]) {
        const value = section[key];
        if (typeof value === "string" && value.length > 0) labels[key] = value;
    }
    return labels;
}
