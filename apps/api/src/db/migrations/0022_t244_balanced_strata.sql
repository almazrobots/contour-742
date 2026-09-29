-- Keep per-stratum random selection bounded as the corpus queue grows.
create index verification_tasks_ready_strata on verification_tasks(parameter,object_key,operation,random_key) where state='ready';
create index verification_user_recent on verification_assignments(user_id,created_at desc,id) where purpose='annotation';
create index verification_adjudication_latest on verification_adjudications(task_id,id desc);
