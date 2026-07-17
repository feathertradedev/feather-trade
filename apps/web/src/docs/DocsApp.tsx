import { MDXProvider } from "@mdx-js/react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  Info,
  Menu,
  Moon,
  Search,
  ShieldAlert,
  Sun,
  X
} from "lucide-react";
import {
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode
} from "react";

import { DOC_SECTIONS, docForPath, docsManifest, docsSearchIndex } from "./catalog";
import type { DocRecord, DocsSearchEntry } from "./types";
import "./docs.css";

const CANONICAL_ORIGIN = "https://feather.markets";
const APP_ORIGIN = "https://app.feather.markets";
const THEME_STORAGE_KEY = "feather-docs-theme";

type DocsTheme = "dark" | "light";

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
  return "";
}

function DocsAnchor({ href = "", children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const external = /^https?:\/\//.test(href);
  return (
    <a {...props} href={href} rel={external ? "noreferrer" : undefined} target={external ? "_blank" : undefined}>
      {children}
      {external ? <ExternalLink aria-hidden="true" className="docs-inline-icon" size={13} /> : null}
    </a>
  );
}

function Callout({ children, kind = "note", title }: { children: ReactNode; kind?: "note" | "risk" | "warning"; title?: string }) {
  const Icon = kind === "risk" ? ShieldAlert : kind === "warning" ? AlertTriangle : Info;
  return (
    <aside className={`docs-callout docs-callout-${kind}`}>
      <Icon aria-hidden="true" size={18} />
      <div>
        {title ? <strong>{title}</strong> : null}
        {children}
      </div>
    </aside>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <div className="docs-steps">{children}</div>;
}

function Definition({ children, term }: { children: ReactNode; term: string }) {
  return (
    <div className="docs-definition">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ContractAddress({ label, value }: { label: string; value?: string }) {
  return (
    <div className="docs-contract-address">
      <span>{label}</span>
      <code>{value ?? "Publishes after verified mainnet deployment"}</code>
    </div>
  );
}

function MethodSummary({ children, name }: { children: ReactNode; name: string }) {
  return (
    <section className="docs-method">
      <code>{name}</code>
      <div>{children}</div>
    </section>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = textFromNode(children).trimEnd();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className="docs-code-wrap">
      <pre>{children}</pre>
      <button aria-label="Copy code" className="docs-copy-code" onClick={() => void copy()} type="button">
        {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
      </button>
    </div>
  );
}

function headingId(value: string) {
  return value.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

function ArticleHeading({ children, level }: { children: ReactNode; level: 2 | 3 }) {
  const [copied, setCopied] = useState(false);
  const label = textFromNode(children);
  const id = headingId(label);
  const copy = async () => {
    const href = `${CANONICAL_ORIGIN}${window.location.pathname}#${id}`;
    window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}#${id}`);
    try {
      await navigator.clipboard.writeText(href);
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  const content = <>{children}<button aria-label={`Copy link to ${label}`} className="docs-copy-link" onClick={() => void copy()} type="button">{copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}</button></>;
  return level === 2 ? <h2 id={id}>{content}</h2> : <h3 id={id}>{content}</h3>;
}

const mdxComponents = {
  a: DocsAnchor,
  Callout,
  ContractAddress,
  Definition,
  h2: (props: { children: ReactNode }) => <ArticleHeading {...props} level={2} />,
  h3: (props: { children: ReactNode }) => <ArticleHeading {...props} level={3} />,
  MethodSummary,
  pre: CodeBlock,
  Risk: (props: { children: ReactNode; title?: string }) => <Callout {...props} kind="risk" />,
  Steps,
  Warning: (props: { children: ReactNode; title?: string }) => <Callout {...props} kind="warning" />
};

function initialTheme(): DocsTheme {
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

function normalizePath(pathname: string): string {
  if (pathname === "/docs/" || pathname === "/docs/welcome") return "/docs";
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function scoreSearch(entry: DocsSearchEntry, query: string): number {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const title = entry.title.toLowerCase();
  const description = entry.description.toLowerCase();
  const text = entry.text.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (!title.includes(word) && !description.includes(word) && !text.includes(word)) return 0;
    if (title === word) score += 16;
    else if (title.includes(word)) score += 8;
    if (description.includes(word)) score += 4;
    if (text.includes(word)) score += 1;
  }
  return score;
}

function searchSnippet(text: string, query: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const firstWord = query.toLowerCase().trim().split(/\s+/)[0] ?? "";
  const match = normalized.toLowerCase().indexOf(firstWord);
  if (match < 0) return normalized.slice(0, 150);
  const start = Math.max(0, match - 54);
  const end = Math.min(normalized.length, match + 110);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end).trim()}${end < normalized.length ? "…" : ""}`;
}

function SearchDialog({ onClose, onNavigate }: { onClose: () => void; onNavigate: (href: string) => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  const results = useMemo(
    () => docsSearchIndex
      .flatMap((entry) => {
        const page = { entry, href: entry.href, label: entry.title, snippet: searchSnippet(`${entry.description} ${entry.text}`, query), score: scoreSearch(entry, query) };
        const headings = entry.headings.map((heading) => {
          const headingScore = scoreSearch({ ...entry, title: heading.title, description: entry.title, text: heading.title }, query);
          return {
            entry,
            href: `${entry.href}#${heading.id}`,
            label: heading.title,
            snippet: `Heading in ${entry.title}`,
            score: headingScore > 0 ? headingScore + 2 : 0
          };
        });
        return [page, ...headings];
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10),
    [query]
  );
  return (
    <div aria-label="Search documentation" aria-modal="true" className="docs-search-backdrop" role="dialog" onMouseDown={onClose}>
      <div className="docs-search-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="docs-search-field">
          <Search aria-hidden="true" size={18} />
          <input
            aria-label="Search documentation"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search concepts, actions, and contracts"
            ref={inputRef}
            value={query}
          />
          <button aria-label="Close search" onClick={onClose} type="button"><X aria-hidden="true" size={18} /></button>
        </div>
        <div aria-live="polite" className="docs-search-results">
          {query.trim() === "" ? <p className="docs-search-hint">Try “slippage”, “active bin”, or “approval”.</p> : null}
          {query.trim() !== "" && results.length === 0 ? <p className="docs-search-hint">No documentation matched that search.</p> : null}
          {results.map(({ entry, href, label, snippet }) => (
            <button className="docs-search-result" key={href} onClick={() => onNavigate(href)} type="button">
              <span>{entry.section}</span>
              <strong>{label}</strong>
              <small>{snippet}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Sidebar({ current, onNavigate }: { current: DocRecord | null; onNavigate: (href: string) => void }) {
  return (
    <nav aria-label="Documentation" className="docs-sidebar-nav">
      {DOC_SECTIONS.map((section) => (
        <section key={section}>
          <h2>{section}</h2>
          {docsManifest.docs.filter((doc) => doc.section === section).map((doc) => (
            <a
              aria-current={doc.slug === current?.slug ? "page" : undefined}
              className={doc.slug === current?.slug ? "active" : undefined}
              href={doc.href}
              key={doc.slug}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(doc.href);
              }}
            >
              {doc.title}
            </a>
          ))}
        </section>
      ))}
    </nav>
  );
}

function updateMetadata(doc: DocRecord | null) {
  const title = doc ? `${doc.title} | Feather Docs` : "Page not found | Feather Docs";
  const description = doc?.description ?? "The requested Feather documentation page does not exist.";
  const canonicalPath = doc?.href ?? "/docs/not-found";
  document.title = title;
  const setMeta = (selector: string, attribute: string, value: string) => {
    const element = document.head.querySelector<HTMLMetaElement>(selector);
    if (element) element.setAttribute(attribute, value);
  };
  setMeta('meta[name="description"]', "content", description);
  setMeta('meta[property="og:title"]', "content", title);
  setMeta('meta[property="og:description"]', "content", description);
  let ogUrl = document.head.querySelector<HTMLMetaElement>('meta[property="og:url"]');
  if (!ogUrl) {
    ogUrl = document.createElement("meta");
    ogUrl.setAttribute("property", "og:url");
    document.head.append(ogUrl);
  }
  ogUrl.content = `${CANONICAL_ORIGIN}${canonicalPath}`;
  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.append(canonical);
  }
  canonical.href = `${CANONICAL_ORIGIN}${canonicalPath}`;
}

export default function DocsApp() {
  const [path, setPath] = useState(() => normalizePath(window.location.pathname));
  const [theme, setTheme] = useState<DocsTheme>(initialTheme);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const doc = docForPath(path);
  const docIndex = doc ? docsManifest.docs.findIndex((candidate) => candidate.slug === doc.slug) : -1;
  const previous = docIndex > 0 ? docsManifest.docs[docIndex - 1] : null;
  const next = docIndex >= 0 && docIndex < docsManifest.docs.length - 1 ? docsManifest.docs[docIndex + 1] : null;

  const navigate = (href: string) => {
    const [requestedPath, requestedHash] = href.split("#");
    const normalized = normalizePath(requestedPath || path);
    const destination = `${normalized}${requestedHash ? `#${requestedHash}` : ""}`;
    if (`${window.location.pathname}${window.location.hash}` !== destination) window.history.pushState({}, "", destination);
    setPath(normalized);
    setMobileNavOpen(false);
    setSearchOpen(false);
    if (requestedHash) window.setTimeout(() => document.getElementById(requestedHash)?.scrollIntoView(), 0);
    else window.scrollTo({ top: 0, behavior: "auto" });
  };

  useEffect(() => {
    if (window.location.pathname !== path && (window.location.pathname === "/docs/" || window.location.pathname.startsWith("/docs/"))) {
      window.history.replaceState({}, "", `${path}${window.location.search}${window.location.hash}`);
    }
    const listener = () => setPath(normalizePath(window.location.pathname));
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, [path]);

  useEffect(() => {
    if (!window.location.hash) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView(), 0);
  }, [path]);

  useEffect(() => {
    document.documentElement.dataset.docsTheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => updateMetadata(doc), [doc]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const handleArticleClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const anchor = target.closest<HTMLAnchorElement>('a[href^="/docs"]');
    if (!anchor) return;
    event.preventDefault();
    navigate(anchor.getAttribute("href") ?? "/docs");
  };

  return (
    <div className="docs-app">
      <header className="docs-header">
        <a aria-label="Feather Docs home" className="docs-brand" href="/docs" onClick={(event) => { event.preventDefault(); navigate("/docs"); }}>
          <img alt="" src="/feather/feather-mark-128.png" />
          <span>Feather <strong>Docs</strong></span>
        </a>
        <button aria-label="Search documentation" className="docs-search-trigger" onClick={() => setSearchOpen(true)} type="button">
          <Search aria-hidden="true" size={16} /><span>Search documentation</span><kbd>⌘ K</kbd>
        </button>
        <div className="docs-header-actions">
          <button aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} type="button">
            {theme === "dark" ? <Sun aria-hidden="true" size={17} /> : <Moon aria-hidden="true" size={17} />}
          </button>
          <a className="docs-open-app" href={APP_ORIGIN}>Open app <ArrowRight aria-hidden="true" size={15} /></a>
          <button aria-label="Open documentation navigation" className="docs-mobile-menu" onClick={() => setMobileNavOpen(true)} type="button"><Menu aria-hidden="true" size={19} /></button>
        </div>
      </header>

      <div className="docs-layout">
        <aside className="docs-sidebar"><Sidebar current={doc} onNavigate={navigate} /></aside>
        <main className="docs-main" onClick={handleArticleClick}>
          {doc ? (
            <>
              <nav aria-label="Breadcrumb" className="docs-breadcrumb"><a href="/docs" onClick={(event) => { event.preventDefault(); navigate("/docs"); }}>Docs</a><span>/</span><span>{doc.section}</span></nav>
              <article className="docs-article">
                <header>
                  <p className="docs-section-label">{doc.section}</p>
                  <h1>{doc.title}</h1>
                  <p>{doc.description}</p>
                  <small>Last reviewed {doc.lastReviewed}</small>
                </header>
                <MDXProvider components={mdxComponents}><doc.Component /></MDXProvider>
              </article>
              <nav aria-label="Adjacent documentation" className="docs-adjacent">
                {previous ? <a href={previous.href} onClick={(event) => { event.preventDefault(); navigate(previous.href); }}><ArrowLeft aria-hidden="true" size={16} /><span><small>Previous</small>{previous.title}</span></a> : <span />}
                {next ? <a href={next.href} onClick={(event) => { event.preventDefault(); navigate(next.href); }}><span><small>Next</small>{next.title}</span><ArrowRight aria-hidden="true" size={16} /></a> : null}
              </nav>
            </>
          ) : (
            <article className="docs-not-found">
              <BookOpen aria-hidden="true" size={28} />
              <h1>Documentation page not found</h1>
              <p>The address may have changed, or the page may not exist.</p>
              <button onClick={() => navigate("/docs")} type="button">Return to docs</button>
            </article>
          )}
        </main>
        <aside className="docs-toc">
          {doc && doc.headings.length > 0 ? <nav aria-label="On this page"><h2>On this page</h2>{doc.headings.map((heading) => <a className={heading.depth === 3 ? "nested" : undefined} href={`#${heading.id}`} key={heading.id}>{heading.title}</a>)}</nav> : null}
        </aside>
      </div>

      {mobileNavOpen ? <div aria-label="Documentation navigation" aria-modal="true" className="docs-mobile-backdrop" role="dialog" onMouseDown={() => setMobileNavOpen(false)}><aside onMouseDown={(event) => event.stopPropagation()}><header><strong>Documentation</strong><button aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} type="button"><X aria-hidden="true" size={19} /></button></header><a className="docs-mobile-open-app" href={APP_ORIGIN}>Open app <ArrowRight aria-hidden="true" size={15} /></a><Sidebar current={doc} onNavigate={navigate} /></aside></div> : null}
      {searchOpen ? <SearchDialog onClose={() => setSearchOpen(false)} onNavigate={navigate} /> : null}
    </div>
  );
}
