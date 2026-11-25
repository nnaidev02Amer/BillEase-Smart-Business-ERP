"use client";

import { useLocale } from "next-intl";

/** Rounds a maximum up to a tidy axis ceiling (1, 2, 5 × 10ⁿ). */
const niceMax = (value: number): number => {
    if (value <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(value)));
    const n = value / pow;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
};

export type Series = { name: string; color: string };
export type BarDatum = { label: string; values: number[]; title: string };

const W = 560;
const PAD = { top: 12, right: 8, bottom: 28, left: 46 };

/**
 * Grouped bar chart in plain SVG: the data is a dozen groups of one to three
 * numbers, which does not justify a charting dependency. Every bar has a
 * tooltip, the legend names each series, and an off-screen table carries the
 * same numbers for screen readers.
 *
 * `format` renders values for tooltips and the table; `axis` renders the (short)
 * axis labels.
 */
export const BarChart = ({
    data,
    series,
    ariaLabel,
    format,
    axis,
    height = 220,
}: {
    data: BarDatum[];
    series: Series[];
    ariaLabel: string;
    format: (v: number) => string;
    axis?: (v: number) => string;
    height?: number;
}) => {
    const locale = useLocale();
    const H = height;
    const max = niceMax(Math.max(...data.flatMap((d) => d.values), 0));
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const slot = innerW / Math.max(1, data.length);
    const barW = Math.max(3, Math.min(18, (slot * 0.72) / series.length));
    const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
    const ticks = [0, 0.5, 1].map((f) => f * max);
    const compact =
        axis ??
        ((v: number) =>
            new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(v));

    return (
        <figure className="m-0">
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="h-auto w-full">
                {ticks.map((t) => (
                    <g key={t}>
                        <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="hsl(var(--border))" />
                        <text
                            x={PAD.left - 6}
                            y={y(t) + 4}
                            textAnchor="end"
                            fontSize={11}
                            fill="hsl(var(--muted-foreground))"
                        >
                            {compact(t)}
                        </text>
                    </g>
                ))}

                {data.map((d, i) => {
                    const cx = PAD.left + slot * i + slot / 2;
                    const groupW = barW * series.length + (series.length - 1) * 2;
                    return (
                        <g key={`${d.label}-${i}`}>
                            <title>{d.title}</title>
                            {series.map((s, k) => (
                                <rect
                                    key={s.name}
                                    x={cx - groupW / 2 + k * (barW + 2)}
                                    y={y(d.values[k] ?? 0)}
                                    width={barW}
                                    height={Math.max(0, PAD.top + innerH - y(d.values[k] ?? 0))}
                                    rx={3}
                                    fill={s.color}
                                />
                            ))}
                            <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="hsl(var(--muted-foreground))">
                                {d.label}
                            </text>
                        </g>
                    );
                })}
            </svg>

            <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {series.map((s) => (
                    <span key={s.name} className="inline-flex items-center gap-1.5">
                        <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                        {s.name}
                    </span>
                ))}
            </figcaption>

            <table className="sr-only">
                <caption>{ariaLabel}</caption>
                <thead>
                    <tr>
                        <th />
                        {series.map((s) => (
                            <th key={s.name} scope="col">
                                {s.name}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {data.map((d, i) => (
                        <tr key={`${d.label}-${i}`}>
                            <th scope="row">{d.label}</th>
                            {series.map((s, k) => (
                                <td key={s.name}>{format(d.values[k] ?? 0)}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </figure>
    );
};

export type Segment = { label: string; value: number; color: string; display: string };

/** One stacked horizontal bar with a labelled legend; never colour alone. */
export const SegmentBar = ({ segments, ariaLabel }: { segments: Segment[]; ariaLabel: string }) => {
    const total = segments.reduce((s, x) => s + x.value, 0);
    return (
        <div>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={ariaLabel}>
                {total > 0 &&
                    segments
                        .filter((s) => s.value > 0)
                        .map((s) => (
                            <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
                        ))}
            </div>
            <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {segments.map((s) => (
                    <li key={s.label} className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2 text-muted-foreground">
                            <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                            {s.label}
                        </span>
                        <span className="font-medium tabular-nums">{s.display}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
};

/** Percentage change with direction, in words as well as colour. */
export const Delta = ({ change, label }: { change: number | null; label: string }) => {
    if (change === null) return <span className="text-xs text-muted-foreground">{label}</span>;
    const up = change >= 0;
    return (
        <span className={`text-xs font-medium ${up ? "text-success" : "text-destructive"}`}>
            {up ? "▲" : "▼"} {Math.abs(change * 100).toFixed(0)}% <span className="text-muted-foreground">{label}</span>
        </span>
    );
};
