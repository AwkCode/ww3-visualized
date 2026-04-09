-- =====================================================
-- ww3-visualized — Live Anonymous Chat
-- Run this in Supabase SQL Editor (one-time setup)
-- =====================================================

-- Drop existing (safe rerun)
drop trigger if exists prune_after_insert on messages;
drop trigger if exists rate_limit_check on messages;
drop function if exists prune_messages();
drop function if exists check_rate_limit();
drop table if exists messages;

-- Messages table
create table messages (
    id bigserial primary key,
    username text not null check (length(username) between 3 and 20),
    text text not null check (length(text) between 1 and 200),
    created_at timestamptz default now() not null
);

-- Index for realtime ordering
create index messages_created_at_idx on messages (created_at desc);

-- Enable Row Level Security
alter table messages enable row level security;

-- Public read: anyone can read messages
create policy "public can read messages"
    on messages for select
    using (true);

-- Public insert: anyone can insert (validated by check constraints)
create policy "public can insert messages"
    on messages for insert
    with check (true);

-- No update, no delete allowed via API (only the prune trigger deletes)

-- =====================================================
-- Rolling buffer: keep only 100 most recent messages
-- =====================================================
create or replace function prune_messages()
returns trigger
language plpgsql
security definer
as $$
begin
    delete from messages
    where id in (
        select id from messages
        order by created_at desc
        offset 100
    );
    return null;
end;
$$;

create trigger prune_after_insert
    after insert on messages
    for each statement
    execute function prune_messages();

-- =====================================================
-- Server-side rate limit: reject inserts if same username
-- posted within the last 3 seconds
-- =====================================================
create or replace function check_rate_limit()
returns trigger
language plpgsql
as $$
declare
    last_post timestamptz;
begin
    select created_at into last_post
    from messages
    where username = new.username
    order by created_at desc
    limit 1;

    if last_post is not null and (now() - last_post) < interval '3 seconds' then
        raise exception 'Rate limit: wait 3 seconds between messages';
    end if;

    return new;
end;
$$;

create trigger rate_limit_check
    before insert on messages
    for each row
    execute function check_rate_limit();

-- =====================================================
-- Enable Realtime on the messages table
-- =====================================================
alter publication supabase_realtime add table messages;

-- =====================================================
-- News archive table — populated hourly by GitHub Actions
-- Frontend queries this for past-date news
-- =====================================================
drop table if exists news_archive;

create table news_archive (
    id bigserial primary key,
    source text not null,
    source_color text,
    title text not null,
    description text,
    link text unique not null,
    pub_date timestamptz not null,
    thumb text,
    created_at timestamptz default now() not null
);

create index news_archive_pub_date_idx on news_archive (pub_date desc);
create index news_archive_day_idx on news_archive (date_trunc('day', pub_date));

alter table news_archive enable row level security;

create policy "public can read news archive"
    on news_archive for select using (true);

create policy "public can insert news archive"
    on news_archive for insert with check (true);

-- Done!
select 'Setup complete. Messages + news_archive tables ready.' as status;
