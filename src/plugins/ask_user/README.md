# ask_user

Presents a question to the user with optional multiple-choice answers.

## Registration

- **Tool**: `ask_user`
- **Modes**: ask, act
- **Category**: act
- **Handler**: Parses options (semicolon or comma delimited) and upserts a `proposed` entry awaiting user response.

## Projection

Shows the question and answer attributes.

## Behavior

Options are split by semicolons first, falling back to commas. The entry stays in `proposed` state until resolved by the client.
