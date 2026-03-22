# RUMMY: File Visibility Superstrate (Authoritative Context Control)

This document defines how Rummy manages the model's perception of the codebase. It establishes a **superstrate** (authoritative layer) that overrides Git or filesystem permissions.

## 1. The Visibility Matrix

The `visibility` state in the `repo_map_files` table is the source of truth for all Rummy and model operations.

| Visibility | RepoMap (Symbols) | Content (Body) | Edit (Write) | Notes |
| :--- | :---: | :---: | :---: | :--- |
| **`active`** | Yes | Yes | **YES** | Files the model is currently working on. |
| **`read_only`**| Yes | Yes | **NO** | Reference files. Model sees `<file read-only="true">`. |
| **`mappable`** | **YES** | No | No | Visible to model's "map" for context/navigation. |
| **`ignored`** | No | No | No | Completely hidden from the model. |

## 2. The Superstrate Hierarchy

The system follows a strict hierarchy to determine what the model sees.

1.  **Persistent Superstrate (Database)**: The `visibility` column in `repo_map_files` is final. If a file is marked `ignored`, the model **never** sees it.
2.  **Volatile State (Client Buffers)**: The list of `projectBufferFiles` sent by the client is a hint.
    *   If a buffer's visibility is `active`, it is sent to the model with full body.
    *   If a buffer's visibility is `read_only`, it is sent to the model with full body and `read-only="true"`.
    *   If a buffer's visibility is `mappable` or `ignored`, its content is **rejected** and never reaches the model.
3.  **Base Layer (Git/FS)**: Git provides the initial state (e.g., untracked vs. ignored), but this is strictly a **one-time or background suggestion** that is overridden by the database.

## 3. Client Interaction Model

The client is considered "dumb" and may send buffers for any file. Rummy is responsible for filtering.

### Explicit State Changes
Only an explicit call to `updateFiles` or `drop` can transition a file between visibility states. Opening or closing a file in the IDE **MUST NOT** change its visibility in the database.

### RPC: `fileStatus`
Retrieves the current authoritative state of a file from the superstrate.

**Request:**
```json
{ "method": "fileStatus", "params": { "path": "src/logic.js" } }
```
**Response:**
```json
{
  "result": {
    "path": "src/logic.js",
    "visibility": "active",
    "is_buffered": true,
    "is_git_ignored": false,
    "size": 5120
  }
}
```

### RPC: `updateFiles`
Explicitly overrides the visibility of one or more files.

**Request:**
```json
{
  "method": "updateFiles",
  "params": {
    "files": [
      { "path": "src/config.js", "visibility": "read_only" }
    ]
  }
}
```

### RPC: `getFiles`
Returns the visibility status for the entire project tree.

**Request:**
```json
{ "method": "getFiles", "params": {} }
```

### RPC: `drop`
Authoritatively demotes files matching a glob pattern to the `mappable` state and clears their retention flag. This is useful for clearing model focus without losing the file's presence in the map.

**Request:**
```json
{
  "method": "drop",
  "params": {
    "pattern": "*" 
  }
}
```
**Examples:**
*   `"*"`: Demote everything in the project.
*   `"src/*.js"`: Demote all JS files in src.
*   `"test/**"`: Demote all files in the test directory and its subdirectories.

## 4. Implementation Guidelines

*   **`AgentLoop.js`**: Before constructing the `<context>` block for the model, filter all `projectBufferFiles` against the database's `active` or `read_only` status.
*   **`RepoMap.js`**: When generating the symbolic map, only include files with visibility `active`, `read_only`, or `mappable`.
*   **`ProjectAgent.js`**: Reconcile Git status into the database but preserve any explicit overrides made by the user.
