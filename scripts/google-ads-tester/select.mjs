// Account presentation and the opt-in, exactly-one link rules (DEV / VALIDATION TOOLING).
// Statuses are printed literally: an "unknown" test-account or manager status is never
// shown or treated as test / not_test / client.

const CUSTOMER_ID = /^\d{10}$/;

export function formatCustomerId(id) {
  return CUSTOMER_ID.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : String(id);
}

/** Digits of a typed customer id ("123-456-7890" or "1234567890"), or null when malformed. */
export function normalizeCustomerId(input) {
  const text = String(input ?? "").trim();
  if (!/^[\d-]+$/.test(text)) return null;
  const digits = text.replace(/-/g, "");
  return CUSTOMER_ID.test(digits) ? digits : null;
}

function managerLabel(status) {
  if (status === "manager") return "manager (not linkable)";
  if (status === "client") return "client";
  return "unknown (not reported by Google; not linkable)";
}

/** One discovered account as display fields (exact customer id, relation, statuses). */
export function describeAsset(asset) {
  return {
    customerId: formatCustomerId(asset.externalId),
    name: asset.name,
    type: managerLabel(asset.managerStatus),
    relation: asset.parentExternalId
      ? `client of manager ${formatCustomerId(asset.parentExternalId)}`
      : "directly accessible",
    testAccountStatus: asset.testAccountStatus,
    accountStatus: asset.status,
    linked: asset.linked ? "linked" : "not linked",
  };
}

export function describeAssetLine(asset) {
  const d = describeAsset(asset);
  return [
    d.customerId,
    `"${d.name}"`,
    `type=${d.type}`,
    `relation=${d.relation}`,
    `testAccountStatus=${d.testAccountStatus}`,
    `status=${d.accountStatus}`,
    d.linked,
  ].join(" | ");
}

/**
 * Selects exactly ONE discovered account for linking. Never links managers or accounts with
 * an unknown manager status. A test-account status other than "test" needs the explicit
 * acknowledgement flag, which never overrides Google's access rules.
 */
export function selectForLink(assets, customerIdInput, { allowNonTestAccount = false } = {}) {
  if (Array.isArray(customerIdInput) || /[,\s]/.test(String(customerIdInput ?? "").trim())) {
    return {
      ok: false,
      reason: "one_account_only",
      message: "Exactly one customer id may be linked.",
    };
  }
  const customerId = normalizeCustomerId(customerIdInput);
  if (customerId === null) {
    return {
      ok: false,
      reason: "invalid_customer_id",
      message: "Pass --customer as a 10-digit customer id.",
    };
  }
  const matches = assets.filter((a) => a.externalId === customerId);
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: "not_discovered",
      message: `${formatCustomerId(customerId)} was not discovered by this connection.`,
    };
  }
  const asset = matches[0];
  if (asset.linked) {
    return { ok: false, reason: "already_linked", message: "This account is already linked." };
  }
  if (asset.managerStatus === "manager") {
    return {
      ok: false,
      reason: "manager_not_linkable",
      message: "Manager accounts cannot be linked.",
    };
  }
  if (asset.managerStatus !== "client") {
    return {
      ok: false,
      reason: "manager_status_unknown",
      message: "Google did not report whether this is a client account; it cannot be linked.",
    };
  }
  const warnings = [];
  if (asset.testAccountStatus !== "test") {
    if (!allowNonTestAccount) {
      return {
        ok: false,
        reason: "not_confirmed_test_account",
        message: `Test-account status is "${asset.testAccountStatus}". Re-run with --allow-non-test-account to acknowledge (read-only; Google access rules still apply).`,
      };
    }
    warnings.push(
      `Acknowledged: test-account status is "${asset.testAccountStatus}". This flag is an acknowledgement only; Google API access restrictions still apply and are never bypassed.`,
    );
  }
  return { ok: true, asset, warnings };
}

/** The typed confirmation must be exactly the selected customer id (dashes optional). */
export function confirmationMatches(typed, asset) {
  const digits = normalizeCustomerId(typed);
  return digits !== null && digits === asset.externalId;
}
