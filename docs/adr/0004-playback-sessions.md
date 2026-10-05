# 0004. Playback sessions with cancellation

- Status: Accepted
- Date: 2026-10-04 (PR #7)

## Context
Old loads were only aborted after a new song finished loading, so an older selection could cancel a newer one, stopped radios kept loading, and hour timers piled up.

## Decision
- Each song is a session with its own `AbortController`. Aborting it cancels everything it started: weather request, download, timers, fades, and tears down its `<audio>`.
- Two slots: `pendingSession` (loading) and `currentSession` (audible). A new request aborts only the pending one; the current song keeps playing until the new one plays (muted until promoted).
- The next hour's song starts loading 60 s early (`PREFETCH_MS`); at the hour the old song fades out and the new one fades in.

## Consequences
- The last click wins; stop leaves nothing running; no silence at the hour.
- Every async step must take the session (or attempt) signal.
