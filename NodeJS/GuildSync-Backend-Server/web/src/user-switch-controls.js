const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const canUseUserSwitch = user => Boolean(user?.user_switch?.actor_id && (user.user_switch.active || user.user_switch.can_switch !== false));
export function renderUserSwitchControls(user = {}, users = []) {
 if (!canUseUserSwitch(user)) return '';
 const state = user.user_switch;
 if (state.active) return `<section class="profile-section" aria-label="Switch account"><p>Acting as ${escape(state.target_name || user.display_name)}</p><button id="returnToMyAccount" class="discord-secondary-button" type="button">Return to my account</button></section>`;
 return `<section class="profile-section" aria-label="Switch account"><label for="switchGuildSyncAccount">Act as account</label><select id="switchGuildSyncAccount" class="discord-secondary-button"><option value="">Select an approved account</option>${users.filter(u => String(u.discord_user_id) !== String(state.actor_id)).map(u => `<option value="${escape(u.discord_user_id)}">${escape(u.display_name || u.username || u.discord_user_id)} (${escape(u.role)})</option>`).join('')}</select></section>`;
}
