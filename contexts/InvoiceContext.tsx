"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// Next Intl
import { useLocale } from "next-intl";
import { useRouter } from "@/i18n/navigation";

// RHF
import { useFormContext } from "react-hook-form";

// Hooks
import useToasts from "@/hooks/useToasts";
import { toast } from "@/components/ui/use-toast";
import { useTranslationContext } from "@/contexts/TranslationContext";

// Services
import { exportInvoice } from "@/services/invoice/client/exportInvoice";

// Validation
import { InvoiceSchema } from "@/lib/schemas";

// Library (saved invoices, settings, templates, recents)
import { useInvoiceLibrary } from "@/contexts/useInvoiceLibrary";

// Variables
import {
  GENERATE_PDF_API,
  SEND_PDF_API,
  LOCAL_STORAGE_INVOICE_DRAFT_KEY,
  DRAFT_SAVE_DEBOUNCE_MS,
} from "@/lib/variables";

// Storage
import { removeSecure, writeSecure } from "@/lib/secureStore";

// Types
import { ExportTypes, InvoiceType } from "@/types";

type LibraryValue = ReturnType<typeof useInvoiceLibrary>["value"];

type InvoiceContextValue = LibraryValue & {
  invoicePdf: Blob;
  invoicePdfLoading: boolean;
  pdfUrl: string | null;
  onFormSubmit: (values: InvoiceType) => void;
  newInvoice: () => void;
  generatePdf: (data: InvoiceType) => Promise<void>;
  removeFinalPdf: () => void;
  downloadPdf: () => void;
  printPdf: () => void;
  previewPdfInTab: () => void;
  sendPdfToMail: (email: string) => Promise<void>;
  exportInvoiceAs: (exportAs: ExportTypes) => void;
  importInvoice: (file: File) => void;
};

export const InvoiceContext = createContext<InvoiceContextValue | null>(null);

/**
 * Autosave status, kept out of InvoiceContext on purpose.
 *
 * `draftPending` flips on the first keystroke of every burst and
 * `draftSavedAt` changes on every write. Inside InvoiceContext each of those
 * re-rendered all ~36 consumers (every nav link included) while the user typed;
 * only the autosave indicator reads them.
 */
type DraftStatus = {
  /** Timestamp of the last successful draft write, for the autosave indicator. */
  draftSavedAt: number | null;
  /** True while edits are sitting in the debounce window, unwritten. */
  draftPending: boolean;
};

const DraftStatusContext = createContext<DraftStatus>({
  draftSavedAt: null,
  draftPending: false,
});

export const useDraftStatus = (): DraftStatus => useContext(DraftStatusContext);

export const useInvoiceContext = (): InvoiceContextValue => {
  const ctx = useContext(InvoiceContext);
  if (!ctx) throw new Error("useInvoiceContext must be used inside InvoiceContextProvider");
  return ctx;
};

type InvoiceContextProviderProps = {
  children: React.ReactNode;
};

/** A message safe to show for a failed PDF request, by what went wrong. */
const pdfFailureMessage = (status: number): string | undefined => {
  if (status === 429) return "Too many requests. Wait a few seconds and try again.";
  if (status === 400 || status === 413)
    return "The invoice contains data the PDF service could not accept. Check the highlighted fields and your logo size.";
  if (status === 504 || status === 408) return "The PDF took too long to render. Try again.";
  return undefined;
};

export const InvoiceContextProvider = ({
  children,
}: InvoiceContextProviderProps) => {
  const router = useRouter();
  const locale = useLocale();

  // Toasts
  const {
    newInvoiceSuccess,
    pdfGenerationSuccess,
    sendPdfSuccess,
    sendPdfError,
    pdfGenerationError,
    exportInvoiceError,
    importInvoiceError,
  } = useToasts();

  const { getValues, reset, watch, setValue } = useFormContext<InvoiceType>();
  const { _t } = useTranslationContext();

  const [invoicePdf, setInvoicePdf] = useState<Blob>(new Blob());
  const [invoicePdfLoading, setInvoicePdfLoading] = useState<boolean>(false);

  // Lets a new PDF request cancel the one it supersedes
  const generateAbortRef = useRef<AbortController | null>(null);

  const library = useInvoiceLibrary({
    onFormReplaced: useCallback(() => setInvoicePdf(new Blob()), []),
  });
  const { savedInvoices, changeStatus, checkStock } = library.value;

  /**
   * Draft autosave.
   *
   * The latest value is parked in a ref and written on a trailing timer rather
   * than serialised on every keystroke (a logo makes that megabytes). The flush
   * also runs when the tab is hidden or unloaded, so nothing is lost if the
   * user leaves inside the debounce window.
   */
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [draftPending, setDraftPending] = useState(false);
  const pendingDraftRef = useRef<unknown>(null);

  const flushDraft = useCallback(() => {
    if (pendingDraftRef.current === null) return;
    const payload = pendingDraftRef.current;
    pendingDraftRef.current = null;

    void writeSecure(LOCAL_STORAGE_INVOICE_DRAFT_KEY, payload).then((ok) => {
      // A false result is quota, disabled storage, or no usable key. It must
      // not break editing — but it must not report "Saved" either.
      if (ok) setDraftSavedAt(Date.now());
    });

    setDraftPending(false);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const subscription = watch((value) => {
      pendingDraftRef.current = value;
      setDraftPending(true);

      if (timer) clearTimeout(timer);
      timer = setTimeout(flushDraft, DRAFT_SAVE_DEBOUNCE_MS);
    });

    // `pagehide` rather than `unload`, which is ignored on mobile Safari and
    // blocks the back/forward cache everywhere else.
    const onHide = () => flushDraft();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);

    return () => {
      subscription.unsubscribe();
      if (timer) clearTimeout(timer);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      flushDraft();
    };
  }, [watch, flushDraft]);

  /*
   * Editing returns you to the live preview: the first real edit after a
   * generation drops the PDF, so generating is an action with a result rather
   * than a mode you have to know how to leave.
   */
  useEffect(() => {
    if (invoicePdf.size === 0) return;

    const subscription = watch((_value, { type }) => {
      // `type` is undefined for programmatic reset()/setValue() calls made
      // during hydration; only a real user change should discard the PDF.
      if (type === "change") setInvoicePdf(new Blob());
    });

    return () => subscription.unsubscribe();
  }, [invoicePdf.size, watch]);

  // Object URL for the generated PDF, revoked on replace and on unmount.
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  useEffect(() => {
    if (invoicePdf.size === 0) {
      setPdfUrl(null);
      return;
    }

    const url = window.URL.createObjectURL(invoicePdf);
    setPdfUrl(url);

    return () => window.URL.revokeObjectURL(url);
  }, [invoicePdf]);

  const onFormSubmit = (data: InvoiceType) => {
    generatePdf(data);
  };

  /**
   * Starts a blank invoice. The number is a *suggestion* from the user's
   * numbering settings (or, in automatic mode, the saved invoices' own
   * pattern); the field stays a normal editable input.
   */
  const newInvoice = () => {
    reset(library.newInvoiceValues());
    setInvoicePdf(new Blob());
    library.rebase(null);

    // Clear the draft
    void removeSecure(LOCAL_STORAGE_INVOICE_DRAFT_KEY);

    router.refresh();

    newInvoiceSuccess();
  };

  /**
   * Generate a PDF document based on the provided data.
   * Failures surface as a toast with a specific reason where one is safe to
   * give, and a retry action.
   */
  const generatePdf = useCallback(
    async (data: InvoiceType) => {
      // Cancel any in-flight generation so a re-submit doesn't race the previous
      // one and resolve out of order.
      generateAbortRef.current?.abort();
      const controller = new AbortController();
      generateAbortRef.current = controller;

      setInvoicePdfLoading(true);

      try {
        // Locale travels as a query param so the server can render the PDF in
        // the same language as the UI.
        const response = await fetch(`${GENERATE_PDF_API}?locale=${locale}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
          signal: controller.signal,
        });

        // An error response is JSON, not a PDF; reading it as a blob would
        // report a "successful" generation.
        if (!response.ok) {
          const err = new Error(`PDF generation failed with status ${response.status}`);
          (err as Error & { status?: number }).status = response.status;
          throw err;
        }

        const result = await response.blob();
        setInvoicePdf(result);

        if (result.size > 0) pdfGenerationSuccess();
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          // Superseded by a newer submit; the newer one owns the loading state.
          return;
        }
        console.error(err);
        pdfGenerationError({
          message: pdfFailureMessage((err as { status?: number }).status ?? 0),
          retry: () => void generatePdf(data),
        });
      } finally {
        if (generateAbortRef.current === controller) {
          generateAbortRef.current = null;
          setInvoicePdfLoading(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale]
  );

  const removeFinalPdf = () => {
    setInvoicePdf(new Blob());
  };

  const previewPdfInTab = () => {
    // Reuses the managed URL; revoking here is not an option, the new tab still
    // needs it.
    if (pdfUrl) {
      window.open(pdfUrl, "_blank");
    }
  };

  const downloadPdf = () => {
    if (invoicePdf instanceof Blob && invoicePdf.size > 0) {
      const url = window.URL.createObjectURL(invoicePdf);

      const a = document.createElement("a");
      a.href = url;
      // The number, not "invoice.pdf" for every file. Restricted to characters
      // that are safe in a file name on every platform.
      const safe = (getValues().details.invoiceNumber || "invoice").replace(/[^\w.-]+/g, "_");
      a.download = `${safe}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    }
  };

  const printPdf = () => {
    if (pdfUrl) {
      const printWindow = window.open(pdfUrl, "_blank");
      if (printWindow) {
        printWindow.onload = () => {
          printWindow.print();
        };
      }
    }
  };

  /**
   * Send the invoice PDF to the specified email address. A successful send
   * moves a saved draft to "sent", which is the natural meaning of the action.
   */
  const sendPdfToMail = (email: string) => {
    // Sending issues the invoice, which takes stock. Do not send one the
    // inventory cannot cover.
    const current = getValues();
    if (current.details.status !== "sent" && !savedInvoices.some((i) => i.details.invoiceNumber === current.details.invoiceNumber && i.details.status === "sent")) {
      const problem = checkStock({ ...current, details: { ...current.details, status: "sent" } });
      if (problem) {
        toast({ variant: "destructive", title: _t("inventory.cannotIssue"), description: problem });
        return Promise.resolve();
      }
    }

    const fd = new FormData();
    fd.append("email", email);
    fd.append("invoicePdf", invoicePdf, "invoice.pdf");
    fd.append("invoiceNumber", getValues().details.invoiceNumber);

    return fetch(SEND_PDF_API, {
      method: "POST",
      body: fd,
    })
      .then((res) => {
        if (res.ok) {
          sendPdfSuccess();
          const number = getValues().details.invoiceNumber;
          if (getValues().details.status === "draft" || !getValues().details.status) {
            setValue("details.status", "sent");
          }
          if (savedInvoices.some((i) => i.details.invoiceNumber === number)) {
            changeStatus(number, "sent");
          }
        } else {
          sendPdfError({ email, sendPdfToMail });
        }
      })
      .catch((error) => {
        console.log(error);
        sendPdfError({ email, sendPdfToMail });
      });
  };

  const exportInvoiceAs = (exportAs: ExportTypes) => {
    const formValues = getValues();

    exportInvoice(exportAs, formValues).catch((error) => {
      console.error("Error exporting invoice:", error);
      exportInvoiceError();
    });
  };

  /**
   * Import an invoice from a JSON file into the form.
   *
   * The file is arbitrary input, so it is size-limited and validated against
   * the same schema as the form before it touches form state.
   */
  const importInvoice = (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      importInvoiceError();
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const importedData = JSON.parse(event.target?.result as string);

        if (importedData.details) {
          if (importedData.details.invoiceDate) {
            importedData.details.invoiceDate = new Date(importedData.details.invoiceDate);
          }
          if (importedData.details.dueDate) {
            importedData.details.dueDate = new Date(importedData.details.dueDate);
          }
        }

        const validated = InvoiceSchema.safeParse(importedData);
        if (!validated.success) {
          console.error("Invalid invoice file:", validated.error.issues);
          importInvoiceError();
          return;
        }

        reset(importedData);
        library.rebase(null);
      } catch (error) {
        console.error("Error parsing JSON file:", error);
        importInvoiceError();
      }
    };
    reader.readAsText(file);
  };

  /*
   * The action functions below close over state (invoicePdf, pdfUrl,
   * savedInvoices…) and are recreated every render. Handing them to consumers
   * directly would make the context value change every render, so consumers
   * get stable wrappers that always call the latest version instead. Nothing
   * can call a stale closure, and the value below only changes when data does.
   */
  const latest = {
    onFormSubmit,
    newInvoice,
    removeFinalPdf,
    downloadPdf,
    printPdf,
    previewPdfInTab,
    sendPdfToMail,
    exportInvoiceAs,
    importInvoice,
  };
  const latestRef = useRef(latest);
  latestRef.current = latest;

  const actions = useMemo(
    () => ({
      onFormSubmit: (values: InvoiceType) => latestRef.current.onFormSubmit(values),
      newInvoice: () => latestRef.current.newInvoice(),
      removeFinalPdf: () => latestRef.current.removeFinalPdf(),
      downloadPdf: () => latestRef.current.downloadPdf(),
      printPdf: () => latestRef.current.printPdf(),
      previewPdfInTab: () => latestRef.current.previewPdfInTab(),
      sendPdfToMail: (email: string) => latestRef.current.sendPdfToMail(email),
      exportInvoiceAs: (exportAs: ExportTypes) => latestRef.current.exportInvoiceAs(exportAs),
      importInvoice: (file: File) => latestRef.current.importInvoice(file),
    }),
    []
  );

  const libraryValue = library.value;
  const value = useMemo<InvoiceContextValue>(
    () => ({
      ...libraryValue,
      invoicePdf,
      invoicePdfLoading,
      pdfUrl,
      generatePdf,
      ...actions,
    }),
    [libraryValue, invoicePdf, invoicePdfLoading, pdfUrl, generatePdf, actions]
  );

  const draftStatus = useMemo(
    () => ({ draftSavedAt, draftPending }),
    [draftSavedAt, draftPending]
  );

  return (
    <InvoiceContext.Provider value={value}>
      <DraftStatusContext.Provider value={draftStatus}>
        {children}
        {library.dialogs}
      </DraftStatusContext.Provider>
    </InvoiceContext.Provider>
  );
};
