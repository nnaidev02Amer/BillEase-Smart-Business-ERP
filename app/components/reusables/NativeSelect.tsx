import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A native <select> styled like `Input`. Used where the list is long (GST
 * states, suppliers) or the control has to work well on a phone: the browser's
 * own picker is the best one there is.
 */
const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
    <select
        ref={ref}
        className={cn(
            "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors",
            "hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive",
            className
        )}
        {...props}
    />
));
NativeSelect.displayName = "NativeSelect";

export default NativeSelect;
