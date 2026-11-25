"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useMessages } from "next-intl";
import { useSearchParams } from "next/navigation";
import { FormProvider, useForm, useFormContext, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useDebounce } from "use-debounce";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import GuardedLink from "@/app/components/layout/GuardedLink";
import BillFromSection from "@/app/components/invoice/form/sections/BillFromSection";
import BillToSection from "@/app/components/invoice/form/sections/BillToSection";
import Charges from "@/app/components/invoice/form/Charges";
import CurrencySelector from "@/app/components/reusables/form-fields/CurrencySelector";
import DatePickerFormField from "@/app/components/reusables/form-fields/DatePickerFormField";
import DynamicInvoiceTemplate from "@/app/components/templates/invoice-pdf/DynamicInvoiceTemplate";
import FormFile from "@/app/components/reusables/form-fields/FormFile";
import FormInput from "@/app/components/reusables/form-fields/FormInput";
import FormTextarea from "@/app/components/reusables/form-fields/FormTextarea";
import Items from "@/app/components/invoice/form/sections/Items";
import TemplateGallery from "@/app/components/invoice/form/TemplateGallery";
import GstSection from "@/app/components/invoice/form/sections/GstSection";
import { QuotationStatusBadge } from "./QuotationStatusBadge";

import { buildInvoiceLabels } from "@/app/components/templates/invoice-pdf/invoiceLabels";
import { PAPER_SIZES, resolveTheme } from "@/app/components/templates/invoice-pdf/invoiceTheme";
import { ChargesContextProvider } from "@/contexts/ChargesContext";
import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useQuotations } from "@/contexts/useQuotations";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { useWarmPdfRenderer } from "@/hooks/useWarmPdfRenderer";
import { useRouter } from "@/i18n/navigation";
import { clientKey, parseDate } from "@/lib/invoiceRecords";
import { readParties, toDocumentParty } from "@/lib/partyStore";
import { fetchQuotationPdf, downloadBlob, openBlobInTab, quotationFilename } from "@/lib/quotationPdf";
import { saveQuotation } from "@/lib/quotationStore";
import {
    DEFAULT_VALIDITY_DAYS,
    canEdit,
    displayStatus,
    numberOf,
    suggestQuotationNumber,
    type Quotation,
} from "@/lib/quotations";
import { InvoiceSchema } from "@/lib/schemas";
import { FORM_DEFAULT_VALUES } from "@/lib/variables";
import type { InvoiceType } from "@/types";

import { ArrowLeft, Eye, FileDown, Printer, Save, Send } from "lucide-react";

const VALIDITY_PRESETS = [7, 15, 30, 60];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

type Loose = Record<string, unknown>;

/** Form-ready values for an existing quotation: the pickers want real Dates. */
function fromQuotation(q: Quotation): InvoiceType {
    const doc = clone(q.doc);
    const d = doc.details as unknown as Loose;
    d.invoiceDate = parseDate(doc.details.invoiceDate) ?? new Date();
    d.dueDate = parseDate(doc.details.dueDate) ?? addDays(new Date(), DEFAULT_VALIDITY_DAYS);
    return doc;
}

/**
 * A new quotation that already knows who is sending it and how it should look:
 * it carries over the business, branding, template and currency from your most
 * recent document, exactly as "quick invoice" does.
 */
function blankQuotation(opts: { number: string; carry: InvoiceType | null; sender?: InvoiceType["sender"]; receiver?: InvoiceType["receiver"] }): InvoiceType {
    const base = clone(FORM_DEFAULT_VALUES) as unknown as InvoiceType;
    const d = base.details as unknown as Loose;
    const today = new Date();
    d.invoiceNumber = opts.number;
    d.invoiceDate = today;
    d.dueDate = addDays(today, DEFAULT_VALIDITY_DAYS);
    d.paymentTerms = "Net 30";

    const src = opts.carry ? clone(opts.carry) : null;
    // The invoice form's empty bank-detail defaults are not valid data; a
    // quotation only carries payment details that are actually filled in.
    delete d.paymentInformation;
    if (src) {
        base.sender = src.sender;
        const pay = src.details.paymentInformation;
        if (pay?.bankName && pay.accountName && pay.accountNumber) d.paymentInformation = pay;
        for (const k of ["invoiceLogo", "currency", "language", "pdfTemplate", "theme", "terms"] as const) {
            if (src.details[k] !== undefined) d[k] = src.details[k];
        }
        if (src.details.gst?.enabled) {
            // GST stays on for a GST business; the place of supply is per customer.
            d.gst = { enabled: true, pricing: src.details.gst.pricing ?? "exclusive", placeOfSupply: "" };
        }
    } else if (opts.sender) {
        base.sender = opts.sender;
    }
    if (opts.receiver) base.receiver = { ...base.receiver, ...opts.receiver };
    return base;
}

/* ------------------------------------------------------------- preview */

const SheetPreview = () => {
    const { control } = useFormContext<InvoiceType>();
    const locale = useLocale();
    const messages = useMessages();
    const labels = useMemo(() => buildInvoiceLabels(messages as Record<string, unknown>, "quotation"), [messages]);
    const values = useWatch({ control }) as InvoiceType;
    // Preview a moment after typing stops: re-rendering a whole document on
    // every keystroke is wasted work.
    const [data] = useDebounce(values, 300);

    const paper = PAPER_SIZES[resolveTheme(data?.details?.theme).paper];
    const paneRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);
    const [height, setHeight] = useState(0);

    useEffect(() => {
        const measure = () => {
            const pane = paneRef.current;
            const content = contentRef.current;
            if (!pane) return;
            setScale(Math.min(1, pane.clientWidth / paper.viewport.width));
            if (content) setHeight(content.scrollHeight);
        };
        measure();
        const ro = new ResizeObserver(measure);
        if (paneRef.current) ro.observe(paneRef.current);
        if (contentRef.current) ro.observe(contentRef.current);
        return () => ro.disconnect();
    }, [paper.viewport.width, data]);

    if (!data?.details?.items) return <Skeleton className="h-96 w-full" />;

    return (
        <div ref={paneRef} className="w-full overflow-hidden rounded-lg bg-muted/40 p-0" data-testid="quotation-preview">
            <div style={{ height: height * scale }}>
                <div ref={contentRef} style={{ width: paper.viewport.width, transform: `scale(${scale})`, transformOrigin: "top left" }}>
                    <DynamicInvoiceTemplate {...data} labels={labels} locale={locale} />
                </div>
            </div>
        </div>
    );
};

/* -------------------------------------------------------------- the form */

const Card = ({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) => (
    <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6" data-testid={testId}>
        <h2 className="mb-4 text-base font-semibold">{title}</h2>
        {children}
    </section>
);

const BuilderForm = ({ initial, existing }: { initial: InvoiceType; existing: Quotation | null }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const router = useRouter();
    const isDesktop = useIsDesktop();
    const { converted } = useQuotations();

    // Quotations render through the same Chromium as invoices.
    useWarmPdfRenderer();

    const form = useForm<InvoiceType>({ resolver: zodResolver(InvoiceSchema), defaultValues: initial, mode: "onTouched" });
    const { getValues, setValue, setError, handleSubmit, formState } = form;

    const [busy, setBusy] = useState<null | "save" | "send" | "pdf" | "print">(null);
    const [previewOpen, setPreviewOpen] = useState(false);

    // Warn before a reload or tab close throws away edits.
    useEffect(() => {
        if (!formState.isDirty) return;
        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, [formState.isDirty]);

    const setValidity = (days: number) => {
        const issued = parseDate(getValues("details.invoiceDate")) ?? new Date();
        setValue("details.dueDate", addDays(issued, days) as unknown as string, { shouldDirty: true, shouldValidate: true });
    };

    const onInvalid = useCallback(
        (errors: unknown) => {
            // The first problem, named, so the user is not left hunting.
            const walk = (node: unknown, path: string[]): { path: string; message: string } | null => {
                if (!node || typeof node !== "object") return null;
                const rec = node as Record<string, unknown>;
                if (typeof rec.message === "string") return { path: path.join("."), message: rec.message };
                for (const [k, v] of Object.entries(rec)) {
                    if (k === "ref") continue;
                    const hit = walk(v, [...path, k]);
                    if (hit) return hit;
                }
                return null;
            };
            const first = walk(errors, []);
            toast({
                variant: "destructive",
                title: _t("quotations.errors.invalid", { message: first ? `${first.path}: ${first.message}` : "" }),
            });
        },
        [_t]
    );

    const persist = useCallback(
        (kind: "save" | "send") =>
            handleSubmit(async (values) => {
                setBusy(kind);
                try {
                    const result = await saveQuotation({ id: existing?.id, doc: values, status: kind === "send" ? "sent" : undefined }, converted);
                    if (result.ok) {
                        toast({ title: _t("quotations.toast.saved"), description: numberOf(result.quotation) });
                        // The saved copy is now the baseline: leaving is not "losing edits".
                        form.reset(values, { keepValues: true });
                        router.push("/quotations");
                    } else if (result.reason === "numberTaken") {
                        setError("details.invoiceNumber", { message: _t("quotations.errors.numberTaken") });
                        toast({ variant: "destructive", title: _t("quotations.errors.numberTaken") });
                    } else if (result.reason === "invalid" && "message" in result) {
                        toast({ variant: "destructive", title: _t("quotations.errors.invalid", { message: `${result.path}: ${result.message}` }) });
                    } else {
                        toast({ variant: "destructive", title: _t(`quotations.errors.${result.reason}`) });
                    }
                } finally {
                    setBusy(null);
                }
            }, onInvalid),
        [handleSubmit, existing?.id, converted, _t, form, router, setError, onInvalid]
    );

    const pdf = useCallback(
        (mode: "pdf" | "print") =>
            handleSubmit(async (values) => {
                setBusy(mode);
                try {
                    const blob = await fetchQuotationPdf(values, locale);
                    if (mode === "pdf") downloadBlob(blob, quotationFilename(values.details.invoiceNumber));
                    else openBlobInTab(blob);
                } catch (e) {
                    console.error(e);
                    toast({ variant: "destructive", title: _t("quotations.toast.pdfFailed"), description: _t("quotations.toast.pdfFailedBody") });
                } finally {
                    setBusy(null);
                }
            }, onInvalid),
        [handleSubmit, locale, _t, onInvalid]
    );

    const status = existing ? displayStatus(existing) : "draft";
    const canSend = !existing || existing.status === "draft" || existing.status === "rejected";

    return (
        <FormProvider {...form}>
            <ChargesContextProvider>
                <div className="space-y-6" data-testid="quotation-builder">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <GuardedLink href="/quotations" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                                <ArrowLeft className="h-4 w-4" aria-hidden />
                                {_t("quotations.builder.back")}
                            </GuardedLink>
                            <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                                {existing ? _t("quotations.builder.titleEdit") : _t("quotations.builder.titleNew")}
                                {existing && <QuotationStatusBadge status={status} />}
                            </h1>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {!isDesktop && (
                                <BaseButton variant="outline" onClick={() => setPreviewOpen(true)} data-testid="open-preview">
                                    <Eye className="h-4 w-4" />
                                    {_t("quotations.builder.preview")}
                                </BaseButton>
                            )}
                            <BaseButton variant="outline" onClick={pdf("pdf")} loading={busy === "pdf"} disabled={busy !== null} data-testid="builder-pdf">
                                <FileDown className="h-4 w-4" />
                                {_t("quotations.actions.pdf")}
                            </BaseButton>
                            <BaseButton variant="outline" onClick={pdf("print")} loading={busy === "print"} disabled={busy !== null} data-testid="builder-print">
                                <Printer className="h-4 w-4" />
                                {_t("quotations.actions.print")}
                            </BaseButton>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
                        <div className="min-w-0 space-y-6">
                            <Card title={_t("quotations.builder.details")} testId="q-details">
                                <div className="flex flex-col gap-3">
                                    <FormFile name="details.invoiceLogo" label={_t("form.steps.invoiceDetails.invoiceLogo.label")} placeholder={_t("form.steps.invoiceDetails.invoiceLogo.placeholder")} />
                                    <FormInput name="details.invoiceNumber" label={_t("quotations.builder.number")} placeholder="QUO-0001" />
                                    <DatePickerFormField name="details.invoiceDate" label={_t("quotations.builder.issueDate")} />
                                    <DatePickerFormField name="details.dueDate" label={_t("quotations.builder.validUntil")} />
                                    <div className="flex flex-wrap items-center gap-2 text-sm">
                                        <span className="text-muted-foreground">{_t("quotations.builder.validFor")}:</span>
                                        {VALIDITY_PRESETS.map((n) => (
                                            <BaseButton key={n} variant="outline" size="sm" className="h-8" onClick={() => setValidity(n)} data-testid={`validity-${n}`}>
                                                {_t("quotations.builder.validDays", { days: n })}
                                            </BaseButton>
                                        ))}
                                    </div>
                                    <CurrencySelector name="details.currency" label={_t("form.steps.invoiceDetails.currency")} placeholder="Select Currency" />
                                    <GstSection />
                                    <TemplateGallery />
                                </div>
                            </Card>

                            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                                <Card title={_t("quotations.builder.business")} testId="q-business"><BillFromSection /></Card>
                                <Card title={_t("quotations.builder.customer")} testId="q-customer"><BillToSection /></Card>
                            </div>

                            <Card title={_t("quotations.builder.items")} testId="q-items"><Items /></Card>

                            <Card title={_t("quotations.builder.summary")} testId="q-summary">
                                <div className="grid grid-cols-1 gap-8">
                                    <div className="flex min-w-0 flex-col gap-3">
                                        <FormTextarea name="details.paymentTerms" label={_t("quotations.builder.paymentTerms")} placeholder={_t("quotations.builder.paymentTermsPlaceholder")} />
                                        <FormTextarea name="details.additionalNotes" label={_t("quotations.builder.notes")} placeholder={_t("quotations.builder.notes")} />
                                        <FormTextarea name="details.terms" label={_t("quotations.builder.terms")} placeholder={_t("quotations.builder.termsPlaceholder")} maxLength={2000} />
                                    </div>
                                    <Charges />
                                </div>
                            </Card>

                            <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
                                <BaseButton variant="outline" onClick={persist("save")} loading={busy === "save"} disabled={busy !== null} data-testid="save-quotation">
                                    <Save className="h-4 w-4" />
                                    {existing && existing.status !== "draft" ? _t("quotations.builder.saveChanges") : _t("quotations.builder.saveDraft")}
                                </BaseButton>
                                {canSend && (
                                    <BaseButton onClick={persist("send")} loading={busy === "send"} disabled={busy !== null} data-testid="save-send-quotation">
                                        <Send className="h-4 w-4" />
                                        {_t("quotations.builder.saveSend")}
                                    </BaseButton>
                                )}
                            </div>
                        </div>

                        {isDesktop && (
                            <aside className="min-w-0">
                                <div className="sticky top-4">
                                    <SheetPreview />
                                </div>
                            </aside>
                        )}
                    </div>

                    <Dialog open={previewOpen && !isDesktop} onOpenChange={setPreviewOpen}>
                        <DialogContent className="max-h-[90vh] overflow-y-auto p-3 sm:max-w-3xl">
                            <DialogHeader>
                                <DialogTitle>{_t("quotations.builder.preview")}</DialogTitle>
                                <DialogDescription>{_t("quotations.builder.titleNew")}</DialogDescription>
                            </DialogHeader>
                            {previewOpen && <SheetPreview />}
                        </DialogContent>
                    </Dialog>
                </div>
            </ChargesContextProvider>
        </FormProvider>
    );
};

/* ---------------------------------------------------------------- loader */

/**
 * Resolves what to show (a new blank quotation, one for a given customer, or
 * an existing one to edit) before mounting the form, so the form's default
 * values are right from the first render.
 */
const QuotationBuilder = () => {
    const { _t } = useTranslationContext();
    const params = useSearchParams();
    const { savedInvoices } = useInvoiceContext();
    const { quotations, converted, loaded } = useQuotations();
    const id = params.get("id");
    const customer = params.get("customer");

    const [prefill, setPrefill] = useState<{ receiver?: InvoiceType["receiver"]; sender?: InvoiceType["sender"]; ready: boolean }>({ ready: false });

    useEffect(() => {
        let active = true;
        (async () => {
            const [receivers, senders] = await Promise.all([readParties("receiver"), readParties("sender")]);
            if (!active) return;
            let receiver: InvoiceType["receiver"] | undefined;
            if (customer) {
                const saved = receivers.find((p) => clientKey(p) === customer);
                if (saved) {
                    // The address-book extras (id, notes, CRM fields) do not belong on a document.
                    receiver = toDocumentParty(saved);
                } else {
                    // An unsaved customer: take their details from the latest document naming them.
                    const fromDoc = [...savedInvoices.map((i) => i.receiver), ...quotations.map((q) => q.doc.receiver)].reverse().find((r) => clientKey(r) === customer);
                    if (fromDoc) receiver = clone(fromDoc);
                }
            }
            const { id: _s, notes: _sn, createdAt: _sc, ...sender } = senders[0] ?? ({} as Record<string, unknown>);
            setPrefill({ receiver, sender: senders[0] ? (sender as unknown as InvoiceType["sender"]) : undefined, ready: true });
        })();
        return () => {
            active = false;
        };
        // Resolved once per visit; later changes to the lists must not reset a form being edited.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [customer]);

    if (!loaded || !prefill.ready) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    if (id) {
        const existing = quotations.find((q) => q.id === id) ?? null;
        if (!existing) {
            return (
                <div className="rounded-xl border border-dashed p-10 text-center" data-testid="builder-missing">
                    <p className="text-sm text-muted-foreground">{_t("quotations.builder.notFound")}</p>
                    <GuardedLink href="/quotations" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">{_t("quotations.builder.back")}</GuardedLink>
                </div>
            );
        }
        const editable = canEdit(existing, converted.has(existing.id));
        if (!editable.ok) {
            return (
                <div className="rounded-xl border border-dashed p-10 text-center" data-testid="builder-readonly">
                    <p className="text-sm text-muted-foreground">{_t("quotations.builder.readOnly")}</p>
                    <p className="mt-1 text-sm">{_t(`quotations.errors.${editable.reason}`)}</p>
                    <GuardedLink href="/quotations" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">{_t("quotations.builder.back")}</GuardedLink>
                </div>
            );
        }
        return <BuilderForm key={existing.id} initial={fromQuotation(existing)} existing={existing} />;
    }

    // Carry-over source: your most recent quotation, else your most recent invoice.
    const carry = quotations.at(-1)?.doc ?? savedInvoices.at(-1) ?? null;
    const initial = blankQuotation({ number: suggestQuotationNumber(quotations), carry, sender: prefill.sender, receiver: prefill.receiver });
    return <BuilderForm key={customer ?? "new"} initial={initial} existing={null} />;
};

export default QuotationBuilder;
