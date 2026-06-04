import { hasSupabaseConfig, supabase } from './supabase-client.js';
import { renderUserMenu, setupUserMenu } from './user-menu.js';

const ACTIVE_HOUSEHOLD_KEY = 'recipe_web_active_household_id';

const statusLine = document.querySelector('#settings-status');
const profileForm = document.querySelector('#profile-form');
const profileAvatar = document.querySelector('#profile-avatar');
const profileName = document.querySelector('#profile-name');
const profileHandle = document.querySelector('#profile-handle');
const householdList = document.querySelector('#household-list');
const inviteList = document.querySelector('#invite-list');
const createHouseholdButton = document.querySelector('#create-household');
const refreshInvitesButton = document.querySelector('#refresh-invites');
const householdDetail = document.querySelector('#household-detail');
const householdDetailTitle = document.querySelector('#household-detail-title');
const householdForm = document.querySelector('#household-form');
const householdNicknameForm = document.querySelector('#household-nickname-form');
const activateHouseholdButton = document.querySelector('#activate-household');
const inviteForm = document.querySelector('#invite-form');
const inviteHint = document.querySelector('#invite-hint');
const inviteTargetError = document.querySelector('#invite-target-error');
const inviteRoleError = document.querySelector('#invite-role-error');
const memberList = document.querySelector('#member-list');
const saveHouseholdChangesButton = document.querySelector('#save-household-changes');
const leaveHouseholdButton = document.querySelector('#leave-household');
const deleteHouseholdButton = document.querySelector('#delete-household');

let currentSession = null;
let currentProfile = null;
let households = [];
let activeHouseholdId = null;
let selectedHouseholdId = null;
let selectedMembers = [];
let settingsRealtimeChannel = null;

function setStatus(message) {
  statusLine.textContent = message || '';
}

function setInviteFieldError(field, message) {
  const targetInput = inviteForm.elements.target;
  const roleInput = inviteForm.elements.role;
  const errorNode = field === 'role' ? inviteRoleError : inviteTargetError;
  const input = field === 'role' ? roleInput : targetInput;

  if (!errorNode || !input) return;
  errorNode.textContent = message || '';
  errorNode.hidden = !message;
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function clearInviteFieldErrors() {
  setInviteFieldError('target', '');
  setInviteFieldError('role', '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function initialHtml(value) {
  return `
    <svg class="profile-initial" viewBox="0 0 56 56" aria-hidden="true" focusable="false">
      <text x="26" y="25" text-anchor="middle" dominant-baseline="central">${escapeHtml(value)}</text>
    </svg>
  `;
}

function normalizeRoleForDisplay(role) {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Member';
}

function normalizeRoleForCloud(role) {
  return role === 'admin' ? 'admin' : 'editor';
}

function getInviteError(error) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('invite target user not found')) {
    return { field: 'target', message: 'Pouzivatel s tymto emailom alebo handle neexistuje.' };
  }
  if (message.includes('invalid invite target')) {
    return { field: 'target', message: 'Zadaj email alebo handle vo formate meno#1234.' };
  }
  if (message.includes('already in household')) {
    return { field: 'target', message: 'Tento pouzivatel uz je v domacnosti.' };
  }
  if (message.includes('already pending')) {
    return { field: 'target', message: 'Pozvanka pre tohto pouzivatela uz caka na prijatie.' };
  }
  if (message.includes('cannot invite yourself')) {
    return { field: 'target', message: 'Nemozes pozvat sam seba.' };
  }
  if (message.includes('invites require premium')) {
    return { field: 'general', message: 'Pozvanie clenov vyzaduje Premium domacnost alebo Premium ucet.' };
  }
  if (message.includes('admin role requires premium user')) {
    return { field: 'role', message: 'Admin rola vyzaduje Premium ucet pozvaneho pouzivatela.' };
  }
  if (message.includes('create_household_invite_for_existing_user')) {
    return { field: 'general', message: 'Pozvanky vyzaduju aktualnu databazovu migraciu.' };
  }
  return { field: 'general', message: error?.message || 'Pozvanku sa nepodarilo vytvorit.' };
}

function isPremiumProfile(profile) {
  if (!profile?.is_premium) return false;
  if (!profile.premium_until) return true;
  return new Date(profile.premium_until).getTime() > Date.now();
}

function randomHandleSuffix() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

function buildHandle(displayName) {
  const base = String(displayName || '').trim().replace(/\s+/g, ' ') || 'User';
  return `${base}#${randomHandleSuffix()}`;
}

function isPremiumHousehold(household) {
  return Boolean(household?.is_premium);
}

function getMemberLabel(member) {
  const handleBase = String(member?.handle || '').replace(/#\d{4}$/, '');
  return member?.display_name || handleBase || member?.handle || member?.email || 'Neznamy clen';
}

function getCurrentMember() {
  const userId = currentSession?.user?.id || '';
  const email = String(currentSession?.user?.email || currentProfile?.email || '').toLowerCase();
  const handle = String(currentProfile?.handle || '');

  return selectedMembers.find((member) => (
    (userId && member.user_id === userId) ||
    (email && String(member.email || '').toLowerCase() === email) ||
    (handle && member.handle === handle)
  )) || null;
}

function canManageMembers() {
  const role = getCurrentMember()?.role;
  return role === 'owner' || role === 'admin';
}

function canInviteMembers() {
  const household = households.find((item) => item.id === selectedHouseholdId);
  return canManageMembers() && (isPremiumHousehold(household) || isPremiumProfile(currentProfile));
}

function renderProfile() {
  const fallbackEmail = currentSession?.user?.email || '';
  const displayName = currentProfile?.display_name || currentProfile?.handle || fallbackEmail || 'BASIL user';
  const secondary = currentProfile?.handle ? `@${currentProfile.handle}` : currentProfile?.email || fallbackEmail || '';
  const initial = displayName.trim().charAt(0).toUpperCase() || 'B';

  profileName.textContent = displayName;
  profileHandle.textContent = secondary;
  profileAvatar.innerHTML = currentProfile?.avatar_url
    ? `<img src="${escapeHtml(currentProfile.avatar_url)}" alt="" />`
    : initialHtml(initial);
  profileForm.elements.display_name.value = currentProfile?.display_name || '';
  profileForm.elements.email.value = currentProfile?.email || fallbackEmail || '';
}

async function loadProfile() {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', currentSession.user.id)
    .maybeSingle();

  if (error) throw error;
  currentProfile = data || { id: currentSession.user.id, email: currentSession.user.email };
  renderProfile();
  renderUserMenu({ profile: currentProfile, user: currentSession.user });
}

async function saveProfile(event) {
  event.preventDefault();
  const data = new FormData(profileForm);
  const displayName = String(data.get('display_name') || '').trim() || 'User';
  const email = String(data.get('email') || '').trim() || null;
  const displayNameChanged = String(currentProfile?.display_name || '').trim() !== displayName;

  setStatus('Ukladam profil...');
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const patch = {
      id: currentSession.user.id,
      display_name: displayName,
      email,
    };

    if (displayNameChanged) {
      patch.handle = buildHandle(displayName);
    }

    const { error } = await supabase.from('profiles').upsert(patch, { onConflict: 'id' });
    if (!error) {
      await loadProfile();
      await refreshSelectedHouseholdAfterProfileSave();
      setStatus('Profil je ulozeny.');
      return;
    }

    lastError = error;
    if (!String(error.message || '').toLowerCase().includes('duplicate')) break;
  }

  setStatus(lastError?.message || 'Profil sa nepodarilo ulozit.');
}

async function refreshSelectedHouseholdAfterProfileSave() {
  if (!selectedHouseholdId) return;

  const currentMember = getCurrentMember();
  if (currentMember?.id) {
    const { error } = await supabase.rpc('update_own_household_member_display_name', {
      target_household_id: selectedHouseholdId,
      next_display_name: currentMember.display_name || null,
    });

    if (error && !String(error.message || '').includes('update_own_household_member_display_name')) {
      throw error;
    }
  }

  await openHousehold(selectedHouseholdId);
}

async function loadHouseholds() {
  const { data, error } = await supabase
    .from('households')
    .select('id,name,owner_user_id,is_premium,created_at')
    .order('created_at', { ascending: true });

  if (error) throw error;
  households = Array.isArray(data) ? data : [];
  const storedActiveId = localStorage.getItem(ACTIVE_HOUSEHOLD_KEY);
  activeHouseholdId = households.some((household) => household.id === storedActiveId)
    ? storedActiveId
    : households[0]?.id || null;
  if (activeHouseholdId) localStorage.setItem(ACTIVE_HOUSEHOLD_KEY, activeHouseholdId);
  renderHouseholds();
}

function renderHouseholds() {
  if (households.length === 0) {
    householdList.innerHTML = '<p class="empty-state">Zatial nemas ziadnu domacnost.</p>';
    householdDetail.hidden = true;
    return;
  }

  householdList.innerHTML = households
    .map((household) => {
      const active = household.id === activeHouseholdId;
      const selected = household.id === selectedHouseholdId;
      const premium = isPremiumHousehold(household);
      return `
        <article class="settings-row ${active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}" data-household-id="${escapeHtml(household.id)}">
          <button type="button" class="settings-row-main" data-action="open-household">
            <strong>${escapeHtml(household.name)}</strong>
            <span class="household-row-meta">
              <span>${active ? 'Aktivna domacnost' : 'Domacnost'}</span>
              ${
                premium
                  ? '<small class="premium-chip is-premium household-premium-chip">Premium</small>'
                  : '<span>Free</span>'
              }
            </span>
          </button>
          <div class="settings-row-actions">
            <button type="button" data-action="activate-household">${active ? 'Aktivna' : 'Aktivovat'}</button>
            <button type="button" data-action="open-household">${selected ? 'Zavriet' : 'Spravovat'}</button>
          </div>
        </article>
      `;
    })
    .join('');

  placeHouseholdDetail();
}

function placeHouseholdDetail() {
  if (!selectedHouseholdId || householdDetail.hidden) return;
  const selectedRow = householdList.querySelector(`[data-household-id="${selectedHouseholdId}"]`);
  if (!selectedRow) {
    householdDetail.hidden = true;
    return;
  }

  selectedRow.insertAdjacentElement('afterend', householdDetail);
}

function closeHouseholdDetail() {
  selectedHouseholdId = null;
  householdDetail.hidden = true;
  renderHouseholds();
}

async function toggleHousehold(householdId) {
  if (selectedHouseholdId === householdId && !householdDetail.hidden) {
    closeHouseholdDetail();
    return;
  }

  await openHousehold(householdId);
}

async function createHousehold() {
  const name = window.prompt('Nazov novej domacnosti', 'Nova domacnost');
  const trimmed = String(name || '').trim();
  if (!trimmed) return;

  setStatus('Vytvaram domacnost...');
  const { data: household, error: householdError } = await supabase
    .from('households')
    .insert({ name: trimmed, owner_user_id: currentSession.user.id })
    .select('id,name,owner_user_id,is_premium,created_at')
    .single();

  if (householdError) {
    setStatus(householdError.message);
    return;
  }

  const { error: memberError } = await supabase.from('household_members').insert({
    household_id: household.id,
    user_id: currentSession.user.id,
    email: currentSession.user.email || currentProfile?.email || null,
    handle: currentProfile?.handle || null,
    display_name: currentProfile?.display_name || currentSession.user.email || 'User',
    role: 'owner',
    status: 'accepted',
  });

  if (memberError) {
    setStatus(memberError.message);
    return;
  }

  localStorage.setItem(ACTIVE_HOUSEHOLD_KEY, household.id);
  selectedHouseholdId = household.id;
  await loadHouseholds();
  await openHousehold(household.id);
  setStatus('Domacnost je vytvorena.');
}

async function loadMembers(householdId) {
  const { data, error } = await supabase
    .from('household_members')
    .select('id,household_id,user_id,email,handle,display_name,role,status,invite_id,created_at')
    .eq('household_id', householdId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  selectedMembers = Array.isArray(data) ? data : [];
}

async function openHousehold(householdId) {
  selectedHouseholdId = householdId;
  await loadMembers(householdId);

  const household = households.find((item) => item.id === householdId);
  householdDetail.hidden = false;
  householdDetailTitle.textContent = household?.name || 'Domacnost';
  householdForm.elements.name.value = household?.name || '';
  activateHouseholdButton.disabled = householdId === activeHouseholdId;
  activateHouseholdButton.textContent = householdId === activeHouseholdId ? 'Aktivna domacnost' : 'Nastavit ako aktivnu';
  const currentMember = getCurrentMember();
  householdNicknameForm.hidden = !currentMember?.id;
  householdNicknameForm.elements.display_name.value = currentMember?.display_name || currentProfile?.display_name || '';

  renderMembers();
  renderHouseholds();
  householdDetail.hidden = false;
  placeHouseholdDetail();
}

function renderMembers() {
  const currentMember = getCurrentMember();
  const currentRole = currentMember?.role || '';
  const manage = canManageMembers();
  const inviteAllowed = canInviteMembers();

  inviteForm.hidden = !manage;
  inviteHint.textContent = manage
    ? (inviteAllowed ? '' : 'Pozvanie clenov je dostupne pre owner/admin v Premium domacnosti alebo Premium ucte.')
    : 'Clenov moze spravovat iba owner alebo admin.';

  deleteHouseholdButton.hidden = currentRole !== 'owner';
  leaveHouseholdButton.hidden = currentRole === 'owner' || !currentMember;

  if (selectedMembers.length === 0) {
    memberList.innerHTML = '<p class="empty-state">Zatial ziadni clenovia.</p>';
    return;
  }

  memberList.innerHTML = selectedMembers
    .map((member) => {
      const isCurrentUser = member.id === currentMember?.id;
      const canEditRole = manage && member.role !== 'owner' && (currentRole === 'owner' || member.role !== 'admin');
      const canRemove = member.role !== 'owner' && (isCurrentUser || manage);
      const meta = [member.handle || member.email || '', member.status === 'invited' ? 'Pozvany' : '', isCurrentUser ? 'Ty' : '']
        .filter(Boolean)
        .join(' · ');

      return `
        <article class="settings-row" data-member-id="${escapeHtml(member.id)}">
          <div class="settings-row-main as-static">
            <strong>${escapeHtml(getMemberLabel(member))}</strong>
            <span>${escapeHtml(meta)}</span>
          </div>
          <div class="settings-row-actions">
            ${
              canEditRole
                ? `
                  <select data-action="change-role" aria-label="Rola">
                    <option value="editor" ${member.role !== 'admin' ? 'selected' : ''}>Member</option>
                    <option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Admin</option>
                  </select>
                `
                : `<span class="qty-chip">${normalizeRoleForDisplay(member.role)}</span>`
            }
            ${canRemove ? `<button type="button" class="remove" data-action="remove-member">${isCurrentUser ? 'Odstranit moj pristup' : 'Odstranit'}</button>` : ''}
          </div>
        </article>
      `;
    })
    .join('');
}

async function saveHouseholdNameValue({ reload = true } = {}) {
  if (!selectedHouseholdId) return;

  const name = String(new FormData(householdForm).get('name') || '').trim();
  if (!name) return;

  const { error } = await supabase.from('households').update({ name }).eq('id', selectedHouseholdId);
  if (error) throw error;

  if (reload) {
    await loadHouseholds();
    await openHousehold(selectedHouseholdId);
  }
}

async function saveHouseholdName(event) {
  event.preventDefault();

  try {
    setStatus('Ukladam domacnost...');
    await saveHouseholdNameValue();
    setStatus('Domacnost je ulozena.');
  } catch (error) {
    setStatus(error.message || 'Domacnost sa nepodarilo ulozit.');
  }
}

async function saveHouseholdNicknameValue({ reload = true } = {}) {
  const currentMember = getCurrentMember();
  if (!selectedHouseholdId || !currentMember?.id) return;

  const displayName = String(new FormData(householdNicknameForm).get('display_name') || '').trim() || null;

  let { error } = await supabase.rpc('update_own_household_member_display_name', {
    target_household_id: selectedHouseholdId,
    next_display_name: displayName,
  });

  if (error && String(error.message || '').includes('update_own_household_member_display_name')) {
    const fallback = await supabase
      .from('household_members')
      .update({ display_name: displayName })
      .eq('household_id', selectedHouseholdId)
      .eq('id', currentMember.id);
    error = fallback.error;
  }

  if (error) throw error;

  if (reload) {
    await openHousehold(selectedHouseholdId);
  }
}

async function saveHouseholdNickname(event) {
  event.preventDefault();

  try {
    setStatus('Ukladam meno v domacnosti...');
    await saveHouseholdNicknameValue();
    setStatus('Meno v domacnosti je ulozene.');
  } catch (error) {
    setStatus(error.message || 'Meno v domacnosti sa nepodarilo ulozit.');
  }
}

async function saveHouseholdChanges() {
  if (!selectedHouseholdId) return;

  try {
    setStatus('Ukladam zmeny domacnosti...');
    await saveHouseholdNameValue({ reload: false });
    await saveHouseholdNicknameValue({ reload: false });
    await loadHouseholds();
    await openHousehold(selectedHouseholdId);
    setStatus('Zmeny domacnosti su ulozene.');
  } catch (error) {
    setStatus(error.message || 'Zmeny domacnosti sa nepodarilo ulozit.');
  }
}

async function activateHousehold(householdId = selectedHouseholdId) {
  if (!householdId) return;
  activeHouseholdId = householdId;
  localStorage.setItem(ACTIVE_HOUSEHOLD_KEY, householdId);
  renderHouseholds();
  if (selectedHouseholdId) await openHousehold(selectedHouseholdId);
}

async function inviteMember(event) {
  event.preventDefault();
  if (!selectedHouseholdId || !canInviteMembers()) return;

  clearInviteFieldErrors();
  const data = new FormData(inviteForm);
  const target = String(data.get('target') || '').trim();
  if (!target) {
    setInviteFieldError('target', 'Zadaj email alebo handle.');
    return;
  }

  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target);
  const isHandle = /^.{1,80}#\d{4}$/.test(target);
  if (!isEmail && !isHandle) {
    setInviteFieldError('target', 'Zadaj email alebo handle vo formate meno#1234.');
    return;
  }

  const role = normalizeRoleForCloud(data.get('role'));
  setStatus('Posielam pozvanku...');

  const { error } = await supabase.rpc('create_household_invite_for_existing_user', {
    target_household_id: selectedHouseholdId,
    invite_target: isEmail ? target.toLowerCase() : target,
    invite_role: role,
  });

  if (error) {
    const inviteError = getInviteError(error);
    if (inviteError.field === 'target' || inviteError.field === 'role') {
      setInviteFieldError(inviteError.field, inviteError.message);
    } else {
      setStatus(inviteError.message);
    }
    return;
  }

  inviteForm.reset();
  clearInviteFieldErrors();
  await openHousehold(selectedHouseholdId);
  setStatus('Pozvanka je vytvorena.');
}

async function updateMemberRole(memberId, role) {
  const { error } = await supabase
    .from('household_members')
    .update({ role: normalizeRoleForCloud(role) })
    .eq('household_id', selectedHouseholdId)
    .eq('id', memberId);

  if (error) {
    setStatus(error.message);
    return;
  }

  await openHousehold(selectedHouseholdId);
}

async function removeMember(memberId) {
  if (!selectedHouseholdId || !memberId) return;
  if (!window.confirm('Naozaj odstranit pristup k tejto domacnosti?')) return;

  const { error } = await supabase
    .from('household_members')
    .delete()
    .eq('household_id', selectedHouseholdId)
    .eq('id', memberId);

  if (error) {
    setStatus(error.message);
    return;
  }

  await loadHouseholds();
  if (households.some((item) => item.id === selectedHouseholdId)) {
    await openHousehold(selectedHouseholdId);
  } else {
    householdDetail.hidden = true;
  }
}

async function deleteHousehold() {
  const household = households.find((item) => item.id === selectedHouseholdId);
  if (!household || !window.confirm(`Naozaj zmazat domacnost ${household.name}?`)) return;

  const { error } = await supabase.from('households').delete().eq('id', selectedHouseholdId);
  if (error) {
    setStatus(error.message);
    return;
  }

  selectedHouseholdId = null;
  householdDetail.hidden = true;
  await loadHouseholds();
  setStatus('Domacnost je zmazana.');
}

async function loadInvites() {
  const { data, error } = await supabase.rpc('list_household_invites_for_current_user');
  if (error) {
    setStatus(error.message);
    inviteList.innerHTML = '<p class="empty-state">Pozvanky sa nepodarilo nacitat.</p>';
    return;
  }

  renderInvites(Array.isArray(data) ? data : []);
}

function subscribeToSettingsChanges() {
  if (settingsRealtimeChannel) {
    supabase.removeChannel(settingsRealtimeChannel);
    settingsRealtimeChannel = null;
  }

  // Settings ma zostat aktualny aj po zmene z appky alebo ineho tabu.
  settingsRealtimeChannel = supabase
    .channel(`recipe-web-settings-${currentSession.user.id}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'profiles',
        filter: `id=eq.${currentSession.user.id}`,
      },
      () => {
        loadProfile().catch((error) => setStatus(error.message));
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'households',
      },
      async () => {
        try {
          await loadHouseholds();
          if (selectedHouseholdId && households.some((household) => household.id === selectedHouseholdId)) {
            await openHousehold(selectedHouseholdId);
          }
        } catch (error) {
          setStatus(error.message);
        }
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'household_members',
      },
      async () => {
        if (!selectedHouseholdId) return;
        try {
          await openHousehold(selectedHouseholdId);
        } catch (error) {
          setStatus(error.message);
        }
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'household_invites',
      },
      () => {
        loadInvites().catch((error) => setStatus(error.message));
      },
    )
    .subscribe();
}

function renderInvites(invites) {
  if (invites.length === 0) {
    inviteList.innerHTML = '<p class="empty-state">Ziadne cakajuce pozvanky.</p>';
    return;
  }

  inviteList.innerHTML = invites
    .map((invite) => {
      const sender = invite.invited_by_handle || invite.invited_by_display_name || invite.invited_by_email || 'neznamy pouzivatel';
      return `
        <article class="settings-row" data-invite-id="${escapeHtml(invite.id)}">
          <div class="settings-row-main as-static">
            <strong>${escapeHtml(invite.household_name || 'Domacnost')}</strong>
            <span>Pozval/a ${escapeHtml(sender)} · ${normalizeRoleForDisplay(invite.role)}</span>
          </div>
          <div class="settings-row-actions">
            <button type="button" class="primary" data-action="accept-invite">Prijat</button>
            <button type="button" data-action="decline-invite">Odmietnut</button>
          </div>
        </article>
      `;
    })
    .join('');
}

async function actOnInvite(inviteId, action) {
  const rpc = action === 'accept' ? 'accept_household_invite' : 'decline_household_invite';
  setStatus(action === 'accept' ? 'Prijimam pozvanku...' : 'Odmietam pozvanku...');

  const { error } = await supabase.rpc(rpc, { target_invite_id: inviteId });
  if (error) {
    setStatus(error.message);
    return;
  }

  await Promise.all([loadHouseholds(), loadInvites()]);
  setStatus(action === 'accept' ? 'Pozvanka je prijata.' : 'Pozvanka je odmietnuta.');
}

function bindEvents() {
  profileForm.addEventListener('submit', saveProfile);
  createHouseholdButton.addEventListener('click', createHousehold);
  refreshInvitesButton.addEventListener('click', loadInvites);
  householdForm.addEventListener('submit', saveHouseholdName);
  householdNicknameForm.addEventListener('submit', saveHouseholdNickname);
  activateHouseholdButton.addEventListener('click', () => activateHousehold());
  inviteForm.addEventListener('submit', inviteMember);
  inviteForm.elements.target.addEventListener('input', () => setInviteFieldError('target', ''));
  inviteForm.elements.role.addEventListener('change', () => setInviteFieldError('role', ''));
  saveHouseholdChangesButton.addEventListener('click', saveHouseholdChanges);
  deleteHouseholdButton.addEventListener('click', deleteHousehold);
  leaveHouseholdButton.addEventListener('click', () => removeMember(getCurrentMember()?.id));

  householdList.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const row = event.target.closest('[data-household-id]');
    if (!action || !row) return;

    if (action === 'activate-household') {
      await activateHousehold(row.dataset.householdId);
    } else {
      await toggleHousehold(row.dataset.householdId);
    }
  });

  memberList.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const row = event.target.closest('[data-member-id]');
    if (action === 'remove-member' && row) {
      await removeMember(row.dataset.memberId);
    }
  });

  memberList.addEventListener('change', async (event) => {
    if (event.target.dataset.action !== 'change-role') return;
    const row = event.target.closest('[data-member-id]');
    if (!row) return;
    await updateMemberRole(row.dataset.memberId, event.target.value);
  });

  inviteList.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const row = event.target.closest('[data-invite-id]');
    if (!action || !row) return;
    await actOnInvite(row.dataset.inviteId, action === 'accept-invite' ? 'accept' : 'decline');
  });

  window.addEventListener('beforeunload', () => {
    if (settingsRealtimeChannel) {
      supabase.removeChannel(settingsRealtimeChannel);
      settingsRealtimeChannel = null;
    }
  });
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
  bindEvents();

  try {
    await loadProfile();
    await Promise.all([loadHouseholds(), loadInvites()]);
    subscribeToSettingsChanges();
  } catch (error) {
    setStatus(error.message);
  }
}

init();
