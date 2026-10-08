/**
 * "Step n of N" without a schema parameter.
 *
 * A walkthrough prompt that starts with `n/N` ("2/5 Click Export") carries its
 * own progress: the overlay shows it as a pill and the panel as a counter.
 * Doing it by convention costs nothing in the tool list, which is resent on
 * every turn, and `n/N` followed by a space is rare enough in real captions
 * that false positives are unlikely.
 */
export interface Progress {
    n: number;
    of: number;
    /** The prompt without its prefix. */
    rest: string;
}

export function parseProgress(text: string): Progress | null {
    const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s+(\S[\s\S]*)$/.exec(text);
    if (!m) return null;
    const n = Number(m[1]);
    const of = Number(m[2]);
    if (n < 1 || of < 1 || n > of) return null;
    return { n, of, rest: m[3]! };
}
