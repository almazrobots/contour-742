-- Personal selection of useful examples; never an adjudication or a label edit.
create table verification_library_marks (
  label_id text not null references verification_labels(id),
  user_id text not null references users(id),
  starred boolean not null, updated_at timestamptz not null default now(),
  primary key(label_id,user_id)
);
create index verification_labels_library on verification_labels(user_id,created_at desc,id desc);
create index verification_labels_library_all on verification_labels(created_at desc,id desc);
