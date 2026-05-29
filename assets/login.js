import { hasSupabaseConfig, supabase } from './supabase-client.js';

const form = document.querySelector('#login-form');
const statusMessage = document.querySelector('#status-message');

async function redirectIfSignedIn() {
  if (!hasSupabaseConfig()) {
    statusMessage.textContent = 'Chyba Supabase URL alebo anon key.';
    return;
  }

  const { data } = await supabase.auth.getSession();

  if (data.session) {
    window.location.href = '/admin/recipes/new';
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  if (!hasSupabaseConfig()) {
    statusMessage.textContent = 'Chyba Supabase URL alebo anon key.';
    return;
  }

  const data = new FormData(form);
  const email = data.get('email').trim();
  const password = data.get('password');

  statusMessage.textContent = 'Prihlasujem...';

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    statusMessage.textContent = error.message;
    return;
  }

  window.location.href = '/admin/recipes/new';
}

form.addEventListener('submit', handleSubmit);
redirectIfSignedIn();
