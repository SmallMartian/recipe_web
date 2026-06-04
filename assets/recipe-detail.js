import { hasSupabaseConfig, supabase } from './supabase-client.js';
import { getCurrentProfile, renderUserMenu } from './user-menu.js';
import {
  areUnitsCompatible,
  buildShoppingRow,
  computeExpiryForName,
  formatQuantityValue,
  loadItemPreferences,
  normalizeItemUnit,
  normalizeKeyName,
  normalizeQuantityToBaseUnit,
  pickCanonicalDisplayName,
  toQuantityNumber,
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
const savePremiumNote = document.querySelector('#save-recipe-premium-note');
const cookButton = document.querySelector('#cook-recipe-button');
const ACTIVE_HOUSEHOLD_KEY = 'recipe_web_active_household_id';
const INGREDIENT_ALIASES_KEY = 'recipe_web_recipe_ingredient_aliases_v1';
const INGREDIENT_USER_ALIASES_KEY = 'recipe_web_recipe_ingredient_user_aliases_v1';

const RECIPE_CATEGORIES = [
  { slug: 'breakfast', name: 'Ranajky' },
  { slug: 'soup', name: 'Polievky' },
  { slug: 'main', name: 'Hlavne jedla' },
  { slug: 'side', name: 'Prilohy' },
  { slug: 'salad', name: 'Salaty' },
  { slug: 'pasta', name: 'Cestoviny' },
  { slug: 'rice', name: 'Ryza' },
  { slug: 'meat', name: 'Maso' },
  { slug: 'fish', name: 'Ryby' },
  { slug: 'vegetarian', name: 'Bezmasite' },
  { slug: 'vegan', name: 'Veganske' },
  { slug: 'sweet', name: 'Sladke' },
  { slug: 'dessert', name: 'Dezerty' },
  { slug: 'baking', name: 'Pecenie' },
  { slug: 'quick', name: 'Rychle' },
  { slug: 'healthy', name: 'Zdrave' },
  { slug: 'kids', name: 'Pre deti' },
  { slug: 'drink', name: 'Napoje' },
];

let currentSession = null;
let currentProfile = null;
let currentRecipe = null;
let currentSave = null;
let currentIngredients = [];
let currentSteps = [];
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

function nullableText(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed : null;
}

function nullableNumber(value) {
  const trimmed = String(value ?? '').trim().replace(',', '.');
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function nullableInteger(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const number = Number.parseInt(trimmed, 10);
  return Number.isFinite(number) ? number : null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isCurrentRecipeOwner() {
  return Boolean(
    currentSession?.user?.id &&
    currentRecipe?.created_by_user_id &&
    String(currentRecipe.created_by_user_id) === String(currentSession.user.id),
  );
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
    currentProfile = await getCurrentProfile(currentSession);
    renderUserMenu({ profile: currentProfile, user: currentSession.user });
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
  const addButton = canUseRecipe() && missingCount > 0 && currentRecipeHousehold?.id
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
    .select('id,list_id,name,quantity,unit,expiry_date,status')
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

async function consumeInventoryByName(items, name, amount, unit) {
  const normalizedName = normalizeKeyName(name);
  const normalizedAmount = toQuantityNumber(amount, NaN);
  const normalizedUnit = normalizeItemUnit(unit);

  if (!normalizedName || !Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    return { changed: false, nextItems: items };
  }

  const targetBase = normalizeQuantityToBaseUnit(normalizedAmount, normalizedUnit);
  let remainingToConsume = toQuantityNumber(targetBase.quantity, NaN);
  if (!Number.isFinite(remainingToConsume) || remainingToConsume <= 0) {
    return { changed: false, nextItems: items };
  }

  const candidates = (items || [])
    .filter((item) => normalizeKeyName(item.name) === normalizedName)
    .filter((item) => areUnitsCompatible(item.unit, targetBase.unit))
    .sort((a, b) => new Date(a.expiry_date || '9999-12-31') - new Date(b.expiry_date || '9999-12-31'));

  if (candidates.length === 0) {
    return { changed: false, nextItems: items };
  }

  const updates = [];
  const deletes = [];

  for (const item of candidates) {
    if (remainingToConsume <= 0) break;

    const itemBase = normalizeQuantityToBaseUnit(item.quantity, item.unit);
    const currentQuantity = toQuantityNumber(itemBase.quantity, NaN);
    if (!Number.isFinite(currentQuantity) || currentQuantity <= 0) {
      deletes.push(item.id);
      continue;
    }

    const consumed = Math.min(currentQuantity, remainingToConsume);
    remainingToConsume -= consumed;
    const nextQuantity = currentQuantity - consumed;

    if (nextQuantity <= 0) {
      deletes.push(item.id);
    } else {
      updates.push({
        id: item.id,
        quantity: toQuantityNumber(formatQuantityValue(nextQuantity), nextQuantity),
        unit: itemBase.unit,
      });
    }
  }

  for (const update of updates) {
    const { error } = await supabase
      .from('list_items')
      .update({
        quantity: update.quantity,
        unit: update.unit,
        updated_by: currentSession.user.id,
      })
      .eq('id', update.id);

    if (error) throw error;
  }

  if (deletes.length > 0) {
    const { error } = await supabase.from('list_items').delete().in('id', deletes);
    if (error) throw error;
  }

  const changedIds = new Set([...updates.map((item) => item.id), ...deletes]);
  const nextItems = (items || [])
    .map((item) => {
      const update = updates.find((entry) => entry.id === item.id);
      return update ? { ...item, quantity: update.quantity, unit: update.unit } : item;
    })
    .filter((item) => !deletes.includes(item.id));

  return { changed: changedIds.size > 0, nextItems };
}

async function cookRecipe() {
  if (!canUseRecipe() || !currentRecipe || !currentSession) return;

  cookButton.disabled = true;
  cookButton.textContent = 'Odpisujem...';

  try {
    let nextItems = currentInventoryItems;
    const consumed = [];

    for (const ingredient of currentIngredients) {
      const quantity = ingredient.quantity ?? 1;
      const unit = normalizeItemUnit(ingredient.unit || 'pcs');
      const aliasName = getIngredientAlias(ingredient);
      const targetName = aliasName || ingredient.name;

      const result = await consumeInventoryByName(nextItems, targetName, quantity, unit);
      nextItems = result.nextItems;
      if (result.changed) consumed.push(targetName);
    }

    currentInventoryItems = nextItems;
    renderIngredients(currentIngredients);
    setMessage(
      consumed.length > 0
        ? 'Spotrebovane suroviny boli odpocitane zo zasob.'
        : 'V zasobach nebola ziadna odpocitatelna surovina.',
    );
  } catch (error) {
    setMessage(error.message || 'Nepodarilo sa odpocitat zasoby.');
  } finally {
    updateCookButton();
  }
}

function renderSteps(steps) {
  const target = document.querySelector('#recipe-steps');
  currentSteps = Array.isArray(steps) ? steps : [];

  if (currentSteps.length === 0) {
    target.innerHTML = '<li class="empty-state">Postup zatial nie je doplneny.</li>';
    return;
  }

  target.innerHTML = currentSteps
    .map((step, index) => `<div class="step-display-row"><strong>${index + 1}.</strong> ${escapeHtml(step.instruction)}</div>`)
    .join('');
}

function updateSaveButton() {
  if (!currentSession || !currentRecipe) {
    saveButton.hidden = true;
    if (savePremiumNote) savePremiumNote.hidden = true;
    return;
  }

  const isOwner = String(currentRecipe.created_by_user_id || '') === String(currentSession.user.id || '');
  if (isOwner) {
    saveButton.hidden = true;
    if (savePremiumNote) savePremiumNote.hidden = true;
    return;
  }

  saveButton.hidden = false;
  saveButton.disabled = false;
  if (savePremiumNote) savePremiumNote.hidden = true;

  if (currentSave) {
    saveButton.textContent = 'Odlozit z mojich receptov';
    saveButton.title = '';
    return;
  }

  saveButton.textContent = 'Ulozit do mojich receptov';
  if (!isPremiumRecord(currentProfile)) {
    saveButton.disabled = true;
    saveButton.title = 'Ukladanie komunitnych receptov vyzaduje Premium ucet.';
    if (savePremiumNote) savePremiumNote.hidden = false;
  } else {
    saveButton.title = '';
  }
}

function canUseRecipe() {
  if (!currentSession || !currentRecipe) return false;
  const isOwner = String(currentRecipe.created_by_user_id || '') === String(currentSession.user.id || '');
  return Boolean(isOwner || (currentSave && isPremiumRecord(currentProfile)));
}

function updateCookButton() {
  if (!cookButton) return;
  cookButton.hidden = !canUseRecipe();
  cookButton.disabled = false;
  cookButton.textContent = 'Uvarene';
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

function updateEditButtons() {
  const isOwner = isCurrentRecipeOwner();
  document.querySelectorAll('[data-edit-section]').forEach((button) => {
    button.hidden = !isOwner;
  });
}

function getRecipeCategorySlugs() {
  return (Array.isArray(currentRecipe?.recipe_categories) ? currentRecipe.recipe_categories : [])
    .map((entry) => entry.categories?.slug || entry.category?.slug || entry.slug)
    .filter(Boolean);
}

async function saveRecipeCategories(recipeIdValue, slugs) {
  const { error: deleteError } = await supabase.from('recipe_categories').delete().eq('recipe_id', recipeIdValue);
  if (deleteError) throw deleteError;

  const selected = RECIPE_CATEGORIES
    .filter((category) => slugs.includes(category.slug))
    .map((category) => ({ slug: category.slug, name: category.name }));

  if (selected.length === 0) return;

  const { data: categories, error: categoriesError } = await supabase
    .from('categories')
    .upsert(selected, { onConflict: 'slug' })
    .select('id,slug');
  if (categoriesError) throw categoriesError;

  const links = (categories || []).map((category) => ({
    recipe_id: recipeIdValue,
    category_id: category.id,
  }));
  if (links.length > 0) {
    const { error } = await supabase.from('recipe_categories').insert(links);
    if (error) throw error;
  }
}

function renderBasicEditor() {
  if (!isCurrentRecipeOwner()) return;

  const target = document.querySelector('#recipe-basic-editor');
  const selectedSlugs = new Set(getRecipeCategorySlugs());
  target.hidden = false;
  target.innerHTML = `
    <form class="section-editor" data-basic-editor>
      <div class="editor-grid">
        <label><span>Nazov</span><input name="title" value="${escapeHtml(currentRecipe.title || '')}" required /></label>
        <label><span>Obrazok URL</span><input name="image_url" value="${escapeHtml(currentRecipe.image_url || '')}" /></label>
        <label><span>Porcie</span><input name="servings" type="number" step="0.01" value="${escapeHtml(currentRecipe.servings ?? '')}" /></label>
        <label><span>Priprava min</span><input name="prep_time_minutes" type="number" step="1" value="${escapeHtml(currentRecipe.prep_time_minutes ?? '')}" /></label>
        <label><span>Varenie min</span><input name="cook_time_minutes" type="number" step="1" value="${escapeHtml(currentRecipe.cook_time_minutes ?? '')}" /></label>
        <label><span>Narocnost</span>
          <select name="difficulty">
            <option value="">Nezadane</option>
            ${['easy', 'medium', 'hard'].map((value) => `
              <option value="${value}" ${currentRecipe.difficulty === value ? 'selected' : ''}>${value}</option>
            `).join('')}
          </select>
        </label>
      </div>
      <label><span>Popis</span><textarea name="description" rows="3">${escapeHtml(currentRecipe.description || '')}</textarea></label>
      <div class="field-block">
        <span class="field-label">Kategorie</span>
        <div class="chip-grid">
          ${RECIPE_CATEGORIES.map((category) => `
            <label class="chip-check">
              <input type="checkbox" name="category_slugs" value="${category.slug}" ${selectedSlugs.has(category.slug) ? 'checked' : ''} />
              <span>${category.name}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="editor-actions">
        <button type="button" class="button-link" data-cancel-edit>Zrusit</button>
        <button type="submit" class="primary">Ulozit zaklad</button>
      </div>
    </form>
  `;
}

function renderIngredientsEditor() {
  if (!isCurrentRecipeOwner()) return;

  const target = document.querySelector('#recipe-ingredients');
  const rows = currentIngredients.length ? currentIngredients : [{ name: '', quantity: '', unit: '', optional: false, sort_order: 0 }];
  target.innerHTML = `
    <form class="section-editor" data-ingredients-editor>
      <div data-ingredient-edit-list>
        ${rows.map((ingredient, index) => renderIngredientEditRow(ingredient, index)).join('')}
      </div>
      <button type="button" class="button-link primary" data-add-edit-ingredient>Pridat surovinu</button>
      <div class="editor-actions">
        <button type="button" class="button-link" data-cancel-edit>Zrusit</button>
        <button type="submit" class="primary">Ulozit suroviny</button>
      </div>
    </form>
  `;
}

function renderIngredientEditRow(ingredient = {}, index = 0) {
  return `
    <div class="edit-row">
      <label><span>Nazov</span><input name="ingredient_name" value="${escapeHtml(ingredient.name || '')}" /></label>
      <label><span>Mnozstvo</span><input name="ingredient_quantity" type="number" step="0.01" value="${escapeHtml(ingredient.quantity ?? '')}" /></label>
      <label><span>Jednotka</span><input name="ingredient_unit" value="${escapeHtml(ingredient.unit || '')}" /></label>
      <label class="check-row"><input name="ingredient_optional" type="checkbox" ${ingredient.optional ? 'checked' : ''} /><span>Volitelne</span></label>
      <input name="ingredient_sort_order" type="hidden" value="${escapeHtml(ingredient.sort_order ?? index)}" />
      <button type="button" class="remove" data-remove-edit-row>X</button>
    </div>
  `;
}

function renderStepsEditor() {
  if (!isCurrentRecipeOwner()) return;

  const target = document.querySelector('#recipe-steps');
  const rows = currentSteps.length ? currentSteps : [{ instruction: '', sort_order: 0 }];
  target.innerHTML = `
    <form class="section-editor" data-steps-editor>
      <div data-step-edit-list>
        ${rows.map((step, index) => renderStepEditRow(step, index)).join('')}
      </div>
      <button type="button" class="button-link primary" data-add-edit-step>Pridat krok</button>
      <div class="editor-actions">
        <button type="button" class="button-link" data-cancel-edit>Zrusit</button>
        <button type="submit" class="primary">Ulozit postup</button>
      </div>
    </form>
  `;
}

function renderStepEditRow(step = {}, index = 0) {
  return `
    <div class="step-edit-row">
      <label><span>Instrukcia</span><textarea name="step_instruction" rows="2">${escapeHtml(step.instruction || '')}</textarea></label>
      <input name="step_sort_order" type="hidden" value="${escapeHtml(step.sort_order ?? index)}" />
      <button type="button" class="remove" data-remove-edit-row>X</button>
    </div>
  `;
}

async function saveBasicEditor(form) {
  const data = new FormData(form);
  const title = String(data.get('title') || '').trim();
  if (!title) {
    setMessage('Recept potrebuje nazov.');
    return;
  }

  const row = {
    title,
    description: nullableText(data.get('description')),
    image_url: nullableText(data.get('image_url')),
    servings: nullableNumber(data.get('servings')),
    prep_time_minutes: nullableInteger(data.get('prep_time_minutes')),
    cook_time_minutes: nullableInteger(data.get('cook_time_minutes')),
    difficulty: nullableText(data.get('difficulty')),
  };
  const slugs = [...new Set(data.getAll('category_slugs').map((value) => String(value || '').trim()).filter(Boolean))];

  const { error } = await supabase.from('recipes').update(row).eq('id', recipeId).eq('created_by_user_id', currentSession.user.id);
  if (error) throw error;
  await saveRecipeCategories(recipeId, slugs);
  await loadRecipe();
  setMessage('Zaklad receptu je ulozeny.');
}

async function saveIngredientsEditor(form) {
  const rows = [...form.querySelectorAll('.edit-row')]
    .map((row, index) => {
      const name = row.querySelector('[name="ingredient_name"]').value.trim();
      if (!name) return null;
      return {
        recipe_id: recipeId,
        name,
        normalized_name: normalizeIngredientName(name),
        quantity: nullableNumber(row.querySelector('[name="ingredient_quantity"]').value),
        unit: nullableText(row.querySelector('[name="ingredient_unit"]').value),
        optional: row.querySelector('[name="ingredient_optional"]').checked,
        sort_order: index,
      };
    })
    .filter(Boolean);

  const { error: deleteError } = await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipeId);
  if (deleteError) throw deleteError;
  if (rows.length > 0) {
    const { error } = await supabase.from('recipe_ingredients').insert(rows);
    if (error) throw error;
  }

  await loadRecipe();
  setMessage('Suroviny su ulozene.');
}

async function saveStepsEditor(form) {
  const rows = [...form.querySelectorAll('.step-edit-row')]
    .map((row, index) => {
      const instruction = row.querySelector('[name="step_instruction"]').value.trim();
      if (!instruction) return null;
      return {
        recipe_id: recipeId,
        instruction,
        sort_order: index,
      };
    })
    .filter(Boolean);

  const { error: deleteError } = await supabase.from('recipe_steps').delete().eq('recipe_id', recipeId);
  if (deleteError) throw deleteError;
  if (rows.length > 0) {
    const { error } = await supabase.from('recipe_steps').insert(rows);
    if (error) throw error;
  }

  await loadRecipe();
  setMessage('Postup je ulozeny.');
}

function renderRecipe(recipe, ingredients, steps) {
  currentRecipe = recipe;
  const basicEditor = document.querySelector('#recipe-basic-editor');
  if (basicEditor) {
    basicEditor.hidden = true;
    basicEditor.innerHTML = '';
  }

  const image = recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?auto=format&fit=crop&w=1200&q=80';
  const meta = [
    recipe.servings ? `${formatNumber(recipe.servings)} porcie` : null,
    recipe.prep_time_minutes ? `Priprava ${recipe.prep_time_minutes} min` : null,
    recipe.cook_time_minutes ? `Varenie ${recipe.cook_time_minutes} min` : null,
    recipe.difficulty ? `Narocnost ${recipe.difficulty}` : null,
  ].filter(Boolean);

  document.querySelector('#recipe-image').src = image;
  document.querySelector('#recipe-status').textContent = recipe.is_published ? 'Publikovany recept' : 'Draft recept';
  document.querySelector('#recipe-title').textContent = recipe.title;
  document.querySelector('#recipe-description').textContent = recipe.description || 'Bez popisu.';
  document.querySelector('#recipe-meta').innerHTML = meta.map((item) => `<span>${item}</span>`).join('');

  renderIngredients(ingredients);
  renderSteps(steps);
  updateSaveButton();
  updateCookButton();
  updateEditButtons();

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
        .select('id,title,description,image_url,servings,prep_time_minutes,cook_time_minutes,difficulty,is_published,created_by_user_id,recipe_categories(category_id,categories(id,name,slug))')
        .eq('id', recipeId)
        .maybeSingle(),
      supabase
        .from('recipe_ingredients')
        .select('id,name,normalized_name,quantity,unit,optional,sort_order')
        .eq('recipe_id', recipeId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('recipe_steps')
        .select('id,instruction,sort_order')
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

  const isOwner = String(currentRecipe.created_by_user_id || '') === String(currentSession.user.id || '');
  if (isOwner) return;

  if (!currentSave && !isPremiumRecord(currentProfile)) {
    setMessage('Ukladanie komunitnych receptov vyzaduje Premium ucet.');
    updateSaveButton();
    return;
  }

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
  updateCookButton();
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
cookButton?.addEventListener('click', cookRecipe);

document.addEventListener('click', (event) => {
  const editButton = event.target.closest('[data-edit-section]');
  if (editButton) {
    const section = editButton.dataset.editSection;
    if (section === 'basic') renderBasicEditor();
    if (section === 'ingredients') renderIngredientsEditor();
    if (section === 'steps') renderStepsEditor();
    return;
  }

  if (event.target.closest('[data-cancel-edit]')) {
    const basicEditor = document.querySelector('#recipe-basic-editor');
    if (basicEditor) {
      basicEditor.hidden = true;
      basicEditor.innerHTML = '';
    }
    renderIngredients(currentIngredients);
    renderSteps(currentSteps);
    return;
  }

  if (event.target.closest('[data-add-edit-ingredient]')) {
    const list = document.querySelector('[data-ingredient-edit-list]');
    if (list) list.insertAdjacentHTML('beforeend', renderIngredientEditRow({}, list.children.length));
    return;
  }

  if (event.target.closest('[data-add-edit-step]')) {
    const list = document.querySelector('[data-step-edit-list]');
    if (list) list.insertAdjacentHTML('beforeend', renderStepEditRow({}, list.children.length));
    return;
  }

  const removeButton = event.target.closest('[data-remove-edit-row]');
  if (removeButton) {
    removeButton.closest('.edit-row, .step-edit-row')?.remove();
    return;
  }

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

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!form.matches('[data-basic-editor], [data-ingredients-editor], [data-steps-editor]')) return;

  event.preventDefault();
  if (!isCurrentRecipeOwner()) return;

  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;

  try {
    if (form.matches('[data-basic-editor]')) await saveBasicEditor(form);
    if (form.matches('[data-ingredients-editor]')) await saveIngredientsEditor(form);
    if (form.matches('[data-steps-editor]')) await saveStepsEditor(form);
  } catch (error) {
    setMessage(error.message || 'Uprava receptu zlyhala.');
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

init();
