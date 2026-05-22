create or replace function public.upsert_inventory_cells_newer(p_cells jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.inventory_cells (
    sheet_id,
    row_order,
    field_key,
    value,
    updated_by,
    updated_at
  )
  select
    cell.sheet_id,
    cell.row_order,
    cell.field_key,
    coalesce(cell.value, ''),
    cell.updated_by,
    coalesce(cell.updated_at, now())
  from jsonb_to_recordset(p_cells) as cell(
    sheet_id text,
    row_order integer,
    field_key text,
    value text,
    updated_by text,
    updated_at timestamptz
  )
  on conflict (sheet_id, row_order, field_key)
  do update set
    value = excluded.value,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
  where excluded.updated_at >= public.inventory_cells.updated_at;
end;
$$;

grant execute on function public.upsert_inventory_cells_newer(jsonb) to anon;
