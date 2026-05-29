export const ITEM_UNITS = ['pcs', 'l', 'ml', 'kg', 'dkg', 'g'];

const UNIT_META = {
  pcs: { family: 'count', baseUnit: 'pcs', factor: 1 },
  l: { family: 'volume', baseUnit: 'ml', factor: 1000 },
  ml: { family: 'volume', baseUnit: 'ml', factor: 1 },
  kg: { family: 'mass', baseUnit: 'g', factor: 1000 },
  dkg: { family: 'mass', baseUnit: 'g', factor: 10 },
  g: { family: 'mass', baseUnit: 'g', factor: 1 },
};

const expiryRules = [
  { match: /rozok/i, days: 3 },
  { match: /chlieb|pecivo/i, days: 4 },
  { match: /maso|kurca|hovadz|bravc/i, days: 5 },
  { match: /mrazen/i, days: 60 },
  { match: /mlieko|jogurt/i, days: 10 },
  { match: /syr/i, days: 20 },
  { match: /vajc/i, days: 21 },
  { match: /ovoc/i, days: 5 },
  { match: /zelenin/i, days: 5 },
  { match: /maslo/i, days: 30 },
];

export function normalizeKeyName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizeItemUnit(unit) {
  const raw = String(unit || '').trim().toLowerCase();
  return ITEM_UNITS.includes(raw) ? raw : 'pcs';
}

export function toQuantityNumber(value, fallback = 0) {
  const number = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) ? number : fallback;
}

export function formatQuantityValue(value) {
  const number = Number.parseFloat(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(number)) return '0';
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(3).replace(/\.?0+$/, '');
}

function toPositiveQuantity(value, fallback = 1) {
  const number = toQuantityNumber(value, NaN);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getUnitMeta(unit) {
  return UNIT_META[normalizeItemUnit(unit)] || UNIT_META.pcs;
}

function convertQuantity(quantity, fromUnit, toUnit) {
  const from = getUnitMeta(fromUnit);
  const to = getUnitMeta(toUnit);
  const numeric = toQuantityNumber(quantity, NaN);

  if (!Number.isFinite(numeric)) return 0;
  if (from.family !== to.family) return numeric;

  return (numeric * from.factor) / to.factor;
}

function normalizeQuantityToBaseUnit(quantity, unit) {
  const normalizedUnit = normalizeItemUnit(unit);
  const meta = getUnitMeta(normalizedUnit);
  const baseUnit = meta.baseUnit;
  const numeric = toQuantityNumber(quantity, NaN);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { quantity: '1', unit: baseUnit };
  }

  const baseQuantity = convertQuantity(numeric, normalizedUnit, baseUnit);

  if (meta.family === 'count') {
    return { quantity: formatQuantityValue(baseQuantity), unit: baseUnit };
  }

  return { quantity: String(Math.max(1, Math.round(baseQuantity))), unit: baseUnit };
}

export function toIsoDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

function defaultExpiryDays(name) {
  const normalized = normalizeKeyName(name);

  for (const rule of expiryRules) {
    if (rule.match.test(normalized)) {
      return rule.days;
    }
  }

  return 14;
}

function mapPreferenceRows(rows) {
  const map = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = normalizeKeyName(row.normalized_name || row.display_name);
    if (key) map.set(key, row);
  }

  return map;
}

export async function loadItemPreferences({ supabase, householdId, userId }) {
  const [globalResult, householdResult, quickResult] = await Promise.all([
    userId
      ? supabase
          .from('user_global_item_preferences')
          .select('normalized_name,display_name,aliases,preferred_unit,default_expiry_days,min_stock')
          .eq('user_id', userId)
      : Promise.resolve({ data: [] }),
    householdId
      ? supabase
          .from('household_item_preferences')
          .select('normalized_name,display_name,aliases,preferred_unit,default_expiry_days,min_stock')
          .eq('household_id', householdId)
      : Promise.resolve({ data: [] }),
    householdId && userId
      ? supabase
          .from('user_item_preferences')
          .select('normalized_name,quick_consume_quantity,quick_consume_unit')
          .eq('household_id', householdId)
          .eq('user_id', userId)
      : Promise.resolve({ data: [] }),
  ]);

  if (globalResult.error) throw globalResult.error;
  if (householdResult.error) throw householdResult.error;
  if (quickResult.error) throw quickResult.error;

  const merged = mapPreferenceRows(globalResult.data);
  for (const [key, row] of mapPreferenceRows(householdResult.data)) {
    merged.set(key, row);
  }

  const quick = new Map();
  for (const row of quickResult.data || []) {
    const key = normalizeKeyName(row.normalized_name);
    if (key) quick.set(key, row);
  }

  return { itemPreferences: merged, quickPreferences: quick };
}

export function getPreferenceForName(preferences, name) {
  return preferences?.itemPreferences?.get(normalizeKeyName(name)) || null;
}

export function getQuickPreferenceForName(preferences, name) {
  return preferences?.quickPreferences?.get(normalizeKeyName(name)) || null;
}

export function computeExpiryForName(name, preferences) {
  const pref = getPreferenceForName(preferences, name);
  const days = Number(pref?.default_expiry_days);
  return addDays(Number.isFinite(days) && days > 0 ? Math.round(days) : defaultExpiryDays(name));
}

export function getSuggestedDefaults({ name, listType, preferences }) {
  const itemPref = getPreferenceForName(preferences, name);
  const quickPref = getQuickPreferenceForName(preferences, name);

  return {
    unit: normalizeItemUnit(quickPref?.quick_consume_unit || itemPref?.preferred_unit || 'pcs'),
    quantity:
      listType === 'shopping' && quickPref?.quick_consume_quantity
        ? formatQuantityValue(quickPref.quick_consume_quantity)
        : '1',
    expiryDate: computeExpiryForName(name, preferences),
    minStock: itemPref?.min_stock != null ? formatQuantityValue(itemPref.min_stock) : '',
  };
}

export async function upsertItemPreferenceEverywhere({ supabase, householdId, userId, name, unit, expiryDate, minStock }) {
  const normalizedName = normalizeKeyName(name);
  const displayName = String(name || '').trim();
  if (!normalizedName || !displayName) return;

  const normalizedUnit = normalizeItemUnit(unit);
  const patch = {
    normalized_name: normalizedName,
    display_name: displayName,
    aliases: [normalizedName],
    preferred_unit: normalizedUnit,
  };

  const today = new Date();
  const expiry = expiryDate ? new Date(`${expiryDate}T00:00:00`) : null;
  const diffDays = expiry ? Math.round((expiry - new Date(today.toISOString().slice(0, 10))) / 86400000) : null;

  if (Number.isFinite(diffDays) && diffDays > 0) {
    patch.default_expiry_days = diffDays;
  }

  const min = toQuantityNumber(minStock, NaN);
  if (Number.isFinite(min) && min > 0) {
    patch.min_stock = min;
  }

  const writes = [];

  if (householdId) {
    writes.push(
      supabase.from('household_item_preferences').upsert(
        {
          household_id: householdId,
          ...patch,
          updated_by: userId || null,
          created_by: userId || null,
        },
        { onConflict: 'household_id,normalized_name' },
      ),
    );
  }

  if (userId) {
    writes.push(
      supabase.from('user_global_item_preferences').upsert(
        {
          user_id: userId,
          ...patch,
        },
        { onConflict: 'user_id,normalized_name' },
      ),
    );
  }

  const results = await Promise.all(writes);
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;
}

export async function upsertQuickPreference({ supabase, householdId, userId, name, quantity, unit }) {
  const normalizedName = normalizeKeyName(name);
  if (!householdId || !userId || !normalizedName) return;

  const amount = Math.round(toPositiveQuantity(quantity, 1));
  const { error } = await supabase.from('user_item_preferences').upsert(
    {
      user_id: userId,
      household_id: householdId,
      normalized_name: normalizedName,
      quick_consume_quantity: amount,
      quick_consume_unit: normalizeItemUnit(unit),
    },
    { onConflict: 'user_id,household_id,normalized_name' },
  );

  if (error) throw error;
}

export function pickCanonicalDisplayName(name, lists = []) {
  const key = normalizeKeyName(name);
  for (const list of lists) {
    const found = (Array.isArray(list) ? list : []).find((item) => normalizeKeyName(item?.name) === key);
    if (found?.name) return found.name;
  }
  return name;
}

export function buildInventoryRow({ listId, userId, input, canonicalName }) {
  const normalized = normalizeQuantityToBaseUnit(input.quantity, input.unit);
  return {
    list_id: listId,
    client_item_id: input.clientItemId,
    name: canonicalName,
    quantity: toQuantityNumber(normalized.quantity, 1),
    unit: normalized.unit,
    expiry_date: input.expiryDate,
    min_stock: input.minStock,
    status: 'active',
    added_at: toIsoDate(new Date()),
    created_by: userId,
    updated_by: userId,
  };
}

export function buildShoppingRow({ listId, userId, input, canonicalName, expiryDate }) {
  return {
    list_id: listId,
    client_item_id: input.clientItemId,
    name: canonicalName,
    quantity: Math.round(toPositiveQuantity(input.quantity, 1)),
    unit: normalizeItemUnit(input.unit),
    expiry_date: expiryDate,
    status: 'active',
    added_at: toIsoDate(new Date()),
    created_by: userId,
    updated_by: userId,
  };
}

export async function upsertListItemWithMerge({ supabase, listType, row, userId }) {
  const key = normalizeKeyName(row.name);
  let query = supabase
    .from('list_items')
    .select('id,name,quantity,unit,expiry_date,min_stock,status,added_at')
    .eq('list_id', row.list_id)
    .eq('unit', row.unit);

  if (listType === 'inventory') {
    query = query.eq('status', 'active').eq('expiry_date', row.expiry_date);
  } else {
    query = query.neq('status', 'archived');
  }

  const { data, error } = await query;
  if (error) throw error;

  const existing = (data || []).find((item) => normalizeKeyName(item.name) === key);

  if (!existing) {
    const { error: insertError } = await supabase.from('list_items').insert(row);
    if (insertError) throw insertError;
    return;
  }

  const quantity = toQuantityNumber(existing.quantity) + toPositiveQuantity(row.quantity);
  const patch = {
    name: existing.name || row.name,
    quantity,
    unit: row.unit,
    updated_by: userId,
  };

  if (listType === 'inventory') {
    patch.min_stock = row.min_stock ?? existing.min_stock ?? null;
  } else {
    patch.expiry_date = existing.expiry_date || row.expiry_date || null;
    patch.added_at = existing.added_at || row.added_at || null;
  }

  const { error: updateError } = await supabase.from('list_items').update(patch).eq('id', existing.id);
  if (updateError) throw updateError;
}
