import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

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
type Mode = 'bookmarks' | 'feeds';
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
//
// Legacy read-only support: /?view=feeds[&feed_id=N] is still parsed so old
// extension links and shared URLs keep working. We never write that shape.
interface UrlState { mode: Mode; scope: Scope; feedId: number | null }

function parseCategoryParam(raw: string | null): Scope {
  if (raw === 'uncategorized') return { kind: 'uncategorized' };
  const id = raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null;
  if (id !== null) return { kind: 'category', id };
  return { kind: 'all' };
}

function readUrlState(): UrlState {
  try {
    const path = window.location.pathname;
    const p = new URLSearchParams(window.location.search);
    if (path === '/feeds' || p.get('view') === 'feeds') {
      const raw = p.get('feed_id');
      const feedId = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
      return { mode: 'feeds', scope: { kind: 'all' }, feedId };
    }
    return { mode: 'bookmarks', scope: parseCategoryParam(p.get('category')), feedId: null };
  } catch {
    return { mode: 'bookmarks', scope: { kind: 'all' }, feedId: null };
  }
}

// Build the full path + query for a given state. feed_id is owned by FeedsView
// (not tracked in App state), so preserve it verbatim when we're already on
// /feeds and writing another feeds URL.
function buildUrl(mode: Mode, scope: Scope): string {
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
          <h1>{mode === 'feeds' ? 'Feeds' : scopeHeading}</h1>
          {mode === 'bookmarks' && <span className="header-count">{total.toLocaleString()}</span>}
          {mode === 'bookmarks' && (
            <div className="controls">
              <button onClick={() => setView((v) => (v === 'list' ? 'grid' : 'list'))}>
                {view === 'list' ? 'Grid' : 'List'}
              </button>
            </div>
          )}
        </header>

        {mode === 'feeds' && <FeedsView initialFeedId={readUrlState().feedId} />}
        {mode === 'bookmarks' && (<>
        <AddForm onSaved={refresh} />

        <EnrichBanner onProgress={refresh} />

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

        {searchResults === null && !loading && !error && scope.kind === 'all' && page === 0 && (
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
        <div className="sidebar-brand">Bookmarks</div>
        <button className="sidebar-btn" onClick={onToggle} title="Collapse sidebar">‹</button>
      </div>

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

      <div className="sidebar-foot">
        <button
          className="theme-toggle"
          onClick={onThemeToggle}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
          {theme === 'light' ? '☾ Dark mode' : '☀ Light mode'}
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

// Drains the 'imported' + 'pending' backlog in bounded batches. The server
// processes each batch in background via waitUntil; we poll pending-count
// between rounds so the UI shows actual server-observed progress, not a
// hopeful counter based on what we queued.
function EnrichBanner({ onProgress }: { onProgress: () => Promise<void> | void }) {
  const [pending, setPending] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);

  const fetchPending = useCallback(async () => {
    try {
      const r = await fetch('/api/bookmarks/pending-count');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { pending: number };
      setPending(d.pending);
    } catch {
      setPending(null);
    }
  }, []);

  useEffect(() => { void fetchPending(); }, [fetchPending]);

  const run = async () => {
    if (running) return;
    stopRef.current = false;
    setRunning(true);
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
        // Wait for the background batch to land, then refresh + re-poll.
        await new Promise((res) => setTimeout(res, 8000));
        await Promise.all([fetchPending(), Promise.resolve(onProgress())]);
        if (d.remaining === 0) break;
      }
    } catch {
      // Swallow — user can retry; pending count will refresh on next mount.
    } finally {
      setRunning(false);
      await fetchPending();
    }
  };

  const stop = () => { stopRef.current = true; };

  if (pending === null || pending === 0) return null;

  return (
    <div className="enrich-banner">
      <span className="enrich-banner-label">
        {running
          ? `Enriching… ${pending.toLocaleString()} remaining`
          : `${pending.toLocaleString()} bookmark${pending === 1 ? '' : 's'} waiting to be enriched`}
      </span>
      {running ? (
        <button className="enrich-banner-btn" onClick={stop}>Stop</button>
      ) : (
        <button className="enrich-banner-btn" onClick={run}>Enrich all</button>
      )}
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

function BookmarkCard({
  b, categories, onReenriched, onUpdate, onDelete, onToggleWatched,
}: { b: Bookmark } & CardHandlers) {
  const [busy, setBusy] = useState(false);

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
    </div>
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

function TodaysPicks({
  view, ...handlers
}: { view: View } & CardHandlers) {
  const [picks, setPicks] = useState<PickEnvelope[] | null>(null);
  const [date, setDate] = useState<string>('');
  const [refreshing, setRefreshing] = useState(false);

  const fetchPicks = useCallback(async () => {
    try {
      const r = await fetch('/api/suggestions/today');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { date: string; picks: PickEnvelope[] };
      setDate(d.date);
      setPicks(d.picks ?? []);
    } catch {
      setPicks([]);
    }
  }, []);

  useEffect(() => { void fetchPicks(); }, [fetchPicks]);

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
        Today's picks · {date}
        <button className="link-btn" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'refreshing…' : 'refresh'}
        </button>
      </h2>
      <div className={`bookmarks ${view}`}>
        {picks.map((p) => (
          <div key={p.bookmark.id} className="pick-wrap">
            {p.reason && <div className="pick-reason">{p.reason}</div>}
            <BookmarkCard b={p.bookmark} {...handlers} />
          </div>
        ))}
      </div>
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
