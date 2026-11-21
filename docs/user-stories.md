# OAI Agent: user stories (draft)

Assumption: the main user is a developer on a locked-down machine (no marketplace, possibly no internet) using an internal or self-hosted OpenAI-compatible model.

## Setup
1. **First run.** As a developer, I install the .vsix, enter a URL, model and key, and get a working answer within 2 minutes.
   - The first message checks the connection and tool-calling support, and shows a clear error if either fails.
2. **Switch models.** As a developer, I switch between a fast model and a strong model without opening Settings.

## Everyday coding
3. **Small fix.** As a developer, I describe a bug in one sentence and the agent finds the code, edits it and shows me what changed. I approve each edit in one keystroke.
4. **Feature across files.** As a developer, I ask for a feature touching 5+ files. The agent plans it (todo list), makes the edits, runs the build and tests, and fixes failures without me stepping in, except for approvals.
5. **Explain code.** As a developer, I select code and ask "what does this do?". The agent reads related files and answers without editing anything.
6. **Run and fix tests.** As a developer, I say "make the tests pass". The agent runs them, reads the failures and iterates. I can watch the command output live.

## Control and trust
7. **Review before applying.** As a developer, I see a diff of each proposed edit and can accept it, reject it, or reject it with feedback ("use the existing helper instead").
8. **Hands-off mode.** As a developer who trusts the current task, I switch to auto-approving edits for this chat only. Commands still ask.
9. **Stop and redirect.** As a developer, I can stop the agent mid-task, type a correction and have it continue from where it was.
10. **Undo.** As a developer, I can revert everything the agent changed since a given message, even without git.
11. **No surprises.** The agent never runs destructive commands (rm -rf, git push --force, deleting data) without an explicit approval, whatever mode I am in.

## Long work
12. **Long session.** As a developer, I work with the agent for an hour. Context is summarized automatically and it still remembers what I originally asked for.
13. **Resume later.** As a developer, I close VS Code and reopen the previous chat the next day.

## Team / environment
14. **Project rules.** As a team lead, I commit an AGENTS.md with conventions ("use pnpm", "never edit generated/") and the agent follows it for everyone.
15. **Offline.** As a developer with no internet, everything except web_fetch works against an internal endpoint, with no outbound calls.
