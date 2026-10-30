# GitHub Copilot

T3 Code can run [GitHub Copilot CLI](https://github.com/features/copilot/cli) through Copilot's own SDK, using the `copilot` install and Copilot subscription on the machine that runs the T3 Code server. This provider is separate from adding Copilot through the [ACP Registry](./providers-acp.md); both can be enabled.

## Set up GitHub Copilot

1. Install GitHub Copilot CLI on that machine, for example with `brew install copilot-cli` or `npm install -g @github/copilot`.
2. Run `copilot login` in a terminal on that machine.
3. Open **Settings → Providers**, add **GitHub Copilot**, and refresh the provider.

If `copilot` is not on the server's `PATH`, set **Binary path** to the executable.

T3 Code does not use `GH_TOKEN`, `GITHUB_TOKEN`, or `COPILOT_GITHUB_TOKEN` from the server's own environment, so two instances cannot quietly share one account and its premium requests. An instance signs in with the `copilot login` account, or with a **GitHub token** (`COPILOT_GITHUB_TOKEN`) set in that instance's environment variables. Copilot accepts fine-grained and OAuth tokens, not classic `ghp_` tokens. The provider shows **Not signed in** until one of these is available.

## Models and reasoning

The model picker lists **Auto** first, which lets Copilot choose the model. The other entries are the models your Copilot plan offers. Models that support it have a **Reasoning** control. A model change applies from the next message and keeps the conversation.

Each turn can use premium requests. Copilot bills them by model, so check your plan's multipliers before switching to a larger model.

## Permission modes

| Mode            | Behavior                                                                             |
| --------------- | ------------------------------------------------------------------------------------ |
| **Supervised**  | Copilot asks before it runs commands, edits files, or takes other actions it guards. |
| **Full access** | Copilot runs commands and edits without approval prompts.                            |

T3 Code does not offer **Auto** or **Auto-accept edits** for GitHub Copilot. A thread already set to either runs in **Supervised**. Changing the permission mode restarts the connection and resumes the same Copilot session.

When Copilot can remember an approval, the request offers **Allow for this session**.

## Conversations

Each thread is a Copilot session saved under `~/.copilot/session-state` on the server's machine, so a thread resumes its conversation after a restart. Copilot keeps your custom instructions, skills, and MCP servers from its own configuration; T3 Code adds its own MCP tools to each session.

A message sent while Copilot is working is steered into the running turn. **Stop** also stops any background agents the turn started.

## Not supported yet

- Plan mode and Copilot's sub-agent views; a sub-agent's work appears inside the tool call that started it.
- Reverting to an earlier turn, and forking a thread from a turn.
- Commit messages, pull request text, branch names, and thread titles. Pick another provider for those.

See [provider setup](./install.md#providers) and [Permission modes](./permission-modes.md).
