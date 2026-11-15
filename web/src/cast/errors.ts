import { getT } from "../i18n";

/** Platforms report known problems by code ("noNetwork", "streamFailed"…): turn those into the user's language. */
export function translateCastError(e: unknown): Error {
  const message = (e as Error)?.message ?? String(e);
  const known = getT().cast.errors as Record<string, string>;
  return known[message] ? new Error(known[message]) : e instanceof Error ? e : new Error(message);
}

export const translated = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e: unknown) => {
    throw translateCastError(e);
  });
