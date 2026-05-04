import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface Bookmark {
  id: number;
  url: string;
  title: string | null;
  note: string;
  domain: string | null;
  ai_summary: string | null;
  ai_tags: string;
  category_id: number | null;
  og_image_url: string | null;
  importance: number;
  status: string;
  content_type: string | null;
  metadata: string;  // raw JSON string; parse lazily in the card
  short_code: string | null;
  click_count: number;
  created_at: number;
}

interface VideoMetadata {
  videoId?: string;
  channel?: string;
  durationSec?: number;
  publishedAt?: string;
  watchedAt?: number;
  captionsAvailable?: boolean;
  captionsAuto?: boolean;
}

function parseVideoMetadata(raw: string | undefined | null): VideoMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as VideoMetadata) : {};
  } catch {
    return {};
  }
}

interface XPostMetadata {
  statusId?: string;
  author?: string | null;
  handle?: string | null;
  postedAt?: string | null;
  mediaUrls?: string[];
  likes?: number | null;
  retweets?: number | null;
  replies?: number | null;
  hashtags?: string[];
  source?: 'fxtwitter' | 'oembed';
}

function parseXPostMetadata(raw: string | undefined | null): XPostMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as XPostMetadata) : {};
  } catch {
    return {};
  }
}

function formatDurationSec(sec: number | undefined): string | null {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
  count: number;
}

interface CategoriesPayload {
  categories: CategoryRow[];
  uncategorized: number;
  total: number;
}

type View = 'list' | 'grid';
type Theme = 'light' | 'dark';
type Mode = 'bookmarks' | 'feeds' | 'shortlinks' | 'settings' | 'reader';
type Scope = { kind: 'all' } | { kind: 'uncategorized' } | { kind: 'category'; id: number };
type Patch = Partial<Pick<Bookmark, 'importance' | 'note' | 'category_id'>>;
type MinImportance = 0 | 1 | 2;

interface Filters {
  minImportance: MinImportance;  // 0 = all, 1 = important+pinned, 2 = pinned only
  domain: string | null;
  year: string | null;
  contentType: 'video' | 'x' | null;
}

interface FacetsPayload {
  domains: { name: string; count: number }[];
  years: { year: string; count: number }[];
  contentTypes: { name: string; count: number }[];
}

const EMPTY_FILTERS: Filters = { minImportance: 0, domain: null, year: null, contentType: null };

function isFilterActive(f: Filters): boolean {
  return f.minImportance !== 0 || f.domain !== null || f.year !== null || f.contentType !== null;
}

interface CategoryNode extends CategoryRow {
  children: CategoryNode[];
  subtreeCount: number;  // direct + descendants
  path: string;          // "Dev / React / Hooks"
  depth: number;
}

const PAGE_SIZE = 25;
const THEME_KEY = 'bm:theme';
const SIDEBAR_KEY = 'bm:sidebar-open';
const EXPANDED_KEY = 'bm:expanded-cats';
const PICKS_COLLAPSED_KEY = 'bm:picks-collapsed';

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function scopeToQuery(scope: Scope): string {
  if (scope.kind === 'all') return '__all__';
  if (scope.kind === 'uncategorized') return '__uncategorized__';
  return String(scope.id);
}

// Build a tree + flatten with path labels. Roll up descendant counts bottom-up.
function buildTree(rows: CategoryRow[]): { roots: CategoryNode[]; byId: Map<number, CategoryNode> } {
  const byId = new Map<number, CategoryNode>();
  for (const r of rows) {
    byId.set(r.id, { ...r, children: [], subtreeCount: r.count, path: r.name, depth: 0 });
  }
  const roots: CategoryNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Depth + path (pre-order) and subtree counts (post-order).
  const visit = (node: CategoryNode, depth: number, prefix: string) => {
    node.depth = depth;
    node.path = prefix ? `${prefix} / ${node.name}` : node.name;
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of node.children) visit(child, depth + 1, node.path);
    node.subtreeCount = node.count + node.children.reduce((s, c) => s + c.subtreeCount, 0);
  };
  roots.sort((a, b) => a.name.localeCompare(b.name));
  for (const r of roots) visit(r, 0, '');
  return { roots, byId };
}

// URL ↔ state mapping. Each navigable view has its own URL so refresh, share,
// and browser back/forward all work without a routing library.
//   /                                → all bookmarks (default landing)
//   /bookmarks                       → all bookmarks
//   /bookmarks?category=uncategorized → uncategorized
//   /bookmarks?category=N            → specific category
//   /feeds                           → feeds
//   /feeds?feed_id=N                 → feeds, pre-filtered (read once by FeedsView)
//   /settings                        → app-level maintenance tools (URL health, …)
//
// Legacy read-only support: /?view=feeds[&feed_id=N] is still parsed so old
// extension links and shared URLs keep working. We never write that shape.
interface UrlState { mode: Mode; scope: Scope; feedId: number | null; readerId: number | null }

function parseCategoryParam(raw: string | null): Scope {
  if (raw === 'uncategorized') return { kind: 'uncategorized' };
  const id = raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null;
  if (id !== null) return { kind: 'category', id };
  return { kind: 'all' };
}

const READER_PATH_RE = /^\/reader\/(\d+)\/?$/;

function readUrlState(): UrlState {
  try {
    const path = window.location.pathname;
    const p = new URLSearchParams(window.location.search);
    const readerMatch = path.match(READER_PATH_RE);
    if (readerMatch) {
      return { mode: 'reader', scope: { kind: 'all' }, feedId: null, readerId: Number(readerMatch[1]) };
    }
    if (path === '/settings') {
      return { mode: 'settings', scope: { kind: 'all' }, feedId: null, readerId: null };
    }
    if (path === '/shortlinks') {
      return { mode: 'shortlinks', scope: { kind: 'all' }, feedId: null, readerId: null };
    }
    if (path === '/feeds' || p.get('view') === 'feeds') {
      const raw = p.get('feed_id');
      const feedId = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
      return { mode: 'feeds', scope: { kind: 'all' }, feedId, readerId: null };
    }
    return { mode: 'bookmarks', scope: parseCategoryParam(p.get('category')), feedId: null, readerId: null };
  } catch {
    return { mode: 'bookmarks', scope: { kind: 'all' }, feedId: null, readerId: null };
  }
}

// Build the full path + query for a given state. feed_id is owned by FeedsView
// (not tracked in App state), so preserve it verbatim when we're already on
// /feeds and writing another feeds URL.
function buildUrl(mode: Mode, scope: Scope): string {
  if (mode === 'settings') return '/settings';
  if (mode === 'shortlinks') return '/shortlinks';
  if (mode === 'feeds') {
    const existing = new URLSearchParams(window.location.search).get('feed_id');
    return existing ? `/feeds?feed_id=${encodeURIComponent(existing)}` : '/feeds';
  }
  if (scope.kind === 'uncategorized') return '/bookmarks?category=uncategorized';
  if (scope.kind === 'category') return `/bookmarks?category=${scope.id}`;
  return '/bookmarks';
}

const INITIAL_URL_STATE = readUrlState();

export default function App() {
  // Reader is a self-contained, full-page view opened in a new tab. Short-
  // circuit the rest of App (sidebar, bookmark list state, URL-sync effects)
  // so it doesn't try to re-fetch the library or rewrite the URL away from
  // /reader/:id. INITIAL_URL_STATE is read once at module load and never
  // mutates — this branch is stable across renders, so hook order is
  // preserved within each branch.
  if (INITIAL_URL_STATE.mode === 'reader' && INITIAL_URL_STATE.readerId !== null) {
    return <ReaderView bookmarkId={INITIAL_URL_STATE.readerId} />;
  }

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [mode, setMode] = useState<Mode>(INITIAL_URL_STATE.mode);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    return saved === null ? true : saved === '1';
  });

  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [scope, setScope] = useState<Scope>(INITIAL_URL_STATE.scope);

  const [categoryRows, setCategoryRows] = useState<CategoryRow[]>([]);
  const [uncategorizedCount, setUncategorizedCount] = useState(0);
  const [libraryTotal, setLibraryTotal] = useState(0);

  const [view, setView] = useState<View>('list');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Bookmark[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [facets, setFacets] = useState<FacetsPayload>({ domains: [], years: [], contentTypes: [] });

  // Guards against reload / close while an optimistic write is still in flight.
  // The ref is authoritative (avoids setState-batching races); the boolean state
  // exists only to drive the `beforeunload` effect below.
  const pendingWrites = useRef(0);
  const [hasPendingWrites, setHasPendingWrites] = useState(false);

  const trackPending = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    pendingWrites.current += 1;
    setHasPendingWrites(true);
    try {
      return await work();
    } finally {
      pendingWrites.current -= 1;
      if (pendingWrites.current === 0) setHasPendingWrites(false);
    }
  }, []);

  useEffect(() => {
    if (!hasPendingWrites) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Modern browsers ignore custom messages and show their own generic dialog;
      // preventDefault + setting returnValue is the cross-browser trigger.
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasPendingWrites]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0');
  }, [sidebarOpen]);

  // Keep the URL in sync with mode/scope. On the first run we `replace` so
  // normalizations (e.g. `/` → `/bookmarks`, or a legacy `?view=feeds` link
  // arriving from the extension → `/feeds`) don't leave a useless back-button
  // entry. Subsequent runs `push` so each sidebar click is a real history step.
  const didMountUrl = useRef(false);
  useEffect(() => {
    const next = buildUrl(mode, scope);
    const current = `${window.location.pathname}${window.location.search}`;
    if (next !== current) {
      const method = didMountUrl.current ? 'pushState' : 'replaceState';
      window.history[method]({}, '', next);
    }
    didMountUrl.current = true;
  }, [mode, scope]);

  // Browser back/forward: re-derive state from the URL.
  useEffect(() => {
    const onPop = () => {
      const s = readUrlState();
      setMode(s.mode);
      setScope(s.scope);
      setPage(0);
      setFilters(EMPTY_FILTERS);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const r = await fetch('/api/categories');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as CategoriesPayload;
      setCategoryRows(d.categories ?? []);
      setUncategorizedCount(d.uncategorized ?? 0);
      setLibraryTotal(d.total ?? 0);
    } catch {
      // Sidebar degrades gracefully — main list still loads.
    }
  }, []);

  const loadPage = useCallback(async (nextPage: number, nextScope: Scope, nextFilters: Filters) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(nextPage * PAGE_SIZE),
        scope: scopeToQuery(nextScope),
      });
      if (nextFilters.minImportance > 0) params.set('min_importance', String(nextFilters.minImportance));
      if (nextFilters.domain) params.set('domain', nextFilters.domain);
      if (nextFilters.year) params.set('year', nextFilters.year);
      if (nextFilters.contentType) params.set('content_type', nextFilters.contentType);
      const r = await fetch(`/api/bookmarks?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { bookmarks: Bookmark[]; total: number };
      setBookmarks(d.bookmarks ?? []);
      setTotal(d.total ?? 0);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFacets = useCallback(async (nextScope: Scope) => {
    try {
      const r = await fetch(`/api/bookmarks/facets?scope=${scopeToQuery(nextScope)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as {
        domains?: FacetsPayload['domains'];
        years?: FacetsPayload['years'];
        content_types?: FacetsPayload['contentTypes'];
      };
      setFacets({
        domains: d.domains ?? [],
        years: d.years ?? [],
        contentTypes: d.content_types ?? [],
      });
    } catch {
      // Filter bar degrades to empty selects — list still works.
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadPage(page, scope, filters), loadCategories(), loadFacets(scope)]);
  }, [loadPage, loadCategories, loadFacets, page, scope, filters]);

  // Patch a single bookmark in place after re-enrich so the list doesn't
  // reload wholesale — that caused every card to re-mount and the browser
  // to lose its scroll anchor.
  const refreshOne = useCallback(async (id: number) => {
    try {
      const r = await fetch(`/api/bookmarks/${id}`);
      if (!r.ok) return;
      const { bookmark } = (await r.json()) as { bookmark: Bookmark };
      const apply = (list: Bookmark[]) =>
        list.map((b) => (b.id === id ? bookmark : b));
      setBookmarks(apply);
      setSearchResults((prev) => (prev ? apply(prev) : prev));
    } catch {
      // network blip — leave the row as-is; user can click re-enrich again
    }
  }, []);

  useEffect(() => { void loadPage(page, scope, filters); }, [loadPage, page, scope, filters]);
  useEffect(() => { void loadCategories(); }, [loadCategories]);
  useEffect(() => { void loadFacets(scope); }, [loadFacets, scope]);

  const switchScope = useCallback((next: Scope) => {
    setScope(next);
    setPage(0);
    // Clear filters on scope change — facets are about to change anyway, and a
    // stale "domain" pick usually confuses more than it saves.
    setFilters(EMPTY_FILTERS);
  }, []);

  const updateFilters = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(0);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { results: Bookmark[] };
        setSearchResults(d.results ?? []);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [query]);

  const updateBookmark = useCallback(async (id: number, patch: Patch) => {
    const apply = (list: Bookmark[]) =>
      list.map((b) => (b.id === id ? { ...b, ...patch } : b));
    setBookmarks(apply);
    setSearchResults((prev) => (prev ? apply(prev) : prev));
    await trackPending(async () => {
      try {
        const r = await fetch(`/api/bookmarks/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (patch.category_id !== undefined) void loadCategories();
      } catch {
        await refresh();
      }
    });
  }, [refresh, loadCategories, trackPending]);

  // Video-only: flip watchedAt on/off. Optimistic update edits the raw
  // metadata JSON in state so the card re-renders dimmed immediately; a
  // failing POST reverts via refresh().
  const toggleWatched = useCallback(async (id: number, watched: boolean) => {
    const mutate = (list: Bookmark[]) =>
      list.map((b) => {
        if (b.id !== id) return b;
        const meta = parseVideoMetadata(b.metadata);
        if (watched) meta.watchedAt = Date.now();
        else delete meta.watchedAt;
        return { ...b, metadata: JSON.stringify(meta) };
      });
    setBookmarks(mutate);
    setSearchResults((prev) => (prev ? mutate(prev) : prev));
    await trackPending(async () => {
      try {
        const r = await fetch(`/api/bookmarks/${id}/watched`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ watched }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch {
        await refresh();
      }
    });
  }, [refresh, trackPending]);

  const removeBookmark = useCallback(async (id: number) => {
    const drop = (list: Bookmark[]) => list.filter((b) => b.id !== id);
    setBookmarks(drop);
    setSearchResults((prev) => (prev ? drop(prev) : prev));
    await trackPending(async () => {
      try {
        const r = await fetch(`/api/bookmarks/${id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        void loadCategories();
      } catch {
        await refresh();
      }
    });
  }, [refresh, loadCategories, trackPending]);

  const tree = useMemo(() => buildTree(categoryRows), [categoryRows]);
  // Flat ordered list with paths, used by the per-card picker.
  const flatCategories = useMemo(() => {
    const out: CategoryNode[] = [];
    const walk = (nodes: CategoryNode[]) => {
      for (const n of nodes) { out.push(n); walk(n.children); }
    };
    walk(tree.roots);
    return out;
  }, [tree]);

  const scopeHeading = useMemo(() => {
    if (scope.kind === 'all') return 'All bookmarks';
    if (scope.kind === 'uncategorized') return 'Uncategorized';
    const node = tree.byId.get(scope.id);
    return node ? node.path : 'Collection';
  }, [scope, tree]);

  const pinned = bookmarks.filter((b) => b.importance === 2);
  const rest = bookmarks.filter((b) => b.importance !== 2);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className={`app-shell${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
        tree={tree.roots}
        uncategorizedCount={uncategorizedCount}
        libraryTotal={libraryTotal}
        scope={scope}
        onScopeChange={(next) => { setMode('bookmarks'); switchScope(next); }}
        onCategoriesChanged={loadCategories}
        mode={mode}
        onModeChange={setMode}
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
      />

      <main className="app-main">
        <header className="app-header">
          <button
            className="sidebar-btn"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-label="Toggle sidebar"
          >
            ☰
          </button>
          <h1>{mode === 'feeds' ? 'Feeds' : mode === 'settings' ? 'Settings' : mode === 'shortlinks' ? 'Short links' : scopeHeading}</h1>
          {mode === 'bookmarks' && <span className="header-count">{total.toLocaleString()}</span>}
          {mode === 'bookmarks' && (
            <div className="controls">
              <button onClick={() => setView((v) => (v === 'list' ? 'grid' : 'list'))}>
                {view === 'list' ? 'Grid' : 'List'}
              </button>
            </div>
          )}
        </header>

        {mode === 'settings' && <SettingsView onArchived={refresh} />}
        {mode === 'feeds' && <FeedsView initialFeedId={readUrlState().feedId} />}
        {mode === 'shortlinks' && <ShortlinksView />}
        {mode === 'bookmarks' && (<>
        <AddForm onSaved={refresh} />

        <input
          type="search"
          className="search-input"
          placeholder="Search your library — describe what you're looking for…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {searchResults === null && (
          <FilterBar
            filters={filters}
            facets={facets}
            onChange={updateFilters}
            onReset={() => updateFilters(EMPTY_FILTERS)}
          />
        )}

        <ChatPanel />

        {loading && <p className="empty">Loading…</p>}
        {error && <p className="empty">Error: {error}</p>}

        {searchResults === null && !loading && !error && scope.kind === 'all' && page === 0 && !isFilterActive(filters) && (
          <TodaysPicks
            view={view}
            categories={flatCategories}
            onReenriched={refreshOne}
            onUpdate={updateBookmark}
            onDelete={removeBookmark}
            onToggleWatched={toggleWatched}
          />
        )}

        {searchResults !== null ? (
          <section>
            <h2>
              {searching ? 'Searching…' : `Results for "${query.trim()}"`}
              {!searching && ` — ${searchResults.length}`}
            </h2>
            <BookmarkList
              items={searchResults}
              view={view}
              categories={flatCategories}
              onReenriched={refreshOne}
              onUpdate={updateBookmark}
              onDelete={removeBookmark}
              onToggleWatched={toggleWatched}
              emptyMessage={`No strong matches for "${query.trim()}". Try a longer or more specific query.`}
            />
          </section>
        ) : (
          <>
            {!loading && !error && pinned.length > 0 && page === 0 && (
              <section>
                <h2>Pinned</h2>
                <BookmarkList
                  items={pinned}
                  view={view}
                  categories={flatCategories}
                  onReenriched={refreshOne}
                  onUpdate={updateBookmark}
                  onDelete={removeBookmark}
                  onToggleWatched={toggleWatched}
                />
              </section>
            )}

            {!loading && !error && (
              <section>
                <h2>
                  {page === 0 ? 'Recent' : `Page ${page + 1}`}
                  <span className="count-hint">
                    — {bookmarks.length} on this page · {total.toLocaleString()} total
                  </span>
                </h2>
                <BookmarkList
                  items={page === 0 ? rest : bookmarks}
                  view={view}
                  categories={flatCategories}
                  onReenriched={refreshOne}
                  onUpdate={updateBookmark}
                  onDelete={removeBookmark}
                  onToggleWatched={toggleWatched}
                />
                {totalPages > 1 && (
                  <Pagination
                    page={page}
                    totalPages={totalPages}
                    onChange={setPage}
                  />
                )}
              </section>
            )}
          </>
        )}
        </>)}
      </main>
    </div>
  );
}

function Sidebar({
  open, onToggle, tree, uncategorizedCount, libraryTotal,
  scope, onScopeChange, onCategoriesChanged, mode, onModeChange,
  theme, onThemeToggle,
}: {
  open: boolean;
  onToggle: () => void;
  tree: CategoryNode[];
  uncategorizedCount: number;
  libraryTotal: number;
  scope: Scope;
  onScopeChange: (s: Scope) => void;
  onCategoriesChanged: () => Promise<void> | void;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  theme: Theme;
  onThemeToggle: () => void;
}) {
  const [creatingUnder, setCreatingUnder] = useState<number | null | 'root-requested'>(null);
  const [newName, setNewName] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseMsg, setParseMsg] = useState<string | null>(null);
  const [feedsUnread, setFeedsUnread] = useState<number | null>(null);

  // Badge refreshes on mount and when the user switches to the feeds view —
  // the FeedsView updates the count indirectly via mode toggles after reads.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/feeds');
        if (!r.ok) return;
        const d = (await r.json()) as { total_unread?: number };
        if (!cancelled) setFeedsUnread(d.total_unread ?? 0);
      } catch {
        // Badge just won't show a number; nav still works.
      }
    })();
    return () => { cancelled = true; };
  }, [mode]);
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      return raw ? new Set(JSON.parse(raw) as number[]) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  }, [expanded]);

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const create = async (parentId: number | null) => {
    const name = newName.trim();
    if (!name) { setCreatingUnder(null); setNewName(''); return; }
    try {
      await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parent_id: parentId }),
      });
      if (parentId !== null) setExpanded((prev) => new Set(prev).add(parentId));
      setNewName('');
      setCreatingUnder(null);
      await onCategoriesChanged();
    } catch {
      // silent — user can retry
    }
  };

  const remove = async (id: number, name: string) => {
    if (!confirm(`Delete "${name}"? Children and bookmarks move up to the parent.`)) return;
    await fetch(`/api/categories/${id}`, { method: 'DELETE' });
    if (scope.kind === 'category' && scope.id === id) onScopeChange({ kind: 'all' });
    await onCategoriesChanged();
  };

  const parseFromTags = async () => {
    setParsing(true);
    setParseMsg(null);
    try {
      const r = await fetch('/api/categories/parse', { method: 'POST' });
      const d = (await r.json()) as { assigned: number; categories: number };
      setParseMsg(
        d.assigned
          ? `Assigned ${d.assigned} bookmark${d.assigned === 1 ? '' : 's'}; ${d.categories} categor${d.categories === 1 ? 'y' : 'ies'} total.`
          : 'Nothing to parse — every tagged bookmark already has a category.',
      );
      await onCategoriesChanged();
    } catch {
      setParseMsg('Parse failed.');
    } finally {
      setParsing(false);
    }
  };

  if (!open) return null;

  return (
    <aside className="sidebar" aria-label="Collections">
      <div className="sidebar-head">
        <button
          className="sidebar-brand"
          onClick={() => onScopeChange({ kind: 'all' })}
          title="Go to All bookmarks"
        >
          Bookmarks
        </button>
        <button className="sidebar-btn" onClick={onToggle} title="Collapse sidebar">‹</button>
      </div>

      <div className="sidebar-body">
      <nav className="sidebar-nav">
        <button
          className={`sidebar-item${mode === 'bookmarks' && scope.kind === 'all' ? ' active' : ''}`}
          onClick={() => onScopeChange({ kind: 'all' })}
        >
          <span className="sidebar-item-label">All bookmarks</span>
          <span className="sidebar-item-count">{libraryTotal.toLocaleString()}</span>
        </button>
        <button
          className={`sidebar-item${mode === 'bookmarks' && scope.kind === 'uncategorized' ? ' active' : ''}`}
          onClick={() => onScopeChange({ kind: 'uncategorized' })}
        >
          <span className="sidebar-item-label">Uncategorized</span>
          <span className="sidebar-item-count">{uncategorizedCount.toLocaleString()}</span>
        </button>
        <button
          className={`sidebar-item${mode === 'feeds' ? ' active' : ''}`}
          onClick={() => onModeChange('feeds')}
        >
          <span className="sidebar-item-label">Feeds</span>
          {feedsUnread !== null && feedsUnread > 0 && (
            <span className="sidebar-item-count">{feedsUnread.toLocaleString()}</span>
          )}
        </button>
        <button
          className={`sidebar-item${mode === 'shortlinks' ? ' active' : ''}`}
          onClick={() => onModeChange('shortlinks')}
        >
          <span className="sidebar-item-label">Short links</span>
        </button>
      </nav>

      <div className="sidebar-section-head">
        <span>Collections</span>
        <button
          className="sidebar-mini-btn"
          onClick={() => setCreatingUnder('root-requested')}
          title="New top-level collection"
        >
          +
        </button>
      </div>

      {creatingUnder === 'root-requested' && (
        <CreateInput
          depth={0}
          value={newName}
          onChange={setNewName}
          onCommit={() => create(null)}
          onCancel={() => { setCreatingUnder(null); setNewName(''); }}
        />
      )}

      <nav className="sidebar-nav">
        {tree.length === 0 && creatingUnder === null && (
          <div className="sidebar-empty">
            No collections yet.{' '}
            <button className="link-btn inline" onClick={parseFromTags} disabled={parsing}>
              {parsing ? 'Parsing…' : 'Parse from imports'}
            </button>
          </div>
        )}
        {tree.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            scope={scope}
            expanded={expanded}
            creatingUnder={typeof creatingUnder === 'number' ? creatingUnder : null}
            newName={newName}
            onScopeChange={onScopeChange}
            onToggleExpand={toggleExpand}
            onStartCreate={(parentId) => { setCreatingUnder(parentId); setNewName(''); }}
            onCreate={create}
            onCancelCreate={() => { setCreatingUnder(null); setNewName(''); }}
            onChangeNewName={setNewName}
            onDelete={remove}
          />
        ))}
      </nav>

      {tree.length > 0 && (
        <div className="sidebar-foot-tools">
          <button className="link-btn inline" onClick={parseFromTags} disabled={parsing}>
            {parsing ? 'Parsing…' : 'Parse more from imports'}
          </button>
        </div>
      )}
      {parseMsg && <div className="sidebar-hint">{parseMsg}</div>}
      </div>

      <div className="sidebar-foot">
        <button
          className="theme-toggle"
          onClick={onThemeToggle}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
          {theme === 'light' ? '☾ Dark mode' : '☀ Light mode'}
        </button>
        <button
          className={`sidebar-foot-icon${mode === 'settings' ? ' active' : ''}`}
          onClick={() => onModeChange('settings')}
          title="Settings"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>
    </aside>
  );
}

function TreeNode({
  node, scope, expanded, creatingUnder, newName,
  onScopeChange, onToggleExpand, onStartCreate, onCreate, onCancelCreate, onChangeNewName, onDelete,
}: {
  node: CategoryNode;
  scope: Scope;
  expanded: Set<number>;
  creatingUnder: number | null;
  newName: string;
  onScopeChange: (s: Scope) => void;
  onToggleExpand: (id: number) => void;
  onStartCreate: (parentId: number) => void;
  onCreate: (parentId: number | null) => void;
  onCancelCreate: () => void;
  onChangeNewName: (v: string) => void;
  onDelete: (id: number, name: string) => void;
}) {
  const active = scope.kind === 'category' && scope.id === node.id;
  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const padding = 8 + node.depth * 14;

  return (
    <>
      <div className={`sidebar-item-row${active ? ' active' : ''}`}>
        <div className="sidebar-item-main" style={{ paddingLeft: padding }}>
          {hasChildren ? (
            <button
              className="tree-chevron"
              onClick={(e) => { e.stopPropagation(); onToggleExpand(node.id); }}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="tree-chevron-spacer" />
          )}
          <button
            className="sidebar-item-clickable"
            onClick={() => onScopeChange({ kind: 'category', id: node.id })}
          >
            <span className="sidebar-item-label">{node.name}</span>
            <span className="sidebar-item-count">
              {/* Show subtree total when collapsed and non-empty; direct count otherwise. */}
              {hasChildren && !isExpanded
                ? node.subtreeCount.toLocaleString()
                : node.count.toLocaleString()}
            </span>
          </button>
        </div>
        <button
          className="sidebar-item-add"
          onClick={() => onStartCreate(node.id)}
          title={`New collection under "${node.name}"`}
          aria-label={`New child of ${node.name}`}
        >
          +
        </button>
        <button
          className="sidebar-item-del"
          onClick={() => onDelete(node.id, node.name)}
          title={`Delete "${node.name}"`}
          aria-label={`Delete ${node.name}`}
        >
          ✕
        </button>
      </div>

      {creatingUnder === node.id && (
        <CreateInput
          depth={node.depth + 1}
          value={newName}
          onChange={onChangeNewName}
          onCommit={() => onCreate(node.id)}
          onCancel={onCancelCreate}
        />
      )}

      {isExpanded && node.children.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          scope={scope}
          expanded={expanded}
          creatingUnder={creatingUnder}
          newName={newName}
          onScopeChange={onScopeChange}
          onToggleExpand={onToggleExpand}
          onStartCreate={onStartCreate}
          onCreate={onCreate}
          onCancelCreate={onCancelCreate}
          onChangeNewName={onChangeNewName}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

function CreateInput({
  depth, value, onChange, onCommit, onCancel,
}: {
  depth: number;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const padding = 8 + depth * 14 + 18;  // align with label column, not chevron
  return (
    <div className="sidebar-create" style={{ paddingLeft: padding }}>
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        placeholder="Collection name"
        maxLength={64}
      />
    </div>
  );
}

function Pagination({
  page, totalPages, onChange,
}: { page: number; totalPages: number; onChange: (p: number) => void }) {
  const pages = buildPageList(page, totalPages);
  return (
    <nav className="pagination" aria-label="Pagination">
      <button className="page-btn" onClick={() => onChange(Math.max(0, page - 1))} disabled={page === 0}>
        ‹ Prev
      </button>
      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`ellipsis-${i}`} className="page-ellipsis">…</span>
        ) : (
          <button
            key={p}
            className={`page-btn${p === page ? ' active' : ''}`}
            onClick={() => onChange(p)}
          >
            {p + 1}
          </button>
        ),
      )}
      <button
        className="page-btn"
        onClick={() => onChange(Math.min(totalPages - 1, page + 1))}
        disabled={page >= totalPages - 1}
      >
        Next ›
      </button>
    </nav>
  );
}

function FilterBar({
  filters, facets, onChange, onReset,
}: {
  filters: Filters;
  facets: FacetsPayload;
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
}) {
  const active = isFilterActive(filters);
  const videoFacet = facets.contentTypes.find((c) => c.name === 'video');
  const xPostFacet = facets.contentTypes.find((c) => c.name === 'x');
  return (
    <div className="filter-bar" aria-label="Filters">
      <select
        className="filter-select"
        value={String(filters.minImportance)}
        onChange={(e) => onChange({ minImportance: Number(e.target.value) as MinImportance })}
        title="Filter by importance"
      >
        <option value="0">All</option>
        <option value="1">Important+</option>
        <option value="2">Pinned only</option>
      </select>
      {videoFacet && (
        <button
          type="button"
          className={`filter-chip${filters.contentType === 'video' ? ' active' : ''}`}
          onClick={() => onChange({ contentType: filters.contentType === 'video' ? null : 'video' })}
          title="Show only videos"
        >
          ▶ Videos ({videoFacet.count.toLocaleString()})
        </button>
      )}
      {xPostFacet && (
        <button
          type="button"
          className={`filter-chip${filters.contentType === 'x' ? ' active' : ''}`}
          onClick={() => onChange({ contentType: filters.contentType === 'x' ? null : 'x' })}
          title="Show only x.com posts"
        >
          𝕏 Posts ({xPostFacet.count.toLocaleString()})
        </button>
      )}
      <select
        className="filter-select"
        value={filters.domain ?? ''}
        onChange={(e) => onChange({ domain: e.target.value || null })}
        title="Filter by domain"
        disabled={facets.domains.length === 0}
      >
        <option value="">All domains</option>
        {facets.domains.map((d) => (
          <option key={d.name} value={d.name}>
            {d.name} ({d.count.toLocaleString()})
          </option>
        ))}
      </select>
      <select
        className="filter-select"
        value={filters.year ?? ''}
        onChange={(e) => onChange({ year: e.target.value || null })}
        title="Filter by year saved"
        disabled={facets.years.length === 0}
      >
        <option value="">All years</option>
        {facets.years.map((y) => (
          <option key={y.year} value={y.year}>
            {y.year} ({y.count.toLocaleString()})
          </option>
        ))}
      </select>
      {active && (
        <button className="filter-clear" onClick={onReset} title="Clear all filters">
          Clear filters
        </button>
      )}
    </div>
  );
}

function buildPageList(current: number, total: number): (number | '…')[] {
  const neighbors = 1;
  const pages = new Set<number>([0, total - 1, current]);
  for (let d = 1; d <= neighbors; d++) {
    if (current - d >= 0) pages.add(current - d);
    if (current + d < total) pages.add(current + d);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i]!;
    out.push(curr);
    const next = sorted[i + 1];
    if (next !== undefined && next - curr > 1) out.push('…');
  }
  return out;
}

// App-level maintenance tools. Single scrolling page with titled sections —
// no sub-nav until we reach 3+ sections (premature nav for one item is worse
// than a plain scroll). Add future tools (import cleanup, backup export,
// cost dashboard…) as sibling <section>s below the existing ones.
function SettingsView({ onArchived }: { onArchived: () => Promise<void> | void }) {
  return (
    <div className="settings-view">
      <section className="settings-section">
        <h2 className="settings-section-title">Enrichment</h2>
        <EnrichmentPanel onProgress={onArchived} />
      </section>
      <section className="settings-section">
        <h2 className="settings-section-title">URL health</h2>
        <DeadLinksView onArchived={onArchived} />
      </section>
    </div>
  );
}

interface DeadCandidate {
  id: number;
  url: string;
  title: string | null;
  domain: string | null;
  http_status: number;
  last_checked_at: number | null;
  created_at: number;
}

// URL-health scanner + dead-link review. Single page, two phases:
//   1. Scan — loops POST /check-health?since=<startTs> until remaining=0.
//      `since` is fixed at the start of the sweep so freshly-checked rows
//      drop out of the candidate set immediately and the loop terminates.
//   2. Review — lists 404/410 candidates with checkboxes; bulk-archives via
//      POST /archive-bulk. Re-fetches the list after archive so the user
//      can see what's left (or run another scan).
interface UrlConflict {
  forId: number;
  existing: { id: number; url: string; title: string | null; status: string };
}

function DeadLinksView({ onArchived }: { onArchived: () => Promise<void> | void }) {
  const [candidates, setCandidates] = useState<DeadCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ checked: number; dead: number; remaining: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Single-row edit — only one URL editable at a time so the conflict block
  // unambiguously belongs to one candidate.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<UrlConflict | null>(null);
  const stopRef = useRef(false);

  const loadDead = useCallback(async () => {
    try {
      const r = await fetch('/api/bookmarks/dead');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { bookmarks: DeadCandidate[] };
      setCandidates(d.bookmarks ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDead(); }, [loadDead]);

  const runScan = async () => {
    if (scanning) return;
    stopRef.current = false;
    setScanning(true);
    setScanProgress({ checked: 0, dead: 0, remaining: 0 });
    setError(null);
    // Fix the sweep cursor at the moment the user clicked Scan. Any row
    // probed during this sweep gets a last_checked_at >= startTs, so it
    // disappears from the candidate query on the next batch — guaranteeing
    // the loop terminates even if every probe completes instantly.
    const startTs = Date.now();
    let totalChecked = 0;
    let totalDead = 0;
    try {
      while (!stopRef.current) {
        const r = await fetch(`/api/bookmarks/check-health?since=${startTs}`, { method: 'POST' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { checked: number; dead: number; remaining: number };
        totalChecked += d.checked;
        totalDead += d.dead;
        setScanProgress({ checked: totalChecked, dead: totalDead, remaining: d.remaining });
        if (d.checked === 0 || d.remaining === 0) break;
      }
      await loadDead();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const stopScan = () => { stopRef.current = true; };

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === candidates.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(candidates.map((c) => c.id)));
    }
  };

  const archiveSelected = async () => {
    if (!selected.size || archiving) return;
    const ids = [...selected];
    if (!confirm(`Archive ${ids.length} dead bookmark${ids.length === 1 ? '' : 's'}?`)) return;
    setArchiving(true);
    try {
      const r = await fetch('/api/bookmarks/archive-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSelected(new Set());
      await loadDead();
      await onArchived();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setArchiving(false);
    }
  };

  const startEdit = (c: DeadCandidate) => {
    setEditingId(c.id);
    setEditValue(c.url);
    setEditError(null);
    setConflict(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue('');
    setEditError(null);
    setConflict(null);
  };

  const saveEdit = async () => {
    if (editingId === null || savingEdit) return;
    const trimmed = editValue.trim();
    if (!trimmed) { setEditError('URL required'); return; }
    setSavingEdit(true);
    setEditError(null);
    setConflict(null);
    try {
      const r = await fetch(`/api/bookmarks/${editingId}/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      if (r.status === 409) {
        const d = (await r.json()) as { existing: UrlConflict['existing'] };
        setConflict({ forId: editingId, existing: d.existing });
        return;
      }
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      // Optimistic removal — server cleared http_status, so the row no
      // longer matches /api/bookmarks/dead. User re-scans later to verify.
      setCandidates((prev) => prev.filter((b) => b.id !== editingId));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(editingId);
        return next;
      });
      cancelEdit();
      void onArchived();
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setSavingEdit(false);
    }
  };

  const resolveConflict = async (mode: 'keepExisting' | 'archiveBoth') => {
    if (!conflict) return;
    const ids = mode === 'archiveBoth'
      ? [conflict.forId, conflict.existing.id]
      : [conflict.forId];
    setSavingEdit(true);
    try {
      const r = await fetch('/api/bookmarks/archive-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setCandidates((prev) => prev.filter((b) => !ids.includes(b.id)));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      cancelEdit();
      await onArchived();
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setSavingEdit(false);
    }
  };

  // Group by domain for the review list. Same domain appearing 12 times in
  // the dead list often means the site changed its URL scheme rather than
  // 12 separate articles being lost — useful signal before bulk-archiving.
  const grouped = useMemo(() => {
    const m = new Map<string, DeadCandidate[]>();
    for (const c of candidates) {
      const k = c.domain ?? '(unknown)';
      const arr = m.get(k);
      if (arr) arr.push(c); else m.set(k, [c]);
    }
    return [...m.entries()];
  }, [candidates]);

  return (
    <div className="dead-links-view">
      <div className="dead-links-intro">
        <p>
          Probes every non-archived bookmark with a HEAD request (falling back to GET).
          Only <code>404</code> and <code>410</code> responses are flagged as dead — temporary
          blips, paywalls, and bot-blocking 403s are recorded but not surfaced here.
        </p>
        <div className="dead-links-actions">
          {scanning ? (
            <button className="enrich-banner-btn" onClick={stopScan}>Stop scan</button>
          ) : (
            <button className="enrich-banner-btn" onClick={runScan}>Scan all bookmarks</button>
          )}
          {scanProgress && (
            <span className="dead-links-progress">
              Checked {scanProgress.checked.toLocaleString()} · {scanProgress.dead} dead found
              {scanning && scanProgress.remaining > 0 && ` · ${scanProgress.remaining.toLocaleString()} remaining`}
            </span>
          )}
        </div>
      </div>

      {error && <div className="dead-links-error">Error: {error}</div>}

      {loading ? (
        <div className="dead-links-empty">Loading…</div>
      ) : candidates.length === 0 ? (
        <div className="dead-links-empty">
          No dead links found{scanProgress ? ' in this scan.' : ' yet. Run a scan to check.'}
        </div>
      ) : (
        <>
          <div className="dead-links-toolbar">
            <label className="dead-links-selectall">
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === candidates.length}
                ref={(el) => {
                  if (el) el.indeterminate = selected.size > 0 && selected.size < candidates.length;
                }}
                onChange={toggleAll}
              />
              {selected.size === candidates.length ? 'Deselect all' : 'Select all'}
            </label>
            <span className="dead-links-count">
              {candidates.length} dead · {selected.size} selected
            </span>
            <button
              className="enrich-banner-btn"
              onClick={archiveSelected}
              disabled={!selected.size || archiving}
            >
              {archiving ? 'Archiving…' : `Archive ${selected.size || ''}`}
            </button>
          </div>

          <div className="dead-links-list">
            {grouped.map(([domain, items]) => (
              <div key={domain} className="dead-links-group">
                <div className="dead-links-group-head">
                  {domain} <span className="dead-links-group-count">({items.length})</span>
                </div>
                {items.map((c) => {
                  const isEditing = editingId === c.id;
                  return (
                    <div key={c.id} className={`dead-links-row${isEditing ? ' editing' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggle(c.id)}
                        disabled={isEditing}
                        aria-label={`Select ${c.title || c.url}`}
                      />
                      <div className="dead-links-row-body">
                        <div className="dead-links-row-title">{c.title || c.url}</div>
                        {isEditing ? (
                          <div className="dead-links-edit">
                            <input
                              type="url"
                              className="dead-links-edit-input"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); void saveEdit(); }
                                if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                              }}
                              autoFocus
                              disabled={savingEdit}
                              placeholder="https://…"
                            />
                            <button
                              className="dead-links-edit-save"
                              onClick={() => void saveEdit()}
                              disabled={savingEdit}
                            >
                              {savingEdit ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              className="dead-links-edit-cancel"
                              onClick={cancelEdit}
                              disabled={savingEdit}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <a
                            className="dead-links-row-url"
                            href={c.url}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {c.url}
                          </a>
                        )}
                        {isEditing && editError && (
                          <div className="dead-links-edit-error">{editError}</div>
                        )}
                        {isEditing && conflict && conflict.forId === c.id && (
                          <div className="dead-links-conflict">
                            <div className="dead-links-conflict-msg">
                              This URL is already in your library
                              {conflict.existing.status === 'archived' && ' (archived)'}
                              :{' '}
                              <strong>{conflict.existing.title || conflict.existing.url}</strong>
                              {' '}(#{conflict.existing.id}).
                            </div>
                            <div className="dead-links-conflict-actions">
                              <button
                                className="dead-links-edit-save"
                                onClick={() => void resolveConflict('keepExisting')}
                                disabled={savingEdit}
                              >
                                Keep existing (archive this)
                              </button>
                              <button
                                className="dead-links-edit-cancel"
                                onClick={() => void resolveConflict('archiveBoth')}
                                disabled={savingEdit}
                              >
                                Archive both
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      <span className={`dead-links-status status-${c.http_status}`}>
                        {c.http_status}
                      </span>
                      {!isEditing && (
                        <button
                          className="dead-links-edit-btn"
                          onClick={() => startEdit(c)}
                          title="Edit URL"
                          aria-label="Edit URL"
                        >
                          ✎
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Drains the 'imported' + 'pending' backlog in bounded batches. The server
// processes each batch in background via waitUntil; we poll pending-count
// between rounds so the UI shows actual server-observed progress, not a
// hopeful counter based on what we queued.
//
// Lives in Settings (not the landing page) — enrichment is an on-demand
// maintenance action, not something the user should be nagged about every
// time they open the app.
function EnrichmentPanel({ onProgress }: { onProgress: () => Promise<void> | void }) {
  const [pending, setPending] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  const fetchPending = useCallback(async () => {
    try {
      const r = await fetch('/api/bookmarks/pending-count');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { pending: number };
      setPending(d.pending);
      setError(null);
    } catch (e) {
      setPending(null);
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void fetchPending(); }, [fetchPending]);

  const run = async () => {
    if (running) return;
    stopRef.current = false;
    setRunning(true);
    setError(null);
    try {
      // Loop: each round enriches up to 20, waits for the server to finish
      // (approx.), then checks the remaining count. Server backlog shrinking
      // is the true progress signal — a batch can "finish queuing" quickly
      // but take seconds to actually process.
      while (!stopRef.current) {
        const r = await fetch('/api/bookmarks/enrich-imported', { method: 'POST' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { queued: number; remaining: number };
        if (d.queued === 0) break;
        await new Promise((res) => setTimeout(res, 8000));
        await Promise.all([fetchPending(), Promise.resolve(onProgress())]);
        if (d.remaining === 0) break;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      await fetchPending();
    }
  };

  const stop = () => { stopRef.current = true; };

  const statusLine = (() => {
    if (pending === null && error) return 'Status unavailable';
    if (pending === null) return 'Loading status…';
    if (running) return `Enriching… ${pending.toLocaleString()} remaining`;
    if (pending === 0) return 'All bookmarks are enriched.';
    return `${pending.toLocaleString()} bookmark${pending === 1 ? '' : 's'} waiting to be enriched`;
  })();

  const hasBacklog = pending !== null && pending > 0;

  return (
    <div className="enrichment-panel">
      <div className="enrichment-panel-intro">
        <p>
          Imported bookmarks (from the Chrome extension or bulk import) and any
          saves stuck on <code>pending</code> are processed here. Each pass
          enriches up to 20 at a time — title, summary, tags, and embedding —
          so you can stop and resume safely.
        </p>
        <div className="enrichment-panel-actions">
          {running ? (
            <button className="enrich-banner-btn" onClick={stop}>Stop</button>
          ) : (
            <button
              className="enrich-banner-btn"
              onClick={run}
              disabled={!hasBacklog}
            >
              {hasBacklog ? 'Enrich all' : 'Nothing to enrich'}
            </button>
          )}
          <button
            className="enrichment-panel-refresh"
            onClick={() => { void fetchPending(); }}
            disabled={running}
          >
            Refresh status
          </button>
          <span className="enrichment-panel-status">{statusLine}</span>
        </div>
      </div>
      {error && <div className="dead-links-error">Error: {error}</div>}
    </div>
  );
}

function AddForm({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { duplicate?: boolean; restored?: boolean };
      setMsg(
        data.duplicate
          ? 'Already saved.'
          : data.restored
            ? 'Restored — refreshing in background…'
            : 'Saved — enriching in background…',
      );
      setUrl('');
      await onSaved();
      setTimeout(() => { void onSaved(); }, 3500);
    } catch (err) {
      setMsg(`Error: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="add-form">
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Paste a URL to save…"
        disabled={saving}
        autoComplete="off"
      />
      <button type="submit" disabled={saving || !url.trim()}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {msg && <div className="add-msg">{msg}</div>}
    </form>
  );
}

interface CardHandlers {
  categories: CategoryNode[];
  onReenriched: (id: number) => Promise<void> | void;
  onUpdate: (id: number, patch: Patch) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onToggleWatched: (id: number, watched: boolean) => Promise<void>;
}

function BookmarkList({
  items, view, emptyMessage, ...handlers
}: {
  items: Bookmark[];
  view: View;
  emptyMessage?: string;
} & CardHandlers) {
  if (!items.length) {
    return <p className="empty">{emptyMessage ?? 'Nothing here yet — save something from the Chrome extension.'}</p>;
  }
  return (
    <div className={`bookmarks ${view}`}>
      {items.map((b) => (
        <BookmarkCard key={b.id} b={b} {...handlers} />
      ))}
    </div>
  );
}

// Article-only: the markdown view targets readable prose, so we hide the
// button for video and X posts (their content_type is set), and for rows
// we haven't enriched yet (imported / pending / failed) — content_type is
// only confirmed after enrich() runs, so showing the button beforehand
// would be a guess.
function isMarkdownEligible(b: Bookmark): boolean {
  if (b.content_type === 'video' || b.content_type === 'x') return false;
  return b.status === 'active' || b.status === 'partial';
}

type MarkdownSource = 'cf-markdown' | 'jina' | 'reddit';

interface MarkdownResult {
  ok: true;
  markdown: string;
  source: MarkdownSource | null;
  cachedAt: number | null;
  cached: boolean;
}
interface MarkdownFailure {
  ok: false;
  reason: 'unsupported' | 'fetch_failed' | 'ineligible_content_type' | 'network';
  status?: number;
  detail?: string;
}

interface ReaderBookmark {
  id: number;
  url: string;
  title: string | null;
  domain: string | null;
}

type ReaderViewMode = 'rendered' | 'source';
type FetchState =
  | { phase: 'loading' }
  | { phase: 'refreshing'; previous: MarkdownResult }
  | { phase: 'done'; result: MarkdownResult | MarkdownFailure };

// Configure marked once. `gfm` enables tables/strikethrough/etc; `breaks: false`
// keeps single newlines as soft breaks (CommonMark default), which matches what
// most providers emit. `async: false` makes parse() return a string we can
// hand to DOMPurify synchronously.
marked.setOptions({ gfm: true, breaks: false, async: false });

// Open every link in a new tab — readers usually want to skim references
// without losing their place in the article. DOMPurify's ADD_ATTR config
// keeps the target/rel attributes through sanitization.
marked.use({
  renderer: {
    link({ href, title, tokens }) {
      const text = (this as unknown as { parser: { parseInline(t: unknown): string } }).parser.parseInline(tokens);
      const t = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
      return `<a href="${href}"${t} target="_blank" rel="noreferrer noopener">${text}</a>`;
    },
  },
});

function ReaderView({ bookmarkId }: { bookmarkId: number }) {
  const [bookmark, setBookmark] = useState<ReaderBookmark | null>(null);
  const [state, setState] = useState<FetchState>({ phase: 'loading' });
  const [view, setView] = useState<ReaderViewMode>('rendered');

  useEffect(() => {
    document.title = 'Reader — AI Bookmarks';
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/bookmarks/${bookmarkId}`);
        if (!r.ok) return;
        const data = await r.json() as { bookmark: ReaderBookmark };
        if (!cancelled && data.bookmark) {
          setBookmark(data.bookmark);
          if (data.bookmark.title) document.title = `${data.bookmark.title} — Reader`;
        }
      } catch {
        // bookmark metadata is decorative; markdown fetch is the real payload
      }
    })();
    return () => { cancelled = true; };
  }, [bookmarkId]);

  const fetchMarkdown = useCallback(async (revalidate: boolean) => {
    setState((prev) => {
      if (revalidate && prev.phase === 'done' && prev.result.ok) {
        return { phase: 'refreshing', previous: prev.result };
      }
      return { phase: 'loading' };
    });
    try {
      const url = `/api/bookmarks/${bookmarkId}/markdown${revalidate ? '?revalidate=1' : ''}`;
      const r = await fetch(url);
      const data = await r.json() as MarkdownResult | MarkdownFailure;
      setState({ phase: 'done', result: data });
    } catch {
      setState({ phase: 'done', result: { ok: false, reason: 'network' } });
    }
  }, [bookmarkId]);

  useEffect(() => { void fetchMarkdown(false); }, [fetchMarkdown]);

  // Memoized render: parse + sanitize once per markdown payload, not per
  // render. DOMPurify strips <script>, <iframe>, on* handlers, etc — the
  // worker fetches arbitrary external pages, so the markdown can contain
  // anything and we don't trust it.
  const visible: MarkdownResult | MarkdownFailure | null =
    state.phase === 'refreshing' ? state.previous :
    state.phase === 'done' ? state.result :
    null;
  const isLoading = state.phase === 'loading' || state.phase === 'refreshing';
  const renderedHtml = useMemo(() => {
    if (!visible || !visible.ok) return '';
    const cleaned = stripFrontmatter(visible.markdown);
    const raw = marked.parse(cleaned) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] });
  }, [visible]);

  return (
    <div className="reader-shell">
      <header className="reader-header">
        <div className="reader-title-block">
          <div className="reader-title">
            {bookmark?.title ?? (state.phase === 'loading' ? 'Loading…' : 'Reader')}
          </div>
          <div className="reader-sub">
            {bookmark && (
              <a href={bookmark.url} target="_blank" rel="noreferrer" className="reader-source-link">
                {bookmark.domain ?? bookmark.url}
              </a>
            )}
            {visible && visible.ok && (
              <>
                <span className="reader-dot">·</span>
                <span>{sourceLabel(visible.source)}</span>
                {visible.cachedAt != null && (
                  <>
                    <span className="reader-dot">·</span>
                    <span>
                      {state.phase === 'refreshing' ? 'Refreshing — cached ' : 'Cached '}
                      {formatRelativeTime(visible.cachedAt)}
                    </span>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        <div className="reader-actions">
          <div className="reader-toggle" role="tablist" aria-label="View mode">
            <button
              role="tab"
              aria-selected={view === 'rendered'}
              className={`reader-toggle-btn${view === 'rendered' ? ' active' : ''}`}
              onClick={() => setView('rendered')}
            >
              Rendered
            </button>
            <button
              role="tab"
              aria-selected={view === 'source'}
              className={`reader-toggle-btn${view === 'source' ? ' active' : ''}`}
              onClick={() => setView('source')}
            >
              Source
            </button>
          </div>
          <button
            className="reader-icon-btn"
            onClick={() => fetchMarkdown(true)}
            disabled={isLoading || !visible || !visible.ok}
            title="Refresh: re-fetch and update cache"
          >
            {isLoading ? '…' : '↻'}
          </button>
          <button
            className="reader-icon-btn"
            onClick={() => window.close()}
            title="Close tab"
          >
            ✕
          </button>
        </div>
      </header>

      <main className="reader-main">
        {state.phase === 'loading' && <div className="reader-empty">Fetching markdown…</div>}
        {visible && visible.ok && view === 'rendered' && (
          <article className="reader-article">
            <div className="reader-prose" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </article>
        )}
        {visible && visible.ok && view === 'source' && (
          <pre className="reader-source">{visible.markdown}</pre>
        )}
        {state.phase === 'done' && !state.result.ok && (
          <div className="reader-empty reader-error">{markdownErrorMessage(state.result)}</div>
        )}
      </main>
    </div>
  );
}

// Markdown for Agents and Jina Reader both prepend YAML frontmatter (--- ...
// ---) describing the page. That metadata is duplicated in our header (title,
// domain, source) so showing it inside the article body is just visual noise.
// Also strip Jina's "Title:/URL Source:/Published Time:/Markdown Content:"
// header block that comes before the actual content.
function stripFrontmatter(md: string): string {
  let out = md.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
  out = out.replace(/^(?:Title:.*\r?\n|URL Source:.*\r?\n|Published Time:.*\r?\n|Markdown Content:\s*\r?\n|\r?\n)+/i, '');
  return out;
}

function sourceLabel(source: MarkdownSource | null): string {
  if (source === 'cf-markdown') return 'via Cloudflare Markdown for Agents';
  if (source === 'jina') return 'via Jina Reader';
  if (source === 'reddit') return 'via Reddit API';
  return 'via unknown source';
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

function markdownErrorMessage(f: MarkdownFailure): string {
  switch (f.reason) {
    case 'unsupported':
      return `Couldn't get markdown for this URL.`;
    case 'fetch_failed':
      return `Could not reach the page${f.status ? ` (HTTP ${f.status})` : ''}.`;
    case 'ineligible_content_type':
      return `Markdown view isn't available for this content type.`;
    case 'network':
      return `Network error fetching markdown.`;
  }
}

function BookmarkCard({
  b, categories, onReenriched, onUpdate, onDelete, onToggleWatched,
}: { b: Bookmark } & CardHandlers) {
  const [busy, setBusy] = useState(false);
  const [shortCode, setShortCode] = useState<string | null>(b.short_code);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const clickCount = b.click_count ?? 0;

  // Sync local state if the parent reloads the row (e.g. after re-enrich).
  useEffect(() => { setShortCode(b.short_code); }, [b.short_code]);

  const shortenAndCopy = async () => {
    let code = shortCode;
    if (!code) {
      try {
        const r = await fetch(`/api/bookmarks/${b.id}/shorten`, { method: 'POST' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { short_code: string };
        code = d.short_code;
        setShortCode(code);
      } catch {
        setCopyHint('Failed');
        setTimeout(() => setCopyHint(null), 2000);
        return;
      }
    }
    const fullUrl = `${window.location.origin}/s/${code}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopyHint('Copied');
    } catch {
      setCopyHint(fullUrl);
    }
    setTimeout(() => setCopyHint(null), 2000);
  };

  const reenrich = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/bookmarks/${b.id}/re-enrich`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      // swallow — button just stops spinning
    }
    setTimeout(async () => { await onReenriched(b.id); setBusy(false); }, 3500);
  };

  const cycleImportance = () => {
    const next = ((b.importance + 1) % 3) as 0 | 1 | 2;
    void onUpdate(b.id, { importance: next });
  };

  const remove = () => {
    if (!confirm(`Delete "${b.title ?? b.url}"?`)) return;
    void onDelete(b.id);
  };

  const isVideo = b.content_type === 'video';
  const isXPost = b.content_type === 'x';
  const video = isVideo ? parseVideoMetadata(b.metadata) : null;
  const xPost = isXPost ? parseXPostMetadata(b.metadata) : null;
  const durationLabel = video ? formatDurationSec(video.durationSec) : null;
  const isWatched = !!video?.watchedAt;

  const pinnedClass = b.importance === 2 ? ' pinned' : b.importance === 1 ? ' important' : '';
  const videoClass = isVideo ? ' is-video' : '';
  const xPostClass = isXPost ? ' is-x-post' : '';
  const watchedClass = isWatched ? ' watched' : '';

  const showMarkdownButton = isMarkdownEligible(b);

  return (
    <div className={`bookmark${pinnedClass}${videoClass}${xPostClass}${watchedClass}`}>
      {b.og_image_url && (
        <a href={b.url} target="_blank" rel="noreferrer" className="bookmark-thumb">
          <img src={b.og_image_url} alt="" />
          {isVideo && <span className="play-overlay" aria-hidden>▶</span>}
          {isXPost && <span className="play-overlay" aria-hidden>𝕏</span>}
          {durationLabel && <span className="duration-badge">{durationLabel}</span>}
        </a>
      )}
      <div className="bookmark-body">
        <a href={b.url} target="_blank" rel="noreferrer" className="title">{b.title ?? b.url}</a>
        <div className="domain">
          {xPost?.handle ? (
            <span className="channel">@{xPost.handle}</span>
          ) : video?.channel ? (
            <span className="channel">{video.channel}</span>
          ) : (
            b.domain
          )}
        </div>
        {b.ai_summary && <div className="summary">{b.ai_summary}</div>}
        {!b.ai_summary && b.status === 'imported' && (
          <div className="summary muted-hint">Imported — click ↻ to enrich.</div>
        )}
        {renderTags(b.ai_tags)}
        <CategoryPicker
          value={b.category_id}
          options={categories}
          onChange={(next) => onUpdate(b.id, { category_id: next })}
        />
        <NoteField
          note={b.note}
          onSave={(note) => onUpdate(b.id, { note })}
        />
      </div>
      <div className="actions">
        <button
          className={`icon-btn shorten-btn${shortCode ? ' has-code' : ''}`}
          onClick={shortenAndCopy}
          title={shortCode ? `Copy short URL (${shortCode})` : 'Shorten & copy URL'}
          aria-label="Shorten and copy URL"
        >
          🔗
        </button>
        {shortCode && clickCount > 0 && (
          <button
            className="icon-btn click-badge"
            onClick={() => setStatsOpen(true)}
            title={`${clickCount.toLocaleString()} click${clickCount === 1 ? '' : 's'} — open stats`}
          >
            {clickCount.toLocaleString()}
          </button>
        )}
        {copyHint && <span className="copy-hint" role="status">{copyHint}</span>}
        <button
          className={`icon-btn importance-btn importance-${b.importance}`}
          onClick={cycleImportance}
          title={importanceLabel(b.importance)}
        >
          {importanceIcon(b.importance)}
        </button>
        {isVideo && (
          <button
            className={`icon-btn watched-btn${isWatched ? ' watched' : ''}`}
            onClick={() => void onToggleWatched(b.id, !isWatched)}
            title={isWatched ? 'Watched — click to mark unwatched' : 'Mark as watched'}
          >
            {isWatched ? '✓' : '◯'}
          </button>
        )}
        {showMarkdownButton && (
          <a
            className="icon-btn markdown-btn"
            href={`/reader/${b.id}`}
            target="_blank"
            rel="noreferrer"
            title="Preview as markdown (opens in new tab)"
            aria-label="Preview as markdown"
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </a>
        )}
        <button
          className="icon-btn reenrich-btn"
          onClick={reenrich}
          disabled={busy}
          title="Re-enrich: refetch page, regenerate summary and embedding"
        >
          {busy ? '…' : '↻'}
        </button>
        <button
          className="icon-btn delete-btn"
          onClick={remove}
          title="Archive this bookmark"
        >
          ✕
        </button>
      </div>
      {statsOpen && (
        <ClickStatsModal bookmarkId={b.id} title={b.title ?? b.url} onClose={() => setStatsOpen(false)} />
      )}
    </div>
  );
}

interface ClickStats {
  total: number;
  counted: number;
  daily: Array<{ day: string; count: number }>;
  topReferers: Array<{ referer: string; count: number }>;
  byCountry: Array<{ country: string; count: number }>;
  byUaClass: Array<{ ua_class: string; count: number }>;
}

function ClickStatsModal({ bookmarkId, title, onClose }: { bookmarkId: number; title: string; onClose: () => void }) {
  const [stats, setStats] = useState<ClickStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/bookmarks/${bookmarkId}/clicks`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as ClickStats;
        if (!cancelled) setStats(d);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [bookmarkId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal stats-modal" onClick={(e) => e.stopPropagation()}>
        <header className="stats-modal-head">
          <div>
            <div className="stats-modal-title">Click stats</div>
            <div className="stats-modal-subtitle">{title}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        {!stats && !error && <p className="empty">Loading…</p>}
        {error && <p className="empty">Error: {error}</p>}
        {stats && (
          <div className="stats-modal-body">
            <div className="stats-totals">
              <div><strong>{stats.counted.toLocaleString()}</strong> counted</div>
              <div className="muted">{stats.total.toLocaleString()} total · {Math.max(0, stats.total - stats.counted).toLocaleString()} link previews</div>
            </div>
            <DailyBarChart daily={stats.daily} />
            <div className="stats-tables">
              <div>
                <h4>Top referers</h4>
                {stats.topReferers.length === 0 ? <p className="empty muted">No referer data yet.</p> : (
                  <ul className="stats-list">
                    {stats.topReferers.map((r) => (
                      <li key={r.referer}><span className="stats-list-label" title={r.referer}>{r.referer}</span><span>{r.count.toLocaleString()}</span></li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h4>Top countries</h4>
                {stats.byCountry.length === 0 ? <p className="empty muted">No country data yet.</p> : (
                  <ul className="stats-list">
                    {stats.byCountry.map((c) => (
                      <li key={c.country}><span className="stats-list-label">{c.country}</span><span>{c.count.toLocaleString()}</span></li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DailyBarChart({ daily }: { daily: Array<{ day: string; count: number }> }) {
  const max = Math.max(1, ...daily.map((d) => d.count));
  const width = 320;
  const height = 80;
  const barW = width / daily.length;
  return (
    <div className="stats-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Daily clicks last 30 days">
        {daily.map((d, i) => {
          const h = (d.count / max) * (height - 2);
          return (
            <rect
              key={d.day}
              x={i * barW + 1}
              y={height - h}
              width={Math.max(1, barW - 2)}
              height={h}
              fill="currentColor"
            >
              <title>{d.day}: {d.count}</title>
            </rect>
          );
        })}
      </svg>
      <div className="stats-chart-axis">
        <span>{daily[0]?.day ?? ''}</span>
        <span>{daily[daily.length - 1]?.day ?? ''}</span>
      </div>
    </div>
  );
}

interface ShortlinkRow {
  id: number;
  url: string;
  title: string | null;
  domain: string | null;
  short_code: string;
  short_url: string;
  click_count: number;
  shortened_at: number | null;
  created_at: number;
  recent_7d: number;
  prior_7d: number;
}

interface ShortlinksSummary {
  links: number;
  counted_total: number;
  raw_total: number;
  daily: Array<{ day: string; count: number }>;
  top_links: Array<{ id: number; title: string | null; url: string; short_code: string; click_count: number }>;
  top_referers: Array<{ referer: string; count: number }>;
}

function ShortlinksView() {
  const [rows, setRows] = useState<ShortlinkRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<ShortlinksSummary | null>(null);
  const [sort, setSort] = useState<'clicks' | 'created'>('clicks');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statsFor, setStatsFor] = useState<ShortlinkRow | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [editingAlias, setEditingAlias] = useState<number | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sortParam = sort === 'created' ? 'created' : 'clicks';
      const [listRes, summaryRes] = await Promise.all([
        fetch(`/api/shortlinks?sort=${sortParam}&limit=200`),
        fetch('/api/shortlinks/summary'),
      ]);
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      const d = (await listRes.json()) as { shortlinks: ShortlinkRow[]; total: number };
      setRows(d.shortlinks ?? []);
      setTotal(d.total ?? 0);
      if (summaryRes.ok) {
        setSummary((await summaryRes.json()) as ShortlinksSummary);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sort]);

  useEffect(() => { void load(); }, [load]);

  const copyShort = async (row: ShortlinkRow) => {
    try {
      await navigator.clipboard.writeText(row.short_url);
      setCopied(row.id);
      setTimeout(() => setCopied((id) => (id === row.id ? null : id)), 1500);
    } catch {
      // Clipboard blocked — leave the URL visible so user can select it.
    }
  };

  const startEditAlias = (row: ShortlinkRow) => {
    setEditingAlias(row.id);
    setAliasDraft(row.short_code);
    setAliasError(null);
  };

  const saveAlias = async (row: ShortlinkRow) => {
    const next = aliasDraft.trim();
    if (!next || next === row.short_code) {
      setEditingAlias(null);
      return;
    }
    setBusyId(row.id);
    setAliasError(null);
    try {
      const r = await fetch(`/api/bookmarks/${row.id}/shorten`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: next }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setAliasError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setEditingAlias(null);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const regenerate = async (row: ShortlinkRow) => {
    if (!confirm(`Replace /s/${row.short_code} with a new code? The old URL will start returning 404.`)) return;
    setBusyId(row.id);
    try {
      const r = await fetch(`/api/bookmarks/${row.id}/shorten/regenerate`, { method: 'POST' });
      if (r.ok) await load();
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (row: ShortlinkRow) => {
    if (!confirm(`Revoke /s/${row.short_code}? The bookmark stays, but the short URL will 404 and click history is cleared.`)) return;
    setBusyId(row.id);
    try {
      const r = await fetch(`/api/bookmarks/${row.id}/shorten`, { method: 'DELETE' });
      if (r.ok) await load();
    } finally {
      setBusyId(null);
    }
  };

  const visibleRows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.title ?? '').toLowerCase().includes(q) ||
      (r.domain ?? '').toLowerCase().includes(q) ||
      r.short_code.toLowerCase().includes(q),
    );
  }, [rows, filter]);

  const hasLinks = rows.length > 0;
  const hasClicks = (summary?.counted_total ?? 0) > 0;
  const previewClicks = summary ? Math.max(0, summary.raw_total - summary.counted_total) : 0;

  return (
    <section className="shortlinks-view">
      {summary && hasLinks && (
        <div className="shortlinks-summary">
          <div className="shortlinks-summary-stats">
            <div>
              <div className="big-num">{summary.counted_total.toLocaleString()}</div>
              <div className="muted small">clicks</div>
            </div>
            <div>
              <div className="big-num">{summary.links.toLocaleString()}</div>
              <div className="muted small">links</div>
            </div>
            {previewClicks > 0 && (
              <div>
                <div className="big-num">{previewClicks.toLocaleString()}</div>
                <div className="muted small">previews</div>
              </div>
            )}
          </div>
          {hasClicks ? (
            <DailyBarChart daily={summary.daily} />
          ) : (
            <div className="stats-chart-empty muted small">No clicks recorded yet — share a short URL to start tracking.</div>
          )}
        </div>
      )}

      {hasLinks && (
        <div className="shortlinks-toolbar">
          <input
            className="search-input shortlinks-search"
            type="search"
            placeholder="Filter by title, domain, or code…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="muted">{visibleRows.length.toLocaleString()} of {total.toLocaleString()}</span>
          <div className="shortlinks-sort">
            <button
              className={sort === 'clicks' ? 'active' : ''}
              onClick={() => setSort('clicks')}
            >Most clicked</button>
            <button
              className={sort === 'created' ? 'active' : ''}
              onClick={() => setSort('created')}
            >Recently shortened</button>
          </div>
        </div>
      )}

      {loading && <p className="empty">Loading…</p>}
      {error && <p className="empty">Error: {error}</p>}
      {!loading && !error && !hasLinks && (
        <div className="shortlinks-empty">
          <div className="shortlinks-empty-icon" aria-hidden>🔗</div>
          <h3>No short links yet</h3>
          <p>Open any bookmark and click the <strong>🔗</strong> button to mint a short URL — or use the Chrome extension's <strong>“Shorten &amp; copy URL”</strong> on any page.</p>
          <p className="muted small">Short URLs look like <code>{window.location.origin}/s/aB3xZ9</code> and track clicks automatically.</p>
        </div>
      )}
      {!loading && !error && hasLinks && visibleRows.length === 0 && (
        <p className="empty muted">No matches for “{filter}”.</p>
      )}
      {!loading && !error && visibleRows.length > 0 && (
        <table className="shortlinks-table">
          <thead>
            <tr>
              <th>Bookmark</th>
              <th>Short URL</th>
              <th className="num">Clicks</th>
              <th className="num">Last 7d</th>
              <th>Trend</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const delta = row.recent_7d - row.prior_7d;
              const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '–';
              const isEditing = editingAlias === row.id;
              const rowBusy = busyId === row.id;
              return (
                <tr key={row.id} className={rowBusy ? 'is-busy' : ''}>
                  <td>
                    <a href={row.url} target="_blank" rel="noreferrer">{row.title ?? row.url}</a>
                    <div className="muted small">{row.domain}</div>
                  </td>
                  <td>
                    {isEditing ? (
                      <div className="alias-editor">
                        <span className="alias-prefix">/s/</span>
                        <input
                          className="alias-input"
                          value={aliasDraft}
                          autoFocus
                          onChange={(e) => { setAliasDraft(e.target.value); setAliasError(null); }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveAlias(row);
                            if (e.key === 'Escape') { setEditingAlias(null); setAliasError(null); }
                          }}
                          disabled={rowBusy}
                        />
                        <button className="link-btn" onClick={() => void saveAlias(row)} disabled={rowBusy}>Save</button>
                        <button className="link-btn muted" onClick={() => { setEditingAlias(null); setAliasError(null); }} disabled={rowBusy}>Cancel</button>
                        {aliasError && <div className="alias-error">{aliasError}</div>}
                      </div>
                    ) : (
                      <div className="short-url-cell">
                        <button className="link-btn short-url-text" onClick={() => void copyShort(row)} title={`Copy ${row.short_url}`}>
                          /s/{row.short_code}
                        </button>
                        <button
                          className="copy-icon-btn"
                          onClick={() => void copyShort(row)}
                          title={`Copy ${row.short_url}`}
                          aria-label="Copy short URL"
                        >
                          {copied === row.id ? (
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="11" height="11" rx="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="num">{row.click_count.toLocaleString()}</td>
                  <td className="num">{row.recent_7d.toLocaleString()}</td>
                  <td className={`trend ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`}>
                    {arrow} {delta === 0 ? '0' : (delta > 0 ? `+${delta}` : delta)}
                  </td>
                  <td className="row-actions">
                    <button className="link-btn" onClick={() => setStatsFor(row)} disabled={rowBusy}>Stats</button>
                    <button className="link-btn" onClick={() => startEditAlias(row)} disabled={rowBusy || isEditing}>Edit alias</button>
                    <button className="link-btn" onClick={() => void regenerate(row)} disabled={rowBusy}>Regenerate</button>
                    <button className="link-btn danger" onClick={() => void revoke(row)} disabled={rowBusy}>Revoke</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {statsFor && (
        <ClickStatsModal
          bookmarkId={statsFor.id}
          title={statsFor.title ?? statsFor.url}
          onClose={() => setStatsFor(null)}
        />
      )}
    </section>
  );
}

function CategoryPicker({
  value, options, onChange,
}: { value: number | null; options: CategoryNode[]; onChange: (next: number | null) => Promise<void> }) {
  const [saving, setSaving] = useState(false);

  const handleChange = async (next: number | null) => {
    setSaving(true);
    try {
      await onChange(next);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`category-picker${saving ? ' is-saving' : ''}`}>
      <select
        className="category-select"
        value={value === null ? 'none' : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          void handleChange(v === 'none' ? null : Number(v));
        }}
        title="Collection"
        disabled={saving}
      >
        <option value="none">Uncategorized</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
          {' '.repeat(o.depth)}{o.name}
          </option>
        ))}
        {/* Stale selection safety net: if the bookmark points at a category no longer in the list
            (e.g. deleted by another tab before refresh), surface it so the select isn't blank. */}
        {value !== null && !options.some((o) => o.id === value) && (
          <option value={value}>(unknown #{value})</option>
        )}
      </select>
      {saving && <span className="category-saving" aria-live="polite">Saving…</span>}
    </div>
  );
}

function renderTags(raw: string) {
  if (!raw) return null;
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    return null;
  }
  if (!tags.length) return null;
  return (
    <div className="tags">
      {tags.map((t) => <span key={t} className="tag">{t}</span>)}
    </div>
  );
}

function importanceIcon(n: number): string {
  if (n === 2) return '★';
  if (n === 1) return '★';
  return '☆';
}

function importanceLabel(n: number): string {
  if (n === 2) return 'Pinned — click to reset';
  if (n === 1) return 'Important — click to pin';
  return 'Normal — click to mark important';
}

function NoteField({
  note, onSave,
}: { note: string; onSave: (note: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(note); }, [note]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const commit = async () => {
    setEditing(false);
    if (draft === note) return;
    await onSave(draft);
  };

  if (editing) {
    return (
      <textarea
        ref={ref}
        className="note-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setDraft(note); setEditing(false); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void commit();
        }}
        placeholder="Add a note…"
        rows={2}
      />
    );
  }

  return (
    <div
      className={`note-view${note ? '' : ' note-empty'}`}
      onClick={() => setEditing(true)}
      title="Click to edit note"
    >
      {note || 'Add a note…'}
    </div>
  );
}

interface PickEnvelope { reason: string; bookmark: Bookmark; }

// Dev-only fixtures. Referenced from TodaysPicks.fetchPicks behind a
// import.meta.env.DEV guard, so this whole block is dead-code-eliminated in
// production builds. Delete once seeded local data is reliable.
const DUMMY_PICKS: PickEnvelope[] = [
  {
    reason: 'You bookmarked three React 19 deep-dives this month — this one ties them together.',
    bookmark: {
      id: -1001,
      url: 'https://overreacted.io/before-you-memo/',
      title: 'Before You memo() — Dan Abramov',
      note: '',
      domain: 'overreacted.io',
      ai_summary: 'Two patterns to avoid wrapping everything in React.memo: lift state up, or move expensive children below the state.',
      ai_tags: 'react,performance,memo',
      category_id: null,
      og_image_url: null,
      importance: 4,
      status: 'active',
      content_type: 'article',
      metadata: '{}',
      short_code: null,
      click_count: 0,
      created_at: Date.now() - 1000 * 60 * 60 * 6,
    },
  },
  {
    reason: "Matches your recent reading on edge databases — and you haven't watched a video in a while.",
    bookmark: {
      id: -1002,
      url: 'https://www.youtube.com/watch?v=dummyvideo',
      title: 'How Cloudflare D1 actually works under the hood',
      note: '',
      domain: 'youtube.com',
      ai_summary: 'Walks through D1 internals: SQLite at the edge, replication via leader-followers, and the read/write split.',
      ai_tags: 'cloudflare,d1,sqlite,databases',
      category_id: null,
      og_image_url: null,
      importance: 3,
      status: 'active',
      content_type: 'video',
      metadata: JSON.stringify({ channel: 'Cloudflare', durationSec: 1342 }),
      short_code: null,
      click_count: 0,
      created_at: Date.now() - 1000 * 60 * 60 * 24 * 2,
    },
  },
  {
    reason: 'Saved 3 weeks ago, never opened — short read worth catching up on.',
    bookmark: {
      id: -1003,
      url: 'https://martinfowler.com/articles/feature-toggles.html',
      title: 'Feature Toggles (aka Feature Flags) — Martin Fowler',
      note: 'For the auth refactor.',
      domain: 'martinfowler.com',
      ai_summary: 'Categorises flags into release / experiment / ops / permission toggles, and explains how lifetime + dynamism shape the implementation.',
      ai_tags: 'feature-flags,deployment,architecture',
      category_id: null,
      og_image_url: null,
      importance: 5,
      status: 'active',
      content_type: 'article',
      metadata: '{}',
      short_code: null,
      click_count: 0,
      created_at: Date.now() - 1000 * 60 * 60 * 24 * 21,
    },
  },
];

function TodaysPicks({
  view, ...handlers
}: { view: View } & CardHandlers) {
  const [picks, setPicks] = useState<PickEnvelope[] | null>(null);
  const [date, setDate] = useState<string>('');
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(PICKS_COLLAPSED_KEY) === '1';
  });

  const fetchPicks = useCallback(async () => {
    try {
      const r = await fetch('/api/suggestions/today');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { date: string; picks: PickEnvelope[] };
      setDate(d.date);
      const picks = d.picks ?? [];
      // Dev-only fallback: render dummy picks when the local DB has none, so
      // the section is visible while iterating on UI. Stripped from prod by Vite.
      if (import.meta.env.DEV && picks.length === 0) {
        setDate(d.date || new Date().toISOString().slice(0, 10));
        setPicks(DUMMY_PICKS);
      } else {
        setPicks(picks);
      }
    } catch {
      if (import.meta.env.DEV) {
        setDate(new Date().toISOString().slice(0, 10));
        setPicks(DUMMY_PICKS);
      } else {
        setPicks([]);
      }
    }
  }, []);

  useEffect(() => { void fetchPicks(); }, [fetchPicks]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(PICKS_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/suggestions/refresh', { method: 'POST' });
      await fetchPicks();
    } finally {
      setRefreshing(false);
    }
  };

  if (picks === null) return null;
  if (!picks.length) return null;

  return (
    <section className="picks-section">
      <h2>
        <button
          type="button"
          className="picks-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▸' : '▾'} Today's picks · {date}
        </button>
        {!collapsed && (
          <button className="link-btn" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'refreshing…' : 'refresh'}
          </button>
        )}
      </h2>
      {!collapsed && (
        <div className={`bookmarks ${view}`}>
          {picks.map((p) => (
            <div key={p.bookmark.id} className="pick-wrap">
              {p.reason && <div className="pick-reason">{p.reason}</div>}
              <BookmarkCard b={p.bookmark} {...handlers} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface ChatSource {
  id: number;
  url: string;
  title: string | null;
  domain: string | null;
}

function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string>('');
  const [sources, setSources] = useState<ChatSource[]>([]);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setAnswer('');
    setSources([]);
    setErr(null);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      const d = (await r.json()) as { answer: string; sources: ChatSource[] };
      setAnswer(d.answer);
      setSources(d.sources ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  return (
    <section className={`chat-panel${open ? ' open' : ''}`}>
      <button className="chat-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Ask your library
      </button>
      {open && (
        <div className="chat-body">
          <form onSubmit={ask} className="chat-form">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What did I save about vector databases?"
              disabled={asking}
            />
            <button type="submit" disabled={asking || !question.trim()}>
              {asking ? 'Thinking…' : 'Ask'}
            </button>
          </form>
          {err && <div className="chat-error">Error: {err}</div>}
          {answer && <ChatAnswer answer={answer} sources={sources} />}
        </div>
      )}
    </section>
  );
}

function ChatAnswer({ answer, sources }: { answer: string; sources: ChatSource[] }) {
  const parts = answer.split(/(\[#\d+\])/g);
  return (
    <div className="chat-answer">
      <div className="chat-answer-text">
        {parts.map((part, i) => {
          const m = part.match(/^\[#(\d+)\]$/);
          if (m) {
            const id = Number(m[1]);
            const source = sources.find((s) => s.id === id);
            if (source) {
              return (
                <a key={i} href={source.url} target="_blank" rel="noreferrer" className="citation">
                  [#{id}]
                </a>
              );
            }
          }
          return <span key={i}>{part}</span>;
        })}
      </div>
      {sources.length > 0 && (
        <div className="chat-sources">
          <div className="chat-sources-label">Sources</div>
          {sources.map((s) => (
            <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="chat-source">
              <span className="chat-source-id">#{s.id}</span>
              <span className="chat-source-title">{s.title ?? s.url}</span>
              <span className="chat-source-domain">{s.domain}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Feeds view
// ──────────────────────────────────────────────────────────────────

interface Feed {
  id: number;
  url: string;
  title: string | null;
  site_url: string | null;
  favicon_url: string | null;
  last_fetched_at: number | null;
  error: string | null;
  unread_count: number;
  total_count: number;
}

interface FeedItem {
  id: number;
  feed_id: number;
  url: string | null;
  title: string | null;
  author: string | null;
  published_at: number | null;
  ai_summary: string | null;
  read_at: number | null;
  saved_bookmark_id: number | null;
  feed_title: string | null;
  feed_favicon_url: string | null;
}

interface FeedCandidate {
  url: string;
  title: string | null;
  type: 'rss' | 'atom' | 'unknown';
}

// Banner state for the add-feed form. Kinds have different render/dismiss
// rules: success auto-clears, info carries a deep-link to an existing feed,
// candidates renders a picker, error sticks until replaced.
type AddMsg =
  | { kind: 'success'; text: string }
  | { kind: 'info'; text: string; feedId?: number }
  | { kind: 'error'; text: string }
  | { kind: 'candidates'; candidates: FeedCandidate[]; sourceUrl: string };

const FEEDS_PAGE_SIZE = 50;

function FeedsView({ initialFeedId }: { initialFeedId: number | null }) {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [feedFilter, setFeedFilter] = useState<number | 'all'>(initialFeedId ?? 'all');
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<AddMsg | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);

  // Success and info banners self-dismiss; errors linger until replaced.
  useEffect(() => {
    if (!addMsg || addMsg.kind === 'error') return;
    const t = setTimeout(() => setAddMsg(null), 4000);
    return () => clearTimeout(t);
  }, [addMsg]);
  useEffect(() => {
    if (!itemError) return;
    const t = setTimeout(() => setItemError(null), 5000);
    return () => clearTimeout(t);
  }, [itemError]);

  const loadFeeds = useCallback(async () => {
    try {
      const r = await fetch('/api/feeds');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { feeds: Feed[] };
      setFeeds(d.feeds ?? []);
    } catch {
      // Non-fatal: the selector will show "All feeds" only.
    }
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(FEEDS_PAGE_SIZE),
        offset: String(page * FEEDS_PAGE_SIZE),
      });
      if (feedFilter !== 'all') params.set('feed_id', String(feedFilter));
      if (unreadOnly) params.set('unread', '1');
      const r = await fetch(`/api/feeds/items?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { items: FeedItem[]; total: number };
      setItems(d.items ?? []);
      setTotal(d.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [page, feedFilter, unreadOnly]);

  useEffect(() => { void loadFeeds(); }, [loadFeeds]);
  useEffect(() => { void loadItems(); }, [loadItems]);

  // A click on the title opens the URL (target=_blank) AND marks read
  // optimistically. The server call is best-effort; on failure the row
  // will snap back on the next load.
  const markRead = async (id: number) => {
    setItems((prev) => prev.map((it) => it.id === id ? { ...it, read_at: Date.now() } : it));
    try {
      await fetch(`/api/feeds/items/${id}/read`, { method: 'POST' });
      void loadFeeds();  // refresh unread counts in the selector
    } catch {
      // Snap-back on next load; no inline error needed.
    }
  };

  const summarize = async (id: number) => {
    setItems((prev) => prev.map((it) => it.id === id ? { ...it, ai_summary: '__loading__' } : it));
    try {
      const r = await fetch(`/api/feeds/items/${id}/summarize`, { method: 'POST' });
      const d = (await r.json()) as { ok?: boolean; summary?: string; error?: string };
      if (!r.ok || !d.summary) throw new Error(d.error ?? `HTTP ${r.status}`);
      setItems((prev) => prev.map((it) =>
        it.id === id ? { ...it, ai_summary: d.summary!, read_at: it.read_at ?? Date.now() } : it,
      ));
      void loadFeeds();  // summarize marks-as-read → affects unread count
    } catch (err) {
      setItems((prev) => prev.map((it) =>
        it.id === id ? { ...it, ai_summary: null } : it,
      ));
      setItemError(`Summary failed: ${(err as Error).message}`);
    }
  };

  const markAllRead = async () => {
    const ids = items.filter((it) => it.read_at === null).map((it) => it.id);
    if (!ids.length) return;
    setItems((prev) => prev.map((it) => ({ ...it, read_at: it.read_at ?? Date.now() })));
    try {
      await fetch('/api/feeds/items/read-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      void loadFeeds();
      if (unreadOnly) { setPage(0); void loadItems(); }
    } catch {
      void loadItems();
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const r = await fetch('/api/feeds/refresh', { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await Promise.all([loadFeeds(), loadItems()]);
    } finally {
      setRefreshing(false);
    }
  };

  // Accepts either the URL from the input (user submit) or a pre-picked
  // candidate URL (from the multi-feed picker). The picker path skips
  // discovery because the backend already identified the candidate as a feed.
  const addFeed = async (e?: FormEvent, overrideUrl?: string) => {
    if (e) e.preventDefault();
    const trimmed = (overrideUrl ?? addUrl).trim();
    if (!trimmed || addBusy) return;
    setAddBusy(true);
    setAddMsg(null);
    try {
      const r = await fetch('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const d = (await r.json()) as {
        ok?: boolean;
        error?: string;
        items_added?: number;
        feed?: { id: number; title: string | null };
        feed_id?: number;
        candidates?: FeedCandidate[];
      };

      if (r.status === 300 && Array.isArray(d.candidates) && d.candidates.length > 1) {
        setAddMsg({ kind: 'candidates', candidates: d.candidates, sourceUrl: trimmed });
        return;
      }
      if (r.status === 409) {
        setAddMsg({
          kind: 'info',
          text: d.error ?? 'Feed already subscribed.',
          feedId: d.feed_id,
        });
        return;
      }
      if (!r.ok) {
        setAddMsg({ kind: 'error', text: d.error ?? `HTTP ${r.status}` });
        return;
      }

      const title = d.feed?.title?.trim();
      setAddMsg({
        kind: 'success',
        text: title
          ? `Subscribed to ${title} — ${d.items_added ?? 0} items imported.`
          : `Subscribed — ${d.items_added ?? 0} items imported.`,
      });
      setAddUrl('');
      await Promise.all([loadFeeds(), loadItems()]);
    } catch (err) {
      setAddMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setAddBusy(false);
    }
  };

  const unsubscribe = async (id: number, title: string | null) => {
    if (!confirm(`Unsubscribe from "${title ?? 'this feed'}"? All its items will be removed.`)) return;
    await fetch(`/api/feeds/${id}`, { method: 'DELETE' });
    if (feedFilter === id) setFeedFilter('all');
    await Promise.all([loadFeeds(), loadItems()]);
  };

  const totalPages = Math.max(1, Math.ceil(total / FEEDS_PAGE_SIZE));

  return (
    <section className="feeds-view">
      <form onSubmit={(e) => void addFeed(e)} className="add-form">
        <input
          type="url"
          value={addUrl}
          onChange={(e) => setAddUrl(e.target.value)}
          placeholder="Paste a feed or site URL to subscribe…"
          disabled={addBusy}
          autoComplete="off"
        />
        <button type="submit" disabled={addBusy || !addUrl.trim()}>
          {addBusy ? 'Adding…' : 'Add feed'}
        </button>
        {addMsg && <AddMsgBanner
          msg={addMsg}
          onDismiss={() => setAddMsg(null)}
          onPickCandidate={(url) => void addFeed(undefined, url)}
          onViewFeed={(id) => { setFeedFilter(id); setAddMsg(null); setPage(0); }}
        />}
      </form>

      {itemError && (
        <div className="feed-error" role="alert">
          {itemError}
          <button className="link-btn" onClick={() => setItemError(null)}>Dismiss</button>
        </div>
      )}

      <div className="feeds-toolbar">
        <select
          className="filter-select"
          value={feedFilter === 'all' ? '' : String(feedFilter)}
          onChange={(e) => { setFeedFilter(e.target.value ? Number(e.target.value) : 'all'); setPage(0); }}
        >
          <option value="">All feeds ({feeds.reduce((s, f) => s + f.unread_count, 0)} unread)</option>
          {feeds.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title ?? f.url} ({f.unread_count} unread)
            </option>
          ))}
        </select>
        <label className="feeds-toolbar-check">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => { setUnreadOnly(e.target.checked); setPage(0); }}
          />
          Unread only
        </label>
        <button onClick={refreshAll} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button onClick={markAllRead} disabled={!items.some((it) => it.read_at === null)}>
          Mark page read
        </button>
        {feedFilter !== 'all' && (
          (() => {
            const f = feeds.find((x) => x.id === feedFilter);
            return f ? (
              <button className="feeds-toolbar-del" onClick={() => unsubscribe(f.id, f.title)}>
                Unsubscribe
              </button>
            ) : null;
          })()
        )}
      </div>

      {feedFilter !== 'all' && (() => {
        const f = feeds.find((x) => x.id === feedFilter);
        return f?.error ? <div className="feed-error">Last poll failed: {f.error}</div> : null;
      })()}

      {loading && <p className="empty">Loading…</p>}
      {!loading && !items.length && (
        <p className="empty">
          {feeds.length === 0
            ? 'No feeds yet — paste an RSS or site URL above to subscribe.'
            : unreadOnly ? 'Inbox zero. Nothing unread.' : 'No items.'}
        </p>
      )}

      <ul className="feed-items">
        {items.map((it) => (
          <FeedItemRow
            key={it.id}
            item={it}
            onMarkRead={markRead}
            onSummarize={summarize}
          />
        ))}
      </ul>

      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      )}
    </section>
  );
}

function FeedItemRow({
  item, onMarkRead, onSummarize,
}: {
  item: FeedItem;
  onMarkRead: (id: number) => void;
  onSummarize: (id: number) => Promise<void>;
}) {
  const isRead = item.read_at !== null;
  const summary = item.ai_summary;

  return (
    <li className={`feed-item${isRead ? ' read' : ''}`}>
      <a
        href={item.url ?? '#'}
        target="_blank"
        rel="noreferrer"
        className="feed-item-title"
        onClick={() => { if (!isRead) onMarkRead(item.id); }}
      >
        {item.title ?? item.url ?? '(untitled)'}
      </a>
      <div className="feed-item-meta">
        <span>{item.feed_title ?? 'Feed'}</span>
        {item.published_at && <span>· {formatFeedDate(item.published_at)}</span>}
        {item.author && <span>· {item.author}</span>}
        {item.saved_bookmark_id !== null && <span className="feed-item-saved">· ✓ Saved</span>}
      </div>
      {summary === '__loading__' ? (
        <p className="feed-item-summary loading">Summarizing…</p>
      ) : summary ? (
        <p className="feed-item-summary">{summary}</p>
      ) : (
        <button
          className="feed-item-summary-btn"
          onClick={() => void onSummarize(item.id)}
        >
          Get summary
        </button>
      )}
    </li>
  );
}

function formatFeedDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

// Renders whichever banner variant the add-form is currently in. Split out of
// FeedsView because the candidates/picker path has enough structure to warrant
// its own component rather than inline JSX branches.
function AddMsgBanner({
  msg, onDismiss, onPickCandidate, onViewFeed,
}: {
  msg: AddMsg;
  onDismiss: () => void;
  onPickCandidate: (url: string) => void;
  onViewFeed: (feedId: number) => void;
}) {
  if (msg.kind === 'candidates') {
    return (
      <div className="add-msg add-msg-candidates">
        <div>This page has multiple feeds. Pick one:</div>
        <ul className="feed-candidates">
          {msg.candidates.map((c) => (
            <li key={c.url}>
              <button
                className="feed-candidate-btn"
                onClick={() => onPickCandidate(c.url)}
              >
                <span className="feed-candidate-title">{c.title ?? c.url}</span>
                <span className="feed-candidate-meta">
                  {c.type !== 'unknown' && `${c.type.toUpperCase()} · `}{c.url}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button className="link-btn" onClick={onDismiss}>Cancel</button>
      </div>
    );
  }
  if (msg.kind === 'info' && typeof msg.feedId === 'number') {
    const feedId = msg.feedId;
    return (
      <div className={`add-msg add-msg-${msg.kind}`}>
        {msg.text}{' '}
        <button className="link-btn inline" onClick={() => onViewFeed(feedId)}>
          View feed
        </button>
      </div>
    );
  }
  return <div className={`add-msg add-msg-${msg.kind}`}>{msg.text}</div>;
}
