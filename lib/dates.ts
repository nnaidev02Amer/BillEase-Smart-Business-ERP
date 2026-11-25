/**
 * Display formatting for the plain calendar days (yyyy-mm-dd) the purchasing
 * records store. Storage stays ISO so sorting, comparing and backups are exact;
 * only what a person reads is localised, matching the rest of the app.
 */
export function formatDay(ymd: string, locale: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
    if (!m) return ymd;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}
