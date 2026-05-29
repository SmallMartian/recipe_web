import { hasSupabaseConfig, supabase } from './supabase-client.js';

const params = new URLSearchParams(window.location.search);
const recipeId = params.get('id');
const detail = document.querySelector('#recipe-detail');
const message = document.querySelector('#detail-message');
const loginLink = document.querySelector('[data-login-link]');
const authLinks = [...document.querySelectorAll('[data-auth-link]')];
const logoutButton = document.querySelector('#detail-logout');

function setMessage(value) {
  message.textContent = value || '';
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number.parseFloat(number.toFixed(2)) : value;
}

function formatQuantity(ingredient) {
  const quantity = ingredient.quantity === null ? '' : formatNumber(ingredient.quantity);
  const unit = ingredient.unit || '';
  return `${quantity} ${unit}`.trim();
}

function renderIngredients(ingredients) {
  const target = document.querySelector('#recipe-ingredients');

  if (ingredients.length === 0) {
    target.innerHTML = '<p class="empty-state">Suroviny zatial nie su doplnene.</p>';
    return;
  }

  target.innerHTML = ingredients
    .map(
      (ingredient) => `
        <article class="data-row">
          <div>
            <strong>${ingredient.name}</strong>
            <span>${ingredient.optional ? 'Volitelne' : 'Povinne'}</span>
          </div>
          <span>${formatQuantity(ingredient)}</span>
        </article>
      `,
    )
    .join('');
}

function renderSteps(steps) {
  const target = document.querySelector('#recipe-steps');

  if (steps.length === 0) {
    target.innerHTML = '<li class="empty-state">Postup zatial nie je doplneny.</li>';
    return;
  }

  target.innerHTML = steps.map((step) => `<li>${step.instruction}</li>`).join('');
}

function renderRecipe(recipe, ingredients, steps) {
  const image = recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?auto=format&fit=crop&w=1200&q=80';
  const totalTime = Number(recipe.prep_time_minutes || 0) + Number(recipe.cook_time_minutes || 0);
  const meta = [
    recipe.servings ? `${formatNumber(recipe.servings)} porcie` : null,
    recipe.prep_time_minutes ? `Priprava ${recipe.prep_time_minutes} min` : null,
    recipe.cook_time_minutes ? `Varenie ${recipe.cook_time_minutes} min` : null,
    totalTime ? `Spolu ${totalTime} min` : null,
    recipe.difficulty ? `Narocnost ${recipe.difficulty}` : null,
  ].filter(Boolean);

  document.querySelector('#recipe-image').src = image;
  document.querySelector('#recipe-status').textContent = recipe.is_published ? 'Publikovany recept' : 'Draft recept';
  document.querySelector('#recipe-title').textContent = recipe.title;
  document.querySelector('#recipe-description').textContent = recipe.description || 'Bez popisu.';
  document.querySelector('#recipe-meta').innerHTML = meta.map((item) => `<span>${item}</span>`).join('');

  renderIngredients(ingredients);
  renderSteps(steps);

  detail.hidden = false;
  setMessage('');
}

async function loadRecipe() {
  if (!recipeId) {
    setMessage('Chyba ID receptu.');
    return;
  }

  if (!hasSupabaseConfig()) {
    setMessage('Chyba Supabase URL alebo anon key.');
    return;
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData.session;

  loginLink.hidden = Boolean(session);
  logoutButton.hidden = !session;
  authLinks.forEach((link) => {
    link.hidden = !session;
  });

  const [{ data: recipe, error: recipeError }, { data: ingredients, error: ingredientsError }, { data: steps, error: stepsError }] =
    await Promise.all([
      supabase
        .from('recipes')
        .select('id,title,description,image_url,servings,prep_time_minutes,cook_time_minutes,difficulty,is_published')
        .eq('id', recipeId)
        .maybeSingle(),
      supabase
        .from('recipe_ingredients')
        .select('name,quantity,unit,optional,sort_order')
        .eq('recipe_id', recipeId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('recipe_steps')
        .select('instruction,sort_order')
        .eq('recipe_id', recipeId)
        .order('sort_order', { ascending: true }),
    ]);

  if (recipeError || ingredientsError || stepsError) {
    setMessage(recipeError?.message || ingredientsError?.message || stepsError?.message);
    return;
  }

  if (!recipe) {
    setMessage(session ? 'Recept sa nenasiel.' : 'Recept nie je publikovany alebo neexistuje.');
    return;
  }

  renderRecipe(recipe, ingredients || [], steps || []);
}

logoutButton.addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.href = '/';
});

loadRecipe();
