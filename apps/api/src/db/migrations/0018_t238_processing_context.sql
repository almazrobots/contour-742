-- Recovery context belongs to the inspection transaction, never API process memory.
alter table inspections add column processing_resume_status text
  check (processing_resume_status in ('PENDING', 'READY', 'VERIFYING', 'COMPLETED'));
alter table inspections add column processing_changed_files_json text not null default '[]'
  check (jsonb_typeof(processing_changed_files_json::jsonb) = 'array');
