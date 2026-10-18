-- Adds payment QR columns to a database that was created before this feature. Safe to run again.
-- (The images and qr_access tables are created by schema.sql.)
alter table users add column if not exists pay_upi text;
alter table users add column if not exists pay_qr text;
