create extension if not exists pgcrypto;

create table if not exists public.inventory_teams (
  team_key text primary key,
  team_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_users (
  id uuid primary key default gen_random_uuid(),
  team_key text not null references public.inventory_teams(team_key) on delete cascade,
  team_name text not null,
  agent_key text not null,
  agent_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_key, agent_key)
);

create table if not exists public.inventory_sheets (
  id text primary key,
  team_key text not null,
  team_name text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  archived_at timestamptz,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists inventory_one_active_sheet_per_team
  on public.inventory_sheets(team_key)
  where status = 'active';

create table if not exists public.inventory_cells (
  sheet_id text not null references public.inventory_sheets(id) on delete cascade,
  row_order integer not null check (row_order between 0 and 200),
  field_key text not null,
  value text not null default '',
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (sheet_id, row_order, field_key)
);

create index if not exists inventory_sheets_team_status_idx
  on public.inventory_sheets(team_key, status, updated_at desc);

create index if not exists inventory_cells_sheet_idx
  on public.inventory_cells(sheet_id, row_order);

alter table public.inventory_teams enable row level security;
alter table public.inventory_users enable row level security;
alter table public.inventory_sheets enable row level security;
alter table public.inventory_cells enable row level security;

-- Mode compatible avec la connexion actuelle equipe/agent.
-- L'interface filtre par equipe et l'admin equipe_admin/admin1 voit tout.
-- Pour une securite forte cote serveur, remplacer ces policies par Supabase Auth
-- ou des fonctions RPC signees avant une mise en production sensible.
drop policy if exists "gecaf anon teams" on public.inventory_teams;
drop policy if exists "gecaf anon users" on public.inventory_users;
drop policy if exists "gecaf anon sheets" on public.inventory_sheets;
drop policy if exists "gecaf anon cells" on public.inventory_cells;

create policy "gecaf anon teams"
  on public.inventory_teams for all
  to anon
  using (true)
  with check (true);

create policy "gecaf anon users"
  on public.inventory_users for all
  to anon
  using (true)
  with check (true);

create policy "gecaf anon sheets"
  on public.inventory_sheets for all
  to anon
  using (true)
  with check (true);

create policy "gecaf anon cells"
  on public.inventory_cells for all
  to anon
  using (true)
  with check (true);

alter table public.inventory_sheets replica identity full;
alter table public.inventory_cells replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.inventory_sheets;
  exception
    when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.inventory_cells;
  exception
    when duplicate_object then null;
  end;
end $$;
