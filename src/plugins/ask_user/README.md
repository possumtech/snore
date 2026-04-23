# ask_user {#ask_user_plugin}

Presents a question to the user with optional multiple-choice answers.

## Registration

- **Tool**: `ask_user`
- **Category**: `logging`
- **Handler**: Parses options (semicolon or comma delimited) and upserts at status 202 (proposed) awaiting user response.

## Projection

Shows the question and answer attributes.

## Behavior

Options are split by semicolons first, falling back to commas. The entry
stays at status 202 until resolved by the client via `run/resolve`.
