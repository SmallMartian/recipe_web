import { hasSupabaseConfig, supabase } from './supabase-client.js';

function getInitial(profile, fallbackEmail) {
  const value = profile?.display_name || profile?.handle || fallbackEmail || 'B';
  return String(value).trim().charAt(0).toUpperCase() || 'B';
}

function getDisplayName(profile, fallbackEmail) {
  return profile?.display_name || profile?.handle || fallbackEmail || 'BASIL user';
}

function getSecondary(profile, fallbackEmail) {
  return profile?.handle ? `@${profile.handle}` : profile?.email || fallbackEmail || '';
}

function isPremiumProfile(profile) {
  if (!profile?.is_premium) return false;
  if (!profile.premium_until) return true;
  return new Date(profile.premium_until).getTime() > Date.now();
}

function avatarHtml(profile, fallbackEmail) {
  if (profile?.avatar_url) {
    return `<img src="${profile.avatar_url}" alt="" />`;
  }

  return `<span class="profile-initial">${getInitial(profile, fallbackEmail)}</span>`;
}

function closeAllMenus() {
  document.querySelectorAll('[data-user-menu]').forEach((menu) => {
    const button = menu.querySelector('[data-user-menu-button]');
    const dropdown = menu.querySelector('[data-user-menu-dropdown]');

    button?.setAttribute('aria-expanded', 'false');
    if (dropdown) dropdown.hidden = true;
  });
}

function bindGlobalClose() {
  if (window.__recipeWebUserMenuBound) return;
  window.__recipeWebUserMenuBound = true;

  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-user-menu]')) {
      closeAllMenus();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAllMenus();
    }
  });
}

export async function getCurrentProfile(session) {
  if (!session) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error) {
    console.warn('Profile load failed', error);
    return { email: session.user.email };
  }
  return data || { email: session.user.email };
}

export function renderUserMenu({ profile, user, redirectAfterLogout = '/' }) {
  const menus = [...document.querySelectorAll('[data-user-menu]')];
  const fallbackEmail = user?.email || profile?.email || '';
  const displayName = getDisplayName(profile, fallbackEmail);
  const secondary = getSecondary(profile, fallbackEmail);
  const premiumLabel = isPremiumProfile(profile) ? 'Premium' : 'Free';

  bindGlobalClose();

  menus.forEach((menu) => {
    menu.innerHTML = `
      <button type="button" class="profile-badge" data-user-menu-button aria-expanded="false">
        <span class="profile-avatar">${avatarHtml(profile, fallbackEmail)}</span>
        <span class="profile-copy">
          <strong>${displayName}</strong>
          ${secondary ? `<small>${secondary}</small>` : ''}
          <small class="premium-chip ${isPremiumProfile(profile) ? 'is-premium' : ''}">${premiumLabel}</small>
        </span>
        <span class="profile-chevron" aria-hidden="true">v</span>
      </button>
      <div class="profile-menu" data-user-menu-dropdown hidden>
        <a href="/inventory/">Inventar</a>
        <a href="/shopping/">Nakupny zoznam</a>
        <a href="/recipes/">Moje recepty</a>
        <button type="button" data-user-logout>Odhlasit sa</button>
      </div>
    `;
    menu.hidden = false;

    const button = menu.querySelector('[data-user-menu-button]');
    const dropdown = menu.querySelector('[data-user-menu-dropdown]');
    const logoutButton = menu.querySelector('[data-user-logout]');

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextHidden = !dropdown.hidden ? true : false;
      closeAllMenus();
      dropdown.hidden = nextHidden;
      button.setAttribute('aria-expanded', String(!nextHidden));
    });

    logoutButton.addEventListener('click', async () => {
      await supabase.auth.signOut();
      window.location.href = redirectAfterLogout;
    });
  });
}

export async function setupUserMenu({ redirectAfterLogout = '/' } = {}) {
  if (!hasSupabaseConfig()) return null;

  const { data } = await supabase.auth.getSession();
  const session = data.session;

  if (!session) return null;

  const profile = await getCurrentProfile(session);
  renderUserMenu({ profile, user: session.user, redirectAfterLogout });

  return { session, profile };
}
