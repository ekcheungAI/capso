/** Pure classification of a direct-ingest response, kept executable in Node tests. */
export function directDeliveryOutcome(status, body, expectedId) {
  if (status === 404 || status === 501) return { kind: "legacy" };
  if (status === 401 || status === 403) return { kind: "unpaired" };
  if (status >= 200 && status < 300) {
    return body?.screenshot_id === expectedId
      ? { kind: "delivered" }
      : { kind: "retry", message: "Capso returned the wrong delivery receipt." };
  }
  return { kind: "retry", message: `Capso direct delivery responded ${status}.` };
}
