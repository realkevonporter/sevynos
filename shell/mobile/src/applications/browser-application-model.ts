export const BROWSER_HOME_ADDRESS = "sevyn://home";

export interface BrowserHomeDestination {
  readonly kind: "home";
  readonly address: typeof BROWSER_HOME_ADDRESS;
}

export interface BrowserSearchDestination {
  readonly kind: "search";
  readonly address: string;
  readonly query: string;
}

export interface BrowserArticleDestination {
  readonly kind: "article";
  readonly address: string;
  readonly title: string;
  readonly key: string;
}

export interface BrowserExternalDestination {
  readonly kind: "external";
  readonly address: string;
  readonly url: string;
}

export type BrowserDestination =
  | BrowserHomeDestination
  | BrowserSearchDestination
  | BrowserArticleDestination
  | BrowserExternalDestination;

export interface BrowserHistoryState {
  readonly entries: readonly BrowserDestination[];
  readonly index: number;
}

const SEARCH_ADDRESS_PREFIX = "sevyn://search/";
const ARTICLE_ADDRESS_PREFIX = "sevyn://read/";
const WIKIPEDIA_HOSTS = new Set([
  "wikipedia.org",
  "www.wikipedia.org",
  "en.wikipedia.org",
]);

export function createHomeDestination(): BrowserHomeDestination {
  return { kind: "home", address: BROWSER_HOME_ADDRESS };
}

export function createSearchDestination(query: string): BrowserSearchDestination {
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  return {
    kind: "search",
    address: `${SEARCH_ADDRESS_PREFIX}${encodeURIComponent(normalizedQuery)}`,
    query: normalizedQuery,
  };
}

export function createArticleDestination(
  title: string,
  key = title.trim().replace(/\s+/g, "_"),
): BrowserArticleDestination {
  const normalizedTitle = title.trim().replace(/_/g, " ");
  const normalizedKey = key.trim().replace(/\s+/g, "_");
  return {
    kind: "article",
    address: `${ARTICLE_ADDRESS_PREFIX}${encodeURIComponent(normalizedKey)}`,
    title: normalizedTitle,
    key: normalizedKey,
  };
}

export function parseBrowserInput(value: string): BrowserDestination {
  const input = value.trim();
  if (input === "" || input.toLowerCase() === BROWSER_HOME_ADDRESS) {
    return createHomeDestination();
  }

  if (input.toLowerCase().startsWith(SEARCH_ADDRESS_PREFIX)) {
    return createSearchDestination(
      decodeSafely(input.slice(SEARCH_ADDRESS_PREFIX.length)),
    );
  }

  if (input.toLowerCase().startsWith(ARTICLE_ADDRESS_PREFIX)) {
    const key = decodeSafely(input.slice(ARTICLE_ADDRESS_PREFIX.length));
    return createArticleDestination(key, key);
  }

  if (input.toLowerCase().startsWith("wiki:")) {
    return createArticleDestination(input.slice("wiki:".length));
  }

  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(input)
    ? input
    : looksLikeHost(input)
      ? `https://${input}`
      : undefined;

  if (withScheme === undefined) {
    return createSearchDestination(input);
  }

  const url = parseHttpUrl(withScheme);
  if (url === undefined) {
    return createSearchDestination(input);
  }

  const wikipediaArticle = getWikipediaArticle(url);
  if (wikipediaArticle !== undefined) {
    return wikipediaArticle;
  }

  return { kind: "external", address: url.toString(), url: url.toString() };
}

export function pushBrowserHistory(
  state: BrowserHistoryState,
  destination: BrowserDestination,
): BrowserHistoryState {
  if (state.entries[state.index]?.address === destination.address) return state;

  const entries = [...state.entries.slice(0, state.index + 1), destination];
  return { entries, index: entries.length - 1 };
}

export function moveBrowserHistory(
  state: BrowserHistoryState,
  direction: -1 | 1,
): BrowserHistoryState {
  const index = Math.max(0, Math.min(state.entries.length - 1, state.index + direction));
  if (index === state.index) return state;
  return { entries: state.entries, index };
}

export function destinationLabel(destination: BrowserDestination): string {
  switch (destination.kind) {
    case "home":
      return "Start page";
    case "search":
      return destination.query;
    case "article":
      return destination.title;
    case "external":
      return hostFromUrl(destination.url);
  }
}

export function hostFromUrl(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeHost(value: string): boolean {
  return (
    !value.includes(" ") &&
    /(?:^localhost(?::\d+)?$)|(?:\.[a-z]{2,}(?::\d+)?(?:\/|$))/i.test(value)
  );
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function getWikipediaArticle(url: URL): BrowserArticleDestination | undefined {
  if (!WIKIPEDIA_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const prefix = "/wiki/";
  if (!url.pathname.startsWith(prefix)) return undefined;
  const key = decodeSafely(url.pathname.slice(prefix.length));
  return key === "" ? undefined : createArticleDestination(key, key);
}
