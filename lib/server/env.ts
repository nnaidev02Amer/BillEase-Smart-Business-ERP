import "server-only";

/**
 * Server-only environment.
 *
 * `server-only` makes the build fail if anything that reaches the browser
 * imports this file, so mail credentials cannot be bundled into client code by
 * an innocent-looking import. (They used to live in lib/variables.ts, which
 * client components import for unrelated constants.)
 */
export const NODEMAILER_EMAIL = process.env.NODEMAILER_EMAIL;
export const NODEMAILER_PW = process.env.NODEMAILER_PW;
