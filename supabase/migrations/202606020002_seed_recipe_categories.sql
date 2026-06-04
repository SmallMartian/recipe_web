-- Shared recipe categories used by the web editor and mobile recipe dashboard.

insert into public.categories (slug, name)
values
  ('breakfast', 'Ranajky'),
  ('soup', 'Polievky'),
  ('main', 'Hlavne jedla'),
  ('side', 'Prilohy'),
  ('salad', 'Salaty'),
  ('pasta', 'Cestoviny'),
  ('rice', 'Ryza'),
  ('meat', 'Maso'),
  ('fish', 'Ryby'),
  ('vegetarian', 'Bezmasite'),
  ('vegan', 'Veganske'),
  ('sweet', 'Sladke'),
  ('dessert', 'Dezerty'),
  ('baking', 'Pecenie'),
  ('quick', 'Rychle'),
  ('healthy', 'Zdrave'),
  ('kids', 'Pre deti'),
  ('drink', 'Napoje')
on conflict (slug) do update
set name = excluded.name;
