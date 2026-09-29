-- A snapshot is an archival artifact, not a reconstructed processing run.
create table file_result_snapshots (
  id text primary key,
  file_id text not null references files(id),
  sha256 text not null,
  source_run_id text references pipeline_runs(id),
  ml_revision text,
  engine text,
  captured_at timestamptz not null default now(),
  payload_json json not null check (jsonb_typeof(payload_json::jsonb) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  unique (file_id, payload_sha256),
  check (payload_sha256 = encode(sha256(convert_to(payload_json::text, 'UTF8')), 'hex'))
);
create index ix_file_result_snapshots_file on file_result_snapshots(file_id, captured_at);
create trigger file_result_snapshots_append_only before update or delete on file_result_snapshots
  for each row execute function forbid_mutation();
create trigger file_result_snapshots_no_truncate before truncate on file_result_snapshots
  for each statement execute function forbid_mutation();
