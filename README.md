# STARK Code

A coding agent for VS Code that works with any OpenAI-compatible `/chat/completions` endpoint that supports tool calling. Examples: Ollama, LM Studio, vLLM, llama.cpp server, LiteLLM, OpenRouter, Azure/OpenAI.

## Install (offline)
Download the `.vsix` from [Releases](https://github.com/tinamil/STARK-Code/releases), then run:

    code --install-extension stark-code-<version>.vsix
Or use the Extensions view: `...` menu → **Install from VSIX...**

## Setup
Open the robot icon in the left sidebar. On first run the **Setup** panel opens: enter the base URL, key and model, then click **Test connection**. The test checks that the server is reachable, that chat works and that tool calling works. The key is stored in VS Code SecretStorage.

Switch models from the dropdown at the top. It lists models the server reports plus `oaiAgent.models`.

## Tools
read_file, write_file, edit_file, list_dir, glob, grep (uses VS Code's bundled ripgrep), run_command, web_fetch, todo_write.

## Context window
`oaiAgent.contextWindow` defaults to 1,000,000 tokens (Gemini 3's size). When the conversation reaches about 70% of it, older messages are summarized. A larger window keeps more detail but uses more tokens, because each step resends the conversation. Lower it under **Setup** to save credits. If a model's real limit is smaller, the agent notices the server's error, uses a smaller limit for that chat, summarizes and retries.

## Compacting
Type `/compact` (or click **Compact**) to summarize the conversation now and free up context, for example before starting a new task in the same chat. Add a note on what to keep: `/compact keep the API design decisions`. The summary is shown and can be expanded. Files, and Rewind for earlier edits, are unaffected. The agent also compacts automatically at about 70% of the context window.

## API mode
`oaiAgent.apiMode` can be `chat` (`/chat/completions`) or `responses` (`/responses`, stateless with `store:false`). Some gateways pass tool definitions through only one of these. **Test connection** checks the selected mode and falls back to the other if tool calling fails.

## Locked or expired keys
STARK locks API keys 14 days after they're created or unlocked. When that happens, the agent says so and shows an **Unlock API key** button that opens the unlock page from STARK's error response in your browser. Unlock the key, then send "continue". A key that is invalid or expired gets a different message telling you to update it under Setup. The connection test reports both cases.

## Gateway headers
- On HTTP 429 the agent waits for the `Retry-After` time, retrying up to 5 times.
- Remaining daily credits from `X-RateLimit-*-Credits-Day` appear next to context usage.
- `X-Stark-Key-Expiring-Soon` triggers a warning that your key is near expiry.
- If `/models` reports `capabilities.tools: false`, the model picker marks that model "(no tools)".

## How edits are made
- **Files open in VS Code:** the agent reads the editor's current text, including unsaved changes. It applies its edit as a normal editor change, so **Ctrl+Z** undoes it, and then saves. If the file had unsaved changes, they're saved too, and the agent is told so.
- **Other files:** written directly to disk.
- **Encodings:** files keep their encoding: UTF-8, UTF-8 with BOM, UTF-16 LE/BE, or Windows-1252. If an edit adds a character the file's encoding can't store, such as an emoji in a Windows-1252 file, the agent is told instead of the file being corrupted.

## Approvals
- An edit's approval card shows the change as a diff, plus the agent's one-line explanation of what it does and why. Commands show their explanation too. **Open in diff editor** (Ctrl/Cmd+Enter) opens VS Code's side-by-side view.
- Enter allows, Esc denies, and Ctrl/Cmd+Enter opens the diff. These work while the panel has focus.
- From the editor, use Ctrl/Cmd+Alt+Y to allow and Ctrl/Cmd+Alt+N to deny. The agent panel never takes focus from your editor.
- Type feedback and press Enter to deny with a message. The agent continues using your feedback.

## Rewind and history
- Hover a message of yours and click **↶ Rewind**. This restores every file the agent edited since that message, rewinds the chat, and puts the message back in the input box for editing. Changes made by shell commands are not tracked.
- **History** lists saved chats for this workspace. They're kept in VS Code's global storage. The 100 most recent chats are kept, and chats older than 90 days are deleted.
- Rewind keeps a copy of each file the first time the agent changes it in a turn. Files over 2 MB aren't copied, and Rewind lists them as not restored.

## Safety
- `approvalMode`:
  - `ask` (default): asks before edits, commands and fetches.
  - `autoEdit`: file edits run without asking.
  - `auto`: nothing asks.
- Edit approvals include a **View diff** button.
- Read-only commands run without asking, as long as every path they touch is inside the workspace. Examples: `Get-Content`, `Get-ChildItem`, `Select-String`, `type`, `dir`, `findstr`, `cat`, `grep`, `git status/diff/log/show`, `node --check`, `tsc --noEmit`, `--version` checks. They also run without asking when wrapped in `powershell -NoProfile -Command "..."`. Anything with pipes, variables, chaining, redirects or script blocks still asks. Turn this off with `oaiAgent.autoApproveReadOnlyCommands`.
- Read-only PowerShell scripts (pipelines, variables, `ForEach-Object`, `[regex]::Matches`, …) also run without asking. PowerShell's own parser analyzes the script without running it. It runs only if every command, .NET call, method, type and path is on a read-only list and inside the workspace, and the script is passed as one cleanly quoted argument (`powershell -NoProfile -Command "…"` with no inner double quotes). Anything else asks. Turn this off with `oaiAgent.autoApproveReadOnlyScripts`.
- These always ask, even in `auto` mode, and never offer "Always allow":
  - destructive commands (`rm -rf`, `git push --force`, `git reset --hard`, `DROP TABLE`, `sudo`, `terraform destroy` and similar)
  - edits to files outside the workspace
- `autoApproveCommands` lists command prefixes that run without asking. Commands that contain `; & | $ < >` or a backtick always ask.

## Project instructions
These files at the workspace root are added to the system prompt: `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md` and `.oai-agent.md`.

## Notes
- How well the agent works depends mostly on the model. Use a strong model that supports tool calling.
- Command output streams to the **STARK Code** output channel.

## Building and releasing
- Build: `npx @vscode/vsce package`. There are no dependencies and no build step.
- Release: bump `version` in package.json, commit, then push a matching tag (`git tag v<version> && git push origin v<version>`). The Release workflow builds the .vsix and attaches it to a GitHub release.

## Development
- Run the tests with `npm test` (Node 22+, no dependencies). The PowerShell script-checker tests run when PowerShell is installed. Set `REQUIRE_POWERSHELL=1` to make a missing PowerShell an error, and `OAI_AGENT_PWSH` to choose a specific PowerShell.
- CI runs the tests on Linux and Windows, including Windows PowerShell 5.1, for every PR. The release workflow runs them before packaging.
