import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** A label, a control, and an optional hint and error, wired together for screen readers. */
const Field = ({
    id,
    label,
    error,
    hint,
    className,
    children,
}: {
    id: string;
    label: string;
    error?: string;
    hint?: string;
    className?: string;
    children: React.ReactNode;
}) => (
    <div className={cn("space-y-1.5", className)}>
        <Label htmlFor={id}>{label}</Label>
        {children}
        {hint && !error && (
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                {hint}
            </p>
        )}
        {error && (
            <p id={`${id}-error`} role="alert" className="text-xs font-medium text-destructive">
                {error}
            </p>
        )}
    </div>
);

export default Field;
