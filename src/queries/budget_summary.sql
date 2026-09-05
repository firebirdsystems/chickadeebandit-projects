SELECT
  project_id,
  COUNT(id) AS line_items,
  SUM(estimated_cents) AS estimated_cents,
  SUM(COALESCE(actual_cents, 0)) AS actual_cents,
  SUM(CASE WHEN purchased = 1 THEN 1 ELSE 0 END) AS purchased_items
FROM app_projects__budget_items
GROUP BY project_id
ORDER BY project_id
LIMIT 200
