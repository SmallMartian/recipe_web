-- Public recipe steps for published recipe detail pages.

grant select on public.recipe_steps to anon;

drop policy if exists "recipe steps anon select published recipes" on public.recipe_steps;
create policy "recipe steps anon select published recipes"
on public.recipe_steps for select
to anon
using (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_steps.recipe_id
      and r.is_published = true
  )
);
