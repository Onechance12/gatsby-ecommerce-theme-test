/** Check the current principal only. Never disclose tokens/provider bodies. */
export async function checkHcnGmailHealth({ getAccessToken, readProfile, email }) {
  try {
    const token = await getAccessToken();
    const profile = await readProfile(token);
    if (typeof profile?.emailAddress !== "string"
      || profile.emailAddress.toLowerCase() !== String(email).toLowerCase()) {
      return { gmail: "not_connected", verification: "live", reason: "account_mismatch" };
    }
    return { gmail: "connected", verification: "live", reason: "verified" };
  } catch (error) {
    const reconnect = error?.hcnSourceFailureCode === "google_not_linked"
      || error?.statusCode === 401;
    return { gmail: reconnect ? "not_connected" : "unavailable", verification: "live",
      reason: reconnect ? "reconnect_required" : error?.statusCode === 403 ? "permission_denied" : "provider_check_failed" };
  }
}
