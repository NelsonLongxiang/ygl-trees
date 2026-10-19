create table freight_invoice (
  invoice_id text primary key,
  order_id   text not null,
  batch      text not null,
  amount     real not null,
  expect_amount real not null
);
insert into freight_invoice values
  ('INV-1','A-1001','2026-10',1290.40,1290.40),
  ('INV-2','A-1002','2026-10', 860.00, 860.00),
  ('INV-3','A-1003','2026-10',1204.00,1290.40),
  ('INV-4','A-1004','2026-09', 500.00, 400.00);
create table purchase_order (
  order_id text primary key,
  amount   real not null,
  batch    text not null
);
insert into purchase_order values
  ('A-1001',1290.40,'2026-10'),
  ('A-1002', 860.00,'2026-10'),
  ('A-1003',1290.40,'2026-10'),
  ('A-1005', 300.00,'2026-10');
