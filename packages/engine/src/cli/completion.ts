/**
 * IOS keyword completion and `?` help over a command grammar.
 *
 * A grammar is a list of command syntaxes such as `show ip route` or `ip route <net> <mask> <via...>`.
 * Literal words are keywords, `<x>` is a free argument and a final `<x...>` swallows the rest of the
 * line. Each typed word is resolved the way the IOS parser does it: an exact keyword wins, then a
 * unique abbreviation; a word that matches several keywords is ambiguous.
 */
export interface GrammarEntry {
  syntax: string;
  help: string;
}

interface Path {
  entry: GrammarEntry;
  tokens: string[];
}

const isArg = (token: string) => token.startsWith('<');

/** The token a syntax expects at position `i`; a trailing `<x...>` keeps matching to the end of the line. */
function tokenAt(tokens: string[], i: number): string | undefined {
  if (i < tokens.length) return tokens[i];
  const last = tokens[tokens.length - 1]!;
  return last.endsWith('...>') ? last : undefined;
}

/** The distinct keywords the still-matching syntaxes accept at position `i`. */
function keywordsAt(paths: Path[], i: number): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const t = tokenAt(p.tokens, i);
    if (t !== undefined && !isArg(t)) out.add(t);
  }
  return [...out];
}

/** The keyword `word` stands for: itself if typed in full, else its only expansion. */
export function resolveKeyword(word: string, keywords: string[]): string | 'ambiguous' | undefined {
  const w = word.toLowerCase();
  if (keywords.includes(w)) return w;
  const hits = keywords.filter((k) => k.startsWith(w));
  if (hits.length > 1) return 'ambiguous';
  return hits[0];
}

/**
 * The syntaxes that `words` can be the start of. Undefined when a word is an ambiguous
 * abbreviation, since IOS would refuse the line there.
 */
function walk(grammar: GrammarEntry[], words: string[]): Path[] | undefined {
  let alive: Path[] = grammar.map((entry) => ({ entry, tokens: entry.syntax.split(' ') }));
  for (const [i, word] of words.entries()) {
    const k = resolveKeyword(word, keywordsAt(alive, i));
    if (k === 'ambiguous') return undefined;
    alive = alive.filter((p) => {
      const t = tokenAt(p.tokens, i);
      return t !== undefined && (isArg(t) || t === k);
    });
  }
  return alive;
}

/** Splits a line into the words already typed and the word under the cursor ('' after a space). */
function splitLine(line: string): { head: string; words: string[]; partial: string } {
  const m = /^(.*?)(\S*)$/s.exec(line)!;
  const head = m[1]!;
  return { head, words: head.trim().split(/\s+/).filter(Boolean), partial: m[2]! };
}

/**
 * Tab: the line with its last word completed to the one keyword it can stand for, plus a space.
 * Undefined when there is nothing to complete or the word is ambiguous or unknown; IOS then
 * reprints the line unchanged.
 */
export function completeLine(grammar: GrammarEntry[], line: string): string | undefined {
  const { head, words, partial } = splitLine(line);
  if (!partial) return undefined;
  const alive = walk(grammar, words);
  if (!alive) return undefined;
  const k = resolveKeyword(partial, keywordsAt(alive, words.length));
  if (k === undefined || k === 'ambiguous') return undefined;
  return `${head}${k} `;
}

/** The keyword or argument a syntax expects after the words typed so far. */
export interface Continuation {
  /** True when the words typed so far already form a whole command (IOS lists `<cr>`). */
  complete: boolean;
  /** Commands the line can still become. */
  entries: GrammarEntry[];
  /** Words typed so far, one of them ambiguous. */
  ambiguous: boolean;
}

/** `?` after a space: the commands the typed words can still become. */
export function continuations(grammar: GrammarEntry[], words: string[]): Continuation {
  const alive = walk(grammar, words);
  if (!alive) return { complete: false, entries: [], ambiguous: true };
  const n = words.length;
  return {
    complete: alive.some((p) => p.tokens.length === n && !p.tokens[n - 1]?.endsWith('...>')),
    entries: alive.filter((p) => tokenAt(p.tokens, n) !== undefined).map((p) => p.entry),
    ambiguous: false,
  };
}

/** `?` straight after a word ("sh?"): the keywords at that position that start with it. */
export function matchingKeywords(grammar: GrammarEntry[], line: string): string[] {
  const { words, partial } = splitLine(line);
  const alive = walk(grammar, words) ?? [];
  const p = partial.toLowerCase();
  return keywordsAt(alive, words.length)
    .filter((k) => k.startsWith(p))
    .sort();
}

/** The keyword the last whole word typed stands for ("int g" -> "interface"). */
export function previousKeyword(grammar: GrammarEntry[], line: string): string | undefined {
  const { words } = splitLine(line);
  if (!words.length) return undefined;
  const alive = walk(grammar, words.slice(0, -1)) ?? [];
  const k = resolveKeyword(words[words.length - 1]!, keywordsAt(alive, words.length - 1));
  return k === 'ambiguous' ? undefined : k;
}
