-- Stage 1 provenance journal; stage_jobs/attempts/outbox belong to plan 07 stage 2.
-- 0015 is reserved by T-234 in the integration branch.
create table pipeline_runs (
  id text primary key,
  file_id text not null references files(id),
  sha256 text not null,
  route text not null check (route in ('legacy', 'staged-v1')),
  policy text not null default 'legacy-compatible-v1',
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','COMPLETE','FAILED')),
  request_json json,
  context_json json,
  progress_json json not null default '[]',
  trace_json json,
  result_json json,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index ix_pipeline_runs_file on pipeline_runs(file_id, created_at desc);
alter table files add column pipeline_run_id text references pipeline_runs(id);
alter table files add column pipeline_result_run_id text references pipeline_runs(id);
