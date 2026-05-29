-- Public recipe browsing for signed-out users.
-- Only published recipe headers and their ingredients are readable anonymously.

grant usage on schema public to anon;
grant select on public.recipes to anon;
grant select on public.recipe_ingredients to anon;

drop policy if exists "recipes anon select published" on public.recipes;
create policy "recipes anon select published"
on public.recipes for select
to anon
using (is_published = true);

drop policy if exists "recipe ingredients anon select published recipes" on public.recipe_ingredients;
create policy "recipe ingredients anon select published recipes"
on public.recipe_ingredients for select
to anon
using (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_ingredients.recipe_id
      and r.is_published = true
  )
);
