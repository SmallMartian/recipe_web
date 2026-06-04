-- Premium users can save community recipes into their own recipe list.

drop policy if exists "recipe saves insert own" on public.recipe_saves;
create policy "recipe saves insert own"
on public.recipe_saves for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.is_premium_user(auth.uid())
);
