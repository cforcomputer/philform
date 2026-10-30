/**
 * Where model requests go.
 *
 * With the user's own keys (`direct` mode) each provider is called directly.
 * Through philform's service (`proxy` mode) the same request goes to the
 * backend's relay instead (backend/server.mjs): it holds the provider keys,
 * prices each call from the usage the provider reports, and charges the run's
 * wallet when the fill is done. The request and reply are the provider's own,
 * so nothing else in the extension changes between the two.
 *
 * One fill runs at a time, so the relay is set for the run (billing.js) and
 * cleared after it.
 *
 * A key of the user's own (`ownDeepseekKey`) goes straight to its provider
 * even during a relayed run: the service never sees that call, so the wallet
 * is charged only for what went through the relay.
 */

let relayNow = null;

/** Send model requests through the backend for this run: `{ url, token, runId }`, or null. */
export function useRelay(relay) {
  relayNow = relay && relay.url ? relay : null;
}

export function relayActive() {
  return !!relayNow;
}

/** The URL and headers for one request to `provider` ('typesafe' or 'deepseek'). */
export function route(provider, directUrl, apiKey) {
  if (!relayNow || (apiKey && apiKey !== 'relay')) {
    return { url: directUrl, headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` } };
  }
  return {
    url: `${relayNow.url.replace(/\/$/, '')}/v1/relay/${provider}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${relayNow.token}`, 'x-philform-run': relayNow.runId }
  };
}

/** A relay refusal in words a user can act on, or null when it is the provider's own error. */
export async function relayError(res) {
  if (!relayNow || !new URL(res.url || 'http://x/').pathname.startsWith('/v1/relay/')) return null;
  if (res.status === 402) return 'Your philform wallet is empty. Add $5 from the popup to keep filling.';
  if (res.status === 401 || res.status === 403) return 'philform could not sign you in. Reload the extension and try again.';
  if (res.status === 409) return 'This fill reached its spending cap.';
  if (res.status === 410) return 'This fill ran too long and was stopped. Run it again.';
  return null;
}
