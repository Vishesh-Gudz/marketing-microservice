/** Google Ads customer ids: exactly 10 ASCII digits (the API form, without dashes). */
const CUSTOMER_ID = /^[0-9]{10}$/;

export function isGoogleCustomerId(value: unknown): value is string {
  return typeof value === "string" && CUSTOMER_ID.test(value);
}

/**
 * Display form "123-456-7890". Anything that is not a 10-digit id is returned unchanged.
 * Display only: the dashboard never accepts a typed customer id, and the server decides which
 * discovered account may be linked.
 */
export function formatCustomerId(id: string): string {
  return isGoogleCustomerId(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;
}
