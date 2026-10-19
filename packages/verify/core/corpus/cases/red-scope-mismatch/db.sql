create table invoices (id text primary key, billing_month text, amount real);
create table invoice_lines (id text primary key, invoice_id text, amount real);
insert into invoices values ('INV-1','2026-07',100.0),('INV-2','2026-07',200.0);
insert into invoice_lines values ('L-1','INV-1',100.0);
