import { hasSupabaseConfig, supabase } from './supabase-client.js';

const form = document.querySelector('#recipe-form');
const ingredientsList = document.querySelector('#ingredients-list');
const stepsList = document.querySelector('#steps-list');
const statusMessage = document.querySelector('#status-message');
const logoutButton = document.querySelector('#logout-button');

function normalizeIngredientName(value) {
  return value
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function nullableText(value) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nullableNumber(value) {
  if (value.trim() === '') {
    return null;
  }

  const normalized = Number(value.replace(',', '.'));
  return Number.isFinite(normalized) ? normalized : null;
}

function nullableInteger(value) {
  if (value.trim() === '') {
    return null;
  }

  const normalized = Number.parseInt(value, 10);
  return Number.isFinite(normalized) ? normalized : null;
}

function createInput(name, label, type = 'text') {
  const wrapper = document.createElement('label');
  const labelText = document.createElement('span');
  const input = document.createElement('input');

  labelText.textContent = label;
  input.name = name;
  input.type = type;

  wrapper.append(labelText, input);
  return wrapper;
}

function addIngredientRow(values = {}) {
  const row = document.createElement('div');
  row.className = 'row ingredient-row';

  const name = createInput('ingredient_name', 'Nazov');
  const quantity = createInput('ingredient_quantity', 'Mnozstvo', 'number');
  const unit = createInput('ingredient_unit', 'Jednotka');
  const optional = document.createElement('label');
  const sortOrder = createInput('ingredient_sort_order', 'Poradie', 'number');
  const remove = document.createElement('button');

  quantity.querySelector('input').step = '0.01';
  sortOrder.querySelector('input').step = '1';
  sortOrder.querySelector('input').value = values.sort_order ?? ingredientsList.children.length;
  name.querySelector('input').value = values.name || '';
  quantity.querySelector('input').value = values.quantity || '';
  unit.querySelector('input').value = values.unit || '';

  optional.className = 'check-row';
  optional.innerHTML = '<input name="ingredient_optional" type="checkbox" /><span>Volitelne</span>';
  optional.querySelector('input').checked = Boolean(values.optional);

  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = 'X';
  remove.addEventListener('click', () => row.remove());

  row.append(name, quantity, unit, optional, sortOrder, remove);
  ingredientsList.append(row);
}

function addStepRow(values = {}) {
  const row = document.createElement('div');
  row.className = 'row step-row';

  const instruction = document.createElement('label');
  const instructionLabel = document.createElement('span');
  const textarea = document.createElement('textarea');
  const sortOrder = createInput('step_sort_order', 'Poradie', 'number');
  const remove = document.createElement('button');

  instructionLabel.textContent = 'Instrukcia';
  textarea.name = 'step_instruction';
  textarea.rows = 2;
  textarea.value = values.instruction || '';
  instruction.append(instructionLabel, textarea);

  sortOrder.querySelector('input').step = '1';
  sortOrder.querySelector('input').value = values.sort_order ?? stepsList.children.length;

  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = 'X';
  remove.addEventListener('click', () => row.remove());

  row.append(instruction, sortOrder, remove);
  stepsList.append(row);
}

function collectIngredients(recipeId) {
  return [...ingredientsList.querySelectorAll('.ingredient-row')]
    .map((row, index) => {
      const name = row.querySelector('[name="ingredient_name"]').value.trim();

      if (!name) {
        return null;
      }

      return {
        recipe_id: recipeId,
        name,
        normalized_name: normalizeIngredientName(name),
        quantity: nullableNumber(row.querySelector('[name="ingredient_quantity"]').value),
        unit: nullableText(row.querySelector('[name="ingredient_unit"]').value),
        optional: row.querySelector('[name="ingredient_optional"]').checked,
        sort_order: nullableInteger(row.querySelector('[name="ingredient_sort_order"]').value) ?? index,
      };
    })
    .filter(Boolean);
}

function collectSteps(recipeId) {
  return [...stepsList.querySelectorAll('.step-row')]
    .map((row, index) => {
      const instruction = row.querySelector('[name="step_instruction"]').value.trim();

      if (!instruction) {
        return null;
      }

      return {
        recipe_id: recipeId,
        instruction,
        sort_order: nullableInteger(row.querySelector('[name="step_sort_order"]').value) ?? index,
      };
    })
    .filter(Boolean);
}

async function handleSubmit(event) {
  event.preventDefault();

  if (!hasSupabaseConfig()) {
    statusMessage.textContent = 'Chyba Supabase URL alebo anon key.';
    return;
  }

  const { data: sessionData } = await supabase.auth.getSession();

  if (!sessionData.session) {
    window.location.href = '/login';
    return;
  }

  const data = new FormData(form);
  const recipe = {
    title: data.get('title').trim(),
    description: nullableText(data.get('description')),
    image_url: nullableText(data.get('image_url')),
    servings: nullableNumber(data.get('servings')),
    prep_time_minutes: nullableInteger(data.get('prep_time_minutes')),
    cook_time_minutes: nullableInteger(data.get('cook_time_minutes')),
    difficulty: nullableText(data.get('difficulty')),
    is_published: data.get('is_published') === 'on',
  };

  statusMessage.textContent = 'Ukladam...';

  const { data: insertedRecipe, error: recipeError } = await supabase
    .from('recipes')
    .insert(recipe)
    .select('id')
    .single();

  if (recipeError) {
    statusMessage.textContent = recipeError.message;
    return;
  }

  const ingredients = collectIngredients(insertedRecipe.id);
  const steps = collectSteps(insertedRecipe.id);

  if (ingredients.length > 0) {
    const { error } = await supabase.from('recipe_ingredients').insert(ingredients);

    if (error) {
      statusMessage.textContent = error.message;
      return;
    }
  }

  if (steps.length > 0) {
    const { error } = await supabase.from('recipe_steps').insert(steps);

    if (error) {
      statusMessage.textContent = error.message;
      return;
    }
  }

  window.location.href = `/recipes/?id=${encodeURIComponent(insertedRecipe.id)}`;
}

async function requireSession() {
  if (!hasSupabaseConfig()) {
    statusMessage.textContent = 'Chyba Supabase URL alebo anon key.';
    form.hidden = true;
    return;
  }

  const { data } = await supabase.auth.getSession();

  if (!data.session) {
    window.location.href = '/login';
  }
}

async function handleLogout() {
  await supabase.auth.signOut();
  window.location.href = '/login';
}

document.querySelector('#add-ingredient').addEventListener('click', () => addIngredientRow());
document.querySelector('#add-step').addEventListener('click', () => addStepRow());
form.addEventListener('submit', handleSubmit);
logoutButton.addEventListener('click', handleLogout);

addIngredientRow();
addStepRow();
requireSession();
