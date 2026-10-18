-- Quantum Market database schema (PostgreSQL). Safe to run more than once.
-- This file creates EMPTY tables only. It never inserts demo users, products or orders.
-- Timestamps are stored as ISO-8601 text (UTC). JSON is stored as text.

create table if not exists users (
  id text primary key,
  email text not null unique,
  name text not null,
  role text not null check (role in ('buyer','owner','admin')),
  shop text,
  status text not null default 'Active' check (status in ('Active','Invited','Suspended','Deleted')),
  password_hash text,
  mobile text not null default '',
  address text not null default '',
  city text not null default '',
  state text not null default '',
  pin text not null default '',
  token_version integer not null default 0,
  fail_count integer not null default 0,
  locked_until text,
  invite_hash text,
  invite_exp text,
  created_at text not null
);
create index if not exists users_role_idx on users(role);

create table if not exists products (
  id text primary key,
  owner_id text not null references users(id),
  type text not null check (type in ('single','combo')),
  name text not null,
  category text not null,
  description text not null,
  ptype text,
  price double precision not null check (price > 0),
  stock double precision not null check (stock >= 0),
  unit text not null,
  pkg_size double precision not null default 0,
  pkg_unit text not null default '',
  expiry text,
  brand text,
  discount double precision not null default 0 check (discount >= 0 and discount <= 90),
  status text not null default 'Active' check (status in ('Active','Disabled','Deleted')),
  location text not null default 'Main store',
  image text,
  items text,
  log text not null default '[]',
  qty0 double precision not null default 0,
  created_at text not null,
  updated_at text not null
);
create index if not exists products_owner_idx on products(owner_id);
create index if not exists products_status_idx on products(status);

create table if not exists orders (
  id text primary key,
  buyer_id text not null references users(id),
  buyer_email text not null,
  owner_id text not null references users(id),
  lines text not null,
  sub double precision not null,
  del double precision not null,
  tot double precision not null,
  pm text not null check (pm in ('cod','on')),
  pay text not null,
  st text not null,
  addr text not null,
  hist text not null,
  rate double precision,
  created_at text not null,
  done_at text,
  cancelled_at text,
  recv_at text,
  paid_at text,
  paid_by text,
  utr text,
  settled_at text
);
create index if not exists orders_buyer_idx on orders(buyer_id);
create index if not exists orders_owner_idx on orders(owner_id);

create table if not exists buyer_payments (
  id text primary key,
  order_id text not null references orders(id),
  owner_id text not null,
  buyer_email text not null,
  kind text not null,
  amt double precision not null,
  method text not null,
  ref text not null,
  proof text,
  at text not null,
  status text not null,
  verified_at text
);
create index if not exists bp_ref_idx on buyer_payments(ref);

create table if not exists commission_payments (
  id text primary key,
  owner_id text not null references users(id),
  amt double precision not null check (amt > 0),
  ref text not null,
  proof text,
  at text not null,
  status text not null,
  verified_at text,
  verified_by text
);
create index if not exists cp_ref_idx on commission_payments(ref);

create table if not exists audit (
  id text primary key,
  owner_ref text not null,
  orig double precision not null,
  new_v double precision not null,
  red double precision not null,
  reason text not null,
  admin_email text not null,
  at text not null
);

create table if not exists notifications (
  id integer primary key,
  role text not null,
  user_ref text,
  title text not null,
  msg text not null,
  go text,
  at text not null,
  is_read integer not null default 0
);
create index if not exists notif_user_idx on notifications(role, user_ref);

create table if not exists store_status (
  owner_id text primary key references users(id),
  status text not null,
  msg text not null default '',
  since text,
  resumed_at text
);

create table if not exists store_history (
  id text primary key,
  owner_id text not null,
  name text not null,
  msg text not null,
  paused_at text not null,
  resumed_at text
);

-- System metadata only (these are settings and ID counters, not application records)
create table if not exists settings (key text primary key, value text not null);
create table if not exists counters (name text primary key, val integer not null);

insert into settings(key, value) values ('commission_rate', '5') on conflict do nothing;
insert into counters(name, val) values ('product', 0) on conflict do nothing;
insert into counters(name, val) values ('order', 100100) on conflict do nothing;
insert into counters(name, val) values ('owner', 0) on conflict do nothing;
insert into counters(name, val) values ('buyer', 0) on conflict do nothing;
insert into counters(name, val) values ('bp', 2000) on conflict do nothing;
insert into counters(name, val) values ('cp', 1000) on conflict do nothing;
insert into counters(name, val) values ('audit', 0) on conflict do nothing;
insert into counters(name, val) values ('notif', 0) on conflict do nothing;
insert into counters(name, val) values ('sp', 0) on conflict do nothing;
