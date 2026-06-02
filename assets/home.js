import { hasSupabaseConfig, supabase } from './supabase-client.js';
import { renderUserMenu } from './user-menu.js';

const publicHome = document.querySelector('#public-home');
const dashboardHome = document.querySelector('#dashboard-home');
const statusLine = document.querySelector('#home-status');
const loginLink = document.querySelector('[data-login-link]');
const authLinks = [...document.querySelectorAll('[data-auth-link]')];
const appNav = document.querySelector('[data-app-nav]');
const householdSelect = document.querySelector('#household-select');
const dashboardRecipesPanel = document.querySelector('#dashboard-recipes-panel');
const dashboardInventoryPanel = document.querySelector('#dashboard-inventory-panel');
const dashboardShoppingPanel = document.querySelector('#dashboard-shopping-panel');
const dashboardInventoryStat = document.querySelector('#dashboard-inventory-stat');
const dashboardExpiringStat = document.querySelector('#dashboard-expiring-stat');
const dashboardShoppingStat = document.querySelector('#dashboard-shopping-stat');

let currentSession = null;

const ACTIVE_HOUSEHOLD_KEY = 'recipe_web_active_household_id';
const INGREDIENT_ALIASES_KEY = 'recipe_web_recipe_ingredient_aliases_v1';
const INGREDIENT_USER_ALIASES_KEY = 'recipe_web_recipe_ingredient_user_aliases_v1';

function setStatus(message) {
  statusLine.textContent = message || '';
}

function formatQuantity(item) {
  const quantity = Number(item.quantity);
  const shownQuantity = Number.isFinite(quantity) ? Number.parseFloat(quantity.toFixed(2)) : item.quantity;
  return `${shownQuantity} ${item.unit || ''}`.trim();
}

function daysUntil(dateValue) {
  if (!dateValue) return null;

  const today = new Date();
  const target = new Date(`${dateValue}T00:00:00`);
  today.setHours(0, 0, 0, 0);

  return Math.ceil((target - today) / 86400000);
}

function normalizeIngredientName(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function loadAllIngredientAliases() {
  try {
    const map = JSON.parse(localStorage.getItem(INGREDIENT_ALIASES_KEY) || '{}');
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

function loadUserIngredientAliases(session) {
  const userKey = session?.user?.id || 'local';
  try {
    const map = JSON.parse(localStorage.getItem(INGREDIENT_USER_ALIASES_KEY) || '{}');
    return map[userKey] && typeof map[userKey] === 'object' ? map[userKey] : { ingredients: {}, inventoryItems: {} };
  } catch {
    return { ingredients: {}, inventoryItems: {} };
  }
}

function getIngredientAlias(ingredient, recipeAliases = {}, userAliases = {}) {
  const recipeAlias = recipeAliases?.[ingredient.id];
  if (recipeAlias) return recipeAlias;

  const normalized = ingredient.normalized_name || normalizeIngredientName(ingredient.name);
  const legacyAlias = userAliases?.[normalized];
  if (legacyAlias) return legacyAlias;

  const inventoryKey = userAliases?.ingredients?.[normalized];
  if (!inventoryKey) return '';

  return userAliases?.inventoryItems?.[inventoryKey]?.name || inventoryKey;
}

function renderRecipeCard(recipe) {
  const image = recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?auto=format&fit=crop&w=900&q=80';
  const url = `/recipes/?id=${encodeURIComponent(recipe.id)}`;
  const time = [recipe.prep_time_minutes, recipe.cook_time_minutes]
    .map((value) => Number(value || 0))
    .reduce((sum, value) => sum + value, 0);

  return `
    <a class="recipe-card" href="${url}">
      <img src="${image}" alt="" loading="lazy" />
      <div>
        <h3>${recipe.title}</h3>
        <p>${recipe.description || 'Jednoduchy recept pripraveny pre BASIL kuchynu.'}</p>
        <div class="meta-row">
          <span>${time ? `${time} min` : 'Cas nezadany'}</span>
          <span>${recipe.servings ? `${recipe.servings} porcie` : 'Porcie nezadane'}</span>
        </div>
      </div>
    </a>
  `;
}

function renderEmpty(target, message) {
  target.innerHTML = `<p class="empty-state">${message}</p>`;
}

function isPremiumRecord(row) {
  if (!row?.is_premium) return false;
  if (!row.premium_until) return true;
  return new Date(row.premium_until).getTime() > Date.now();
}

async function loadPublishedRecipes() {
  const { data, error } = await supabase
    .from('recipes')
    .select(`
      id,title,description,image_url,servings,prep_time_minutes,cook_time_minutes,difficulty,created_at,
      recipe_ingredients(id,name,normalized_name,optional,sort_order)
    `)
    .eq('is_published', true)
    .order('created_at', { ascending: false })
    .limit(12);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadIngredientTags(recipes) {
  if (recipes.length === 0) return [];

  const { data, error } = await supabase
    .from('recipe_ingredients')
    .select('name,normalized_name,recipe_id')
    .in(
      'recipe_id',
      recipes.map((recipe) => recipe.id),
    );

  if (error) throw error;

  const counts = new Map();
  for (const item of data || []) {
    const key = item.normalized_name || normalizeIngredientName(item.name);
    const existing = counts.get(key) || { name: item.name, count: 0 };
    counts.set(key, { name: existing.name, count: existing.count + 1 });
  }

  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 12);
}

function renderPublicHome(recipes, tags) {
  const newRecipes = document.querySelector('#new-recipes');
  const popularRecipes = document.querySelector('#popular-recipes');
  const ingredientTags = document.querySelector('#ingredient-tags');

  if (recipes.length === 0) {
    renderEmpty(newRecipes, 'Zatial tu nie su publikovane recepty.');
    renderEmpty(popularRecipes, 'Popularne recepty sa zobrazia po publikovani.');
  } else {
    newRecipes.innerHTML = recipes.slice(0, 6).map(renderRecipeCard).join('');
    popularRecipes.innerHTML = recipes.slice(0, 3).map(renderRecipeCard).join('');
  }

  if (tags.length === 0) {
    renderEmpty(ingredientTags, 'Suroviny sa zobrazia po doplneni receptov.');
  } else {
    ingredientTags.innerHTML = tags
      .map((tag) => `<button type="button" class="tag-button" data-ingredient="${tag.name}">${tag.name}</button>`)
      .join('');
  }
}

function bindIngredientSearch(recipes) {
  const form = document.querySelector('#ingredient-search');
  const target = document.querySelector('#new-recipes');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const query = normalizeIngredientName(new FormData(form).get('ingredient'));
    if (!query) {
      target.innerHTML = recipes.slice(0, 6).map(renderRecipeCard).join('');
      return;
    }

    const { data, error } = await supabase
      .from('recipe_ingredients')
      .select('recipe_id')
      .ilike('normalized_name', `%${query}%`);

    if (error) {
      setStatus(error.message);
      return;
    }

    const matchingIds = new Set((data || []).map((row) => row.recipe_id));
    const matchingRecipes = recipes.filter((recipe) => matchingIds.has(recipe.id));

    if (matchingRecipes.length === 0) {
      renderEmpty(target, 'Pre tuto surovinu zatial nemame recept.');
      return;
    }

    target.innerHTML = matchingRecipes.map(renderRecipeCard).join('');
  });
}

async function loadUserHomeData(session) {
  const [{ data: profile, error: profileError }, { data: households, error: householdError }, recipes] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle(),
    supabase.from('households').select('*').order('created_at', { ascending: true }),
    loadPublishedRecipes(),
  ]);

  if (profileError) console.warn('Profile load failed', profileError);
  if (householdError) throw householdError;

  return {
    profile,
    households: Array.isArray(households) ? households : [],
    recipes,
  };
}

async function loadHouseholdLists(householdId) {
  const { data: lists, error: listsError } = await supabase
    .from('lists')
    .select('id,type,name,is_default')
    .eq('household_id', householdId);

  if (listsError) throw listsError;

  const inventoryList = (lists || []).find((list) => list.type === 'inventory' && list.is_default);
  const shoppingList = (lists || []).find((list) => list.type === 'shopping' && list.is_default);
  const listIds = [inventoryList?.id, shoppingList?.id].filter(Boolean);

  if (listIds.length === 0) {
    return { inventoryItems: [], shoppingItems: [] };
  }

  const { data: items, error: itemsError } = await supabase
    .from('list_items')
    .select('id,list_id,name,quantity,unit,expiry_date,min_stock,status')
    .in('list_id', listIds)
    .neq('status', 'archived')
    .order('updated_at', { ascending: false });

  if (itemsError) throw itemsError;

  return {
    inventoryItems: (items || []).filter((item) => item.list_id === inventoryList?.id),
    shoppingItems: (items || []).filter((item) => item.list_id === shoppingList?.id && item.status !== 'checked'),
  };
}

function renderList(target, rows, emptyMessage) {
  if (rows.length === 0) {
    renderEmpty(target, emptyMessage);
    return;
  }

  target.innerHTML = rows
    .map(
      (item) => `
        <article class="data-row">
          <div>
            <strong>${item.name}</strong>
            <span>${item.expiry_date || item.status || ''}</span>
          </div>
          <span>${formatQuantity(item)}</span>
        </article>
      `,
    )
    .join('');
}

function renderMatchedRecipes(recipes, inventoryItems) {
  const target = document.querySelector('#matched-recipes');
  const inventoryNames = new Set(inventoryItems.map((item) => normalizeIngredientName(item.name)));
  const aliasesByRecipe = loadAllIngredientAliases();
  const userAliases = loadUserIngredientAliases(currentSession);

  if (recipes.length === 0) {
    renderEmpty(target, 'Publikovane recepty sa zobrazia tu.');
    return;
  }

  const shown = recipes
    .map((recipe) => {
      const ingredients = Array.isArray(recipe.recipe_ingredients) ? recipe.recipe_ingredients : [];
      const required = ingredients.filter((ingredient) => !ingredient.optional);
      const relevant = required.length ? required : ingredients;
      const base = relevant.length || 1;
      const aliases = aliasesByRecipe?.[recipe.id] || {};
      const matchedCount = relevant.filter((ingredient) => {
        const directName = ingredient.normalized_name || normalizeIngredientName(ingredient.name);
        const aliasName = getIngredientAlias(ingredient, aliases, userAliases);
        return inventoryNames.has(directName) ||
          (aliasName && inventoryNames.has(normalizeIngredientName(aliasName)));
      }).length;

      return {
        ...recipe,
        matchPercent: Math.round((matchedCount / base) * 100),
        matchedCount,
      };
    })
    .sort((a, b) => {
      if (b.matchPercent !== a.matchPercent) return b.matchPercent - a.matchPercent;
      return b.matchedCount - a.matchedCount;
    })
    .slice(0, 3);

  target.innerHTML = shown
    .map(
      (recipe) => `
        <a class="recipe-mini" href="/recipes/?id=${encodeURIComponent(recipe.id)}">
          <strong>${recipe.title}</strong>
          <span>${recipe.matchPercent}% zhoda</span>
        </a>
      `,
    )
    .join('');
}

function openRecipesPage() {
  window.location.href = '/recipes/';
}

function openInventoryPage() {
  window.location.href = '/inventory/';
}

function openInventoryByExpiryPage() {
  window.location.href = '/inventory/?sort=expiry';
}

function openShoppingPage() {
  window.location.href = '/shopping/';
}

async function renderDashboardForHousehold(householdId, recipes) {
  const { inventoryItems, shoppingItems } = await loadHouseholdLists(householdId);
  const expiringItems = inventoryItems
    .map((item) => ({ ...item, days: daysUntil(item.expiry_date) }))
    .filter((item) => item.days !== null && item.days >= 0 && item.days <= 5)
    .sort((a, b) => a.days - b.days);
  const lowStockItems = inventoryItems.filter((item) => item.min_stock !== null && Number(item.quantity) < Number(item.min_stock));

  document.querySelector('#inventory-count').textContent = String(inventoryItems.length);
  document.querySelector('#expiring-count').textContent = String(expiringItems.length);
  document.querySelector('#shopping-count').textContent = String(shoppingItems.length);

  renderList(document.querySelector('#expiring-items'), expiringItems.slice(0, 6), 'Nic neexpiruje v najblizsich 5 dnoch.');
  renderList(document.querySelector('#shopping-items'), shoppingItems.slice(0, 6), 'Nakupny zoznam je prazdny.');
  renderList(document.querySelector('#low-stock-items'), lowStockItems.slice(0, 6), 'Ziadne minajuce sa polozky.');
  renderMatchedRecipes(recipes, inventoryItems);
}

async function renderDashboard(session) {
  const { profile, households, recipes } = await loadUserHomeData(session);
  const displayName = profile?.display_name || profile?.handle || session.user.email || 'BASIL user';

  document.querySelector('#dashboard-title').textContent = `Vitaj, ${displayName}`;
  renderUserMenu({ profile: profile || { email: session.user.email }, user: session.user });
  loginLink.hidden = true;
  authLinks.forEach((link) => {
    link.hidden = false;
  });

  if (households.length === 0) {
    householdSelect.innerHTML = '<option>Ziadna domacnost</option>';
    setStatus('Zatial nemas dostupnu domacnost.');
    return;
  }

  householdSelect.innerHTML = households.map((household) => `<option value="${household.id}">${household.name}</option>`).join('');

  const storedActiveId = localStorage.getItem(ACTIVE_HOUSEHOLD_KEY);
  const activeHousehold = households.find((household) => household.id === storedActiveId) || households[0];
  householdSelect.value = activeHousehold.id;
  document.querySelector('#dashboard-subtitle').textContent = `Prehlad pre domacnost ${activeHousehold.name}. Domacnost: ${isPremiumRecord(activeHousehold) ? 'Premium' : 'Free'}.`;

  householdSelect.addEventListener('change', async () => {
    const nextId = householdSelect.value;
    const nextHousehold = households.find((household) => household.id === nextId);
    localStorage.setItem(ACTIVE_HOUSEHOLD_KEY, nextId);
    document.querySelector('#dashboard-subtitle').textContent = `Prehlad pre domacnost ${nextHousehold?.name || 'domacnost'}. Domacnost: ${isPremiumRecord(nextHousehold) ? 'Premium' : 'Free'}.`;
    await renderDashboardForHousehold(nextId, recipes);
  });

  await renderDashboardForHousehold(activeHousehold.id, recipes);
}

async function init() {
  if (!hasSupabaseConfig()) {
    publicHome.hidden = false;
    setStatus('Chyba Supabase URL alebo anon key.');
    return;
  }

  const { data } = await supabase.auth.getSession();
  const session = data.session;
  currentSession = session;

  authLinks.forEach((link) => {
    link.hidden = !session;
  });

  try {
    const recipes = await loadPublishedRecipes();
    const tags = await loadIngredientTags(recipes);

    if (!session) {
      publicHome.hidden = false;
      renderPublicHome(recipes, tags);
      bindIngredientSearch(recipes);
      return;
    }

    dashboardHome.hidden = false;
    appNav.hidden = false;
    await renderDashboard(session);
  } catch (error) {
    setStatus(error.message);
    publicHome.hidden = !session;
    dashboardHome.hidden = Boolean(session) ? false : dashboardHome.hidden;
  }
}

dashboardRecipesPanel?.addEventListener('click', (event) => {
  if (event.target.closest('a')) return;
  openRecipesPage();
});

dashboardRecipesPanel?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openRecipesPage();
  }
});

dashboardInventoryPanel?.addEventListener('click', (event) => {
  if (event.target.closest('a')) return;
  openInventoryByExpiryPage();
});

dashboardInventoryPanel?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openInventoryByExpiryPage();
  }
});

dashboardShoppingPanel?.addEventListener('click', (event) => {
  if (event.target.closest('a')) return;
  openShoppingPage();
});

dashboardShoppingPanel?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openShoppingPage();
  }
});

dashboardInventoryStat?.addEventListener('click', openInventoryPage);
dashboardExpiringStat?.addEventListener('click', openInventoryByExpiryPage);
dashboardShoppingStat?.addEventListener('click', openShoppingPage);

dashboardInventoryStat?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openInventoryPage();
  }
});

dashboardShoppingStat?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openShoppingPage();
  }
});

dashboardExpiringStat?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openInventoryByExpiryPage();
  }
});

init();
