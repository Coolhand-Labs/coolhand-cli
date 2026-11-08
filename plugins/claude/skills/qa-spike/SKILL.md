---
name: qa-spike
description: Throwaway QA skill for testing that Coolhand capture works when installed as a plugin (issue #213). Use when the user says "run qa-spike".
---

# qa-spike

A three-turn session used only to test capture. Capture comes from the plugin's hook, so there is nothing to install here.

1. Turn 1: ask the user for a one-word favourite colour and reply with it.
2. Turn 2: read the file `package.json` (or any file in the workspace) using a tool and report its name.
3. Turn 3: summarise turns 1 and 2 in one sentence.

Do nothing else.
