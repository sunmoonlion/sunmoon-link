// Presence and the local API share a listener. Its public fields need no ticket: name, version, connected,
// device id, host, os, link state (ledger 143) and the Windows sandbox mode — none of them is a secret or names the account.
export { startLocalApi as startPresence } from "./localApi.js";
export type { LocalApiOptions as PresenceOptions, LocalApiHandle as PresenceHandle } from "./localApi.js";
