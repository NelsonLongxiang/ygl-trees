create table freight_invoice (
  invoice_id text primary key, order_id text not null, batch text not null,
  amount real not null, expect_amount real not null
);
insert into freight_invoice values
  ('INV-1','A-1001','2026-10',1290.40,1290.40),
  ('INV-2','A-1002','2026-10', 860.00, 860.01),
  ('INV-3','A-1003','2026-10',1204.00,1204.00);
create table pair_left (k text, v real);
insert into pair_left values ('K1',10.0),('K1',11.0),('K2',20.0);
create table pair_right (k text, v real);
create table pair_boundary (k text, v real);
insert into pair_boundary values ('K1',10.0);
insert into pair_right values ('K1',10.0),('K2',20.0);
