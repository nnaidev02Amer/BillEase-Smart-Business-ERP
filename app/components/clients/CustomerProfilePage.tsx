"use client";

import { Suspense, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { useSearchParams } from "next/navigation";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/use-toast";

import BaseButton from "@/app/components/reusables/BaseButton";
import GuardedLink from "@/app/components/layout/GuardedLink";
import StatusBadge from "@/app/components/dashboard/StatusBadge";
import { BarChart } from "@/app/components/dashboard/Charts";
import { ExpiryNote, QuotationStatusBadge } from "@/app/components/quotations/QuotationStatusBadge";

import { CustomerDialog } from "./CustomerEditor";
import { InsightsList, Panel, StatCard } from "./CrmWidgets";
import RecordPaymentDialog from "./RecordPaymentDialog";
import StatementPanel from "./StatementPanel";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useCustomers } from "@/contexts/useCustomers";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { currenciesOf, customerInsights, documentsOf, monthlyInvoiced, timelineOf, trendOf, type CustomerRecord, type TimelineKind } from "@/lib/crm";
import { validateGstin } from "@/lib/gst";
import { balanceDue, displayStatus, formatMoney, invoiceTotal, parseDate } from "@/lib/invoiceRecords";
import { readParties, replaceParties } from "@/lib/partyStore";
import { currencyOf, displayStatus as quotationStatus, numberOf, totalOf, validUntilOf } from "@/lib/quotations";
import { buildStatement } from "@/lib/statement";

import { ArrowLeft, BadgeCheck, CheckCircle2, CircleDollarSign, FilePlus2, FileSignature, FileText, Mail, Pencil, Phone, Receipt, Globe, User, Wallet, ClipboardCheck, Clock, XCircle, Send, PlusCircle, AlertTriangle } from "lucide-react";

const TIMELINE_ICON: Record<TimelineKind, typeof FileText> = {
    customerAdded: User,
    invoiceIssued: Receipt,
    payment: Wallet,
    invoiceOverdue: AlertTriangle,
    quotationCreated: PlusCircle,
    quotationSent: Send,
    quotationAccepted: CheckCircle2,
    quotationRejected: XCircle,
    quotationConverted: ClipboardCheck,
};

const Chip = ({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "primary" | "success" | "warn" }) => (
    <span
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            tone === "primary" ? "bg-primary/10 text-primary" : tone === "success" ? "bg-success/15 text-success" : tone === "warn" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground"
        }`}
    >
        {children}
    </span>
);

const Profile = ({ customerKey, initialTab }: { customerKey: string; initialTab: string }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { invoiceForClient, loadInvoice } = useInvoiceContext();
    const { records, invoices, quotations, senders, converted, loaded, reload } = useCustomers();

    const [tab, setTab] = useState(["overview", "documents", "statement", "activity"].includes(initialTab) ? initialTab : "overview");
    const [editing, setEditing] = useState<{ row: CustomerRecord | null } | null>(null);
    const [paying, setPaying] = useState<CustomerRecord | null>(null);
    const [currencyChoice, setCurrencyChoice] = useState<string | null>(null);

    const record = records.find((r) => r.key === customerKey) ?? null;
    const docs = useMemo(() => (record ? documentsOf(record.key, invoices, quotations) : { invoices: [], quotations: [] }), [record, invoices, quotations]);
    const currencies = useMemo(() => (record ? currenciesOf([record]) : []), [record]);

    const date = (d: Date | null) => (d ? d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : "—");

    if (!loaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    if (!record) {
        return (
            <div className="rounded-xl border border-dashed p-10 text-center" data-testid="profile-missing">
                <p className="text-sm text-muted-foreground">{_t("crm.profile.notFound")}</p>
                <GuardedLink href="/clients" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">{_t("crm.profile.back")}</GuardedLink>
            </div>
        );
    }

    const currency = currencyChoice && currencies.includes(currencyChoice) ? currencyChoice : record.primaryCurrency;
    const money = (v: number) => formatMoney(v, currency, locale);
    const inv = record.invoices;
    const q = record.quotes;
    const p = record.profile;

    const insights = customerInsights(record, docs, { all: records });
    const timeline = timelineOf(p, docs);
    const trend = monthlyInvoiced(docs.invoices, currency);
    const trendInfo = trendOf(trend);
    const recent = buildStatement(invoices, record.key, { currency }).rows.slice(-8).reverse();
    const gstinOk = record.gstin ? validateGstin(record.gstin).valid : null;

    const startInvoice = () =>
        invoiceForClient({
            name: record.name,
            email: record.email,
            phone: record.phone,
            address: p?.address ?? "",
            zipCode: p?.zipCode ?? "",
            city: p?.city ?? record.city,
            country: p?.country ?? "",
            gstin: record.gstin,
            shippingAddress: p?.shippingAddress,
        });

    const toggleActive = async () => {
        if (!p) return;
        const list = await readParties("receiver");
        const now = new Date().toISOString();
        await replaceParties(
            "receiver",
            list.map((x) => {
                if (x.id !== p.id) return x;
                const next = { ...x, updatedAt: now };
                if (record.active) next.inactive = true;
                else delete next.inactive;
                return next;
            })
        );
        await reload();
        toast({ title: _t(record.active ? "crm.profile.markedInactive" : "crm.profile.markedActive"), description: record.name });
    };

    const owes = inv ? Object.values(inv.outstanding).some((v) => v > 0) : false;
    const monthLabel = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 1).toLocaleDateString(locale, { month: "short" });

    const b = record.behaviour;
    const f = record.frequency;

    return (
        <div className="space-y-6" data-testid="customer-profile" data-key={record.key}>
            <div>
                <GuardedLink href="/clients" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    {_t("crm.profile.back")}
                </GuardedLink>

                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                        <h1 className="break-words text-2xl font-semibold tracking-tight sm:text-3xl" data-testid="profile-name">{record.name}</h1>
                        {record.company && <p className="text-sm text-muted-foreground">{record.company}</p>}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            <Chip tone={record.active ? "success" : "muted"}>{record.active ? _t("crm.active") : _t("crm.inactive")}</Chip>
                            {record.category && <Chip tone="primary">{record.category}</Chip>}
                            {record.tags.map((t) => (
                                <Chip key={t}>{t}</Chip>
                            ))}
                            {!p && <Chip>{_t("clients.fromInvoices")}</Chip>}
                            {record.behaviour.class !== "unknown" && <Chip tone={b.class === "reliable" ? "success" : b.class === "late" ? "warn" : "muted"}>{_t(`crm.behaviour.class.${b.class}`)}</Chip>}
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-2" data-testid="quick-actions">
                        <BaseButton onClick={startInvoice} data-testid="qa-invoice">
                            <FilePlus2 className="h-4 w-4" />
                            {_t("clients.newInvoice")}
                        </BaseButton>
                        <GuardedLink
                            href={`/quotations/builder?customer=${encodeURIComponent(record.key)}`}
                            data-testid="qa-quotation"
                            className="inline-flex h-10 items-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                            <FileSignature className="h-4 w-4" aria-hidden />
                            {_t("clients.newQuotation")}
                        </GuardedLink>
                        <BaseButton variant="outline" onClick={() => setPaying(record)} disabled={!owes} data-testid="qa-payment">
                            <CircleDollarSign className="h-4 w-4" />
                            {_t("crm.actions.recordPayment")}
                        </BaseButton>
                        <BaseButton variant="outline" onClick={() => setTab("statement")} data-testid="qa-statement">
                            <FileText className="h-4 w-4" />
                            {_t("crm.actions.statement")}
                        </BaseButton>
                        <BaseButton variant="outline" onClick={() => setTab("documents")} data-testid="qa-documents">
                            {_t("crm.actions.documents")}
                        </BaseButton>
                        <BaseButton variant="outline" onClick={() => setEditing({ row: record })} data-testid="qa-edit">
                            <Pencil className="h-4 w-4" />
                            {p ? _t("clients.edit") : _t("clients.saveToBook")}
                        </BaseButton>
                    </div>
                </div>
            </div>

            <Tabs value={tab} onValueChange={setTab}>
                <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto" data-testid="profile-tabs">
                    <TabsTrigger value="overview">{_t("crm.tabs.overview")}</TabsTrigger>
                    <TabsTrigger value="documents">{_t("crm.tabs.documents")}</TabsTrigger>
                    <TabsTrigger value="statement">{_t("crm.tabs.statement")}</TabsTrigger>
                    <TabsTrigger value="activity">{_t("crm.tabs.activity")}</TabsTrigger>
                </TabsList>

                {/* ------------------------------------------------ overview */}
                <TabsContent value="overview" className="mt-6 space-y-6">
                    {currencies.length > 1 && (
                        <div className="flex items-center gap-2 text-sm">
                            <span className="text-muted-foreground">{_t("crm.profile.currency")}</span>
                            <Select value={currency} onValueChange={setCurrencyChoice}>
                                <SelectTrigger className="h-8 w-28" aria-label={_t("crm.profile.currency")}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {currencies.map((c) => (
                                        <SelectItem key={c} value={c}>{c}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" data-testid="financial-overview">
                        <StatCard testId="fo-invoiced" label={_t("crm.financial.invoiced")} value={money(inv?.billed[currency] ?? 0)} sub={_t("crm.financial.invoicesCount", { count: inv?.issuedCount ?? docs.invoices.filter((i) => displayStatus(i) !== "draft" && displayStatus(i) !== "cancelled").length })} />
                        <StatCard testId="fo-paid" label={_t("crm.financial.paid")} value={money(inv?.paid[currency] ?? 0)} tone="text-success" />
                        <StatCard testId="fo-outstanding" label={_t("crm.financial.outstanding")} value={money(inv?.outstanding[currency] ?? 0)} />
                        <StatCard testId="fo-overdue" label={_t("crm.financial.overdue")} value={money(inv?.overdue[currency] ?? 0)} tone={(inv?.overdue[currency] ?? 0) > 0 ? "text-destructive" : ""} sub={inv?.overdueCount ? _t("crm.financial.overdueCount", { count: inv.overdueCount }) : undefined} />
                        <StatCard testId="fo-quotes" label={_t("crm.financial.quotations")} value={q.count} sub={_t("crm.financial.quotesHint", { accepted: q.accepted, pending: q.pending })} />
                        <StatCard testId="fo-accepted" label={_t("crm.financial.acceptedValue")} value={money(q.acceptedValue[currency] ?? 0)} sub={q.acceptedNotInvoiced.length ? _t("crm.financial.notInvoiced", { count: q.acceptedNotInvoiced.length }) : undefined} />
                    </div>

                    <div className="grid gap-6 lg:grid-cols-3">
                        <Panel title={_t("crm.profile.details")} className="lg:col-span-1" testId="profile-details">
                            <dl className="space-y-3 text-sm">
                                {record.contactPerson && (
                                    <div><dt className="text-xs text-muted-foreground">{_t("crm.form.contactPerson")}</dt><dd className="flex items-center gap-2"><User className="h-4 w-4 text-muted-foreground" aria-hidden />{record.contactPerson}</dd></div>
                                )}
                                {record.email && (
                                    <div><dt className="text-xs text-muted-foreground">{_t("clients.fields.email")}</dt><dd className="flex items-center gap-2"><Mail className="h-4 w-4 text-muted-foreground" aria-hidden /><a className="break-all underline-offset-4 hover:underline" href={`mailto:${record.email}`}>{record.email}</a></dd></div>
                                )}
                                {record.phone && (
                                    <div><dt className="text-xs text-muted-foreground">{_t("clients.fields.phone")}</dt><dd className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted-foreground" aria-hidden />{record.phone}</dd></div>
                                )}
                                {record.website && (
                                    <div><dt className="text-xs text-muted-foreground">{_t("crm.form.website")}</dt><dd className="flex items-center gap-2"><Globe className="h-4 w-4 text-muted-foreground" aria-hidden /><span className="break-all">{record.website}</span></dd></div>
                                )}
                                {record.gstin && (
                                    <div>
                                        <dt className="text-xs text-muted-foreground">{_t("gst.gstin")}</dt>
                                        <dd className="flex items-center gap-2 tabular-nums" data-testid="profile-gstin">
                                            {record.gstin}
                                            {gstinOk && <BadgeCheck className="h-4 w-4 text-success" aria-label={_t("crm.profile.gstinFormatOk")} />}
                                        </dd>
                                    </div>
                                )}
                                <div>
                                    <dt className="text-xs text-muted-foreground">{_t("clients.billing")}</dt>
                                    <dd className="whitespace-pre-line">{[p?.address, [p?.zipCode, p?.city].filter(Boolean).join(" "), p?.country].filter(Boolean).join("\n") || "—"}</dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-muted-foreground">{_t("clients.shipping")}</dt>
                                    <dd className="whitespace-pre-line">
                                        {p?.shippingAddress ? [p.shippingAddress.address, [p.shippingAddress.zipCode, p.shippingAddress.city].filter(Boolean).join(" "), p.shippingAddress.country].filter(Boolean).join("\n") : _t("clients.sameAsBilling")}
                                    </dd>
                                </div>
                                <div className="rounded-lg bg-muted/50 p-3" data-testid="profile-notes">
                                    <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("clients.notes")}</dt>
                                    <dd className="mt-1 whitespace-pre-line">{p?.notes || _t("clients.noNotes")}</dd>
                                </div>
                            </dl>
                            {p && (
                                <BaseButton variant="ghost" size="sm" className="mt-3" onClick={toggleActive} data-testid="toggle-active">
                                    {record.active ? _t("crm.profile.markInactive") : _t("crm.profile.markActive")}
                                </BaseButton>
                            )}
                        </Panel>

                        <div className="min-w-0 space-y-6 lg:col-span-2">
                            <Panel title={_t("crm.insights.title")} testId="profile-insights">
                                <InsightsList insights={insights} empty={_t("crm.insights.none")} />
                            </Panel>

                            <div className="grid gap-6 md:grid-cols-2">
                                <Panel title={_t("crm.behaviour.title")} testId="profile-behaviour">
                                    {b.class === "unknown" ? (
                                        <p className="text-sm text-muted-foreground" data-testid="behaviour-unknown">{_t("crm.behaviour.unknown", { count: b.paidInvoices })}</p>
                                    ) : (
                                        <dl className="space-y-2 text-sm">
                                            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{_t("crm.behaviour.onTime")}</dt><dd className="tabular-nums" data-testid="beh-ontime">{Math.round((b.onTimeRate ?? 0) * 100)}%</dd></div>
                                            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{_t("crm.behaviour.avgDays")}</dt><dd className="tabular-nums" data-testid="beh-days">{Math.round(b.avgDaysToPay ?? 0)}</dd></div>
                                            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{_t("crm.behaviour.avgLate")}</dt><dd className="tabular-nums">{b.lateCount ? Math.round(b.avgDaysLate ?? 0) : "—"}</dd></div>
                                            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{_t("crm.behaviour.paidInvoices")}</dt><dd className="tabular-nums">{b.paidInvoices}</dd></div>
                                        </dl>
                                    )}
                                    <p className="mt-3 text-xs text-muted-foreground">{_t("crm.behaviour.definition")}</p>
                                </Panel>

                                <Panel title={_t("crm.frequency.title")} testId="profile-frequency">
                                    <dl className="space-y-2 text-sm">
                                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{_t("crm.frequency.year")}</dt><dd className="tabular-nums" data-testid="freq-year">{f.count12m}</dd></div>
                                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{_t("crm.frequency.gap")}</dt><dd className="tabular-nums">{f.avgGapDays === null ? "—" : _t("crm.frequency.days", { days: Math.round(f.avgGapDays) })}</dd></div>
                                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{_t("crm.frequency.last")}</dt><dd className="tabular-nums">{f.daysSinceLast === null ? "—" : _t("crm.frequency.daysAgo", { days: f.daysSinceLast })}</dd></div>
                                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{_t("crm.frequency.total")}</dt><dd className="tabular-nums">{f.total}</dd></div>
                                    </dl>
                                </Panel>
                            </div>

                            <Panel title={_t("crm.trend.title", { currency })} testId="profile-trend">
                                <BarChart
                                    ariaLabel={_t("crm.trend.title", { currency })}
                                    series={[{ name: _t("crm.financial.invoiced"), color: "hsl(var(--primary))" }]}
                                    format={(v) => money(v)}
                                    data={trend.map((pt) => ({ label: monthLabel(pt.ym), values: [pt.invoiced], title: `${monthLabel(pt.ym)}: ${money(pt.invoiced)}` }))}
                                />
                                <p className="mt-2 text-xs text-muted-foreground" data-testid="trend-note">
                                    {trendInfo.direction === "none"
                                        ? _t("crm.trend.none")
                                        : trendInfo.direction === "flat"
                                          ? _t("crm.trend.flat")
                                          : trendInfo.change === null
                                            ? _t("crm.trend.new")
                                            : _t(trendInfo.direction === "up" ? "crm.trend.up" : "crm.trend.down", { percent: Math.round(Math.abs(trendInfo.change) * 100) })}
                                </p>
                            </Panel>

                            <Panel
                                title={_t("crm.recent.title")}
                                action={
                                    <BaseButton variant="ghost" size="sm" onClick={() => setTab("statement")}>
                                        {_t("crm.recent.all")}
                                    </BaseButton>
                                }
                                testId="recent-transactions"
                            >
                                {recent.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">{_t("crm.recent.none")}</p>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <tbody>
                                                {recent.map((r, i) => (
                                                    <tr key={i} className="border-t first:border-t-0" data-testid="recent-row">
                                                        <td className="py-2 pe-3 text-muted-foreground">{date(parseDate(r.date))}</td>
                                                        <td className="py-2 pe-3"><span className="font-medium">{r.ref}</span> <span className="text-xs text-muted-foreground">{_t(r.kind === "invoice" ? "crm.statement.typeInvoice" : "crm.statement.typePayment")}</span></td>
                                                        <td className={`py-2 text-end tabular-nums ${r.credit ? "text-success" : ""}`}>{r.credit ? `− ${money(r.credit)}` : money(r.debit)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </Panel>
                        </div>
                    </div>
                </TabsContent>

                {/* ----------------------------------------------- documents */}
                <TabsContent value="documents" className="mt-6 space-y-6">
                    <Panel
                        title={_t("crm.documents.invoices")}
                        testId="documents-invoices"
                        action={
                            <GuardedLink href={`/invoices?client=${encodeURIComponent(record.name)}`} className="text-xs font-medium text-primary hover:underline">
                                {_t("dashboard.viewAll")}
                            </GuardedLink>
                        }
                    >
                        {docs.invoices.length === 0 ? (
                            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{_t("clients.noInvoices")}</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[34rem] text-sm">
                                    <thead className="text-xs text-muted-foreground">
                                        <tr>
                                            <th className="py-2 text-start font-medium">{_t("crm.documents.number")}</th>
                                            <th className="py-2 text-start font-medium">{_t("crm.documents.date")}</th>
                                            <th className="py-2 text-start font-medium">{_t("crm.documents.due")}</th>
                                            <th className="py-2 text-end font-medium">{_t("crm.documents.total")}</th>
                                            <th className="py-2 text-end font-medium">{_t("crm.documents.balance")}</th>
                                            <th className="py-2 ps-4 text-start font-medium">{_t("crm.documents.status")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {docs.invoices.map((i) => (
                                            <tr key={i.details.invoiceNumber} className="border-t" data-testid="doc-invoice">
                                                <td className="py-2">
                                                    <button type="button" className="font-medium hover:underline" onClick={() => loadInvoice(i)}>{i.details.invoiceNumber}</button>
                                                    {i.details.quotationRef && <span className="ms-2 text-xs text-muted-foreground">{_t("crm.documents.from", { number: i.details.quotationRef.number })}</span>}
                                                </td>
                                                <td className="py-2 text-muted-foreground">{date(parseDate(i.details.invoiceDate))}</td>
                                                <td className="py-2 text-muted-foreground">{date(parseDate(i.details.dueDate))}</td>
                                                <td className="py-2 text-end tabular-nums">{formatMoney(invoiceTotal(i), i.details.currency, locale)}</td>
                                                <td className="py-2 text-end tabular-nums">{balanceDue(i) > 0 ? formatMoney(balanceDue(i), i.details.currency, locale) : "—"}</td>
                                                <td className="py-2 ps-4"><StatusBadge status={displayStatus(i)} /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Panel>

                    <Panel
                        title={_t("crm.documents.quotations")}
                        testId="documents-quotations"
                        action={
                            <GuardedLink href={`/quotations?customer=${encodeURIComponent(record.key)}`} className="text-xs font-medium text-primary hover:underline">
                                {_t("dashboard.viewAll")}
                            </GuardedLink>
                        }
                    >
                        {docs.quotations.length === 0 ? (
                            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{_t("quotations.customerSection.none")}</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[30rem] text-sm">
                                    <thead className="text-xs text-muted-foreground">
                                        <tr>
                                            <th className="py-2 text-start font-medium">{_t("crm.documents.number")}</th>
                                            <th className="py-2 text-start font-medium">{_t("crm.documents.validUntil")}</th>
                                            <th className="py-2 text-end font-medium">{_t("crm.documents.total")}</th>
                                            <th className="py-2 ps-4 text-start font-medium">{_t("crm.documents.status")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {docs.quotations.map((x) => (
                                            <tr key={x.id} className="border-t" data-testid="doc-quotation">
                                                <td className="py-2">
                                                    <span className="font-medium">{numberOf(x)}</span>
                                                    {converted.get(x.id) && <span className="ms-2 text-xs text-success">{_t("quotations.convertedBadge")} · {converted.get(x.id)}</span>}
                                                </td>
                                                <td className="py-2 text-muted-foreground">
                                                    {date(validUntilOf(x))}
                                                    <span className="ms-2"><ExpiryNote quotation={x} /></span>
                                                </td>
                                                <td className="py-2 text-end tabular-nums">{formatMoney(totalOf(x), currencyOf(x), locale)}</td>
                                                <td className="py-2 ps-4"><QuotationStatusBadge status={quotationStatus(x)} /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Panel>
                </TabsContent>

                {/* ------------------------------------------------ statement */}
                <TabsContent value="statement" className="mt-6">
                    <StatementPanel record={record} invoices={invoices} quotations={quotations} senders={senders} />
                </TabsContent>

                {/* -------------------------------------------------- activity */}
                <TabsContent value="activity" className="mt-6">
                    <Panel title={_t("crm.timeline.title")} testId="profile-timeline">
                        {timeline.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{_t("crm.timeline.none")}</p>
                        ) : (
                            <ol className="space-y-4 border-s ps-6" data-testid="timeline">
                                {timeline.slice(0, 100).map((e, i) => {
                                    const Icon = TIMELINE_ICON[e.kind] ?? Clock;
                                    const params: Record<string, string | number> = { ref: e.ref, to: e.to ?? "" };
                                    if (e.amount !== undefined && e.currency) params.amount = formatMoney(e.amount, e.currency, locale);
                                    return (
                                        <li key={i} className="relative text-sm" data-testid="timeline-event" data-kind={e.kind}>
                                            <span aria-hidden className="absolute -start-[2.05rem] top-0.5 flex h-6 w-6 items-center justify-center rounded-full border bg-background text-muted-foreground">
                                                <Icon className="h-3.5 w-3.5" />
                                            </span>
                                            <p>{_t(`crm.timeline.kinds.${e.kind}`, params)}</p>
                                            <p className="text-xs text-muted-foreground">{date(e.at)}</p>
                                        </li>
                                    );
                                })}
                            </ol>
                        )}
                    </Panel>
                </TabsContent>
            </Tabs>

            <CustomerDialog state={editing} records={records} onClose={() => setEditing(null)} />
            <RecordPaymentDialog record={paying} onClose={() => setPaying(null)} />
        </div>
    );
};

const Inner = () => {
    const params = useSearchParams();
    const key = params.get("key") ?? "";
    return <Profile customerKey={key} initialTab={params.get("tab") ?? "overview"} />;
};

/** Reads `?key=` (and an optional `?tab=`); Next requires a Suspense boundary for that. */
const CustomerProfilePage = () => (
    <Suspense fallback={<Skeleton className="h-96 rounded-xl" aria-busy="true" />}>
        <Inner />
    </Suspense>
);

export default CustomerProfilePage;
