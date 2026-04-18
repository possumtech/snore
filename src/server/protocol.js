/**
 * Server↔client wire-protocol version. Bumped whenever the RPC shape
 * or notification payload shape changes in a way that breaks existing
 * clients. Git commit log is the human-readable changelog; this
 * constant is the machine-readable gate.
 *
 * Semver-ish:
 *   MAJOR — breaking change (removed/renamed method, shape change)
 *   MINOR — additive change (new method, new optional field)
 *   PATCH — internal fix visible to the wire shape
 *
 * Clients SHOULD check the MAJOR on `rummy/hello` and refuse to operate
 * on mismatch.
 */
export const RUMMY_PROTOCOL_VERSION = "1.0.0";
