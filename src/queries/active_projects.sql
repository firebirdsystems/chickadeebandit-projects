SELECT
  id,
  name,
  description,
  status,
  target_date,
  budget_cap_cents,
  created_at
FROM app_projects__projects
WHERE completed_at IS NULL
ORDER BY
  (target_date IS NULL),
  target_date,
  created_at
LIMIT 100
