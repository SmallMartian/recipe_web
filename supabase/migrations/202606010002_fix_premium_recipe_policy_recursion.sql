-- Fix recursive recipe/share RLS introduced by Premium foundations.

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

drop policy if exists "recipe ingredients authenticated select" on public.recipe_ingredients;
create policy "recipe ingredients authenticated select"
on public.recipe_ingredients for select
to authenticated
using (public.can_view_recipe(recipe_id));

drop policy if exists "recipe steps authenticated select" on public.recipe_steps;
create policy "recipe steps authenticated select"
on public.recipe_steps for select
to authenticated
using (public.can_view_recipe(recipe_id));

revoke all on function public.is_recipe_owner(uuid) from public, anon;
grant execute on function public.is_recipe_owner(uuid) to authenticated;
revoke all on function public.is_recipe_shared_with_current_user(uuid) from public, anon;
grant execute on function public.is_recipe_shared_with_current_user(uuid) to authenticated;
revoke all on function public.can_view_recipe(uuid) from public, anon;
grant execute on function public.can_view_recipe(uuid) to authenticated;
