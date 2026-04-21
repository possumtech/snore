/**
 * Server↔client wire-protocol version. Bumped whenever the RPC shape
 * or notification payload shape changes in a way that breaks existing
 * clients. Clients pass their own version in `rummy/hello`; server
 * rejects MAJOR mismatch. Git commit log is the changelog.
 *
 *   MAJOR — breaking change (removed/renamed method, shape change)
 *   MINOR — additive change (new method, new optional field)
 *   PATCH — internal fix visible to the wire shape
 */
export const RUMMY_PROTOCOL_VERSION = "2.0.0";
