import { hasSupabaseConfig, supabase } from './supabase-client.js';
import { getCurrentProfile, renderUserMenu } from './user-menu.js';
import {
  buildShoppingRow,
  computeExpiryForName,
  loadItemPreferences,
  normalizeItemUnit,
  pickCanonicalDisplayName,
  upsertListItemWithMerge,
} from './basil-item-logic.js';

const params = new URLSearchParams(window.location.search);
const recipeId = params.get('id');
const browse = document.querySelector('#recipes-browse');
const detail = document.querySelector('#recipe-detail');
const message = document.querySelector('#detail-message');
const loginLink = document.querySelector('[data-login-link]');
const authLinks = [...document.querySelectorAll('[data-auth-link]')];
const appNav = document.querySelector('[data-app-nav]');
const saveButton = document.querySelector('#save-recipe-button');
const ACTIVE_HOUSEHOLD_KEY = 'recipe_web_active_household_id';
const INGREDIENT_ALIASES_KEY = 'recipe_web_recipe_ingredient_aliases_v1';
const INGREDIENT_USER_ALIASES_KEY = 'recipe_web_recipe_ingredient_user_aliases_v1';

let currentSession = null;
let currentRecipe = null;
let currentSave = null;
let currentIngredients = [];
let currentInventoryItems = [];
let currentKnownItems = [];
let currentIngredientAliases = {};
let currentUserIngredientAliases = {};
let currentRecipeHousehold = null;
let selectedIngredient = null;

function isPremiumRecord(row) {
  if (!row?.is_premium) return false;
  if (!row.premium_until) return true;
  return new Date(row.premium_until).getTime() > Date.now();
}

function setMessage(value) {
  message.textContent = value || '';
}

function normalizeIngredientName(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function ingredientStem(value) {
  const normalized = normalizeIngredientName(value).replace(/[^a-z0-9]/g, '');
  if (normalized.length <= 4) return normalized;
  const suffixes = ['ciach', 'iach', 'ami', 'och', 'iou', 'cia', 'ia', 'ie', 'ou', 'ov', 'om', 'e', 'a', 'y', 'i'];
  const suffix = suffixes.find((item) => normalized.endsWith(item) && normalized.length - item.length >= 3);
  return suffix ? normalized.slice(0, -suffix.length) : normalized;
}

function bigrams(value) {
  const text = normalizeIngredientName(value).replace(/[^a-z0-9]/g, '');
  if (text.length <= 1) return new Set(text ? [text] : []);
  const result = new Set();
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
  return result;
}

function similarityScore(left, right) {
  const leftName = normalizeIngredientName(left);
  const rightName = normalizeIngredientName(right);
  if (!leftName || !rightName) return 0;
  if (leftName === rightName) return 100;

  const leftStem = ingredientStem(leftName);
  const rightStem = ingredientStem(rightName);
  if (leftStem && rightStem && leftStem === rightStem) return 92;
  if (leftStem && rightStem && (leftStem.startsWith(rightStem) || rightStem.startsWith(leftStem))) return 78;

  const leftBigrams = bigrams(leftName);
  const rightBigrams = bigrams(rightName);
  const intersection = [...leftBigrams].filter((item) => rightBigrams.has(item)).length;
  const union = new Set([...leftBigrams, ...rightBigrams]).size || 1;
  return Math.round((intersection / union) * 70);
}

function loadIngredientAliases(recipeIdValue) {
  if (!recipeIdValue) return {};
  try {
    const map = JSON.parse(localStorage.getItem(INGREDIENT_ALIASES_KEY) || '{}');
    return map[recipeIdValue] && typeof map[recipeIdValue] === 'object' ? map[recipeIdValue] : {};
  } catch {
    return {};
  }
}

function loadUserIngredientAliases() {
  const userKey = currentSession?.user?.id || 'local';
  try {
    const map = JSON.parse(localStorage.getItem(INGREDIENT_USER_ALIASES_KEY) || '{}');
    return map[userKey] && typeof map[userKey] === 'object' ? map[userKey] : { ingredients: {}, inventoryItems: {} };
  } catch {
    return { ingredients: {}, inventoryItems: {} };
  }
}

function getIngredientAlias(ingredient) {
  const recipeAlias = currentIngredientAliases[ingredient.id];
  if (recipeAlias) return recipeAlias;

  const normalized = ingredient.normalized_name || normalizeIngredientName(ingredient.name);
  const legacyAlias = currentUserIngredientAliases[normalized];
  if (legacyAlias) return legacyAlias;

  const inventoryKey = currentUserIngredientAliases.ingredients?.[normalized];
  if (!inventoryKey) return '';

  return currentUserIngredientAliases.inventoryItems?.[inventoryKey]?.name || inventoryKey;
}

function saveIngredientAlias(ingredientId, inventoryName) {
  if (!recipeId || !ingredientId || !inventoryName || !selectedIngredient) return;
  const map = JSON.parse(localStorage.getItem(INGREDIENT_ALIASES_KEY) || '{}');
  const recipeAliases = map[recipeId] && typeof map[recipeId] === 'object' ? map[recipeId] : {};
  currentIngredientAliases = {
    ...recipeAliases,
    [ingredientId]: String(inventoryName),
  };
  localStorage.setItem(INGREDIENT_ALIASES_KEY, JSON.stringify({
    ...map,
    [recipeId]: currentIngredientAliases,
  }));

  const normalizedIngredient = normalizeIngredientName(selectedIngredient.name);
  const normalizedInventory = normalizeIngredientName(inventoryName);
  if (!normalizedIngredient || !normalizedInventory) return;

  const userKey = currentSession?.user?.id || 'local';
  const userMap = JSON.parse(localStorage.getItem(INGREDIENT_USER_ALIASES_KEY) || '{}');
  const userAliases = userMap[userKey] && typeof userMap[userKey] === 'object' ? userMap[userKey] : {};
  const inventoryItems = userAliases.inventoryItems && typeof userAliases.inventoryItems === 'object' ? userAliases.inventoryItems : {};
  const currentItem = inventoryItems[normalizedInventory] && typeof inventoryItems[normalizedInventory] === 'object' ? inventoryItems[normalizedInventory] : {};
  const aliasSet = new Set([...(Array.isArray(currentItem.aliases) ? currentItem.aliases : []), normalizedIngredient]);

  currentUserIngredientAliases = {
    ingredients: {
      ...(userAliases.ingredients || {}),
      [normalizedIngredient]: normalizedInventory,
    },
    inventoryItems: {
      ...inventoryItems,
      [normalizedInventory]: {
        name: String(inventoryName),
        aliases: [...aliasSet],
      },
    },
  };

  localStorage.setItem(INGREDIENT_USER_ALIASES_KEY, JSON.stringify({
    ...userMap,
    [userKey]: currentUserIngredientAliases,
  }));
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

function findInventoryMatches(ingredientName) {
  const byName = new Map();

  for (const item of currentInventoryItems) {
    const key = normalizeIngredientName(item?.name);
    if (key) byName.set(key, { ...item, source: 'inventory' });
  }

  for (const name of currentKnownItems) {
    const key = normalizeIngredientName(name);
    if (key && !byName.has(key)) {
      byName.set(key, { id: `known_${key}`, name, source: 'known' });
    }
  }

  return [...byName.values()]
    .map((item) => ({ item, score: similarityScore(ingredientName, item.name) }))
    .filter((match) => match.item?.name && match.score >= 25)
    .sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name)))
    .slice(0, 8);
}

function getIngredientState(ingredient) {
  if (!currentSession) return { matched: false, missing: false, aliasName: '' };

  const inventoryNames = new Set(currentInventoryItems.map((item) => normalizeIngredientName(item.name)).filter(Boolean));
  const normalized = ingredient.normalized_name || normalizeIngredientName(ingredient.name);
  const aliasName = getIngredientAlias(ingredient);
  const directMatched = inventoryNames.has(normalized);
  const aliasMatched = aliasName && inventoryNames.has(normalizeIngredientName(aliasName));

  return {
    matched: Boolean(directMatched || aliasMatched),
    missing: !ingredient.optional && !directMatched && !aliasMatched,
    aliasName: aliasMatched ? aliasName : '',
  };
}

function getMissingIngredients() {
  if (!currentSession) return [];
  return currentIngredients.filter((ingredient) => getIngredientState(ingredient).missing);
}

function getClientItemId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `recipe_web_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function recipeUrl(id) {
  return `/recipes/?id=${encodeURIComponent(id)}`;
}

function renderRecipeCard(recipe, badge = '') {
  const image = recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?auto=format&fit=crop&w=900&q=80';
  const time = [recipe.prep_time_minutes, recipe.cook_time_minutes]
    .map((value) => Number(value || 0))
    .reduce((sum, value) => sum + value, 0);

  return `
    <a class="recipe-card" href="${recipeUrl(recipe.id)}">
      <img src="${image}" alt="" loading="lazy" />
      <div>
        ${badge ? `<span class="card-badge">${badge}</span>` : ''}
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

function renderEmpty(target, value) {
  target.innerHTML = `<p class="empty-state">${value}</p>`;
}

async function setupSessionUi() {
  if (!hasSupabaseConfig()) {
    setMessage('Chyba Supabase URL alebo anon key.');
    return null;
  }

  const { data } = await supabase.auth.getSession();
  currentSession = data.session;

  loginLink.hidden = Boolean(currentSession);
  authLinks.forEach((link) => {
    link.hidden = !currentSession;
  });

  if (currentSession) {
    appNav.hidden = false;
    const profile = await getCurrentProfile(currentSession);
    renderUserMenu({ profile, user: currentSession.user });
  }

  return currentSession;
}

async function loadPublishedRecipes() {
  const { data, error } = await supabase
    .from('recipes')
    .select('id,title,description,image_url,servings,prep_time_minutes,cook_time_minutes,difficulty,is_published,created_by_user_id,created_at')
    .eq('is_published', true)
    .order('created_at', { ascending: false })
    .limit(24);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadMyRecipes(session) {
  if (!session) {
    return [];
  }

  const [{ data: authored, error: authoredError }, { data: saves, error: savesError }] = await Promise.all([
    supabase
      .from('recipes')
      .select('id,title,description,image_url,servings,prep_time_minutes,cook_time_minutes,difficulty,is_published,created_by_user_id,created_at')
      .eq('created_by_user_id', session.user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('recipe_saves')
      .select('recipe_id,recipes(id,title,description,image_url,servings,prep_time_minutes,cook_time_minutes,difficulty,is_published,created_by_user_id,created_at)')
      .eq('user_id', session.user.id),
  ]);

  if (authoredError || savesError) {
    throw authoredError || savesError;
  }

  const rows = new Map();

  for (const recipe of authored || []) {
    rows.set(recipe.id, { ...recipe, badge: recipe.is_published ? 'Tvoj recept' : 'Draft' });
  }

  for (const saved of saves || []) {
    if (saved.recipes && !rows.has(saved.recipes.id)) {
      rows.set(saved.recipes.id, { ...saved.recipes, badge: 'Ulozene' });
    }
  }

  return [...rows.values()];
}

function renderBrowse(allRecipes, myRecipes) {
  const mySection = document.querySelector('#my-recipes-section');
  const myTarget = document.querySelector('#my-recipes');
  const allTarget = document.querySelector('#all-recipes');

  if (currentSession) {
    mySection.hidden = false;

    if (myRecipes.length === 0) {
      renderEmpty(myTarget, 'Zatial nemas ulozeny ani napisany recept.');
    } else {
      myTarget.innerHTML = myRecipes.map((recipe) => renderRecipeCard(recipe, recipe.badge)).join('');
    }
  }

  if (allRecipes.length === 0) {
    renderEmpty(allTarget, 'Zatial tu nie su publikovane recepty.');
  } else {
    allTarget.innerHTML = allRecipes.map((recipe) => renderRecipeCard(recipe)).join('');
  }

  browse.hidden = false;
  setMessage('');
}

function bindBrowseSearch(allRecipes) {
  const form = document.querySelector('#recipes-search');
  const target = document.querySelector('#all-recipes');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const query = normalizeIngredientName(new FormData(form).get('ingredient'));
    if (!query) {
      target.innerHTML = allRecipes.map((recipe) => renderRecipeCard(recipe)).join('');
      return;
    }

    const { data, error } = await supabase
      .from('recipe_ingredients')
      .select('recipe_id')
      .ilike('normalized_name', `%${query}%`);

    if (error) {
      setMessage(error.message);
      return;
    }

    const matchingIds = new Set((data || []).map((row) => row.recipe_id));
    const matchingRecipes = allRecipes.filter((recipe) => matchingIds.has(recipe.id));

    if (matchingRecipes.length === 0) {
      renderEmpty(target, 'Pre tuto surovinu zatial nemame recept.');
      return;
    }

    target.innerHTML = matchingRecipes.map((recipe) => renderRecipeCard(recipe)).join('');
  });
}

function renderIngredients(ingredients) {
  const target = document.querySelector('#recipe-ingredients');
  currentIngredients = ingredients;

  if (ingredients.length === 0) {
    renderEmpty(target, 'Suroviny zatial nie su doplnene.');
    return;
  }

  const rows = ingredients
    .map(
      (ingredient) => {
        const state = getIngredientState(ingredient);
        const status = state.missing
          ? '<span class="ingredient-status missing">Chyba v inventari</span>'
          : state.aliasName
            ? `<span class="ingredient-status matched">Priradene ako ${escapeHtml(state.aliasName)}</span>`
            : `<span>${ingredient.optional ? 'Volitelne' : 'Povinne'}</span>`;

        return `
        <article class="data-row ingredient-row ${state.missing ? 'is-missing' : ''} ${state.aliasName ? 'is-matched' : ''}" data-ingredient-id="${escapeHtml(ingredient.id || '')}">
          <div>
            <strong>${escapeHtml(ingredient.name)}</strong>
            ${status}
          </div>
          <span>${escapeHtml(formatQuantity(ingredient))}</span>
        </article>
      `;
      },
    )
    .join('');

  const missingCount = getMissingIngredients().length;
  const addButton = missingCount > 0 && currentRecipeHousehold?.id
    ? `
      <button type="button" class="primary recipe-shopping-button" data-add-missing-shopping>
        Pridat chybajuce do nakupu (${missingCount})
      </button>
    `
    : '';

  target.innerHTML = `${rows}${addButton}`;
}

function renderIngredientMatcher() {
  let modal = document.querySelector('#ingredient-match-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ingredient-match-modal';
    modal.className = 'modal-backdrop';
    document.body.append(modal);
  }

  if (!selectedIngredient) {
    modal.hidden = true;
    modal.innerHTML = '';
    return;
  }

  const matches = findInventoryMatches(selectedIngredient.name);
  modal.hidden = false;
  modal.innerHTML = `
    <button type="button" class="modal-scrim" data-close-match aria-label="Zavriet"></button>
    <section class="modal-card">
      <p class="eyebrow">Priradenie suroviny</p>
      <h2>${escapeHtml(selectedIngredient.name)}</h2>
      <p class="lead compact">Vyber, ktora polozka v inventari zodpoveda tejto surovine.</p>
      <div class="match-list">
        ${
          matches.length
            ? matches.map((match) => `
              <button type="button" class="match-option" data-match-name="${escapeHtml(match.item.name)}">
                <span>
                  <strong>${escapeHtml(match.item.name)}</strong>
                  <small>${match.item.source === 'known' ? 'Pouzite v minulosti' : `Podobnost ${match.score}%`}</small>
                </span>
                <ion-icon name="checkmark-circle-outline"></ion-icon>
              </button>
            `).join('')
            : '<p class="empty-state">Nenasiel som blizke zhody v inventari.</p>'
        }
      </div>
      <button type="button" class="button-link" data-close-match>Zrusit</button>
    </section>
  `;
}

async function loadInventoryItemsForMatching() {
  if (!currentSession) return [];

  const { data: households, error: householdsError } = await supabase
    .from('households')
    .select('*')
    .order('created_at', { ascending: true });
  if (householdsError) throw householdsError;

  const activeHouseholdId = localStorage.getItem(ACTIVE_HOUSEHOLD_KEY);
  const household = (households || []).find((item) => item.id === activeHouseholdId) || households?.[0];
  currentRecipeHousehold = household || null;
  currentKnownItems = [];
  if (!household?.id) return [];

  try {
    const preferences = await loadItemPreferences({
      supabase,
      householdId: household.id,
      userId: currentSession?.user?.id,
    });
    currentKnownItems = [...preferences.itemPreferences.values()]
      .map((row) => String(row.display_name || row.normalized_name || '').trim())
      .filter(Boolean);
  } catch (error) {
    console.error('Recipe known item preferences load failed:', error);
  }

  const { data: list, error: listError } = await supabase
    .from('lists')
    .select('id')
    .eq('household_id', household.id)
    .eq('type', 'inventory')
    .order('is_default', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (listError) throw listError;
  if (!list?.id) return [];

  const { data, error } = await supabase
    .from('list_items')
    .select('id,name,quantity,unit,status')
    .eq('list_id', list.id)
    .eq('status', 'active');
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getDefaultShoppingList(householdId) {
  const { data: existing, error: existingError } = await supabase
    .from('lists')
    .select('id,type,name,is_default')
    .eq('household_id', householdId)
    .eq('type', 'shopping')
    .eq('is_default', true)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing;

  const { data: createdId, error: rpcError } = await supabase.rpc('get_or_create_default_list', {
    target_household_id: householdId,
    target_type: 'shopping',
  });

  if (rpcError) throw rpcError;

  return {
    id: createdId,
    type: 'shopping',
    name: 'Shopping',
    is_default: true,
  };
}

async function loadAllListItemsForHousehold(householdId) {
  const { data: lists, error: listsError } = await supabase
    .from('lists')
    .select('id')
    .eq('household_id', householdId);

  if (listsError) throw listsError;

  const listIds = (lists || []).map((list) => list.id);
  if (listIds.length === 0) return [];

  const { data, error } = await supabase
    .from('list_items')
    .select('name,list_id,status')
    .in('list_id', listIds)
    .neq('status', 'archived');

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function addMissingIngredientsToShopping() {
  if (!currentSession?.user?.id || !currentRecipeHousehold?.id) {
    setMessage('Najprv sa prihlas a vyber aktivnu domacnost.');
    return;
  }

  const missingIngredients = getMissingIngredients();
  if (missingIngredients.length === 0) return;

  const button = document.querySelector('[data-add-missing-shopping]');
  if (button) {
    button.disabled = true;
    button.textContent = 'Pridavam...';
  }

  try {
    const shoppingList = await getDefaultShoppingList(currentRecipeHousehold.id);
    const allHouseholdItems = await loadAllListItemsForHousehold(currentRecipeHousehold.id);

    for (const ingredient of missingIngredients) {
      const canonicalName = pickCanonicalDisplayName(ingredient.name, [allHouseholdItems]);
      const row = buildShoppingRow({
        listId: shoppingList.id,
        userId: currentSession.user.id,
        input: {
          clientItemId: getClientItemId(),
          quantity: ingredient.quantity ?? 1,
          unit: normalizeItemUnit(ingredient.unit || 'pcs'),
        },
        canonicalName,
        expiryDate: computeExpiryForName(canonicalName, { itemPreferences: new Map(), quickPreferences: new Map() }),
      });

      await upsertListItemWithMerge({
        supabase,
        listType: 'shopping',
        row,
        userId: currentSession.user.id,
      });
    }

    setMessage(`Chybajuce suroviny boli pridane do nakupneho zoznamu (${missingIngredients.length}).`);
  } catch (error) {
    setMessage(error.message || 'Nepodarilo sa pridat suroviny do nakupu.');
  } finally {
    renderIngredients(currentIngredients);
  }
}

function renderSteps(steps) {
  const target = document.querySelector('#recipe-steps');

  if (steps.length === 0) {
    target.innerHTML = '<li class="empty-state">Postup zatial nie je doplneny.</li>';
    return;
  }

  target.innerHTML = steps.map((step) => `<li>${step.instruction}</li>`).join('');
}

function updateSaveButton() {
  if (!currentSession || !currentRecipe) {
    saveButton.hidden = true;
    return;
  }

  saveButton.hidden = false;
  saveButton.textContent = currentSave ? 'Odlozit z mojich receptov' : 'Ulozit recept';
}

async function loadCurrentSave() {
  if (!currentSession || !recipeId) return null;

  const { data, error } = await supabase
    .from('recipe_saves')
    .select('recipe_id')
    .eq('user_id', currentSession.user.id)
    .eq('recipe_id', recipeId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

function renderRecipe(recipe, ingredients, steps) {
  currentRecipe = recipe;

  const image = recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?auto=format&fit=crop&w=1200&q=80';
  const totalTime = Number(recipe.prep_time_minutes || 0) + Number(recipe.cook_time_minutes || 0);
  const meta = [
    recipe.servings ? `${formatNumber(recipe.servings)} porcie` : null,
    recipe.prep_time_minutes ? `Priprava ${recipe.prep_time_minutes} min` : null,
    recipe.cook_time_minutes ? `Varenie ${recipe.cook_time_minutes} min` : null,
    totalTime ? `Spolu ${totalTime} min` : null,
    recipe.difficulty ? `Narocnost ${recipe.difficulty}` : null,
    currentRecipeHousehold ? `Domacnost: ${isPremiumRecord(currentRecipeHousehold) ? 'Premium' : 'Free'}` : null,
  ].filter(Boolean);

  document.querySelector('#recipe-image').src = image;
  document.querySelector('#recipe-status').textContent = recipe.is_published ? 'Publikovany recept' : 'Draft recept';
  document.querySelector('#recipe-title').textContent = recipe.title;
  document.querySelector('#recipe-description').textContent = recipe.description || 'Bez popisu.';
  document.querySelector('#recipe-meta').innerHTML = meta.map((item) => `<span>${item}</span>`).join('');

  renderIngredients(ingredients);
  renderSteps(steps);
  updateSaveButton();

  detail.hidden = false;
  setMessage('');
}

async function loadBrowse() {
  const recipes = await loadPublishedRecipes();
  const myRecipes = await loadMyRecipes(currentSession);
  renderBrowse(recipes, myRecipes);
  bindBrowseSearch(recipes);
}

async function loadRecipe() {
  const [{ data: recipe, error: recipeError }, { data: ingredients, error: ingredientsError }, { data: steps, error: stepsError }] =
    await Promise.all([
      supabase
        .from('recipes')
        .select('id,title,description,image_url,servings,prep_time_minutes,cook_time_minutes,difficulty,is_published,created_by_user_id')
        .eq('id', recipeId)
        .maybeSingle(),
      supabase
        .from('recipe_ingredients')
        .select('id,name,normalized_name,quantity,unit,optional,sort_order')
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
    setMessage(currentSession ? 'Recept sa nenasiel.' : 'Recept nie je publikovany alebo neexistuje.');
    return;
  }

  currentIngredientAliases = loadIngredientAliases(recipeId);
  currentUserIngredientAliases = loadUserIngredientAliases();
  currentInventoryItems = await loadInventoryItemsForMatching();
  currentSave = await loadCurrentSave();
  renderRecipe(recipe, ingredients || [], steps || []);
}

async function toggleSave() {
  if (!currentSession || !currentRecipe) return;

  saveButton.disabled = true;

  if (currentSave) {
    const { error } = await supabase
      .from('recipe_saves')
      .delete()
      .eq('user_id', currentSession.user.id)
      .eq('recipe_id', currentRecipe.id);

    if (error) {
      setMessage(error.message);
    } else {
      currentSave = null;
    }
  } else {
    const { data, error } = await supabase
      .from('recipe_saves')
      .insert({
        user_id: currentSession.user.id,
        recipe_id: currentRecipe.id,
      })
      .select('recipe_id')
      .single();

    if (error) {
      setMessage(error.message);
    } else {
      currentSave = data;
    }
  }

  saveButton.disabled = false;
  updateSaveButton();
}

async function init() {
  const session = await setupSessionUi();

  if (!hasSupabaseConfig()) return;

  try {
    if (recipeId) {
      await loadRecipe();
      return;
    }

    await loadBrowse(session);
  } catch (error) {
    setMessage(error.message);
  }
}

saveButton.addEventListener('click', toggleSave);

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-add-missing-shopping]')) {
    addMissingIngredientsToShopping();
    return;
  }

  const row = event.target.closest('.ingredient-row.is-missing');
  if (row && currentSession) {
    const ingredient = currentIngredients.find((item) => String(item.id) === String(row.dataset.ingredientId));
    if (ingredient) {
      selectedIngredient = ingredient;
      renderIngredientMatcher();
    }
    return;
  }

  if (event.target.closest('[data-close-match]')) {
    selectedIngredient = null;
    renderIngredientMatcher();
    return;
  }

  const option = event.target.closest('[data-match-name]');
  if (option && selectedIngredient) {
    saveIngredientAlias(selectedIngredient.id, option.dataset.matchName);
    selectedIngredient = null;
    renderIngredientMatcher();
    renderIngredients(currentIngredients);
  }
});

init();
