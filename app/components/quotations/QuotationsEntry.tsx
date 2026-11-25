"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { Skeleton } from "@/components/ui/skeleton";

import QuotationBuilder from "./QuotationBuilder";
import QuotationsPage from "./QuotationsPage";

/**
 * The pages read the URL (`?customer=`, `?id=`), which Next only allows inside
 * a Suspense boundary on statically generated routes.
 */
const Fallback = () => <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

const ListInner = () => <QuotationsPage initialCustomer={useSearchParams().get("customer") ?? undefined} />;

export const QuotationsListEntry = () => (
    <Suspense fallback={<Fallback />}>
        <ListInner />
    </Suspense>
);

export const QuotationBuilderEntry = () => (
    <Suspense fallback={<Fallback />}>
        <QuotationBuilder />
    </Suspense>
);
