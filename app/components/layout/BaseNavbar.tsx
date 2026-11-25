"use client";

import { useMemo, useState } from "react";

// Next
import { usePathname } from "@/i18n/navigation";
import Link, { NAV_PREFETCH } from "@/app/components/layout/GuardedLink";

// Assets

// ShadCn
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@/components/ui/sheet";

// Components
import BaseButton from "@/app/components/reusables/BaseButton";
import DevDebug from "@/app/components/dev/DevDebug";
import LanguageSelector from "@/app/components/reusables/LanguageSelector";
import ThemeSwitcher from "@/app/components/reusables/ThemeSwitcher";

// Contexts
import { useTranslationContext } from "@/contexts/TranslationContext";

// Icons
import { FilePlus2, LayoutDashboard, Settings2 } from "lucide-react";

const BaseNavbar = () => {
    const devEnv = useMemo(() => {
        return process.env.NODE_ENV === "development";
    }, []);

    const [menuOpen, setMenuOpen] = useState(false);

    const { _t } = useTranslationContext();
    const pathname = usePathname();

    const links = [
        { href: "/", label: _t("navbar.create"), Icon: FilePlus2, active: pathname === "/" },
        {
            href: "/dashboard",
            label: _t("navbar.dashboard"),
            Icon: LayoutDashboard,
            active: ["/dashboard", "/invoices", "/quotations", "/clients", "/products", "/analytics", "/settings"].some((p) => pathname.startsWith(p)),
        },
    ];

    const linkClass = (active: boolean) =>
        `inline-flex items-center gap-2 rounded-md px-2 py-2 text-sm sm:px-3 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        }`;

    return (
        <header className="sticky top-0 z-50 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
            <nav className="container flex h-16 items-center justify-between gap-2 sm:gap-4">
                <Link href="/" prefetch={NAV_PREFETCH} className="flex shrink-0 items-center gap-2" aria-label="BillEase" data-testid="brand">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-base font-bold text-primary-foreground" aria-hidden="true">
                        B
                    </span>
                    <span className="text-xl font-semibold tracking-tight text-primary">BillEase</span>
                </Link>

                {/* ? DEV Only */}
                {devEnv && (
                    <div className="hidden lg:block">
                        <DevDebug />
                    </div>
                )}

                <div
                    className="flex flex-1 items-center justify-end gap-1 sm:justify-start sm:ps-4"
                    role="navigation"
                    aria-label={_t("navbar.primaryNav")}
                >
                    {links.map(({ href, label, Icon, active }) => (
                        <Link
                            key={href}
                            href={href}
                            prefetch={NAV_PREFETCH}
                            aria-current={active ? "page" : undefined}
                            aria-label={label}
                            className={linkClass(active)}
                        >
                            <Icon className="h-4 w-4" aria-hidden />
                            <span className="hidden sm:inline">{label}</span>
                        </Link>
                    ))}
                </div>

                {/* Desktop controls */}
                <div className="hidden items-center gap-2 sm:flex">
                    <LanguageSelector />
                    <ThemeSwitcher />
                </div>

                {/*
                 * Below sm the language select alone is wider than the space
                 * left beside the logo, so both controls move into a sheet.
                 */}
                <div className="flex items-center gap-1 sm:hidden">
                    <ThemeSwitcher />
                    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                        <SheetTrigger asChild>
                            <BaseButton
                                variant="ghost"
                                size="icon"
                                aria-label={_t("navbar.openSettings")}
                            >
                                <Settings2 className="h-5 w-5" />
                            </BaseButton>
                        </SheetTrigger>
                        <SheetContent side="right" className="w-[85vw] max-w-sm">
                            <SheetHeader className="mb-6">
                                <SheetTitle>
                                    {_t("navbar.settings")}
                                </SheetTitle>
                            </SheetHeader>

                            <div className="flex flex-col gap-4">
                                <div className="flex flex-col gap-2">
                                    <span className="text-sm text-muted-foreground">
                                        {_t("navbar.language")}
                                    </span>
                                    <LanguageSelector variant="block" />
                                </div>

                                {devEnv && <DevDebug />}
                            </div>
                        </SheetContent>
                    </Sheet>
                </div>
            </nav>
        </header>
    );
};

export default BaseNavbar;
