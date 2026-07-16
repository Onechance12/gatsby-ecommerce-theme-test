const CONTACT_FIELD_ALIASES = new Map([
  ["dateofloss", "cf_date_1"],
  ["dol", "cf_date_1"]
]);

function normalizedAlias(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function canonicalizeContactFieldAliases(fields) {
  const source = fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {};
  const explicitKeys = new Set(Object.keys(source).filter((key) => /^cf_[a-z]+_\d+$/i.test(key)));
  const canonical = {};

  for (const [key, value] of Object.entries(source)) {
    const target = CONTACT_FIELD_ALIASES.get(normalizedAlias(key)) || key;
    if (target !== key && explicitKeys.has(target)) continue;
    if (Object.hasOwn(canonical, target) && canonical[target] !== value) {
      throw new Error(`Conflicting values were provided for JobNimbus field ${target}.`);
    }
    canonical[target] = value;
  }

  return canonical;
}
