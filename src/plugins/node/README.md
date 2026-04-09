# node — Integrated Node Development

Multiplexed suite for Node.js testing, profiling, and tracing.

## Overview

The `node` plugin empowers the model to dynamically engage with the project's
runtime environment. It provides a unified namespace (`node://`) for all
execution artifacts, allowing the model to trigger tests, analyze performance,
and debug failures using standard Rummy verbs.

## Usage

### Trigger an Action

```xml
<node action="test" path="src/auth.test.js"/>
<node action="profile" path="bin/server.js"/>
<node action="coverage" path="src/"/>
```

### Investigate Results

Once an action is resolved by the client, use standard `<get>` to explore:

```xml
<!-- Load the test report -->
<get path="node://test/src/auth.test.js"/>

<!-- Filter a large trace for errors -->
<get path="node://trace/run_123">AuthError</get>
```

## Architecture

1. **Multiplexer**: A single tool (`<node>`) and scheme (`node://`) handle
   multiple development concerns (test, profile, trace, coverage).
2. **Proposals**: All Node actions are recorded as 202-status proposals. The
   Rummy server never executes code; it only projects the results.
3. **Investigation**: Filtering and drill-down are handled through the standard
   `<get>` tool, leveraging the `node` plugin's internal filtering logic.

## Client-Side Requirements

To resolve `<node>` proposals, the client must implement an executor that:
1. Listens for `node://` entries with `status: 202`.
2. Maps the `action` attribute to a local command (e.g., `node --test`).
3. Executes the command and captures the output.
4. Calls the `resolve` RPC method with the output and metadata.
