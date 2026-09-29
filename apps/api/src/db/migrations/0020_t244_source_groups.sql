-- Authoritative source memberships, including sources without extracted candidates.
create table verification_source_groups (
  ingestion_id text not null references verification_ingestions(id),
  object_key text not null, sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  primary key(ingestion_id,object_key,sha256)
);
create trigger verification_source_groups_append_only before update or delete on verification_source_groups for each row execute function forbid_mutation();
create trigger verification_source_groups_no_truncate before truncate on verification_source_groups for each statement execute function forbid_mutation();
