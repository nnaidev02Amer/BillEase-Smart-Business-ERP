import { test, expect } from "@playwright/test";

import { changeEvent, createCollection, createQueue, newId, storageKey } from "../lib/repository";

/** Shared repository layer: queue ordering, naming and id rules. No browser. */

test.describe("createQueue", () => {
    test("runs tasks strictly in order even when earlier ones are slower", async () => {
        const enqueue = createQueue();
        const log: string[] = [];
        const slow = enqueue(async () => {
            await new Promise((r) => setTimeout(r, 30));
            log.push("slow");
        });
        const fast = enqueue(async () => {
            log.push("fast");
        });
        await Promise.all([slow, fast]);
        expect(log).toEqual(["slow", "fast"]);
    });

    test("a failing task rejects its own caller but does not block the next task", async () => {
        const enqueue = createQueue();
        const failing = enqueue(async () => {
            throw new Error("boom");
        });
        const next = enqueue(async () => "ok");
        await expect(failing).rejects.toThrow("boom");
        await expect(next).resolves.toBe("ok");
    });
});

test.describe("naming and ids", () => {
    test("keys and events live in the invoify: namespace so existing data and backups stay valid", () => {
        expect(storageKey("suppliers")).toBe("invoify:suppliers");
        expect(changeEvent("suppliers")).toBe("invoify:suppliers-changed");
    });

    test("ids carry the prefix and do not collide", () => {
        const ids = new Set(Array.from({ length: 500 }, () => newId("sup")));
        expect(ids.size).toBe(500);
        for (const id of ids) expect(id).toMatch(/^sup_[a-z0-9]+$/);
    });
});

test.describe("createCollection outside a browser", () => {
    const col = createCollection<{ id: string }>({
        name: "unit-test",
        max: 3,
        sanitise: (raw) => (raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }) : null),
    });

    test("exposes the derived key and event", () => {
        expect(col.key).toBe("invoify:unit-test");
        expect(col.event).toBe("invoify:unit-test-changed");
    });

    test("reads as empty when storage is unavailable, never throws", async () => {
        await expect(col.read()).resolves.toEqual([]);
    });

    test("reports writeFailed, not success, when nothing could be persisted", async () => {
        const res = await col.update((cur) => ({ next: [...cur, { id: "a" }], result: 1 }));
        expect(res).toEqual({ ok: false, reason: "writeFailed" });
    });

    test("aborts without writing when the updater returns null", async () => {
        const res = await col.update(() => null);
        expect(res).toEqual({ ok: false, reason: "aborted" });
    });
});
