# Recipe web MVP

Minimalny admin pre vytvaranie receptov.

## Lokalne spustenie

Server automaticky pouzije Supabase URL a anon key z `../Inventar_app/app.json`.
Ak ich potrebujes prebit, nastav env premenne:

```powershell
$env:SUPABASE_URL="https://your-project.supabase.co"
$env:SUPABASE_ANON_KEY="your-anon-key"
npm run dev
```

Hlavna stranka je na:

```text
http://localhost:5174/
```

Neprihlaseny user vidi verejnu receptovu homepage s publikovanymi receptami. Prihlaseny user vidi dashboard s datami zo Supabase domacnosti, inventara a nakupneho zoznamu.

Prihlasenie je na:

```text
http://localhost:5174/login
```

Admin formular je po prihlaseni na:

```text
http://localhost:5174/admin/recipes/new
```

Detail receptu je na:

```text
http://localhost:5174/recipes/?id=RECIPE_ID
```

Po vytvoreni receptu admin formular presmeruje rovno na detail. Neprihlaseny user vidi detail iba pre publikovane recepty.

Recepty moze vytvarat iba prihlaseny Supabase user. Recipe MVP zatial nema vlastnictvo receptov, takze databazove policy povoluju pristup vsetkym `authenticated` userom.

Stranka vie citat aj hodnoty ulozene v `localStorage`, ak ich potrebujes rychlo prebit v browseri:

```js
localStorage.setItem('recipe_web_supabase_url', 'https://your-project.supabase.co');
localStorage.setItem('recipe_web_supabase_anon_key', 'your-anon-key');
```
