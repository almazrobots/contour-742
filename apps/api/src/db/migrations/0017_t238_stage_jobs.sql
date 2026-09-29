-- Additive stage-2 journal. Existing runs remain inline until explicitly opted in.
alter table pipeline_runs add column execution_mode text not null default 'inline'
  check (execution_mode in ('inline', 'durable'));
alter table pipeline_runs add column manifest_json json;

create table stage_jobs (
  id text primary key,
  run_id text not null references pipeline_runs(id),
  logical_key text not null check (logical_key ~ '^[0-9a-f]{64}$'),
  stage text not null check (stage in ('preflight','parse','merge','extract','aggregate')),
  request_json json not null,
  status text not null default 'READY' check (status in ('READY','RUNNING','RECOVERING','SUCCEEDED','FAILED')),
  attempt_epoch integer not null default 0 check (attempt_epoch >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  owner text,
  lease_until timestamptz,
  not_before timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, logical_key),
  unique (id, run_id),
  check ((status in ('RUNNING','RECOVERING')) = (owner is not null and lease_until is not null))
);
create index ix_stage_jobs_ready on stage_jobs(status, not_before);
create index ix_stage_jobs_lease on stage_jobs(lease_until) where status = 'RUNNING';

create table job_attempts (
  job_id text not null references stage_jobs(id),
  attempt_epoch integer not null check (attempt_epoch > 0),
  owner text not null,
  status text not null check (status in ('RUNNING','RECOVERING','SUCCEEDED','FAILED','STOPPED')),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  primary key (job_id, attempt_epoch)
);

create table stage_artifacts (
  job_id text primary key,
  run_id text not null,
  attempt_epoch integer not null,
  artifact_digest text not null check (artifact_digest ~ '^[0-9a-f]{64}$'),
  blob_sha256 text not null check (blob_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint not null check (byte_length > 0),
  schema_version text not null,
  configuration_fingerprint text not null check (configuration_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (job_id, run_id) references stage_jobs(id, run_id),
  foreign key (job_id, attempt_epoch) references job_attempts(job_id, attempt_epoch)
);

create table pipeline_outbox (
  id text primary key,
  job_id text not null references stage_jobs(id),
  available_at timestamptz not null default now(),
  sent_at timestamptz,
  send_attempts integer not null default 0 check (send_attempts >= 0),
  owner text,
  lease_until timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index ix_pipeline_outbox_pending on pipeline_outbox(available_at) where sent_at is null;

create table pipeline_source_pins (
  run_id text not null references pipeline_runs(id),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (run_id, sha256)
);
create index ix_pipeline_source_pins_active on pipeline_source_pins(sha256) where released_at is null;
