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
 * Clients pass their own protocol version in `rummy/hello`. The server
 * rejects MAJOR mismatch.
 *
 * 2.0.0 — Client surface collapsed to the six primitives
 *   (set/get/rm/cp/mv/update) plus `rummy/hello` and minor config
 *   verbs. ask/act/init/run-lifecycle/legacy-get-store all dead.
 *   Runs are addressable as `run://<alias>` entries; start/cancel
 *   via set.
 * 1.x — Ask/act-based lifecycle (retired).
 */
export const RUMMY_PROTOCOL_VERSION = "2.0.0";
