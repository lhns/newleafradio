# Architecture decision records

| # | Decision | Status |
|---|---|---|
| [0001](0001-static-site-on-github-pages.md) | Static site on GitHub Pages without a build step | Accepted |
| [0002](0002-wall-clock-sync.md) | Synchronize playback to the wall clock | Accepted, extended by 0012 |
| [0003](0003-songs-on-ipfs.md) | Host the songs on IPFS | Accepted |
| [0004](0004-playback-sessions.md) | Playback sessions with cancellation | Accepted |
| [0005](0005-service-worker-streaming.md) | Stream songs through a service worker | Accepted |
| [0006](0006-never-abort-verified-fetch.md) | Never abort verified-fetch, cancel bodies instead | Accepted |
| [0007](0007-no-recursive-gateway.md) | Fetch from providers directly, without a recursive gateway | Accepted |
| [0008](0008-stalls-retries-fallback.md) | Stall detection, retries and fallback | Accepted |
| [0009](0009-long-lived-sessions.md) | Keep verified-fetch sessions alive | Accepted |
| [0010](0010-range-cap.md) | Cap open-ended ranges and read-ahead | Accepted |
| [0011](0011-service-worker-logs.md) | Show service worker logs in the page console | Accepted |
| [0012](0012-converging-sync.md) | Converge playback by seeking and rate changes | Accepted |
| [0013](0013-acoustic-sync-button.md) | Manual sync button using the music itself | Accepted |
| [0014](0014-sync-analysis.md) | How the sync analysis finds the devices | Accepted |
| [0015](0015-mp4-song-files.md) | Songs as mp3 in MP4 instead of VBR mp3 | Accepted |
| [0016](0016-workflow.md) | One PR per concern, no AI attribution | Accepted |

Format: context, decision, consequences. Numbers are permanent; a changed decision gets a new record that supersedes the old one.
