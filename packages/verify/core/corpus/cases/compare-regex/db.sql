create table l (k text, s text);
create table r (k text, s text);
insert into l values ('K1', 'INV-2026-1187');
insert into r values ('K1', '^INV-\d{4}-\d+$');
