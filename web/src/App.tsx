import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

interface Bookmark {
  id: number;
  url: string;
  title: string | null;
  note: string;
  domain: string | null;
  ai_summary: string | null;
  ai_tags: string;
  og_image_url: string | null;
  importance: number;
  status: string;
  created_at: number;
}

type View = 'list' | 'grid';
type Patch = Partial<Pick<Bookmark, 'importance' | 'note'>>;

const PAGE_SIZE = 50;

export default function App() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [view, setView] = useState<View>('list');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Bookmark[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/bookmarks?limit=${PAGE_SIZE}&offset=0`);
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

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/bookmarks?limit=${PAGE_SIZE}&offset=${bookmarks.length}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { bookmarks: Bookmark[]; total: number };
      // Defensive de-dup: if a bookmark was added/removed between pages, the
      // offset could slide and repeat a row. Filter by id to be safe.
      setBookmarks((prev) => {
        const seen = new Set(prev.map((b) => b.id));
        return [...prev, ...(d.bookmarks ?? []).filter((b) => !seen.has(b.id))];
      });
      setTotal(d.total ?? 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [bookmarks.length, loadingMore]);

  useEffect(() => { void load(); }, [load]);

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

  // Optimistic update: apply the patch to both lists right away, then persist.
  // If the PATCH fails, fall back to a full reload to reconcile server state.
  const updateBookmark = useCallback(async (id: number, patch: Patch) => {
    const apply = (list: Bookmark[]) =>
      list.map((b) => (b.id === id ? { ...b, ...patch } : b));
    setBookmarks(apply);
    setSearchResults((prev) => (prev ? apply(prev) : prev));
    try {
      const r = await fetch(`/api/bookmarks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      await load();
    }
  }, [load]);

  const removeBookmark = useCallback(async (id: number) => {
    const drop = (list: Bookmark[]) => list.filter((b) => b.id !== id);
    setBookmarks(drop);
    setSearchResults((prev) => (prev ? drop(prev) : prev));
    try {
      const r = await fetch(`/api/bookmarks/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      await load();
    }
  }, [load]);

  const pinned = bookmarks.filter((b) => b.importance === 2);
  const rest = bookmarks.filter((b) => b.importance !== 2);

  return (
    <div className="app">
      <header>
        <h1>Bookmarks</h1>
        <div className="controls">
          <button onClick={() => setView((v) => (v === 'list' ? 'grid' : 'list'))}>
            {view === 'list' ? 'Grid view' : 'List view'}
          </button>
        </div>
      </header>

      <AddForm onSaved={load} />

      <input
        type="search"
        className="search-input"
        placeholder="Search your library — describe what you're looking for…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <ChatPanel />

      {loading && <p className="empty">Loading…</p>}
      {error && <p className="empty">Error: {error}</p>}

      {searchResults === null && !loading && !error && (
        <TodaysPicks
          view={view}
          onReenriched={load}
          onUpdate={updateBookmark}
          onDelete={removeBookmark}
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
            onReenriched={load}
            onUpdate={updateBookmark}
            onDelete={removeBookmark}
            emptyMessage={`No strong matches for "${query.trim()}". Try a longer or more specific query.`}
          />
        </section>
      ) : (
        <>
          {!loading && !error && pinned.length > 0 && (
            <section>
              <h2>Pinned</h2>
              <BookmarkList
                items={pinned}
                view={view}
                onReenriched={load}
                onUpdate={updateBookmark}
                onDelete={removeBookmark}
              />
            </section>
          )}

          {!loading && !error && (
            <section>
              <h2>Recent <span className="count-hint">— {bookmarks.length} of {total}</span></h2>
              <BookmarkList
                items={rest}
                view={view}
                onReenriched={load}
                onUpdate={updateBookmark}
                onDelete={removeBookmark}
              />
              {bookmarks.length < total && (
                <div className="load-more-wrap">
                  <button
                    type="button"
                    className="load-more"
                    onClick={() => { void loadMore(); }}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : `Load more (${total - bookmarks.length} left)`}
                  </button>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function AddForm({ onSaved }: { onSaved: () => Promise<void> }) {
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
      // Enrichment completes ~2-3s after save. Pick up the summary/tags then.
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
  onReenriched: () => Promise<void> | void;
  onUpdate: (id: number, patch: Patch) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
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
  b, onReenriched, onUpdate, onDelete,
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
    setTimeout(async () => { await onReenriched(); setBusy(false); }, 3500);
  };

  const cycleImportance = () => {
    const next = ((b.importance + 1) % 3) as 0 | 1 | 2;
    void onUpdate(b.id, { importance: next });
  };

  const remove = () => {
    if (!confirm(`Delete "${b.title ?? b.url}"?`)) return;
    void onDelete(b.id);
  };

  const pinnedClass = b.importance === 2 ? ' pinned' : b.importance === 1 ? ' important' : '';

  return (
    <div className={`bookmark${pinnedClass}`}>
      {b.og_image_url && (
        <a href={b.url} target="_blank" rel="noreferrer" className="bookmark-thumb">
          <img src={b.og_image_url} alt="" />
        </a>
      )}
      <div className="bookmark-body">
        <a href={b.url} target="_blank" rel="noreferrer" className="title">{b.title ?? b.url}</a>
        <div className="domain">{b.domain}</div>
        {b.ai_summary && <div className="summary">{b.ai_summary}</div>}
        {!b.ai_summary && b.status === 'imported' && (
          <div className="summary muted-hint">Imported — click ↻ to enrich.</div>
        )}
        {renderTags(b.ai_tags)}
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
  if (n === 2) return '★';  // pinned (filled, accent color)
  if (n === 1) return '★';  // important (filled, muted)
  return '☆';               // normal (outline)
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
  if (!picks.length) return null;  // no picks yet — cron hasn't fired or library too thin

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

// Render the answer text, turning [#42] citations into links to the source card below.
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
