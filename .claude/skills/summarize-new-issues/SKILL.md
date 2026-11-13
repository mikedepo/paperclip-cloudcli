---
name: summarize-new-issues
description: Summarize the GitHub issues opened since the previous weekday's run, for this repo.
---

# Summarize new issues

1. Work out the window: issues created in the last 24 hours (on Monday, the last 72 hours, to cover the weekend).
2. List them with the GitHub CLI (read-only):
   `gh issue list --state open --search "created:>=<ISO date-time>" --json number,title,author,labels,createdAt,url,body --limit 100`
3. Write a short summary:
   - Total count of new issues.
   - One line per issue: `#number title (author, labels)` with its link, and a one-sentence gist of the body.
   - Group related issues together, and flag any that look urgent (bugs, outages, security).
   - If there are none, say "No new issues."
4. Do not comment on, label or change any issue.
5. Put the summary in the task's closing comment, then mark the task done with a one-line summary (e.g. "3 new issues"), or blocked with the reason if something failed (e.g. `gh` not authenticated).
