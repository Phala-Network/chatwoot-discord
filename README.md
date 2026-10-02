# chatwoot-workers

Two independently deployed Cloudflare Workers for Chatwoot support teams:

- [chatwoot-discord-relay](packages/chatwoot-discord-relay/README.md) mirrors conversations into Discord forum posts,
  with commands, agent replies, AI drafts, and the support queue.
- [chatwoot-router](packages/chatwoot-router/README.md) classifies tickets with TypeSafe Jev, assigns owners, adds
  topic and kind labels, and optionally replies or sets tickets aside.

Each package is published separately to npm and owns its own Durable Object. They coordinate **only through
Chatwoot conversation state**: assignments, status, labels, and the `routing_seen`, `routing_handled`, and
`routing_kind` custom attributes. Neither Worker calls the other or shares its storage.

See each package's README for deployment and configuration, [CONTRIBUTING.md](CONTRIBUTING.md) for the npm
workspace development and release workflow, and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
Both packages use the [MIT license](LICENSE).
