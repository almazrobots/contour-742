-- Indexed random seek without sorting all rows of a popular parameter.
create index verification_ready_seek on verification_tasks(parameter,random_key) where state='ready';
create index verification_hard_seek on verification_tasks(parameter,random_key) where state='ready' and difficulty in ('hard','control');
