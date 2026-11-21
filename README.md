# OAI Agent

A coding agent for VS Code that works with any OpenAI-compatible `/chat/completions` endpoint that supports tool calling. Examples: Ollama, LM Studio, vLLM, llama.cpp server, LiteLLM, OpenRouter, Azure/OpenAI.

## Install (offline)
Download the `.vsix` from [Releases](https://github.com/tinamil/STARK-Code/releases), then run:

    code --install-extension oai-agent-0.3.3.vsix
Or use the Extensions view: `...` menu → **Install from VSIX...**

## Setup
Open the robot icon in the left sidebar. On first run the **Setup** panel opens: enter the base URL, key and model, then click **Test connection**. The test checks that the server is reachable, that chat works and that tool calling works. The key is stored in VS Code SecretStorage.

Switch models from the dropdown at the top. It lists models the server reports plus `oaiAgent.models`.

## Tools
read_file, write_file, edit_file, list_dir, glob, grep (uses VS Code's bundled ripgrep), run_command, web_fetch, todo_write.

## API mode
`oaiAgent.apiMode` can be `chat` (`/chat/completions`) or `responses` (`/responses`, stateless with `store:false`). Some gateways pass tool definitions through only one of these. **Test connection** checks the selected mode and falls back to the other if tool calling fails.

## Gateway headers
- On HTTP 429 the agent waits for the `Retry-After` time, retrying up to 5 times.
- Remaining daily credits from `X-RateLimit-*-Credits-Day` appear next to context usage.
- `X-Stark-Key-Expiring-Soon` triggers a warning that your key is near expiry.
- If `/models` reports `capabilities.tools: false`, the model picker marks that model "(no tools)".

## Approvals
- Enter allows, Esc denies, and Ctrl/Cmd+Enter opens the diff. These work while the panel has focus.
- From the editor, use Ctrl/Cmd+Alt+Y to allow and Ctrl/Cmd+Alt+N to deny. The agent panel never takes focus from your editor.
- Type feedback and press Enter to deny with a message. The agent continues using your feedback.

## Rewind and history
- Hover a message of yours and click **↶ Rewind**. This restores every file the agent edited since that message, rewinds the chat, and puts the message back in the input box for editing. Changes made by shell commands are not tracked.
- **History** lists saved chats for this workspace. They are kept in VS Code's global storage.

## Safety
- `approvalMode`:
  - `ask` (default): asks before edits, commands and fetches.
  - `autoEdit`: file edits run without asking.
  - `auto`: nothing asks.
- Edit approvals include a **View diff** button.
- These always ask, even in `auto` mode, and never offer "Always allow":
  - destructive commands (`rm -rf`, `git push --force`, `git reset --hard`, `DROP TABLE`, `sudo`, `terraform destroy` and similar)
  - edits to files outside the workspace
- `autoApproveCommands` lists command prefixes that run without asking. Commands that contain `; & | $ < >` or a backtick always ask.

## Project instructions
These files at the workspace root are added to the system prompt: `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md` and `.oai-agent.md`.

## Notes
- How well the agent works depends mostly on the model. Use a strong model that supports tool calling.
- Command output streams to the **OAI Agent** output channel.

## Building and releasing
- Build: `npx @vscode/vsce package`. There are no dependencies and no build step.
- Release: bump `version` in package.json, commit, then push a matching tag (`git tag v0.3.0 && git push origin v0.3.0`). The Release workflow builds the .vsix and attaches it to a GitHub release.
