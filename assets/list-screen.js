import { hasSupabaseConfig, supabase } from './supabase-client.js';
import { setupUserMenu } from './user-menu.js';
import {
  areUnitsCompatible,
  buildInventoryRow,
  buildShoppingRow,
  computeExpiryForName,
  formatQuantityValue,
  getSuggestedDefaults,
  loadItemPreferences,
  normalizeQuantityToBaseUnit,
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
const detailModal = document.createElement('div');
const shoppingCompleteWrap = document.createElement('div');
const shoppingCompleteButton = document.createElement('button');

let currentSession = null;
let currentList = null;
let currentSort = listType === 'inventory' && params.get('sort') === 'expiry' ? 'expiry' : 'updated';
let currentHouseholdId = null;
let currentPreferences = { itemPreferences: new Map(), quickPreferences: new Map() };
let listRealtimeChannel = null;
let currentItems = [];
let activeGroupKey = null;

detailModal.className = 'modal-backdrop list-detail-modal';
detailModal.hidden = true;
detailModal.innerHTML = `
  <button type="button" class="modal-scrim" data-action="close-detail" aria-label="Zavriet"></button>
  <section class="modal-card list-detail-card" role="dialog" aria-modal="true" aria-labelledby="list-detail-title">
    <div id="list-detail-content"></div>
  </section>
`;
document.body.append(detailModal);
const detailContent = detailModal.querySelector('#list-detail-content');

if (listType === 'shopping') {
  shoppingCompleteWrap.className = 'shopping-complete-wrap';
  shoppingCompleteButton.type = 'button';
  shoppingCompleteButton.id = 'complete-shopping';
  shoppingCompleteButton.className = 'primary complete-shopping-button';
  shoppingCompleteButton.textContent = 'Nakupene';
  shoppingCompleteButton.disabled = true;
  shoppingCompleteWrap.append(shoppingCompleteButton);
  itemsTarget.insertAdjacentElement('afterend', shoppingCompleteWrap);
}

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

function normalizeKeyName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function quantityNumber(value) {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

const UNIT_META = {
  pcs: { family: 'count', factor: 1 },
  l: { family: 'volume', factor: 1000 },
  ml: { family: 'volume', factor: 1 },
  kg: { family: 'mass', factor: 1000 },
  dkg: { family: 'mass', factor: 10 },
  g: { family: 'mass', factor: 1 },
};

function unitsCompatible(left, right) {
  return UNIT_META[normalizeItemUnit(left)]?.family === UNIT_META[normalizeItemUnit(right)]?.family;
}

function convertQuantity(quantity, fromUnit, toUnit) {
  const from = UNIT_META[normalizeItemUnit(fromUnit)] || UNIT_META.pcs;
  const to = UNIT_META[normalizeItemUnit(toUnit)] || UNIT_META.pcs;
  const numeric = quantityNumber(quantity);
  if (from.family !== to.family) return numeric;
  return (numeric * from.factor) / to.factor;
}

function getBaseUnitForUnit(unit) {
  const family = UNIT_META[normalizeItemUnit(unit)]?.family || 'count';
  if (family === 'volume') return 'ml';
  if (family === 'mass') return 'g';
  return 'pcs';
}

function getQuickConsumeOptions(unit) {
  const family = UNIT_META[normalizeItemUnit(unit)]?.family || 'count';

  if (family === 'volume') {
    return [
      { quantity: 200, unit: 'ml' },
      { quantity: 500, unit: 'ml' },
    ];
  }

  if (family === 'mass') {
    return [
      { quantity: 100, unit: 'g' },
      { quantity: 250, unit: 'g' },
    ];
  }

  return [
    { quantity: 1, unit: 'pcs' },
    { quantity: 2, unit: 'pcs' },
  ];
}

function groupListItems(items) {
  const groups = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const key = normalizeKeyName(item.name);
    if (!key) continue;

    const group = groups.get(key) || {
      key,
      name: item.name,
      unit: item.unit || 'pcs',
      quantity: 0,
      min_stock: item.min_stock,
      expiry_date: item.expiry_date || null,
      status: item.status,
      updated_at: item.updated_at,
      items: [],
    };

    group.items.push(item);
    group.quantity += unitsCompatible(item.unit, group.unit)
      ? convertQuantity(item.quantity, item.unit, group.unit)
      : quantityNumber(item.quantity);
    group.min_stock = group.min_stock ?? item.min_stock ?? null;

    if (listType === 'inventory' && item.expiry_date) {
      if (!group.expiry_date || item.expiry_date < group.expiry_date) {
        group.expiry_date = item.expiry_date;
      }
    }

    if (item.status === 'active') group.status = 'active';
    else if (item.status === 'checked' && group.status !== 'active') group.status = 'checked';

    if (!group.updated_at || String(item.updated_at || '') > String(group.updated_at || '')) {
      group.updated_at = item.updated_at;
    }

    groups.set(key, group);
  }

  const grouped = [...groups.values()];
  if (listType === 'inventory' && currentSort === 'expiry') {
    return grouped.sort((a, b) => {
      const expiryA = a.expiry_date || '9999-12-31';
      const expiryB = b.expiry_date || '9999-12-31';
      return expiryA.localeCompare(expiryB) || a.name.localeCompare(b.name);
    });
  }

  return grouped.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
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

async function getDefaultList(householdId, targetType = listType) {
  const { data: existing, error: existingError } = await supabase
    .from('lists')
    .select('id,type,name,is_default')
    .eq('household_id', householdId)
    .eq('type', targetType)
    .eq('is_default', true)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing;

  const { data: createdId, error: rpcError } = await supabase.rpc('get_or_create_default_list', {
    target_household_id: householdId,
    target_type: targetType,
  });

  if (rpcError) throw rpcError;

  return {
    id: createdId,
    type: targetType,
    name: targetType === 'inventory' ? 'Inventory' : 'Shopping',
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
  const groups = groupListItems(items);

  if (groups.length === 0) {
    itemsTarget.innerHTML = `<p class="empty-state">${listType === 'inventory' ? 'Inventar je prazdny.' : 'Nakupny zoznam je prazdny.'}</p>`;
    updateShoppingCompleteButton();
    return;
  }

  itemsTarget.innerHTML = groups
    .map((group) => {
      const checked = group.status === 'checked';
      const detailParts = [
        listType === 'inventory' && group.expiry_date ? `Najblizsia expiracia ${group.expiry_date}` : '',
        listType === 'inventory' && group.min_stock !== null ? `Minimum ${group.min_stock}` : '',
        group.items.length > 1 ? `${group.items.length} zaznamy` : '',
        listType === 'shopping' && checked ? 'V kosiku' : '',
      ].filter(Boolean);

      return `
        <article class="item-row ${checked ? 'is-checked' : ''}" data-group-key="${escapeHtml(group.key)}">
          <div class="item-main">
            ${
              listType === 'shopping'
                ? `<input type="checkbox" data-action="toggle-group" ${checked ? 'checked' : ''} aria-label="V kosiku" />`
                : ''
            }
            <button type="button" class="item-open" data-action="open-detail">
              <strong>${escapeHtml(group.name)}</strong>
              <span>${escapeHtml(detailParts.join(' · '))}</span>
            </button>
          </div>
          <div class="item-actions">
            <span class="qty-chip">${escapeHtml(formatQuantity(group))}</span>
            ${
              listType === 'inventory'
                ? `<button type="button" data-action="quick-consume-group">Spotrebovat</button>`
                : `<button type="button" data-action="move-group-to-inventory">Do inventara</button>`
            }
            <button type="button" class="remove" data-action="delete-group">Zmazat</button>
          </div>
        </article>
      `;
    })
    .join('');
  updateShoppingCompleteButton();
}

function updateShoppingCompleteButton() {
  if (listType !== 'shopping') return;
  const checkedCount = currentItems.filter((item) => item.status === 'checked').length;
  shoppingCompleteButton.disabled = checkedCount === 0;
  shoppingCompleteButton.textContent = checkedCount > 0 ? `Nakupene (${checkedCount})` : 'Nakupene';
}

async function refreshItems() {
  setStatus('Nacitavam...');
  currentItems = await loadItems();
  renderItems(currentItems);
  if (activeGroupKey && !detailModal.hidden) renderDetail(activeGroupKey);
  setStatus(listType === 'inventory' && currentSort === 'expiry' ? 'Zoradene podla najblizsej expiracie.' : '');
}

function subscribeToCurrentList() {
  if (listRealtimeChannel) {
    supabase.removeChannel(listRealtimeChannel);
    listRealtimeChannel = null;
  }

  if (!currentList?.id) return;

  // Web ma reagovat aj na zmeny z mobilu, nielen na vlastny submit/refresh.
  listRealtimeChannel = supabase
    .channel(`recipe-web-${listType}-${currentList.id}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'list_items',
        filter: `list_id=eq.${currentList.id}`,
      },
      () => {
        refreshItems().catch((error) => setStatus(error.message));
      },
    )
    .subscribe();
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
  subscribeToCurrentList();
  await refreshItems();
}

function findGroup(groupKey) {
  return groupListItems(currentItems).find((entry) => entry.key === groupKey) || null;
}

function getPatchFromForm(formElement) {
  const data = new FormData(formElement);
  const patch = {
    name: String(data.get('name') || '').trim(),
    quantity: nullableNumber(data.get('quantity')) ?? 1,
    unit: normalizeItemUnit(data.get('unit') || 'pcs'),
    expiry_date: data.get('expiry_date') || null,
    updated_by: currentSession.user.id,
  };

  if (listType === 'inventory') {
    patch.min_stock = nullableNumber(data.get('min_stock'));
  }

  return patch;
}

function closeDetail() {
  activeGroupKey = null;
  detailModal.hidden = true;
  detailContent.innerHTML = '';
}

function renderDetail(groupKey) {
  const group = findGroup(groupKey);
  if (!group) {
    closeDetail();
    return;
  }

  activeGroupKey = groupKey;
  const sortedItems = [...group.items].sort((a, b) => {
    const expiryA = a.expiry_date || '9999-12-31';
    const expiryB = b.expiry_date || '9999-12-31';
    return expiryA.localeCompare(expiryB) || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
  const baseUnit = getBaseUnitForUnit(group.unit);
  const quickOptions = getQuickConsumeOptions(group.unit);

  detailContent.innerHTML = `
    <div class="detail-heading">
      <form class="detail-name-form" data-action="rename-group">
        <input name="name" value="${escapeHtml(group.name)}" aria-label="Nazov skupiny" />
        <button type="submit" class="primary">Ulozit nazov</button>
      </form>
      <button type="button" data-action="close-detail">Zavriet</button>
    </div>
    <p class="lead compact">${escapeHtml(formatQuantity(group))}${group.expiry_date ? ` - najblizsia expiracia ${escapeHtml(group.expiry_date)}` : ''}</p>
    ${
      listType === 'inventory'
        ? `
          <div class="quick-consume-box">
            <strong>Rychla spotreba</strong>
            <div class="quick-actions">
              ${quickOptions
                .map(
                  (option) =>
                    `<button type="button" data-action="consume-option" data-quantity="${option.quantity}" data-unit="${option.unit}">-${option.quantity} ${option.unit}</button>`,
                )
                .join('')}
            </div>
            <form class="consume-form" data-action="consume-custom">
              <input name="quantity" type="number" min="0" step="0.001" placeholder="Mnozstvo" />
              <span>${escapeHtml(baseUnit)}</span>
              <button type="submit" class="primary">Spotrebovat</button>
            </form>
          </div>
        `
        : ''
    }
    <div class="detail-items">
      ${sortedItems
        .map(
          (item) => `
            <form class="detail-item-form is-${escapeHtml(listType)}" data-action="save-item" data-item-id="${escapeHtml(item.id)}">
              <label>
                <span>Nazov</span>
                <input name="name" value="${escapeHtml(item.name)}" required />
              </label>
              <label>
                <span>Mnozstvo</span>
                <input name="quantity" type="number" min="0" step="0.001" value="${escapeHtml(formatQuantityValue(item.quantity))}" />
              </label>
              <label>
                <span>Jednotka</span>
                <select name="unit">
                  ${['pcs', 'g', 'dkg', 'kg', 'ml', 'l']
                    .map((unit) => `<option value="${unit}" ${normalizeItemUnit(item.unit) === unit ? 'selected' : ''}>${unit}</option>`)
                    .join('')}
                </select>
              </label>
              <label>
                <span>${listType === 'inventory' ? 'Expiracia' : 'Odhad expiracie'}</span>
                <input name="expiry_date" type="date" value="${escapeHtml(item.expiry_date || '')}" />
              </label>
              ${
                listType === 'inventory'
                  ? `
                    <label>
                      <span>Minimum</span>
                      <input name="min_stock" type="number" min="0" step="0.001" value="${escapeHtml(item.min_stock ?? '')}" />
                    </label>
                  `
                  : ''
              }
              <div class="detail-item-actions">
                ${
                  listType === 'shopping'
                    ? `<button type="button" data-action="move-item-to-inventory" data-item-id="${escapeHtml(item.id)}">Do inventara</button>`
                    : ''
                }
                <button type="submit" class="primary">Ulozit</button>
                <button type="button" class="remove" data-action="delete-item" data-item-id="${escapeHtml(item.id)}">Zmazat</button>
              </div>
            </form>
          `,
        )
        .join('')}
    </div>
  `;

  detailModal.hidden = false;
}

function openDetail(groupKey) {
  renderDetail(groupKey);
}

async function renameGroup(group, nextName) {
  const name = String(nextName || '').trim();
  if (!group || !name) return;
  const ids = group.items.map((item) => item.id).filter(Boolean);
  if (ids.length === 0) return;

  const { error } = await supabase
    .from('list_items')
    .update({ name, updated_by: currentSession.user.id })
    .in('id', ids);

  if (error) throw error;
  await upsertItemPreferenceEverywhere({
    supabase,
    householdId: currentHouseholdId,
    userId: currentSession.user.id,
    name,
    unit: group.unit,
    expiryDate: group.expiry_date,
    minStock: group.min_stock,
  });
}

async function saveItem(itemId, formElement) {
  const patch = getPatchFromForm(formElement);
  if (!patch.name) return;

  const { error } = await supabase.from('list_items').update(patch).eq('id', itemId);
  if (error) throw error;

  await upsertItemPreferenceEverywhere({
    supabase,
    householdId: currentHouseholdId,
    userId: currentSession.user.id,
    name: patch.name,
    unit: patch.unit,
    expiryDate: patch.expiry_date,
    minStock: listType === 'inventory' ? patch.min_stock : null,
  });

  if (listType === 'shopping') {
    await upsertQuickPreference({
      supabase,
      householdId: currentHouseholdId,
      userId: currentSession.user.id,
      name: patch.name,
      quantity: patch.quantity,
      unit: patch.unit,
    });
  }
}

async function consumeInventoryGroup(group, amount, unit) {
  if (!group || listType !== 'inventory') return;

  const targetBase = normalizeQuantityToBaseUnit(amount, unit);
  let remaining = quantityNumber(targetBase.quantity);
  if (remaining <= 0) return;

  const updates = [];
  const deletes = [];

  for (const item of [...group.items].sort((a, b) => (a.expiry_date || '9999-12-31').localeCompare(b.expiry_date || '9999-12-31'))) {
    if (remaining <= 0) break;
    if (!areUnitsCompatible(item.unit, targetBase.unit)) continue;

    const itemBase = normalizeQuantityToBaseUnit(item.quantity, item.unit);
    const currentQuantity = quantityNumber(itemBase.quantity);
    if (currentQuantity <= 0) {
      deletes.push(item.id);
      continue;
    }

    const consumed = Math.min(currentQuantity, remaining);
    remaining -= consumed;
    const nextQuantity = currentQuantity - consumed;

    if (nextQuantity <= 0.000001) {
      deletes.push(item.id);
    } else {
      updates.push(
        supabase
          .from('list_items')
          .update({
            quantity: Number(formatQuantityValue(nextQuantity)),
            unit: itemBase.unit,
            updated_by: currentSession.user.id,
          })
          .eq('id', item.id),
      );
    }
  }

  const results = await Promise.all(updates);
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;

  if (deletes.length > 0) {
    const { error } = await supabase.from('list_items').delete().in('id', deletes);
    if (error) throw error;
  }
}

async function moveShoppingItemToInventory(item) {
  if (!item || listType !== 'shopping') return;

  const inventoryList = await getDefaultList(currentHouseholdId, 'inventory');
  const row = buildInventoryRow({
    listId: inventoryList.id,
    userId: currentSession.user.id,
    input: {
      clientItemId: getClientItemId(),
      quantity: item.quantity,
      unit: item.unit,
      expiryDate: item.expiry_date || computeExpiryForName(item.name, currentPreferences),
      minStock: item.min_stock ?? null,
    },
    canonicalName: item.name,
  });

  await upsertListItemWithMerge({
    supabase,
    listType: 'inventory',
    row,
    userId: currentSession.user.id,
  });

  const { error } = await supabase.from('list_items').delete().eq('id', item.id);
  if (error) throw error;
}

async function moveCheckedShoppingItemsToInventory() {
  if (listType !== 'shopping') return;

  const checkedItems = currentItems.filter((item) => item.status === 'checked');
  if (checkedItems.length === 0) return;

  setStatus('Presuvam nakupene polozky do inventara...');
  shoppingCompleteButton.disabled = true;

  try {
    for (const item of checkedItems) {
      await moveShoppingItemToInventory(item);
    }
    closeDetail();
    await refreshItems();
    setStatus('Nakupene polozky su v inventari.');
  } catch (error) {
    setStatus(error.message);
    updateShoppingCompleteButton();
  }
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
  const actionTarget = event.target.closest('[data-action]');
  const action = actionTarget?.dataset.action;
  if (!action) return;

  const row = actionTarget.closest('[data-group-key]');
  const groupKey = row?.dataset.groupKey;
  if (!groupKey) return;

  const items = await loadItems();
  const group = groupListItems(items).find((entry) => entry.key === groupKey);
  if (!group) return;
  const ids = group.items.map((item) => item.id).filter(Boolean);
  if (ids.length === 0) return;

  if (action === 'open-detail' && event.type === 'click') {
    openDetail(groupKey);
    return;
  }

  if (action === 'toggle-group' && event.type === 'change') {
    const status = actionTarget.checked ? 'checked' : 'active';
    const { error } = await supabase
      .from('list_items')
      .update({ status, updated_by: currentSession.user.id })
      .in('id', ids);

    if (error) {
      setStatus(error.message);
      return;
    }

    await refreshItems();
  }

  if (action === 'delete-group' && event.type === 'click') {
    const { error } = await supabase.from('list_items').delete().in('id', ids);

    if (error) {
      setStatus(error.message);
      return;
    }

    await refreshItems();
  }

  if (action === 'quick-consume-group' && event.type === 'click') {
    const option = getQuickConsumeOptions(group.unit)[0];
    setStatus('Spotrebuvam...');
    try {
      await consumeInventoryGroup(group, option.quantity, option.unit);
      await refreshItems();
    } catch (error) {
      setStatus(error.message);
    }
  }

  if (action === 'move-group-to-inventory' && event.type === 'click') {
    setStatus('Presuvam do inventara...');
    try {
      for (const item of group.items) {
        await moveShoppingItemToInventory(item);
      }
      await refreshItems();
    } catch (error) {
      setStatus(error.message);
    }
  }
}

async function handleDetailAction(event) {
  const action = event.target.dataset.action || event.target.closest('form')?.dataset.action;
  if (!action) return;

  if (action === 'close-detail' && event.type === 'click') {
    closeDetail();
    return;
  }

  const group = activeGroupKey ? findGroup(activeGroupKey) : null;

  try {
    if (action === 'rename-group' && event.type === 'submit') {
      event.preventDefault();
      await renameGroup(group, event.target.elements.name.value);
      await refreshItems();
      return;
    }

    if (action === 'save-item' && event.type === 'submit') {
      event.preventDefault();
      await saveItem(event.target.dataset.itemId, event.target);
      await refreshItems();
      return;
    }

    if (action === 'delete-item' && event.type === 'click') {
      const { error } = await supabase.from('list_items').delete().eq('id', event.target.dataset.itemId);
      if (error) throw error;
      await refreshItems();
      return;
    }

    if (action === 'consume-option' && event.type === 'click') {
      await consumeInventoryGroup(group, event.target.dataset.quantity, event.target.dataset.unit);
      await refreshItems();
      return;
    }

    if (action === 'consume-custom' && event.type === 'submit') {
      event.preventDefault();
      const baseUnit = getBaseUnitForUnit(group?.unit);
      await consumeInventoryGroup(group, event.target.elements.quantity.value, baseUnit);
      event.target.reset();
      await refreshItems();
      return;
    }

    if (action === 'move-item-to-inventory' && event.type === 'click') {
      const item = currentItems.find((entry) => entry.id === event.target.dataset.itemId);
      await moveShoppingItemToInventory(item);
      await refreshItems();
    }
  } catch (error) {
    setStatus(error.message);
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
detailModal.addEventListener('click', handleDetailAction);
detailModal.addEventListener('submit', handleDetailAction);
shoppingCompleteButton.addEventListener('click', moveCheckedShoppingItemsToInventory);
refreshButton.addEventListener('click', refreshItems);
window.addEventListener('focus', () => {
  if (currentList?.id) refreshItems().catch((error) => setStatus(error.message));
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentList?.id) {
    refreshItems().catch((error) => setStatus(error.message));
  }
});
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
