# Claude Code Traffic Light 🚦

A macOS menu bar traffic light that shows what Claude Code is doing at a glance.

![macOS](https://img.shields.io/badge/macOS-supported-blue)
![Python](https://img.shields.io/badge/Python-3.9+-green)
![License](https://img.shields.io/license/MIT-yellow)

![Screenshot](example.png)

## Features

| Light | Status | Description |
|-------|--------|-------------|
| 🟢 Green | Working | Claude is executing |
| 🟡 Yellow blink | Awaiting approval | Needs your permission |
| 🔴 Red | Idle | Session ended |

- **Floating pin** — always-on-top window, visible even in fullscreen; double-click to jump back to terminal
- **Multi-project** — monitor multiple Claude Code sessions, switch from menu
- **Auto config** — injects hooks on start, restores on exit, never touches your original settings

## Install

Download `.dmg` or `.app.zip` from [Releases](https://github.com/DemoJj/claude-code-traffic-light/releases), drag to Applications.

Or run from source:

```bash
git clone https://github.com/DemoJj/claude-code-traffic-light.git
cd claude-code-traffic-light
pip install -r requirements.txt
python traffic_light.py
```

Build `.app`:

```bash
bash build.sh
```

## How It Works

Uses Claude Code [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to write state to a file on session events, then polls the file to update the menu bar icon. Config is automatically restored on exit.

## Requirements

- macOS 10.15+
- Python 3.9+ (only for running from source or building)

## License

[MIT](LICENSE)

---

*Vibe coded with Claude Code*
