// Keep this policy identical in backend and bot; the parity test enforces it.
export function raffleAdminRoles(env = process.env) {
  const value = env.GUILDSYNC_RAFFLE_ADMIN_ROLES;
  return String(value === undefined ? 'Consigliere' : value).split(',').map(ref => ref.trim()).filter(Boolean);
}

export function hasRaffleAdminRole(roles, env = process.env) {
  const refs = raffleAdminRoles(env);
  return Array.from(roles?.values?.() || roles || []).some(role => refs.some(ref =>
    /^\d+$/.test(ref)
      ? String(role.id ?? role.role_id ?? '') === ref
      : String(role.name ?? role.role_name ?? '').trim().toLowerCase() === ref.toLowerCase()
  ));
}
