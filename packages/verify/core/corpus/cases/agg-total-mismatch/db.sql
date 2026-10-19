create table bills (
  id integer primary key,
  batch text not null,
  amount_cents integer not null
);
insert into bills (batch, amount_cents) values
  ('2026-07', 120000),
  ('2026-07',  80000),
  ('2026-06',  50000);
create table declared (
  id integer primary key,
  batch text not null,
  amount_cents integer not null
);
insert into declared (batch, amount_cents) values
  ('2026-07', 190000);
