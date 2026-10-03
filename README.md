# chatwoot-workers

Two independently deployed Cloudflare Workers for Chatwoot support teams:

- [chatwoot-discord-relay](packages/chatwoot-discord-relay/README.md) mirrors conversations into Discord forum posts,
  with commands, agent replies, AI drafts, and the support queue.
- [chatwoot-router](packages/chatwoot-router/README.md) classifies tickets with TypeSafe Jev, assigns owners, adds
  topic and kind labels, and optionally replies or sets tickets aside.

Each package is published separately to npm and owns its own Durable Object. The router is a native Chatwoot
agent bot: `pending` is its turn, and leaving pending releases customer messages to the relay. Chatwoot status,
inbox bot links, assignment and messages provide coordination. Neither Worker calls the other or shares storage.

See each package's README for deployment and configuration, [CONTRIBUTING.md](CONTRIBUTING.md) for the npm
workspace development and release workflow, and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
Both packages use the [MIT license](LICENSE).
