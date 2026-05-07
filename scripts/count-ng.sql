SELECT
  COUNT(*) FILTER (WHERE (bant->>'isNG')::boolean = true) AS isng_total,
  COUNT(*) FILTER (WHERE pipeline_stage = '【商談前】日程調整不可') AS schedule_blocked,
  COUNT(*) FILTER (WHERE (bant->>'isNG')::boolean = true OR pipeline_stage = '【商談前】日程調整不可') AS combined,
  COUNT(*) FILTER (WHERE ((bant->>'isNG')::boolean = true OR pipeline_stage = '【商談前】日程調整不可') AND next_action IS NOT NULL AND next_action <> '') AS combined_with_nextaction
FROM deals WHERE deleted_at IS NULL;
