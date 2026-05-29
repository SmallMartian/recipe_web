-- Initial recipe web app schema.
-- Kept separate from BASIL inventory sync and without auth/ownership for MVP.

create extension if not exists pgcrypto;

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  image_url text,
  source_url text,
  servings numeric,
  prep_time_minutes integer,
  cook_time_minutes integer,
  difficulty text,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  name text not null,
  normalized_name text not null,
  quantity numeric,
  unit text,
  optional boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recipe_steps (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  instruction text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recipe_categories (
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (recipe_id, category_id)
);

create unique index if not exists categories_slug_idx
  on public.categories (slug);

create unique index if not exists categories_name_lower_idx
  on public.categories (lower(name));

create index if not exists recipe_ingredients_recipe_sort_idx
  on public.recipe_ingredients (recipe_id, sort_order);

create index if not exists recipe_ingredients_normalized_name_idx
  on public.recipe_ingredients (normalized_name);

create index if not exists recipe_steps_recipe_sort_idx
  on public.recipe_steps (recipe_id, sort_order);

create index if not exists recipe_categories_category_idx
  on public.recipe_categories (category_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists recipes_touch_updated_at on public.recipes;
create trigger recipes_touch_updated_at
before update on public.recipes
for each row execute function public.touch_updated_at();

drop trigger if exists recipe_ingredients_touch_updated_at on public.recipe_ingredients;
create trigger recipe_ingredients_touch_updated_at
before update on public.recipe_ingredients
for each row execute function public.touch_updated_at();

drop trigger if exists recipe_steps_touch_updated_at on public.recipe_steps;
create trigger recipe_steps_touch_updated_at
before update on public.recipe_steps
for each row execute function public.touch_updated_at();

drop trigger if exists categories_touch_updated_at on public.categories;
create trigger categories_touch_updated_at
before update on public.categories
for each row execute function public.touch_updated_at();
