-- Link recipes to users and support saved recipes.

alter table public.recipes
  add column if not exists created_by_user_id uuid references auth.users(id) on delete set null;

create index if not exists recipes_created_by_user_idx
  on public.recipes (created_by_user_id, created_at desc);

create table if not exists public.recipe_saves (
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, recipe_id)
);

alter table public.recipe_saves enable row level security;

grant select, insert, delete on public.recipe_saves to authenticated;

drop policy if exists "recipe saves select own" on public.recipe_saves;
create policy "recipe saves select own"
on public.recipe_saves for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "recipe saves insert own" on public.recipe_saves;
create policy "recipe saves insert own"
on public.recipe_saves for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "recipe saves delete own" on public.recipe_saves;
create policy "recipe saves delete own"
on public.recipe_saves for delete
to authenticated
using (user_id = auth.uid());

drop policy if exists "recipes authenticated insert" on public.recipes;
create policy "recipes authenticated insert"
on public.recipes for insert
to authenticated
with check (created_by_user_id = auth.uid());

drop policy if exists "recipes authenticated select" on public.recipes;
create policy "recipes authenticated select"
on public.recipes for select
to authenticated
using (
  is_published = true
  or created_by_user_id = auth.uid()
  or exists (
    select 1
    from public.recipe_saves rs
    where rs.recipe_id = recipes.id
      and rs.user_id = auth.uid()
  )
);

drop policy if exists "recipes authenticated update" on public.recipes;
create policy "recipes authenticated update"
on public.recipes for update
to authenticated
using (created_by_user_id = auth.uid() or created_by_user_id is null)
with check (created_by_user_id = auth.uid() or created_by_user_id is null);

drop policy if exists "recipes authenticated delete" on public.recipes;
create policy "recipes authenticated delete"
on public.recipes for delete
to authenticated
using (created_by_user_id = auth.uid() or created_by_user_id is null);

drop policy if exists "recipe ingredients authenticated select" on public.recipe_ingredients;
create policy "recipe ingredients authenticated select"
on public.recipe_ingredients for select
to authenticated
using (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_ingredients.recipe_id
      and (
        r.is_published = true
        or r.created_by_user_id = auth.uid()
        or exists (
          select 1
          from public.recipe_saves rs
          where rs.recipe_id = r.id
            and rs.user_id = auth.uid()
        )
      )
  )
);

drop policy if exists "recipe steps authenticated select" on public.recipe_steps;
create policy "recipe steps authenticated select"
on public.recipe_steps for select
to authenticated
using (
  exists (
    select 1
    from public.recipes r
    where r.id = recipe_steps.recipe_id
      and (
        r.is_published = true
        or r.created_by_user_id = auth.uid()
        or exists (
          select 1
          from public.recipe_saves rs
          where rs.recipe_id = r.id
            and rs.user_id = auth.uid()
        )
      )
  )
);
