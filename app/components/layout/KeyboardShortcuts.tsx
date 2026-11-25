"use client";

import { useEffect, useRef, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { usePathname } from "@/i18n/navigation";

const GO_TARGETS: Record<string, string> = {
    d: "/dashboard",
    i: "/invoices",
    c: "/clients",
    a: "/analytics",
    s: "/settings",
    b: "/",
};

export const SHORTCUTS: { keys: string; key: string }[] = [
    { keys: "N", key: "quick" },
    { keys: "G then D", key: "goDashboard" },
    { keys: "G then I", key: "goInvoices" },
    { keys: "G then C", key: "goClients" },
    { keys: "G then A", key: "goAnalytics" },
    { keys: "G then S", key: "goSettings" },
    { keys: "G then B", key: "goBuilder" },
    { keys: "/", key: "search" },
    { keys: "Ctrl/⌘ + S", key: "save" },
    { keys: "?", key: "help" },
];

const isTyping = (el: EventTarget | null) => {
    const node = el as HTMLElement | null;
    if (!node) return false;
    const tag = node.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
};

/**
 * Global keyboard shortcuts. Single keys are ignored while typing in a field
 * and when a modifier is held, so they never fight text entry or the browser's
 * own shortcuts. Ctrl/⌘+S is the one exception: it saves from anywhere on the
 * builder, as people expect.
 */
const KeyboardShortcuts = () => {
    const { _t } = useTranslationContext();
    const { quickInvoice, guardedNavigate, saveInvoice } = useInvoiceContext();
    const pathname = usePathname();
    const [helpOpen, setHelpOpen] = useState(false);
    const awaitingGo = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Handlers read the latest values without re-subscribing on every render.
    const latest = useRef({ quickInvoice, guardedNavigate, saveInvoice, pathname });
    latest.current = { quickInvoice, guardedNavigate, saveInvoice, pathname };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const { quickInvoice, guardedNavigate, saveInvoice, pathname } = latest.current;

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                if (pathname === "/") {
                    e.preventDefault();
                    saveInvoice();
                }
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
            // A dialog or menu is open: leave the keys to it.
            if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="listbox"]')) return;

            const key = e.key.toLowerCase();

            if (awaitingGo.current) {
                clearTimeout(awaitingGo.current);
                awaitingGo.current = null;
                const target = GO_TARGETS[key];
                if (target) {
                    e.preventDefault();
                    guardedNavigate(target);
                }
                return;
            }

            if (key === "g") {
                awaitingGo.current = setTimeout(() => (awaitingGo.current = null), 1200);
            } else if (key === "n") {
                e.preventDefault();
                quickInvoice();
            } else if (e.key === "?") {
                e.preventDefault();
                setHelpOpen(true);
            } else if (e.key === "/") {
                const search = document.querySelector<HTMLInputElement>("[data-shortcut-search]");
                if (search) {
                    e.preventDefault();
                    search.focus();
                    search.select();
                }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    return (
        <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{_t("shortcuts.title")}</DialogTitle>
                    <DialogDescription>{_t("shortcuts.subtitle")}</DialogDescription>
                </DialogHeader>
                <ul className="divide-y text-sm">
                    {SHORTCUTS.map((s) => (
                        <li key={s.key} className="flex items-center justify-between gap-4 py-2">
                            <span>{_t(`shortcuts.${s.key}`)}</span>
                            <kbd className="rounded border bg-muted px-2 py-0.5 font-mono text-xs">{s.keys}</kbd>
                        </li>
                    ))}
                </ul>
            </DialogContent>
        </Dialog>
    );
};

export default KeyboardShortcuts;
