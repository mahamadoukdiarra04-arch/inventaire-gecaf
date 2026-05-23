alter table public.inventory_sheets
  add column if not exists agent_key text,
  add column if not exists agent_name text;

update public.inventory_sheets
set agent_name = coalesce(nullif(agent_name, ''), nullif(updated_by, ''), nullif(created_by, ''), 'Agent terrain')
where agent_name is null or agent_name = '';

update public.inventory_sheets
set agent_key = coalesce(nullif(agent_key, ''), lower(agent_name), 'agent terrain')
where agent_key is null or agent_key = '';

alter table public.inventory_sheets
  alter column agent_key set default '',
  alter column agent_key set not null,
  alter column agent_name set default '',
  alter column agent_name set not null;

drop index if exists public.inventory_one_active_sheet_per_team;

create unique index if not exists inventory_one_active_sheet_per_agent
  on public.inventory_sheets(team_key, agent_key)
  where status = 'active';

create index if not exists inventory_sheets_agent_status_idx
  on public.inventory_sheets(team_key, agent_key, status, updated_at desc);
