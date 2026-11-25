"use client";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslationContext } from "@/contexts/TranslationContext";

export type SaveWarning =
    | { kind: "number"; number: string; suggestion: string }
    | { kind: "similar"; number: string; other: string };

/**
 * Shown before a save that would silently overwrite another invoice, or that
 * looks like a duplicate of one. Saving by number has always replaced a record
 * with the same number; this makes that visible instead of surprising.
 */
export const SaveWarningDialog = ({
    warning,
    onChoose,
    onCancel,
}: {
    warning: SaveWarning | null;
    onChoose: (choice: "anyway" | "next") => void;
    onCancel: () => void;
}) => {
    const { _t } = useTranslationContext();
    return (
        <AlertDialog open={warning !== null} onOpenChange={(o) => !o && onCancel()}>
            <AlertDialogContent>
                {warning && (
                    <>
                        <AlertDialogHeader>
                            <AlertDialogTitle>
                                {warning.kind === "number"
                                    ? _t("guards.numberExistsTitle", { number: warning.number })
                                    : _t("guards.similarTitle")}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                                {warning.kind === "number"
                                    ? _t("guards.numberExistsBody")
                                    : _t("guards.similarBody", { other: warning.other })}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter className="gap-2 sm:gap-0">
                            <AlertDialogCancel onClick={onCancel}>{_t("guards.cancel")}</AlertDialogCancel>
                            {warning.kind === "number" && (
                                <AlertDialogAction
                                    className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
                                    onClick={() => onChoose("next")}
                                >
                                    {_t("guards.saveAsNext", { number: warning.suggestion })}
                                </AlertDialogAction>
                            )}
                            <AlertDialogAction onClick={() => onChoose("anyway")}>
                                {warning.kind === "number" ? _t("guards.overwrite") : _t("guards.saveAnyway")}
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </>
                )}
            </AlertDialogContent>
        </AlertDialog>
    );
};

/** Shown when leaving the builder with edits that are not in the saved list. */
export const LeaveDialog = ({
    open,
    onStay,
    onLeave,
}: {
    open: boolean;
    onStay: () => void;
    onLeave: () => void;
}) => {
    const { _t } = useTranslationContext();
    return (
        <AlertDialog open={open} onOpenChange={(o) => !o && onStay()}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{_t("guards.leaveTitle")}</AlertDialogTitle>
                    <AlertDialogDescription>{_t("guards.leaveBody")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={onStay}>{_t("guards.stay")}</AlertDialogCancel>
                    <AlertDialogAction onClick={onLeave}>{_t("guards.leave")}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
};
