import { parseJobroloGoogleStart } from "./jobrolo-google-journey.js";

// Navigation only. The HCN session and immutable employee pin authorize the
// existing line-verification ceremony; an email hint never selects authority.
export const HCN_JOBROLO_QUO_START = "/hcn/connect/quo/jobrolo";
export const HCN_JOBROLO_QUO_CONSOLE = "/hcn/?quoSetup=1#connections";
export const parseJobroloQuoStart = parseJobroloGoogleStart;

export function jobroloQuoLoginPath(email) {
  const returnTo = `${HCN_JOBROLO_QUO_START}?${new URLSearchParams({ email, afterLogin: "1" })}`;
  return `/hcn/auth/login?${new URLSearchParams({ returnTo })}`;
}

export function jobroloQuoDestination(outcome = "failed") {
  const value = ["returned", "failed", "account_mismatch"].includes(outcome) ? outcome : "failed";
  return `https://jobrolo.com/app/home?quo=${value}`;
}
