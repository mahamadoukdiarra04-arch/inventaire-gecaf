create table if not exists public.mamy_inventory_counts (
  id text primary key,
  mission_id text not null default 'mamy-market-2026',
  team_key text not null,
  team_name text not null,
  agent_key text not null,
  agent_name text not null,
  zone text not null default '',
  product_id text not null,
  barcode text not null default '',
  internal_ref text not null default '',
  product_name text not null,
  sale_price numeric not null default 0,
  cost numeric not null default 0,
  theoretical_qty numeric not null default 0,
  counted_qty numeric not null default 0,
  difference_qty numeric not null default 0,
  status text not null default 'counted',
  note text not null default '',
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mamy_counts_mission_team_idx
  on public.mamy_inventory_counts(mission_id, team_key, updated_at desc);

create index if not exists mamy_counts_product_idx
  on public.mamy_inventory_counts(mission_id, product_id);

create index if not exists mamy_counts_barcode_idx
  on public.mamy_inventory_counts(mission_id, barcode);

create table if not exists public.mamy_inventory_teams (
  mission_id text not null default 'mamy-market-2026',
  team_key text not null,
  team_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (mission_id, team_key)
);

create index if not exists mamy_teams_mission_name_idx
  on public.mamy_inventory_teams(mission_id, team_name);

create or replace function public.upsert_mamy_counts_newer(p_counts jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.mamy_inventory_counts (
    id,
    mission_id,
    team_key,
    team_name,
    agent_key,
    agent_name,
    zone,
    product_id,
    barcode,
    internal_ref,
    product_name,
    sale_price,
    cost,
    theoretical_qty,
    counted_qty,
    difference_qty,
    status,
    note,
    updated_by,
    updated_at
  )
  select
    item.id,
    coalesce(item.mission_id, 'mamy-market-2026'),
    item.team_key,
    item.team_name,
    item.agent_key,
    item.agent_name,
    coalesce(item.zone, ''),
    item.product_id,
    coalesce(item.barcode, ''),
    coalesce(item.internal_ref, ''),
    item.product_name,
    coalesce(item.sale_price, 0),
    coalesce(item.cost, 0),
    coalesce(item.theoretical_qty, 0),
    coalesce(item.counted_qty, 0),
    coalesce(item.counted_qty, 0) - coalesce(item.theoretical_qty, 0),
    coalesce(item.status, 'counted'),
    coalesce(item.note, ''),
    item.updated_by,
    coalesce(item.updated_at, now())
  from jsonb_to_recordset(p_counts) as item(
    id text,
    mission_id text,
    team_key text,
    team_name text,
    agent_key text,
    agent_name text,
    zone text,
    product_id text,
    barcode text,
    internal_ref text,
    product_name text,
    sale_price numeric,
    cost numeric,
    theoretical_qty numeric,
    counted_qty numeric,
    status text,
    note text,
    updated_by text,
    updated_at timestamptz
  )
  on conflict (id)
  do update set
    mission_id = excluded.mission_id,
    team_key = excluded.team_key,
    team_name = excluded.team_name,
    agent_key = excluded.agent_key,
    agent_name = excluded.agent_name,
    zone = excluded.zone,
    product_id = excluded.product_id,
    barcode = excluded.barcode,
    internal_ref = excluded.internal_ref,
    product_name = excluded.product_name,
    sale_price = excluded.sale_price,
    cost = excluded.cost,
    theoretical_qty = excluded.theoretical_qty,
    counted_qty = excluded.counted_qty,
    difference_qty = excluded.difference_qty,
    status = excluded.status,
    note = excluded.note,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
  where excluded.updated_at >= public.mamy_inventory_counts.updated_at;
end;
$$;

grant execute on function public.upsert_mamy_counts_newer(jsonb) to anon;

alter table public.mamy_inventory_counts enable row level security;

drop policy if exists "mamy anon counts" on public.mamy_inventory_counts;

create policy "mamy anon counts"
  on public.mamy_inventory_counts for all
  to anon
  using (true)
  with check (true);

alter table public.mamy_inventory_teams enable row level security;

drop policy if exists "mamy anon teams" on public.mamy_inventory_teams;

create policy "mamy anon teams"
  on public.mamy_inventory_teams for all
  to anon
  using (true)
  with check (true);

alter table public.mamy_inventory_counts replica identity full;
alter table public.mamy_inventory_teams replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.mamy_inventory_counts;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.mamy_inventory_teams;
  exception
    when duplicate_object then null;
  end;
end $$;
