-- Recipe MVP policies.
-- Any signed-in Supabase user can manage recipes until ownership is added.

alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.recipe_steps enable row level security;
alter table public.categories enable row level security;
alter table public.recipe_categories enable row level security;

grant usage on schema public to authenticated;

grant select, insert, update, delete on public.recipes to authenticated;
grant select, insert, update, delete on public.recipe_ingredients to authenticated;
grant select, insert, update, delete on public.recipe_steps to authenticated;
grant select, insert, update, delete on public.categories to authenticated;
grant select, insert, update, delete on public.recipe_categories to authenticated;

drop policy if exists "recipes authenticated select" on public.recipes;
create policy "recipes authenticated select"
on public.recipes for select
to authenticated
using (true);

drop policy if exists "recipes authenticated insert" on public.recipes;
create policy "recipes authenticated insert"
on public.recipes for insert
to authenticated
with check (true);

drop policy if exists "recipes authenticated update" on public.recipes;
create policy "recipes authenticated update"
on public.recipes for update
to authenticated
using (true)
with check (true);

drop policy if exists "recipes authenticated delete" on public.recipes;
create policy "recipes authenticated delete"
on public.recipes for delete
to authenticated
using (true);

drop policy if exists "recipe ingredients authenticated select" on public.recipe_ingredients;
create policy "recipe ingredients authenticated select"
on public.recipe_ingredients for select
to authenticated
using (true);

drop policy if exists "recipe ingredients authenticated insert" on public.recipe_ingredients;
create policy "recipe ingredients authenticated insert"
on public.recipe_ingredients for insert
to authenticated
with check (true);

drop policy if exists "recipe ingredients authenticated update" on public.recipe_ingredients;
create policy "recipe ingredients authenticated update"
on public.recipe_ingredients for update
to authenticated
using (true)
with check (true);

drop policy if exists "recipe ingredients authenticated delete" on public.recipe_ingredients;
create policy "recipe ingredients authenticated delete"
on public.recipe_ingredients for delete
to authenticated
using (true);

drop policy if exists "recipe steps authenticated select" on public.recipe_steps;
create policy "recipe steps authenticated select"
on public.recipe_steps for select
to authenticated
using (true);

drop policy if exists "recipe steps authenticated insert" on public.recipe_steps;
create policy "recipe steps authenticated insert"
on public.recipe_steps for insert
to authenticated
with check (true);

drop policy if exists "recipe steps authenticated update" on public.recipe_steps;
create policy "recipe steps authenticated update"
on public.recipe_steps for update
to authenticated
using (true)
with check (true);

drop policy if exists "recipe steps authenticated delete" on public.recipe_steps;
create policy "recipe steps authenticated delete"
on public.recipe_steps for delete
to authenticated
using (true);

drop policy if exists "categories authenticated select" on public.categories;
create policy "categories authenticated select"
on public.categories for select
to authenticated
using (true);

drop policy if exists "categories authenticated insert" on public.categories;
create policy "categories authenticated insert"
on public.categories for insert
to authenticated
with check (true);

drop policy if exists "categories authenticated update" on public.categories;
create policy "categories authenticated update"
on public.categories for update
to authenticated
using (true)
with check (true);

drop policy if exists "categories authenticated delete" on public.categories;
create policy "categories authenticated delete"
on public.categories for delete
to authenticated
using (true);

drop policy if exists "recipe categories authenticated select" on public.recipe_categories;
create policy "recipe categories authenticated select"
on public.recipe_categories for select
to authenticated
using (true);

drop policy if exists "recipe categories authenticated insert" on public.recipe_categories;
create policy "recipe categories authenticated insert"
on public.recipe_categories for insert
to authenticated
with check (true);

drop policy if exists "recipe categories authenticated update" on public.recipe_categories;
create policy "recipe categories authenticated update"
on public.recipe_categories for update
to authenticated
using (true)
with check (true);

drop policy if exists "recipe categories authenticated delete" on public.recipe_categories;
create policy "recipe categories authenticated delete"
on public.recipe_categories for delete
to authenticated
using (true);
