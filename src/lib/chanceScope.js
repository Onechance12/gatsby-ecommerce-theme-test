export const CHANCE_NAME = "Chance Pearson";

const CHANCE_PATTERN = /chance\s+pearson/i;

export function findChanceUserIds(accountUsersPayload) {
  const ids = new Set();
  for (const user of asRows(accountUsersPayload)) {
    if (!user || typeof user !== "object") continue;
    const name = [
      user.display_name,
      user.displayName,
      user.name,
      [user.first_name, user.last_name].filter(Boolean).join(" "),
      [user.firstName, user.lastName].filter(Boolean).join(" ")
    ].filter(Boolean).join(" | ");
    if (CHANCE_PATTERN.test(name)) {
      for (const id of [user.jnid, user.id, user.recid]) {
        if (id != null && String(id).trim()) ids.add(String(id));
      }
    }
  }
  return ids;
}

export function isChanceContact(contact, chanceUserIds = new Set()) {
  if (!contact || typeof contact !== "object") return false;

  const owners = Array.isArray(contact.owners) ? contact.owners : [];
  for (const owner of owners) {
    if (!owner) continue;
    if (chanceUserIds.has(String(owner.id ?? owner.jnid ?? ""))) return true;
    if (CHANCE_PATTERN.test(String(owner.name || ""))) return true;
  }

  for (const idField of [contact.sales_rep, contact.assigned_to, contact.created_by]) {
    if (idField != null && chanceUserIds.has(String(idField))) return true;
  }

  const nameText = [
    contact.sales_rep_name,
    contact.assigned_to_name,
    contact.owner_name,
    contact.created_by_name
  ].filter(Boolean).join(" | ");

  // created_by_name alone is too weak a signal; only trust it when there is no owner data at all.
  if (CHANCE_PATTERN.test(String(contact.sales_rep_name || ""))) return true;
  if (CHANCE_PATTERN.test(String(contact.assigned_to_name || contact.owner_name || ""))) return true;
  if (!owners.length && !contact.sales_rep_name && CHANCE_PATTERN.test(nameText)) return true;

  return false;
}

function asRows(payload) {
  if (Array.isArray(payload)) {
    // JobNimbus /account/users comes back as a single-item array wrapping
    // { users: [...], date_updated } rather than a flat list of users.
    if (payload.length === 1 && Array.isArray(payload[0]?.users)) {
      return payload[0].users;
    }
    return payload;
  }
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.users)) return payload.users;
  return payload ? [payload] : [];
}
