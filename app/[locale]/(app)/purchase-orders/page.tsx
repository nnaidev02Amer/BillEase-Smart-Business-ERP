import PurchaseOrdersPage from "@/app/components/purchasing/PurchaseOrdersPage";

// A private view of this browser's data: nothing here is worth indexing.
export const metadata = { robots: { index: false, follow: false } };

export default function Page() {
    return <PurchaseOrdersPage />;
}
