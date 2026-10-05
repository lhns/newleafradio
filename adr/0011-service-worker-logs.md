# 0011. Show service worker logs in the page console

- Status: Accepted
- Date: 2026-10-05 (PR #12)

## Context
The service worker's console is hard to find, and stalled downloads logged nothing, so problems were invisible to users and maintainers.

## Decision
- The service worker forwards `console.debug/info/warn/error`, uncaught errors and unhandled rejections to all pages, logged as `[service worker] …`.
- Every IPFS download logs its timeline at debug level (start, status, finished or cancelled with bytes); stalls warn, failures error.
- The page warns when no service worker controls it (whole-file downloads).

## Consequences
A user's console (or HAR) is enough to diagnose loading problems. Debug lines are hidden by default in Chrome ("Verbose").
