// Navigation context only. This cookie never authenticates, selects a principal,
// grants access, or certifies success; existing OAuth/session checks do that.
export const HCN_JOBROLO_GOOGLE_START = "/hcn/connect/google/jobrolo";
export const HCN_JOBROLO_GOOGLE_RETURN = "/hcn/connect/google/jobrolo/return";
export const HCN_JOBROLO_GOOGLE_COOKIE = "__Host-hcn_jobrolo_google";
export const HCN_JOBROLO_GOOGLE_OUTCOMES = new Set([
  "returned", "cancelled", "failed", "account_mismatch"
]);

export function jobroloGoogleDestination(outcome = "failed") {
  const value = HCN_JOBROLO_GOOGLE_OUTCOMES.has(outcome) ? outcome : "failed";
  return `https://jobrolo.com/app/home?gmail=${value}`;
}

export function jobroloGoogleCookie(clear = false) {
  return `${HCN_JOBROLO_GOOGLE_COOKIE}=${clear ? "" : "1"}; Path=/; Max-Age=${clear ? 0 : 900}; Secure; HttpOnly; SameSite=Lax`;
}

export function parseJobroloGoogleStart(url) {
  const keys = [...url.searchParams.keys()];
  const email = url.searchParams.get("email") || "";
  if (keys.some(key => !["email", "afterLogin"].includes(key))
    || new Set(keys).size !== keys.length
    || email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)
    || (url.searchParams.has("afterLogin") && url.searchParams.get("afterLogin") !== "1")) {
    throw new Error("Invalid Google connection request");
  }
  return { email: email.toLowerCase(), afterLogin: url.searchParams.get("afterLogin") === "1" };
}

export function jobroloGoogleLoginPath(email) {
  const returnTo = `${HCN_JOBROLO_GOOGLE_START}?${new URLSearchParams({ email, afterLogin: "1" })}`;
  return `/hcn/auth/login?${new URLSearchParams({ returnTo })}`;
}
