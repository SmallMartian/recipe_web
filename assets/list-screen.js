import { hasSupabaseConfig, supabase } from './supabase-client.js';
import { setupUserMenu } from './user-menu.js';
import {
  buildInventoryRow,
  buildShoppingRow,
  computeExpiryForName,
  getSuggestedDefaults,
  loadItemPreferences,
  normalizeItemUnit,
  pickCanonicalDisplayName,
  upsertItemPreferenceEverywhere,
  upsertListItemWithMerge,
  upsertQuickPreference,
} from './basil-item-logic.js';

const ACTIVE_HOUSEHOLD_KEY = 'recipe_web_active_household_id';
const main = document.querySelector('.list-screen');
const listType = main?.dataset.listType || 'inventory';
const householdSelect = document.querySelector('#list-household-select');
const form = document.querySelector('#list-item-form');
const itemsTarget = document.querySelector('#list-items');
const statusLine = document.querySelector('#list-status');
const refreshButton = document.querySelector('#refresh-list');
const sortSelect = document.querySelector('#list-sort');
const params = new URLSearchParams(window.location.search);

let currentSession = null;
let currentList = null;
let currentSort = listType === 'inventory' && params.get('sort') === 'expiry' ? 'expiry' : 'updated';
let currentHouseholdId = null;
let currentPreferences = { itemPreferences: new Map(), quickPreferences: new Map() };

function setStatus(value) {
  statusLine.textContent = value || '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function nullableNumber(value) {
  if (String(value || '').trim() === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function formatQuantity(item) {
  const quantity = Number(item.quantity);
  const shown = Number.isFinite(quantity) ? Number.parseFloat(quantity.toFixed(3)) : item.quantity;
  return `${shown} ${item.unit || ''}`.trim();
}

function getClientItemId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `web_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getFormName() {
  return String(form.elements.name?.value || '').trim();
}

function setFieldIfUseful(fieldName, value, shouldReplace) {
  const field = form.elements[fieldName];
  if (!field || value == null || value === '') return;

  if (shouldReplace(field.value)) {
    field.value = value;
  }
}

function applySuggestedDefaults({ force = false } = {}) {
  const name = getFormName();
  if (!name) return;

  const defaults = getSuggestedDefaults({
    name,
    listType,
    preferences: currentPreferences,
  });

  setFieldIfUseful('unit', defaults.unit, (value) => force || !value || normalizeItemUnit(value) === 'pcs');
  setFieldIfUseful('quantity', defaults.quantity, (value) => force || !value || Number(value) === 1);

  if (listType === 'inventory') {
    setFieldIfUseful('expiry_date', defaults.expiryDate, (value) => force || !value);
    setFieldIfUseful('min_stock', defaults.minStock, (value) => force || !value);
  }
}

async function loadHouseholds() {
  const { data, error } = await supabase
    .from('households')
    .select('id,name,created_at')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getDefaultList(householdId) {
  const { data: existing, error: existingError } = await supabase
    .from('lists')
    .select('id,type,name,is_default')
    .eq('household_id', householdId)
    .eq('type', listType)
    .order('is_default', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing;

  const { data: createdId, error: rpcError } = await supabase.rpc('get_or_create_default_list', {
    target_household_id: householdId,
    target_type: listType,
  });

  if (rpcError) throw rpcError;

  return {
    id: createdId,
    type: listType,
    name: listType === 'inventory' ? 'Inventory' : 'Shopping',
    is_default: true,
  };
}

async function loadItems() {
  if (!currentList?.id) return [];

  const query = supabase
    .from('list_items')
    .select('id,client_item_id,name,quantity,unit,expiry_date,min_stock,status,updated_at')
    .eq('list_id', currentList.id);

  if (listType === 'inventory') {
    query.eq('status', 'active');
  } else {
    query.neq('status', 'archived');
  }

  if (listType === 'inventory' && currentSort === 'expiry') {
    query.order('expiry_date', { ascending: true, nullsFirst: false }).order('updated_at', { ascending: false });
  } else {
    query.order('updated_at', { ascending: false });
  }

  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadAllListItemsForHousehold(householdId) {
  const { data: lists, error: listsError } = await supabase
    .from('lists')
    .select('id,type')
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

function renderItems(items) {
  if (items.length === 0) {
    itemsTarget.innerHTML = `<p class="empty-state">${listType === 'inventory' ? 'Inventar je prazdny.' : 'Nakupny zoznam je prazdny.'}</p>`;
    return;
  }

  itemsTarget.innerHTML = items
    .map((item) => {
      const checked = item.status === 'checked';
      const detailParts = [
        listType === 'inventory' && item.expiry_date ? `Expiracia ${item.expiry_date}` : '',
        listType === 'inventory' && item.min_stock !== null ? `Minimum ${item.min_stock}` : '',
        listType === 'shopping' && checked ? 'Vybavene' : '',
      ].filter(Boolean);

      return `
        <article class="item-row ${checked ? 'is-checked' : ''}" data-item-id="${escapeHtml(item.id)}">
          <div class="item-main">
            ${
              listType === 'shopping'
                ? `<input type="checkbox" data-action="toggle" ${checked ? 'checked' : ''} aria-label="Vybavene" />`
                : ''
            }
            <div>
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(detailParts.join(' · '))}</span>
            </div>
          </div>
          <div class="item-actions">
            <span class="qty-chip">${escapeHtml(formatQuantity(item))}</span>
            <button type="button" class="remove" data-action="delete">Zmazat</button>
          </div>
        </article>
      `;
    })
    .join('');
}

async function refreshItems() {
  setStatus('Nacitavam...');
  const items = await loadItems();
  renderItems(items);
  setStatus(listType === 'inventory' && currentSort === 'expiry' ? 'Zoradene podla najblizsej expiracie.' : '');
}

async function setHousehold(householdId) {
  if (!householdId) return;
  localStorage.setItem(ACTIVE_HOUSEHOLD_KEY, householdId);
  currentHouseholdId = householdId;
  currentList = await getDefaultList(householdId);
  currentPreferences = await loadItemPreferences({
    supabase,
    householdId,
    userId: currentSession?.user?.id,
  });
  applySuggestedDefaults({ force: true });
  await refreshItems();
}

async function addItem(event) {
  event.preventDefault();

  if (!currentList?.id || !currentSession?.user?.id) {
    setStatus('Chyba aktivnej domacnosti alebo prihlasenia.');
    return;
  }

  const data = new FormData(form);
  const name = String(data.get('name') || '').trim();
  const quantity = nullableNumber(data.get('quantity')) ?? 1;
  const unit = normalizeItemUnit(data.get('unit') || 'pcs');

  if (!name) return;

  const allHouseholdItems = await loadAllListItemsForHousehold(currentHouseholdId);
  const canonicalName = pickCanonicalDisplayName(name, [allHouseholdItems]);
  const input = {
    clientItemId: getClientItemId(),
    quantity,
    unit,
    expiryDate: data.get('expiry_date') || computeExpiryForName(name, currentPreferences),
    minStock: nullableNumber(data.get('min_stock')),
  };

  let row;
  if (listType === 'inventory') {
    row = buildInventoryRow({
      listId: currentList.id,
      userId: currentSession.user.id,
      input,
      canonicalName,
    });
  } else {
    row = buildShoppingRow({
      listId: currentList.id,
      userId: currentSession.user.id,
      input,
      canonicalName,
      expiryDate: computeExpiryForName(name, currentPreferences),
    });
  }

  setStatus('Ukladam...');
  try {
    await upsertListItemWithMerge({
      supabase,
      listType,
      row,
      userId: currentSession.user.id,
    });

    await upsertItemPreferenceEverywhere({
      supabase,
      householdId: currentHouseholdId,
      userId: currentSession.user.id,
      name: canonicalName,
      unit,
      expiryDate: listType === 'inventory' ? row.expiry_date : row.expiry_date,
      minStock: listType === 'inventory' ? row.min_stock : null,
    });

    if (listType === 'shopping') {
      await upsertQuickPreference({
        supabase,
        householdId: currentHouseholdId,
        userId: currentSession.user.id,
        name: canonicalName,
        quantity: row.quantity,
        unit: row.unit,
      });
    }
  } catch (error) {
    setStatus(error.message);
    return;
  }

  form.reset();
  form.elements.quantity.value = '1';
  currentPreferences = await loadItemPreferences({
    supabase,
    householdId: currentHouseholdId,
    userId: currentSession.user.id,
  });
  await refreshItems();
}

async function handleItemAction(event) {
  const action = event.target.dataset.action;
  if (!action) return;

  const row = event.target.closest('[data-item-id]');
  const itemId = row?.dataset.itemId;
  if (!itemId) return;

  if (action === 'toggle' && event.type === 'change') {
    const status = event.target.checked ? 'checked' : 'active';
    const { error } = await supabase
      .from('list_items')
      .update({ status, updated_by: currentSession.user.id })
      .eq('id', itemId);

    if (error) {
      setStatus(error.message);
      return;
    }

    await refreshItems();
  }

  if (action === 'delete' && event.type === 'click') {
    const { error } = await supabase.from('list_items').delete().eq('id', itemId);

    if (error) {
      setStatus(error.message);
      return;
    }

    await refreshItems();
  }
}

async function init() {
  if (!hasSupabaseConfig()) {
    setStatus('Chyba Supabase URL alebo anon key.');
    return;
  }

  const setup = await setupUserMenu();
  if (!setup?.session) {
    window.location.href = '/login';
    return;
  }

  currentSession = setup.session;

  try {
    const households = await loadHouseholds();

    if (households.length === 0) {
      householdSelect.innerHTML = '<option>Ziadna domacnost</option>';
      setStatus('Zatial nemas dostupnu domacnost.');
      return;
    }

    householdSelect.innerHTML = households
      .map((household) => `<option value="${escapeHtml(household.id)}">${escapeHtml(household.name)}</option>`)
      .join('');

    const storedActiveId = localStorage.getItem(ACTIVE_HOUSEHOLD_KEY);
    const activeHousehold = households.find((household) => household.id === storedActiveId) || households[0];
    householdSelect.value = activeHousehold.id;
    if (sortSelect) {
      sortSelect.value = currentSort;
    }
    await setHousehold(activeHousehold.id);
  } catch (error) {
    setStatus(error.message);
  }
}

householdSelect.addEventListener('change', () => setHousehold(householdSelect.value));
form.elements.name?.addEventListener('change', () => applySuggestedDefaults({ force: false }));
form.elements.name?.addEventListener('blur', () => applySuggestedDefaults({ force: false }));
form.addEventListener('submit', addItem);
itemsTarget.addEventListener('click', handleItemAction);
itemsTarget.addEventListener('change', handleItemAction);
refreshButton.addEventListener('click', refreshItems);
sortSelect?.addEventListener('change', () => {
  currentSort = sortSelect.value;
  const url = new URL(window.location.href);

  if (currentSort === 'expiry') {
    url.searchParams.set('sort', 'expiry');
  } else {
    url.searchParams.delete('sort');
  }

  window.history.replaceState({}, '', url);
  refreshItems();
});

init();
