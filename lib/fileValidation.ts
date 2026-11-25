/**
 * Client-side validation for files a user hands the app.
 *
 * The extension and the browser-reported MIME type are both chosen by whoever
 * made the file, so neither is trusted: the leading bytes are checked against
 * the real image signatures. The server still re-validates the resulting data
 * URL (lib/schemas.ts), so this is about giving a precise error early rather
 * than being the only line of defence.
 */

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export type ImageCheck = { ok: true; mime: string } | { ok: false; reason: "tooLarge" | "empty" | "notImage" | "unsafeSvg" };

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);

/** Image type from the file's own signature, or null if it is not a supported image. */
export function sniffImage(bytes: Uint8Array): string | null {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
    // RIFF....WEBP
    if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
    return null;
}

/** SVG is XML text, so it is recognised by content and refused if it can run anything. */
function checkSvg(text: string): ImageCheck {
    if (!/<svg[\s>]/i.test(text)) return { ok: false, reason: "notImage" };
    if (/<script|<foreignObject|\son\w+\s*=|javascript:|<iframe|<embed|<object|<!ENTITY/i.test(text)) {
        return { ok: false, reason: "unsafeSvg" };
    }
    return { ok: true, mime: "image/svg+xml" };
}

export async function validateImageFile(file: File, maxBytes = MAX_IMAGE_BYTES): Promise<ImageCheck> {
    if (file.size === 0) return { ok: false, reason: "empty" };
    if (file.size > maxBytes) return { ok: false, reason: "tooLarge" };

    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const mime = sniffImage(head);
    if (mime) return { ok: true, mime };

    // Not a raster signature: it may be an SVG.
    const text = await file.text();
    return checkSvg(text);
}

/** Plain-language message for a failed check. */
export const imageErrorMessage = (reason: Exclude<ImageCheck, { ok: true }>["reason"]) =>
    ({
        tooLarge: "That image is larger than 2 MB. Use a smaller file.",
        empty: "That file is empty.",
        notImage: "Only PNG, JPEG, GIF, WebP or SVG images are supported.",
        unsafeSvg: "That SVG contains scripts or embedded content and was not accepted.",
    })[reason];
