-- One active assignment plus at most three exclusive preparation reserves.
alter table verification_assignments drop constraint verification_assignments_state_check;
alter table verification_assignments add constraint verification_assignments_state_check check(state in ('active','buffered','expired','submitted'));
alter table verification_assignments add column buffer_slot integer;
alter table verification_assignments add column buffer_order bigint generated always as identity;
alter table verification_assignments add constraint verification_buffer_slot check((state='buffered' and buffer_slot is not null and buffer_slot between 1 and 3) or (state<>'buffered' and buffer_slot is null));
drop index verification_one_active_per_task;
create unique index verification_one_active_per_task on verification_assignments(task_id) where state in ('active','buffered');
create unique index verification_three_buffer_slots on verification_assignments(user_id,buffer_slot) where state='buffered';
create index verification_buffer_expiring on verification_assignments(expires_at) where state='buffered';
