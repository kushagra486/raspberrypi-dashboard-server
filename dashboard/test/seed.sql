-- Test database for test/db.test.js: a small Postgres shaped like Supabase.
-- Idempotent. Load as a superuser:  psql -d postgres -f test/seed.sql
-- pg_stat_statements must be in shared_preload_libraries for the insights test.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    create role supabase_admin login superuser password 'test-db-pass';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

drop schema if exists auth, storage, janseva, shop, lab, blog, blog_dev, acme_store, pi_console, extensions cascade;
drop table if exists public.notes;

create schema extensions;
create extension if not exists pg_stat_statements with schema extensions;

-- Supabase platform schemas (only the parts Pi Console reads)
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(), email text, phone text,
  created_at timestamptz default now(), last_sign_in_at timestamptz,
  email_confirmed_at timestamptz, encrypted_password text);
insert into auth.users (email, email_confirmed_at, encrypted_password)
values ('a@example.com', now(), 'HASH-a'), ('b@example.com', null, 'HASH-b');

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb);
insert into storage.buckets values ('avatars', 'avatars', true);
insert into storage.objects (bucket_id, name, metadata)
values ('avatars', 'a.png', '{"size": 2048}'), ('avatars', 'b.png', '{"size": 4096}');

-- App schema done right: exposed, RLS on, one policy
create schema janseva;
create table janseva.complaints (
  id bigserial primary key, title text not null, status text default 'open', created_at timestamptz default now());
alter table janseva.complaints enable row level security;
create policy "public read" on janseva.complaints for select to anon using (true);
insert into janseva.complaints (title) select 'complaint ' || g from generate_series(1, 250) g;

-- App schema not exposed, one table without RLS, awkward types
create schema shop;
create table shop.orders (id serial primary key, big bigint, raw bytea, note text);
insert into shop.orders (big, raw, note) values (9007199254740993, '\xdeadbeef', 'first');

-- Advisor fixtures: exposed schema with one of each problem
create schema lab;
create table lab.open_table (id int primary key);                         -- RLS off in an exposed schema
create table lab.locked (id int primary key);                             -- RLS on, no policy
alter table lab.locked enable row level security;
create table lab.parent (id int primary key, name text);
create table lab.child (id int primary key, parent_id int references lab.parent(id)); -- FK without index
alter table lab.parent enable row level security;
alter table lab.child enable row level security;
create policy p on lab.parent for select using (true);
create policy c on lab.child for select using (true);
create index parent_name_a on lab.parent (name);                          -- duplicate pair
create index parent_name_b on lab.parent (name);
create table lab.nopk (x int);                                            -- no primary key
alter table lab.nopk enable row level security;
create policy n on lab.nopk for select using (true);
create table lab.forgot (id int primary key);                             -- policy exists, RLS off
create policy f on lab.forgot for select using (true);
create function lab.add_one(i int) returns int language sql as 'select i + 1'; -- mutable search_path

-- Branching fixtures: serial + identity ids, generated column, FKs, RLS policy referring to
-- another table in the schema, plus a view, a function and a trigger (not copied, reported)
create schema blog;
create table blog.posts (id serial primary key, title text not null, slug text generated always as (lower(title)) stored);
create table blog.comments (id bigint generated always as identity primary key,
  post_id int not null references blog.posts(id) on delete cascade, body text, author uuid references auth.users(id));
create index on blog.comments (post_id);
alter table blog.posts enable row level security;
alter table blog.comments enable row level security;
create policy "read posts" on blog.posts for select to anon using (true);
create policy "comments on visible posts" on blog.comments for select to anon, authenticated
  using (exists (select 1 from blog.posts p where p.id = post_id));
insert into blog.posts (title) values ('Hello'), ('Second'), ('Third');
insert into blog.comments (post_id, body) select 1 + (g % 3), 'c' || g from generate_series(1, 10) g;
create view blog.recent as select * from blog.posts order by id desc limit 10;
create function blog.touch() returns trigger language plpgsql as 'begin return new; end';
create trigger touch before update on blog.posts for each row execute function blog.touch();

analyze;
