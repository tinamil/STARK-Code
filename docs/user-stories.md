# STARK Code: user stories

Who it is for: a developer on a locked-down machine (no marketplace, possibly no internet) using the STARK gateway or another OpenAI-compatible endpoint.

Each story lists where it stands. "Built" means implemented and covered by automated tests; anything that has only been checked outside real VS Code says so.

## Setup
1. **First run.** I install the .vsix, enter a URL, model and key, and get a working answer within 2 minutes.
   - Built: the Setup panel opens on first run. **Test connection** checks the server, a tool call and its result, and reports rate limits, a locked key or an expiring key.
2. **Switch models.** I switch models without opening Settings.
   - Built: model dropdown in the header, filled from the server. Models without tool support are marked.

## Everyday coding
3. **Small fix.** I describe a bug in one sentence; the agent finds the code, edits it and shows me the change. I approve in one keystroke.
   - Built: the approval card shows the diff and the agent's one-line reason. Enter allows, Esc denies, only while focus is on the card.
4. **Feature across files.** I ask for a feature touching 5+ files. The agent plans it, makes the edits, runs the build and tests, and fixes failures.
   - Built: task list, edits, commands. Not yet measured with the real model on a large task.
5. **Explain code.** I select code and ask what it does. The agent reads related files and answers without editing.
   - Built: the selection or active file is included with the message; reading never asks for approval inside the workspace.
6. **Run and fix tests.** I say "make the tests pass". The agent runs them, reads the failures and iterates, and I can watch.
   - Built: commands run in PowerShell on Windows, with live output in the panel.

## Control and trust
7. **Review before applying.** I see a diff of each edit and can accept, reject, or reject with feedback.
   - Built.
8. **Hands-off mode.** I let the agent work with fewer prompts when I trust the task.
   - Built: `autoEdit` and `auto` approval modes, "Always allow" per tool for the session, and read-only commands and PowerShell scripts run without asking.
   - Open: the read-only checks have not had an independent security review.
9. **Stop and redirect.** I can stop the agent, or add instructions while it works.
   - Built: Stop button; messages typed while it works are queued and delivered after the current step.
10. **Undo.** I can revert everything the agent changed since a given message.
    - Built: Rewind restores edited files (exact bytes and encoding) and the conversation. Edits to open files can also be undone with Ctrl+Z. Changes made by shell commands are not tracked.
11. **No surprises.** The agent never runs destructive commands or edits outside the workspace without asking, whatever mode I am in.
    - Built. A stray key press can't answer a prompt, and a prompt scrolled out of view is flagged.

## Long work
12. **Long session.** I work with the agent for an hour and it still remembers what I asked for.
    - Built: stale output is trimmed and older steps are summarized as it goes. My requests, the files it changed and the task list are kept word for word. `/compact` does this on demand.
13. **Resume later.** I close VS Code and reopen the previous chat the next day.
    - Built: History per workspace; the newest 100 chats are kept for 90 days.

## Team and environment
14. **Project rules.** I commit an AGENTS.md with conventions and the agent follows it for everyone.
    - Built: AGENTS.md, CLAUDE.md, `.github/copilot-instructions.md` and `.oai-agent.md` are added to the system prompt.
15. **Offline.** Everything except fetching web pages works against an internal endpoint, with no other outbound calls.
    - Built: the only requests are to the configured endpoint, plus `web_fetch` when the agent asks and I approve. There is no update check.
16. **Shared limits.** I stay inside my gateway budget without thinking about it.
    - Built: the agent reads the gateway's rate-limit headers, waits instead of hitting a limit, keeps requests under the per-minute token limit, and shows the daily credits.

## Not built
- Updates: users re-download the .vsix when a new version is announced.
- Images, MCP servers and sub-agents.
