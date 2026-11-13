# Brief Executive Write-Up: Approach, Trade-Offs & Production Evolution

## Approach

I prioritized the support workflow and the data that makes responses useful: the author's book, ISBN, status, sales, and royalty figures. The API selects a single BookLeaf policy section and only the referenced book context for AI triage and draft generation. It validates model output against the allowed categories and priorities, and uses a deterministic policy-grounded fallback when no key is configured or the provider fails. Admins can override triage and edit drafts before sending.

The supplied 10-author, 18-book dataset is served by the backend. The author portal and admin portal now use API authentication, role-specific data, persisted tickets and conversations, server-side AI drafts, triage endpoints, and author-scoped server-sent updates.

## Trade-offs and current limits

To keep the assessment prototype small, ticket persistence uses an atomic JSON file instead of a database; this is suitable for one demo instance and not concurrent or horizontally scaled workloads. Ticket attachments retain metadata only; the file is not uploaded. Retail/print partner actions are not integrated, and the stock availability workflow creates a support request for the team. No live URL has been deployed from this workspace.

## Production evolution

Next replace shared demo credentials with per-user password hashes or managed identity. Move tickets, messages, internal notes, and seed records into PostgreSQL with migrations and transactional writes. Store uploads in object storage, add request rate limits and audit history, and use a shared pub/sub system for realtime updates across instances. Add evaluation examples for classification and draft quality, measuring fallback rate, response edit rate, latency, and cost before changing prompts or models.
