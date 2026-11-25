import enMessages from "@/i18n/locales/en.json";

/**
 * The words on the profit and loss report, passed to the document as a plain
 * prop because it is rendered through renderToStaticMarkup on the server, where
 * the translation hooks do not exist (the same approach as the invoice and
 * statement labels).
 */
export type ReportLabelKey = keyof typeof enMessages.reportDocument;
export type ReportLabels = Record<ReportLabelKey, string>;

export const DEFAULT_REPORT_LABELS = enMessages.reportDocument as ReportLabels;

export function buildReportLabels(messages: Record<string, unknown> | undefined): ReportLabels {
    const section = (messages?.reportDocument ?? {}) as Partial<ReportLabels>;
    const labels = { ...DEFAULT_REPORT_LABELS };
    for (const key of Object.keys(labels) as ReportLabelKey[]) {
        const value = section[key];
        if (typeof value === "string" && value.length > 0) labels[key] = value;
    }
    return labels;
}
