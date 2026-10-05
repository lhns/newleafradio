# 0016. One PR per concern, no AI attribution

- Status: Accepted
- Date: 2026-10-04

## Decision
- Every change is its own branch and PR; dependent PRs are stacked and retargeted after merging.
- Commits and PR descriptions carry no AI attribution lines.
- Changes are tested in headless Chrome and Firefox before merging; what couldn't be tested (Safari, real devices) is stated in the PR.
