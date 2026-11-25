"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormContext } from "react-hook-form";

import { toast } from "@/components/ui/use-toast";
import { LeaveDialog, SaveWarningDialog, type SaveWarning } from "@/app/components/dialogs/InvoiceGuards";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { useRouter } from "@/i18n/navigation";

import {
    addPeriod,
    balanceDue,
    canTransition,
    clientKey,
    duplicateOf,
    formHasContent,
    formSignature,
    invoiceTotal,
    isoDay,
    parseDate,
    restoreRevision,
    runRecurring,
    storedStatus,
    withPayment,
    withRevision,
    withoutPayment,
    type PaymentInput,
    type StoredStatus,
    type TransitionResult,
} from "@/lib/invoiceRecords";
import {
    DEFAULT_SETTINGS,
    readSettings,
    successorFn,
    suggestInvoiceNumber,
    writeSettings,
    type AppSettings,
} from "@/lib/settings";
import { readTemplates, templateFromInvoice, writeTemplates, type SavedTemplate } from "@/lib/templateStore";
import {
    RECENT_KEY,
    SAVED_INVOICES_KEY,
    applyBackup,
    clearData,
    collectBackupData,
    type ApplyOptions,
    type DataScope,
} from "@/lib/dataManagement";
import { analyseBackup, buildBackup, type BackupAnalysis } from "@/lib/backup";
import { INVENTORY_EVENT, loadInventory, syncInventory, syncInventoryAndLoad } from "@/lib/inventory";
import { planStockSync, type Product, type Shortage, type StockMovement } from "@/lib/products";
import { canConvert, conversionsOf, quotationToInvoice } from "@/lib/quotations";
import { readQuotations } from "@/lib/quotationStore";
import { readSecure, removeSecure, writeSecure } from "@/lib/secureStore";
import { FORM_DEFAULT_VALUES, LOCAL_STORAGE_INVOICE_DRAFT_KEY, SHORT_DATE_OPTIONS } from "@/lib/variables";
import { InvoiceSchema } from "@/lib/schemas";
import type { InvoiceType } from "@/types";

const MAX_RECENT = 8;
const DIRTY_DEBOUNCE_MS = 400;
const REBASE_MS = 800;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

type ClientSeed = {
    name: string;
    address: string;
    zipCode: string;
    city: string;
    country: string;
    email: string;
    phone: string;
    gstin?: string;
    shippingAddress?: InvoiceType["receiver"]["shippingAddress"];
};

/**
 * Everything about the *library* of invoices (saved list, settings, templates,
 * recently viewed) and the actions that move invoices between that library and
 * the form. Split from InvoiceContext, which keeps PDF generation, drafts and
 * export, because the two grew independently and were hard to read together.
 */
export function useInvoiceLibrary({ onFormReplaced }: { onFormReplaced: () => void }) {
    const { getValues, reset, setValue, watch, trigger } = useFormContext<InvoiceType>();
    const router = useRouter();
    const { _t } = useTranslationContext();

    /* ------------------------------------------------------------- state */
    const [savedInvoices, setSavedInvoices] = useState<InvoiceType[]>([]);
    const [savedLoaded, setSavedLoaded] = useState(false);
    const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
    const [settingsLoaded, setSettingsLoaded] = useState(false);
    const [templates, setTemplates] = useState<SavedTemplate[]>([]);
    const [recentNumbers, setRecentNumbers] = useState<string[]>([]);
    const [dirty, setDirty] = useState(false);
    const [saveWarning, setSaveWarning] = useState<SaveWarning | null>(null);
    const [leaveTarget, setLeaveTarget] = useState<string | null>(null);

    const savedRef = useRef<InvoiceType[]>([]);
    savedRef.current = savedInvoices;
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    const templatesRef = useRef<SavedTemplate[]>([]);
    templatesRef.current = templates;

    /** Fingerprint of what the form held when it was last loaded or saved. */
    const baselineRef = useRef<string | null>(null);
    /** Number of the saved invoice the form is currently an edit of. */
    const loadedNumberRef = useRef<string | null>(null);
    const rebaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const note = useCallback(
        (title: string, description?: string, destructive = false) =>
            toast({ title, description, variant: destructive ? "destructive" : "default" }),
        []
    );

    /* --------------------------------------------------------- inventory */
    // A synchronous copy of the catalogue and ledger, for pre-checks that must
    // answer before an action is allowed to proceed.
    const inventoryRef = useRef<{ products: Product[]; movements: StockMovement[] }>({ products: [], movements: [] });
    const refreshInventory = useCallback(async () => {
        inventoryRef.current = await loadInventory();
    }, []);

    useEffect(() => {
        const onChange = () => void refreshInventory();
        window.addEventListener(INVENTORY_EVENT, onChange);
        return () => window.removeEventListener(INVENTORY_EVENT, onChange);
    }, [refreshInventory]);

    /** Products that would go below zero if `next` became the saved list. */
    const shortagesFor = useCallback((next: InvoiceType[]): Shortage[] => {
        const { products, movements } = inventoryRef.current;
        return planStockSync(products, movements, next).shortages;
    }, []);

    const describeShortages = useCallback(
        (shortages: Shortage[]) =>
            shortages
                .map((s) => _t("inventory.shortageItem", { name: s.name, available: s.available, needed: s.needed }))
                .join("; "),
        [_t]
    );

    /** The saved list with `invoice` added or replacing its namesake. */
    const withInvoice = useCallback((invoice: InvoiceType): InvoiceType[] => {
        const number = invoice.details.invoiceNumber;
        const list = savedRef.current;
        return list.some((i) => i.details.invoiceNumber === number)
            ? list.map((i) => (i.details.invoiceNumber === number ? invoice : i))
            : [...list, invoice];
    }, []);

    /** Used by the e-mail flow, which must not send an invoice that cannot be issued. */
    const checkStock = useCallback(
        (invoice: InvoiceType) => {
            const shortages = shortagesFor(withInvoice(invoice));
            return shortages.length ? describeShortages(shortages) : null;
        },
        [shortagesFor, withInvoice, describeShortages]
    );

    /* -------------------------------------------------------------- load */
    const reloadAll = useCallback(async () => {
        const [saved, s, t, recent] = await Promise.all([
            readSecure<InvoiceType[]>(SAVED_INVOICES_KEY),
            readSettings(),
            readTemplates(),
            readSecure<string[]>(RECENT_KEY),
        ]);
        const savedList = Array.isArray(saved) ? saved : [];
        setSavedInvoices(savedList);
        savedRef.current = savedList;
        // Heal: bring the stock ledger in line with the invoices. With nothing
        // to change this writes nothing, so it is safe on every load. The sync
        // already has the catalogue and ledger in hand, so it fills the
        // pre-check cache itself rather than having it re-read straight after.
        try {
            inventoryRef.current = await syncInventoryAndLoad(savedList).then(({ products, movements }) => ({
                products,
                movements,
            }));
        } catch {
            /* stock is secondary to showing the invoices */
            await refreshInventory();
        }
        setSettings(s);
        setTemplates(t);
        setRecentNumbers(Array.isArray(recent) ? recent.filter((x) => typeof x === "string") : []);
    }, [refreshInventory]);

    useEffect(() => {
        let active = true;
        reloadAll()
            .catch(() => {})
            .finally(() => {
                if (active) {
                    setSavedLoaded(true);
                    setSettingsLoaded(true);
                }
            });
        return () => {
            active = false;
        };
    }, [reloadAll]);

    /* ------------------------------------------------------- persistence */
    const persistSaved = useCallback(async (next: InvoiceType[]) => {
        savedRef.current = next;
        setSavedInvoices(next);
        const ok = await writeSecure(SAVED_INVOICES_KEY, next);
        if (!ok) {
            note(_t("toasts.storageFailedTitle"), _t("toasts.storageFailedBody"), true);
            return ok;
        }
        // Record whatever the change means for stock (sale, return, nothing).
        try {
            await syncInventory(next);
        } catch {
            note(_t("inventory.syncFailed"), undefined, true);
        }
        return ok;
    }, [note, _t]);

    /* ----------------------------------------------------------- recents */
    const touchRecent = useCallback((number: string) => {
        setRecentNumbers((prev) => {
            const next = [number, ...prev.filter((n) => n !== number)].slice(0, MAX_RECENT);
            void writeSecure(RECENT_KEY, next);
            return next;
        });
    }, []);

    /* ------------------------------------------------------------- dirty */
    /** Marks the form's current contents as "clean" once derived values settle. */
    const candidateRef = useRef<string | null>(null);
    const rebase = useCallback(
        (number: string | null, loaded?: unknown) => {
            loadedNumberRef.current = number;
            baselineRef.current = null;
            // What the form should hold if the user edits before it settles.
            candidateRef.current = loaded === undefined ? null : formSignature(loaded);
            setDirty(false);
            if (rebaseTimer.current) clearTimeout(rebaseTimer.current);
            rebaseTimer.current = setTimeout(() => {
                rebaseTimer.current = null;
                baselineRef.current = formSignature(getValues());
            }, REBASE_MS);
        },
        [getValues]
    );

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const sub = watch((_value, info) => {
            // A real edit inside the settle window must not be absorbed into the
            // baseline: fall back to the loaded invoice's own fingerprint.
            if (info?.type === "change" && rebaseTimer.current) {
                clearTimeout(rebaseTimer.current);
                rebaseTimer.current = null;
                baselineRef.current = candidateRef.current;
            }
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const values = getValues();
                const baseline = baselineRef.current;
                if (baseline === null) {
                    // No baseline yet: a fresh form is dirty only once it has content,
                    // and a just-loaded one is still settling.
                    if (rebaseTimer.current) return;
                    setDirty(formHasContent(values));
                } else {
                    setDirty(formSignature(values) !== baseline);
                }
            }, DIRTY_DEBOUNCE_MS);
        });
        return () => {
            sub.unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [watch, getValues]);

    // The browser's own prompt covers closing the tab and typing a new address.
    useEffect(() => {
        if (!dirty) return;
        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, [dirty]);

    /** In-app navigation that asks first when there are unsaved edits. */
    const guardedNavigate = useCallback(
        (href: string) => {
            if (dirty) setLeaveTarget(href);
            else router.push(href);
        },
        [dirty, router]
    );

    /* -------------------------------------------------------------- save */
    const doSave = useCallback(
        async (number: string) => {
            const list = [...savedRef.current];
            const idx = list.findIndex((i) => i.details.invoiceNumber === number);
            const prev = idx >= 0 ? list[idx] : null;

            const values = clone(getValues());
            values.details.invoiceNumber = number;
            values.details.updatedAt = new Date().toLocaleDateString("en-US", SHORT_DATE_OPTIONS);
            if (!values.details.status || !["draft", "sent", "cancelled"].includes(values.details.status)) {
                values.details.status = prev ? storedStatus(prev) : "draft";
            }
            // The books are authoritative: the form copy of payments may be stale.
            if (prev?.details.payments) values.details.payments = prev.details.payments;
            delete values.details.revisions;

            const rec = values.details.recurring;
            if (rec && rec.frequency !== "none" && !rec.nextDate) {
                const issued = parseDate(values.details.invoiceDate) ?? new Date();
                rec.nextDate = isoDay(addPeriod(issued, rec.frequency));
            }

            let record: InvoiceType = values;
            if (prev) {
                record = withRevision(prev, values, crypto.randomUUID());
                list[idx] = record;
            } else {
                list.push(record);
            }

            // An issued invoice may not take more stock than there is.
            const shortages = shortagesFor(list);
            if (shortages.length > 0) {
                note(_t("inventory.cannotIssue"), describeShortages(shortages), true);
                return;
            }

            const ok = await persistSaved(list);
            if (number !== getValues().details.invoiceNumber) setValue("details.invoiceNumber", number);
            rebase(number, values);
            touchRecent(number);
            if (ok) note(prev ? _t("toasts.modified") : _t("toasts.saved"), number);
        },
        [getValues, setValue, persistSaved, rebase, touchRecent, note, _t, shortagesFor, describeShortages]
    );

    /** Entry point for the Save button. Warns before overwriting or duplicating. */
    const saveInvoice = useCallback(() => {
        const values = getValues();
        const number = values.details.invoiceNumber?.trim();
        if (!number) {
            note(_t("toasts.numberRequired"), undefined, true);
            return;
        }
        // Only complete, valid invoices are saved: anything else would later be
        // rejected by backup validation and could not be turned into a PDF.
        const parsed = InvoiceSchema.safeParse(values);
        if (!parsed.success) {
            const first = parsed.error.issues[0];
            void trigger();
            note(_t("toasts.invalidInvoice"), `${first.path.join(".")}: ${first.message}`, true);
            return;
        }
        const list = savedRef.current;
        const exists = list.some((i) => i.details.invoiceNumber === number);

        if (exists && loadedNumberRef.current !== number) {
            setSaveWarning({
                kind: "number",
                number,
                suggestion: successorFn(settingsRef.current, list)(number),
            });
            return;
        }
        if (!exists) {
            const day = parseDate(values.details.invoiceDate);
            const similar = list.find(
                (i) =>
                    clientKey(i.receiver) === clientKey(values.receiver) &&
                    clientKey(values.receiver) !== "" &&
                    Math.abs(invoiceTotal(i) - Number(values.details.totalAmount)) < 0.005 &&
                    Number(values.details.totalAmount) > 0 &&
                    !!day &&
                    isoDay(parseDate(i.details.invoiceDate) ?? new Date(0)) === isoDay(day)
            );
            if (similar) {
                setSaveWarning({ kind: "similar", number, other: similar.details.invoiceNumber });
                return;
            }
        }
        void doSave(number);
    }, [getValues, doSave, trigger, note, _t]);

    const resolveSaveWarning = useCallback(
        (choice: "anyway" | "next") => {
            const w = saveWarning;
            setSaveWarning(null);
            if (!w) return;
            void doSave(choice === "next" && w.kind === "number" ? w.suggestion : w.number);
        },
        [saveWarning, doSave]
    );

    /* ----------------------------------------------------- list mutations */
    const deleteInvoiceByNumber = useCallback(
        (number: string) => {
            void persistSaved(savedRef.current.filter((i) => i.details.invoiceNumber !== number));
            setRecentNumbers((r) => r.filter((n) => n !== number));
        },
        [persistSaved]
    );

    const deleteInvoice = useCallback(
        (index: number) => {
            const cur = savedRef.current;
            if (index >= 0 && index < cur.length) void persistSaved(cur.filter((_, i) => i !== index));
        },
        [persistSaved]
    );

    const duplicateInvoice = useCallback(
        (number: string): string | null => {
            const cur = savedRef.current;
            const source = cur.find((i) => i.details.invoiceNumber === number);
            if (!source) return null;
            const copy = duplicateOf(
                source,
                cur.map((i) => i.details.invoiceNumber),
                successorFn(settingsRef.current, cur)
            );
            void persistSaved([...cur, copy]);
            return copy.details.invoiceNumber;
        },
        [persistSaved]
    );

    /* ------------------------------------------------ quotation conversion */
    const convertingRef = useRef<Set<string>>(new Set());

    /**
     * Turns an accepted quotation into a **draft** invoice.
     *
     * - Reads the quotation fresh, so a stale screen cannot convert something
     *   that has since been withdrawn.
     * - Refuses if any invoice already references it (this is the whole
     *   duplicate-conversion guard; see lib/quotations). A second click while
     *   the first is in flight is also refused.
     * - Goes through persistSaved like every other invoice change, so it gets
     *   the same stock sync. A draft consumes no stock; that happens only when
     *   the invoice is issued through the normal flow.
     * - Creates no customer and no product: both are referred to, never copied
     *   into their stores.
     */
    const convertQuotation = useCallback(
        async (
            quotationId: string
        ): Promise<{ ok: true; invoiceNumber: string } | { ok: false; reason: string; invoiceNumber?: string; message?: string }> => {
            if (convertingRef.current.has(quotationId)) return { ok: false, reason: "alreadyConverted" };
            convertingRef.current.add(quotationId);
            try {
                const q = (await readQuotations()).find((x) => x.id === quotationId);
                if (!q) return { ok: false, reason: "notFound" };

                /*
                 * Refresh from storage first. This tab's copy of the invoice list
                 * can be stale (another tab may have converted this quotation a
                 * moment ago); judging "already converted" against it, and then
                 * writing it back, would both miss the duplicate and overwrite
                 * the other tab's invoice.
                 */
                const stored = await readSecure<InvoiceType[]>(SAVED_INVOICES_KEY);
                if (Array.isArray(stored)) {
                    savedRef.current = stored;
                    setSavedInvoices(stored);
                }
                const list = savedRef.current;
                const existing = conversionsOf(list).get(q.id);
                const check = canConvert(q, existing !== undefined);
                if (!check.ok) return { ok: false, reason: check.reason, invoiceNumber: existing };

                const taken = new Set(list.map((i) => i.details.invoiceNumber));
                const next = successorFn(settingsRef.current, list);
                let number = suggestInvoiceNumber(settingsRef.current, list);
                for (let i = 0; i < 1000 && taken.has(number); i++) number = next(number);

                const invoice = quotationToInvoice(q, {
                    invoiceNumber: number,
                    dueDays: settingsRef.current.defaultDueDays,
                    knownProductIds: new Set(inventoryRef.current.products.map((p) => p.id)),
                });
                const parsed = InvoiceSchema.safeParse(invoice);
                if (!parsed.success) {
                    const first = parsed.error.issues[0];
                    return { ok: false, reason: "invalid", message: `${first.path.join(".")}: ${first.message}` };
                }
                const ok = await persistSaved([...savedRef.current, invoice]);
                return ok ? { ok: true, invoiceNumber: number } : { ok: false, reason: "storage" };
            } finally {
                convertingRef.current.delete(quotationId);
            }
        },
        [persistSaved]
    );

    const mutate = useCallback(
        (number: string, fn: (inv: InvoiceType) => InvoiceType) => {
            void persistSaved(savedRef.current.map((i) => (i.details.invoiceNumber === number ? fn(i) : i)));
        },
        [persistSaved]
    );

    const changeStatus = useCallback(
        (number: string, to: StoredStatus): TransitionResult => {
            const inv = savedRef.current.find((i) => i.details.invoiceNumber === number);
            if (!inv) return { ok: false, reason: "notFound" };
            const check = canTransition(inv, to);
            if (!check.ok) return check;

            const changed: InvoiceType = { ...inv, details: { ...inv.details, status: to } };
            const shortages = shortagesFor(withInvoice(changed));
            if (shortages.length > 0) {
                return { ok: false, reason: "insufficientStock", detail: describeShortages(shortages) };
            }
            mutate(number, () => changed);
            return check;
        },
        [mutate, shortagesFor, withInvoice, describeShortages]
    );

    const recordPayment = useCallback(
        (number: string, input: PaymentInput): TransitionResult => {
            const inv = savedRef.current.find((i) => i.details.invoiceNumber === number);
            if (!inv) return { ok: false, reason: "notFound" };
            const result = withPayment(inv, input, crypto.randomUUID());
            if (!result.ok) return result;
            mutate(number, () => result.invoice);
            return { ok: true };
        },
        [mutate]
    );

    const markPaid = useCallback(
        (number: string): TransitionResult => {
            const inv = savedRef.current.find((i) => i.details.invoiceNumber === number);
            if (!inv) return { ok: false, reason: "notFound" };
            return recordPayment(number, { amount: balanceDue(inv), date: isoDay(new Date()), method: "other" });
        },
        [recordPayment]
    );

    const removePayment = useCallback(
        (number: string, paymentId: string) => mutate(number, (i) => withoutPayment(i, paymentId)),
        [mutate]
    );

    const restoreInvoiceRevision = useCallback(
        (number: string, revisionId: string): boolean => {
            const inv = savedRef.current.find((i) => i.details.invoiceNumber === number);
            const rev = inv?.details.revisions?.find((r) => r.id === revisionId);
            if (!inv || !rev) return false;
            // The version being replaced becomes a revision itself, so nothing is lost.
            const restored = withRevision(inv, restoreRevision(inv, rev), crypto.randomUUID());
            mutate(number, () => restored);
            return true;
        },
        [mutate]
    );

    /* ----------------------------------------------- form <-> library flow */
    const stamp = (v: InvoiceType) => {
        const today = new Date();
        const d = v.details as unknown as Record<string, unknown>;
        d.invoiceDate = today;
        d.dueDate = addDays(today, settingsRef.current.defaultDueDays);
        d.status = "draft";
        d.invoiceNumber = suggestInvoiceNumber(settingsRef.current, savedRef.current);
        delete d.payments;
        delete d.revisions;
        delete d.updatedAt;
        return v;
    };

    const openForm = useCallback(
        (values: InvoiceType, number: string | null) => {
            reset(values);
            onFormReplaced();
            rebase(number);
            router.push("/");
        },
        [reset, onFormReplaced, rebase, router]
    );

    /** Opens a saved invoice for editing. Works on a copy; never mutates saved data. */
    const loadInvoice = useCallback(
        (invoice: InvoiceType, { navigate = true }: { navigate?: boolean } = {}) => {
            const copy = clone(invoice);
            delete copy.details.revisions;
            const d = copy.details as unknown as Record<string, unknown>;
            d.invoiceDate = new Date(copy.details.invoiceDate);
            d.dueDate = new Date(copy.details.dueDate);
            reset(copy);
            onFormReplaced();
            rebase(copy.details.invoiceNumber, copy);
            touchRecent(copy.details.invoiceNumber);
            if (navigate) router.push("/");
        },
        [reset, onFormReplaced, rebase, touchRecent, router]
    );

    /** The invoice a "quick" start copies from: your most recent one. */
    const latest = () => savedRef.current.at(-1) ?? null;

    const carryOver = (source: InvoiceType | null): InvoiceType => {
        const base = clone(FORM_DEFAULT_VALUES) as unknown as InvoiceType;
        if (!source) return stamp(base);
        const s = clone(source);
        base.sender = s.sender;
        const keep = [
            "invoiceLogo", "currency", "language", "pdfTemplate", "theme", "paymentInformation",
            "taxDetails", "paymentTerms", "additionalNotes", "terms", "paymentInstructions", "signature",
        ] as const;
        for (const k of keep) {
            if (s.details[k] !== undefined) (base.details as Record<string, unknown>)[k] = s.details[k];
        }
        return stamp(base);
    };

    /** A new invoice that already knows who is sending it and how it should look. */
    const quickInvoice = useCallback(() => {
        const values = carryOver(latest());
        openForm(values, null);
        note(_t("toasts.quickCreated"), values.details.invoiceNumber);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openForm, note, _t]);

    const invoiceForClient = useCallback(
        (client: ClientSeed) => {
            const values = carryOver(latest());
            values.receiver = {
                name: client.name,
                address: client.address,
                zipCode: client.zipCode,
                city: client.city,
                country: client.country,
                email: client.email,
                phone: client.phone,
                customInputs: [],
                ...(client.gstin ? { gstin: client.gstin } : {}),
                ...(client.shippingAddress ? { shippingAddress: client.shippingAddress } : {}),
            };
            openForm(values, null);
            // eslint-disable-next-line react-hooks/exhaustive-deps
        },
        [openForm]
    );

    const newInvoiceValues = useCallback(() => {
        const base = clone(FORM_DEFAULT_VALUES) as unknown as InvoiceType;
        base.details.invoiceNumber = suggestInvoiceNumber(settingsRef.current, savedRef.current);
        return base;
    }, []);

    /* ----------------------------------------------------------- templates */
    const saveTemplate = useCallback(
        async (name: string): Promise<boolean> => {
            const clean = name.trim();
            if (!clean) return false;
            const list = [...templatesRef.current];
            if (list.some((t) => t.name.toLowerCase() === clean.toLowerCase())) {
                note(_t("toasts.templateExists"), clean, true);
                return false;
            }
            list.push(templateFromInvoice(clean, getValues()));
            setTemplates(list);
            const ok = await writeTemplates(list);
            note(ok ? _t("toasts.templateSaved") : _t("toasts.storageFailedTitle"), clean, !ok);
            return ok;
        },
        [getValues, note, _t]
    );

    const deleteTemplate = useCallback(
        async (id: string) => {
            const list = templatesRef.current.filter((t) => t.id !== id);
            setTemplates(list);
            await writeTemplates(list);
        },
        []
    );

    const applyTemplate = useCallback(
        (id: string) => {
            const t = templatesRef.current.find((x) => x.id === id);
            if (!t) return;
            const values = stamp(clone(t.data));
            openForm(values, null);
            note(_t("toasts.fromTemplate"), t.name);
        },
        [openForm, note, _t]
    );

    /* ------------------------------------------------------------ settings */
    const updateSettings = useCallback(
        async (next: AppSettings) => {
            setSettings(next);
            const ok = await writeSettings(next);
            note(ok ? _t("toasts.settingsSaved") : _t("toasts.storageFailedTitle"), undefined, !ok);
        },
        [note, _t]
    );

    /* ----------------------------------------------------------- recurring */
    const recurringRan = useRef(false);
    useEffect(() => {
        if (!savedLoaded || !settingsLoaded || recurringRan.current) return;
        recurringRan.current = true;
        const result = runRecurring(savedRef.current, successorFn(settingsRef.current, savedRef.current));
        if (result.created.length > 0) {
            void persistSaved(result.invoices);
            note(_t("toasts.recurringCreated", { count: result.created.length }));
        }
    }, [savedLoaded, settingsLoaded, persistSaved, note, _t]);

    /* -------------------------------------------------------------- backup */
    const downloadBlob = (blob: Blob, filename: string) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoking synchronously can cancel the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const exportBackup = useCallback(async () => {
        const backup = await buildBackup(await collectBackupData(savedRef.current));
        downloadBlob(
            new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }),
            `invoify-backup-${new Date().toISOString().slice(0, 10)}.json`
        );
        note(_t("toasts.backupExported"), _t("toasts.backupExportedBody", { count: backup.counts.invoices }));
    }, [note, _t]);

    /** Read-only: validates a file and reports what restoring it would do. */
    const inspectBackup = useCallback(async (file: File): Promise<BackupAnalysis> => {
        if (file.size > 50 * 1024 * 1024) return { ok: false, error: "tooLarge" };
        return analyseBackup(await file.text());
    }, []);

    const restoreBackup = useCallback(
        async (analysis: Extract<BackupAnalysis, { ok: true }>, opts: ApplyOptions) => {
            const summary = await applyBackup(analysis, opts);
            await reloadAll();
            return summary;
        },
        [reloadAll]
    );

    const clearStoredData = useCallback(
        async (scope: DataScope) => {
            await clearData(scope);
            await reloadAll();
            if (scope === "draft" || scope === "all") {
                void removeSecure(LOCAL_STORAGE_INVOICE_DRAFT_KEY);
            }
        },
        [reloadAll]
    );

    /* -------------------------------------------------------------- dialogs */
    const dialogs = (
        <>
            <SaveWarningDialog
                warning={saveWarning}
                onChoose={resolveSaveWarning}
                onCancel={() => setSaveWarning(null)}
            />
            <LeaveDialog
                open={leaveTarget !== null}
                onStay={() => setLeaveTarget(null)}
                onLeave={() => {
                    const target = leaveTarget;
                    setLeaveTarget(null);
                    // Leaving is a decision to move on: stop warning for this form.
                    setDirty(false);
                    if (target) router.push(target);
                }}
            />
        </>
    );

    /*
     * Memoized so the InvoiceContext built on top of it only changes when data
     * does. Every function here is a useCallback and every other entry is state,
     * so the dependency list is simply the list of entries.
     */
    const value = useMemo(
        () => ({
            savedInvoices,
            savedLoaded,
            settings,
            templates,
            recentNumbers,
            dirty,
            saveInvoice,
            deleteInvoice,
            deleteInvoiceByNumber,
            duplicateInvoice,
            changeStatus,
            convertQuotation,
            checkStock,
            recordPayment,
            markPaid,
            removePayment,
            restoreInvoiceRevision,
            loadInvoice,
            quickInvoice,
            invoiceForClient,
            saveTemplate,
            deleteTemplate,
            applyTemplate,
            updateSettings,
            guardedNavigate,
            exportBackup,
            inspectBackup,
            restoreBackup,
            clearStoredData,
            reloadAll,
        }),
        [
            savedInvoices,
            savedLoaded,
            settings,
            templates,
            recentNumbers,
            dirty,
            saveInvoice,
            deleteInvoice,
            deleteInvoiceByNumber,
            duplicateInvoice,
            changeStatus,
            convertQuotation,
            checkStock,
            recordPayment,
            markPaid,
            removePayment,
            restoreInvoiceRevision,
            loadInvoice,
            quickInvoice,
            invoiceForClient,
            saveTemplate,
            deleteTemplate,
            applyTemplate,
            updateSettings,
            guardedNavigate,
            exportBackup,
            inspectBackup,
            restoreBackup,
            clearStoredData,
            reloadAll,
        ]
    );

    return {
        value,
        /** For InvoiceContext's newInvoice(): number suggestion and form baseline. */
        newInvoiceValues,
        rebase,
        dialogs,
    };
}
