/**
 * Shared repository layer for the encrypted browser store.
 *
 * partyStore, inventory, expenseStore and quotationStore each re-implement the
 * same three things: a serial queue (so two quick read-modify-writes cannot
 * lose each other's update), validate-on-read (storage is user-editable and an
 * older build may have written it), and a change event so other screens
 * refresh. This module is that pattern, written once, for the modules that
 * come next (suppliers, purchase orders, goods receipts, purchase bills,
 * supplier payments, bank accounts, rules).
 *
 * The existing stores are deliberately NOT migrated onto it: they are tested,
 * hold user data, and work. They can move over one at a time later, with their
 * storage keys unchanged.
 *
 * Everything persists through lib/secureStore, so data is encrypted at rest
 * exactly as before. Storage keys keep the `invoify:` prefix (see `storageKey`)
 * so that all keys written by this app share one namespace and a backup can
 * enumerate them.
 *
 * Because every function here is async and returns plain data, the whole
 * module can later be swapped for a server-backed implementation without
 * touching the UI.
 */

import { readSecure, writeSecure } from "@/lib/secureStore";

/** The namespace every persisted key lives in. Do not rename: it would orphan existing data. */
export const STORAGE_PREFIX = "invoify:";

export const storageKey = (name: string) => `${STORAGE_PREFIX}${name}`;
export const changeEvent = (name: string) => `${STORAGE_PREFIX}${name}-changed`;

/* ------------------------------------------------------------------ queue */

/**
 * A serial task queue. A task runs after everything already queued, whether
 * earlier tasks succeeded or failed, and one task's failure never poisons the
 * next.
 */
export function createQueue() {
    let tail: Promise<unknown> = Promise.resolve();
    return function enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = tail.then(task, task);
        tail = run.catch(() => undefined);
        return run;
    };
}

/* ------------------------------------------------------------- collection */

export type CollectionOptions<T> = {
    /** Short name, e.g. "suppliers". Becomes the key `invoify:suppliers` and the event `invoify:suppliers-changed`. */
    name: string;
    /** Validates one stored entry. Return null to drop it. Must never throw on bad input. */
    sanitise: (raw: unknown) => T | null;
    /** Hard cap on stored entries, so a runaway loop cannot fill the browser's storage. */
    max: number;
    /** When the cap is hit, keep the `first` or the `last` entries. Default "first" (newest-first lists). */
    keep?: "first" | "last";
    /** Queue to share with sibling collections that must be updated atomically together. */
    queue?: ReturnType<typeof createQueue>;
};

export type Collection<T> = {
    key: string;
    event: string;
    /** Reads and validates every entry. Never throws; unreadable storage reads as empty. */
    read(): Promise<T[]>;
    /**
     * Read-modify-write inside the queue. `fn` receives the current list and
     * returns the next one plus an optional result for the caller. Returning
     * `null` aborts without writing. Resolves `{ ok:false }` if the write failed.
     */
    update<R = void>(
        fn: (current: T[]) => { next: T[]; result: R } | null
    ): Promise<{ ok: true; result: R } | { ok: false; reason: "aborted" | "writeFailed" }>;
    /** Replaces the whole list (backup restore). Sanitises and caps it first. */
    replace(list: unknown[]): Promise<boolean>;
    /** Announces a change to other screens in this tab. */
    announce(): void;
};

const isBrowser = () => typeof window !== "undefined";

export function createCollection<T>(options: CollectionOptions<T>): Collection<T> {
    const { name, sanitise, max, keep = "first" } = options;
    const key = storageKey(name);
    const event = changeEvent(name);
    const enqueue = options.queue ?? createQueue();

    const cap = (list: T[]) => (list.length <= max ? list : keep === "first" ? list.slice(0, max) : list.slice(-max));

    const clean = (raw: unknown): T[] => {
        if (!Array.isArray(raw)) return [];
        const out: T[] = [];
        for (const entry of raw) {
            try {
                const ok = sanitise(entry);
                if (ok !== null) out.push(ok);
            } catch {
                // A malformed entry is dropped, never allowed to break the screen.
            }
        }
        return out;
    };

    const announce = () => {
        if (isBrowser()) window.dispatchEvent(new Event(event));
    };

    const read = async () => clean(await readSecure<unknown>(key));

    return {
        key,
        event,
        read,
        announce,
        update(fn) {
            return enqueue(async () => {
                const outcome = fn(await read());
                if (outcome === null) return { ok: false as const, reason: "aborted" as const };
                const written = await writeSecure(key, cap(outcome.next));
                if (!written) return { ok: false as const, reason: "writeFailed" as const };
                announce();
                return { ok: true as const, result: outcome.result };
            });
        },
        replace(list) {
            return enqueue(async () => {
                const written = await writeSecure(key, cap(clean(list)));
                if (written) announce();
                return written;
            });
        },
    };
}

/* ------------------------------------------------------------- id helpers */

/** A collision-resistant id with a readable prefix, e.g. `sup_k3j9x2…`. */
export function newId(prefix: string): string {
    const rand =
        isBrowser() && window.crypto?.randomUUID
            ? window.crypto.randomUUID().replace(/-/g, "").slice(0, 16)
            : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return `${prefix}_${rand}`;
}

/** Subscribes to a collection's change event. Returns the unsubscribe function. */
export function subscribe(collection: Pick<Collection<unknown>, "event">, listener: () => void): () => void {
    if (!isBrowser()) return () => undefined;
    window.addEventListener(collection.event, listener);
    return () => window.removeEventListener(collection.event, listener);
}
