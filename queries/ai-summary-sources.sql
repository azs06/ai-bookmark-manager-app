-- Which model wrote each bookmark's current summary, all-time and for
-- summaries written in the last 30 days, plus how many sit at 'partial'.
-- Refusals and per-call fallbacks are only in logs (`wrangler tail`).
--   npm run stats:ai:local
--   npm run stats:ai:remote
SELECT
  COALESCE(json_extract(metadata, '$.summary_source'), '(none)') AS source,
  COUNT(*) AS total,
  SUM(CASE WHEN json_extract(metadata, '$.summary_at') >= (strftime('%s', 'now') - 30 * 86400) * 1000
      THEN 1 ELSE 0 END) AS last_30d,
  SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial
FROM bookmarks
GROUP BY source
ORDER BY total DESC;
