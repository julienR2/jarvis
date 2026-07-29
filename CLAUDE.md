# Jarvis — Personal AI Assistant

A self-hosted, full-stack AI assistant powered by Claude Code CLI, with a chat web interface, voice input, scheduled automation, and file management.

## Git Integration

The Jarvis repo itself is git-controlled. When Claude modifies backend/frontend code, changes can be reviewed (diff), committed, or reverted through the API. The backend mounts the whole repo at `/jarvis` (working dir), so source, agent config, workspace, and data all live under one tree.

**Recovery strategy**: First try discarding uncommitted changes (`/api/git/discard`). If the repo is clean but still broken, revert the last commit (`/api/git/revert`).
