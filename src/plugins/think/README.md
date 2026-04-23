# think {#think_plugin}

Provides a `<think>` tag for model reasoning. Not a tool — does not
appear in the tool list.

## Registration

- **Scheme**: `think` — `category: "logging"`, `model_visible: 0`
- **No handler, no view, no tool registration**

## Behavior

The model writes `<think>reasoning</think>` before tool commands.
XmlParser captures it, TurnExecutor records it as a `think://` entry.
Invisible to the model on subsequent turns (`model_visible: 0`).
Available for debugging and audit.

Models with server-side reasoning (extended thinking) use that
capability independently. The `<think>` tag is a floor — every model
gets at least this.
