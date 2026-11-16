// SQL fragments shared by the bookmark list/facets routes and the MCP
// list_bookmarks tool. All user values go through bound params.

// Scope:
//   (missing | __all__)       → every non-archived bookmark
//   __uncategorized__         → bookmarks with NULL category_id
//   <numeric id>              → that category AND all its descendants (recursive CTE)
export function buildScopedWhere(scope: string | undefined): {
  from: string;
  where: string;
  params: unknown[];
} {
  const categoryId = scope && scope !== '__all__' && scope !== '__uncategorized__'
    ? Number(scope)
    : null;

  let where = `b.status != 'archived'`;
  let from = `FROM bookmarks b`;
  const params: unknown[] = [];

  if (scope === '__uncategorized__') {
    where += ` AND b.category_id IS NULL`;
  } else if (categoryId !== null && Number.isFinite(categoryId)) {
    from = `
      FROM bookmarks b
      INNER JOIN (
        WITH RECURSIVE subtree(id) AS (
          SELECT ? UNION ALL
          SELECT c.id FROM categories c INNER JOIN subtree s ON c.parent_id = s.id
        )
        SELECT id FROM subtree
      ) sc ON sc.id = b.category_id
    `;
    params.push(categoryId);
  }

  return { from, where, params };
}

// ai_tags is written as a JSON array, but a malformed value would make
// json_each() throw and fail the whole query — treat it as no tags instead.
export const SAFE_TAGS_JSON = `CASE WHEN json_valid(b.ai_tags) THEN b.ai_tags ELSE '[]' END`;

// Parses + validates the filter query params. Unknown/invalid values
// are silently dropped so a malformed URL never 500s — the list just comes
// back unfiltered on that dimension.
const KNOWN_CONTENT_TYPES = new Set(['video', 'x']);

export function applyFilters(
  rawImportance: string | undefined,
  rawDomain: string | undefined,
  rawYear: string | undefined,
  rawContentType: string | undefined,
  rawTag: string | undefined,
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const minImportance = Number(rawImportance);
  if (minImportance === 1 || minImportance === 2) {
    clauses.push('b.importance >= ?');
    params.push(minImportance);
  }

  const domain = rawDomain?.trim();
  if (domain) {
    clauses.push('b.domain = ?');
    params.push(domain);
  }

  const year = rawYear?.trim();
  if (year && /^\d{4}$/.test(year)) {
    clauses.push(`strftime('%Y', b.created_at / 1000, 'unixepoch') = ?`);
    params.push(year);
  }

  const contentType = rawContentType?.trim();
  if (contentType && KNOWN_CONTENT_TYPES.has(contentType)) {
    clauses.push('b.content_type = ?');
    params.push(contentType);
  }

  const tag = rawTag?.trim();
  if (tag) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(${SAFE_TAGS_JSON}) WHERE value = ?)`);
    params.push(tag);
  }

  return { clauses, params };
}
