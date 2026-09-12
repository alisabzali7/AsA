# Fundamental / News Connector Guide

Interface: `NewsConnector` (`src/lib/fundamental/engine.ts`): `id`, `name`, `configured`, `state()`, `poll() -> RawNewsItem[]`.

Built-in: `generic-rss` — enabled by `NEWS_RSS_URL`. Polls every `NEWS_POLL_MIN` minutes (default 30), parses RSS 2.0/Atom (title, link, guid, pubDate, description), classifies impact keywords (SEC/ETF/macro/regulation/hack/liquidation) and matches universe symbols.

Rules:
- append-only into `asa_news_events` with deterministic dedupe id (sha1(source + externalId/guid + title))
- original publication time and ingestion time preserved
- rolling 30-day retention (`RETENTION_NEWS_DAYS`, default 30): the retention job (`src/lib/retention.ts`, every 30 min) deletes only rows older than the window, records an audit row, and is visible on the System page
- with no connector configured the module reports NOT CONFIGURED everywhere; nothing is invented
- upcoming events calendar: items with `kind=upcoming`/`eventTime` surface in the calendar panel; no calendar connector is configured by default

Future connectors (X / crypto news vendors): implement `NewsConnector` and push into `connectors[]`.
