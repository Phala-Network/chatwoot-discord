# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-02

### Added

- First release: the TypeSafe Jev routing of chatwoot-discord-relay 0.28.0 as its own Cloudflare Worker. A new ticket
  gets its owner, its topic label, and its kind (with a canned response and a status, if the kind has them), once per
  version of its first three customer messages; people own the ticket after that. See "How it works" in the README.
- Signed per-account Chatwoot webhooks and a five-minute sweep; per-account `startAfterConversationId` for a cutover.
- Coordination with chatwoot-discord-relay through the conversation attributes `routing_seen`, `routing_handled`, and
  `routing_kind`.
- The `chatwoot-router-store-config` command and `chatwoot-router/stored-config`, for a configuration in KV.

[Unreleased]: https://github.com/Phala-Network/chatwoot-workers/compare/chatwoot-router@0.1.0...HEAD
[0.1.0]: https://github.com/Phala-Network/chatwoot-workers/releases/tag/chatwoot-router@0.1.0
