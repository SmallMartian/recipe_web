-- Premium foundations for recipe publishing and household sharing.

alter table public.profiles
  add column if not exists is_premium boolean not null default false,
  add column if not exists premium_until timestamptz;

create or replace function public.is_premium_user(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = target_user_id
      and p.is_premium = true
      and (p.premium_until is null or p.premium_until > now())
  );
$$;

create or replace function public.is_household_member(target_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.household_members hm
    where hm.household_id = target_household_id
      and hm.user_id = auth.uid()
      and hm.status = 'accepted'
  );
$$;

create table if not exists public.recipe_household_shares (
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  shared_by_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (recipe_id, household_id)
);

alter table public.recipe_household_shares enable row level security;

grant select, insert, delete on public.recipe_household_shares to authenticated;

create or replace function public.is_recipe_owner(target_recipe_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.recipes r
    where r.id = target_recipe_id
      and r.created_by_user_id = auth.uid()
  );
$$;

create or replace function public.is_recipe_shared_with_current_user(target_recipe_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.recipe_household_shares rhs
    join public.household_members hm on hm.household_id = rhs.household_id
    where rhs.recipe_id = target_recipe_id
      and hm.user_id = auth.uid()
      and hm.status = 'accepted'
  );
$$;

create or replace function public.can_view_recipe(target_recipe_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.recipes r
    where r.id = target_recipe_id
      and (
        r.is_published = true
        or r.created_by_user_id = auth.uid()
        or public.is_recipe_shared_with_current_user(r.id)
        or exists (
          select 1
          from public.recipe_saves rs
          where rs.recipe_id = r.id
            and rs.user_id = auth.uid()
        )
      )
  );
$$;

drop policy if exists "recipe shares select owner or member" on public.recipe_household_shares;
create policy "recipe shares select owner or member"
on public.recipe_household_shares for select
to authenticated
using (
  public.is_household_member(household_id)
  or shared_by_user_id = auth.uid()
);

drop policy if exists "recipe shares insert owner member" on public.recipe_household_shares;
create policy "recipe shares insert owner member"
on public.recipe_household_shares for insert
to authenticated
with check (
  shared_by_user_id = auth.uid()
  and public.is_household_member(household_id)
  and public.is_recipe_owner(recipe_id)
);

drop policy if exists "recipe shares delete owner" on public.recipe_household_shares;
create policy "recipe shares delete owner"
on public.recipe_household_shares for delete
to authenticated
using (
  shared_by_user_id = auth.uid()
  or public.is_recipe_owner(recipe_id)
);

drop policy if exists "recipes authenticated insert" on public.recipes;
create policy "recipes authenticated insert"
on public.recipes for insert
to authenticated
with check (
  created_by_user_id = auth.uid()
  and (is_published = false or public.is_premium_user(auth.uid()))
);

drop policy if exists "recipes authenticated select" on public.recipes;
create policy "recipes authenticated select"
on public.recipes for select
to authenticated
using (
  is_published = true
  or created_by_user_id = auth.uid()
  or public.is_recipe_shared_with_current_user(recipes.id)
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
with check (
  (created_by_user_id = auth.uid() or created_by_user_id is null)
  and (is_published = false or public.is_premium_user(auth.uid()))
);

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
  public.can_view_recipe(recipe_id)
);

drop policy if exists "recipe ingredients authenticated insert" on public.recipe_ingredients;
create policy "recipe ingredients authenticated insert"
on public.recipe_ingredients for insert
to authenticated
with check (
  exists (
    select 1 from public.recipes r
    where r.id = recipe_ingredients.recipe_id
      and r.created_by_user_id = auth.uid()
  )
);

drop policy if exists "recipe ingredients authenticated update" on public.recipe_ingredients;
create policy "recipe ingredients authenticated update"
on public.recipe_ingredients for update
to authenticated
using (
  exists (
    select 1 from public.recipes r
    where r.id = recipe_ingredients.recipe_id
      and r.created_by_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.recipes r
    where r.id = recipe_ingredients.recipe_id
      and r.created_by_user_id = auth.uid()
  )
);

drop policy if exists "recipe ingredients authenticated delete" on public.recipe_ingredients;
create policy "recipe ingredients authenticated delete"
on public.recipe_ingredients for delete
to authenticated
using (
  exists (
    select 1 from public.recipes r
    where r.id = recipe_ingredients.recipe_id
      and r.created_by_user_id = auth.uid()
  )
);

drop policy if exists "recipe steps authenticated select" on public.recipe_steps;
create policy "recipe steps authenticated select"
on public.recipe_steps for select
to authenticated
using (
  public.can_view_recipe(recipe_id)
);

drop policy if exists "recipe steps authenticated insert" on public.recipe_steps;
create policy "recipe steps authenticated insert"
on public.recipe_steps for insert
to authenticated
with check (
  exists (
    select 1 from public.recipes r
    where r.id = recipe_steps.recipe_id
      and r.created_by_user_id = auth.uid()
  )
);

drop policy if exists "recipe steps authenticated update" on public.recipe_steps;
create policy "recipe steps authenticated update"
on public.recipe_steps for update
to authenticated
using (
  exists (
    select 1 from public.recipes r
    where r.id = recipe_steps.recipe_id
      and r.created_by_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.recipes r
    where r.id = recipe_steps.recipe_id
      and r.created_by_user_id = auth.uid()
  )
);

drop policy if exists "recipe steps authenticated delete" on public.recipe_steps;
create policy "recipe steps authenticated delete"
on public.recipe_steps for delete
to authenticated
using (
  exists (
    select 1 from public.recipes r
    where r.id = recipe_steps.recipe_id
      and r.created_by_user_id = auth.uid()
  )
);

revoke all on function public.is_premium_user(uuid) from public, anon;
grant execute on function public.is_premium_user(uuid) to authenticated;
revoke all on function public.is_recipe_owner(uuid) from public, anon;
grant execute on function public.is_recipe_owner(uuid) to authenticated;
revoke all on function public.is_recipe_shared_with_current_user(uuid) from public, anon;
grant execute on function public.is_recipe_shared_with_current_user(uuid) to authenticated;
revoke all on function public.can_view_recipe(uuid) from public, anon;
grant execute on function public.can_view_recipe(uuid) to authenticated;
