# RunMyWork — Local AI Advisor

The advisor reads each open project and suggests a **next action** plus a few
concrete **tasks**, using your own **Ollama** model. It runs on the machine that
hosts Ollama (so nothing leaves your network), writes suggestions back into
`data.json` on GitHub, and the app shows them on the next load.

```
 ┌──────────────┐   pull data.json    ┌──────────────┐
 │  Your phone  │ ◀─────────────────▶ │   GitHub     │
 │  / PWA       │   push edits        │  data.json   │
 └──────────────┘                     └──────▲───────┘
        ▲  "Ask the advisor" sets a flag             │ pull / push
        │                                            │
        └────────────────────────────────────┌──────┴────────────┐
                                              │  Ollama machine    │
                                              │  ai-advisor.js  ───┼─▶ localhost:11434
                                              │  (Task Scheduler)  │   (llama3.1)
                                              └────────────────────┘
```

## What you need on the Ollama machine

1. **Ollama**, running, with a model pulled:
   ```
   ollama pull llama3.1
   ```
   (Any chat model works — set `OLLAMA_MODEL` to use a different one.)
2. **Node.js 18 or newer** — https://nodejs.org (the script uses the built-in
   `fetch`, so there's nothing to `npm install`).
3. A clone of this repo, or just the `scripts/ai-advisor.js` file.
4. A **GitHub Personal Access Token** with **Contents: read & write** on
   `samcbarth/runmywork`. (This is the same data file the app syncs.)

## One-time setup (Windows)

1. Copy `scripts/run-advisor.bat.example` → `scripts/run-advisor.bat`
   (the copy is gitignored so your token stays private).
2. Open `run-advisor.bat` and paste your token into `GITHUB_PAT`.
3. Test it from a terminal:
   ```
   scripts\run-advisor.bat
   ```
   You should see it review your projects and write suggestions back.

## Schedule it (Windows Task Scheduler)

Run this once in an **Administrator PowerShell** (adjust the path to your clone):

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\path\to\runmywork\scripts\run-advisor.bat"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
             -RepetitionInterval (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "RunMyWork Advisor" `
  -Action $action -Trigger $trigger -Description "Reads projects, suggests next steps via Ollama"
```

That runs the advisor every 30 minutes. Change `-Minutes 30` to taste.

## How the two triggers work

- **Scheduled (automatic):** every run, the advisor reviews any project that is
  new, has changed since its last suggestion, or has no suggestion yet. It skips
  unchanged projects so it doesn't burn compute.
- **On-demand:** tapping **"Ask the advisor"** on a project in the app sets a
  flag in `data.json`. The next scheduled run picks it up — or run
  `run-advisor.bat` manually for an immediate pass.

Set `ADVISOR_FORCE=1` to re-generate suggestions for **every** open project,
ignoring the "unchanged" skip.

## Config reference (environment variables)

| Variable        | Default                   | Purpose                                   |
| --------------- | ------------------------- | ----------------------------------------- |
| `GITHUB_PAT`    | *(required)*              | Token with Contents read+write on the repo |
| `GITHUB_REPO`   | `samcbarth/runmywork`     | Where `data.json` lives                   |
| `OLLAMA_HOST`   | `http://127.0.0.1:11434`  | Your local Ollama endpoint                |
| `OLLAMA_MODEL`  | `llama3.1`                | Model the advisor uses                    |
| `ADVISOR_FORCE` | *(off)*                   | `1` = review every open project           |
