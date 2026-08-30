# ALICE - Advanced Intelligence & Learning Interactive Companion Engine

A futuristic browser-based AI assistant interface with voice interaction, memory, modular skills, multi-step agentic task planning, and advanced capabilities (vision, browser/dev assistance, IoT layer, proactive help).

![ALICE Interface](https://img.shields.io/badge/Version-0.5.0--epsilon-blue)
![Status](https://img.shields.io/badge/Status-Development-yellow)

## 🎯 Project Overview

ALICE is a 5-part development project:

- **Part 1** (Complete): Foundation & Futuristic HUD ✅
- **Part 2** (Complete): Voice Recognition + Natural Speech ✅
- **Part 3** (Complete): Memory, Tools & Skills ✅
- **Part 4** (Complete): Agentic Intelligence — Task Planner, Execution Loop, Permissions ✅
- **Part 5** (Complete): Advanced Capabilities & Final Integration ✅

## 🚀 Features

### Part 1 - Foundation
- **Authentication Screen**: Futuristic login with PIN entry
- **Boot Sequence**: Cinematic system initialization
- **Main HUD**: Full AI command center interface
- **State System**: Visual states with reactive orb
- **Waveform Visualizer**: Real-time audio visualization

### Part 2 - Voice System
- **Wake Word Detection**: "Hey Alice" activation
- **Speech Recognition**: Real-time speech-to-text
- **Natural TTS**: Human-like text-to-speech
- **Voice Controls**: Wake, Stop, Mic toggle buttons

### Part 3 - Memory & Skills
- **Memory System**: Short-term context + user-controlled long-term memory
- **8 Modular Skills**: Calculator, Web Search, Notes, Reminders, DateTime, Files, Reader, Memory
- **Natural Commands**: Voice commands for all features
- **Skill Status Panel**: Visual feedback during skill execution
- **localStorage Persistence**: Memories and notes persist across sessions

### Part 4 - Agentic Intelligence (NEW)
- **Task Planner**: Understands a goal, breaks it into an ordered plan of steps, and binds each step to an existing skill
- **Tool Execution Loop**: `PLAN → EXECUTE → OBSERVE → DECIDE → COMPLETE`, with retry + alternative-tool fallback on failure
- **Permission System**: Pauses for explicit user confirmation before sensitive/irreversible actions (delete, external send, account changes)
- **Confirm by voice or UI**: Approve/cancel via the HUD dialog or by saying "approve" / "cancel"
- **Task Dashboard**: Live panel showing the goal, per-step progress, current action, and final status
- **Responsive execution**: Steps run asynchronously so the UI never freezes during longer tasks

### Part 5 - Advanced Capabilities (NEW)
- **Vision**: local image/screenshot analysis (dimensions, dominant colour, brightness) via Canvas — no external service
- **Browser Assistance**: open websites (confirmation-gated), read current-page visible text, search the page
- **Developer Mode**: explain code, find common bugs, suggest fixes, scaffold projects, analyze logs, simulated (safe) commands
- **Advanced Memory**: preferences, project context, pinned facts, task history, fuzzy scored retrieval, full view/edit/delete UI
- **Proactive Assistance**: configurable suggestions (reminders, pending tasks, follow-ups) with frequency levels
- **IoT / Integrations Layer**: provider-agnostic device registry with bundled virtual (mock) devices; no vendor lock-in
- **Skill/Plugin Ecosystem**: skills are validated plugins (name, description, permissions, risk, inputs, actions, error handling); individually enable/disable-able; auto-discovered by the agent
- **Advanced Security**: log redaction, deny-by-default sensitive actions, per-skill toggles, no unrestricted system access
- **Polish**: notification toasts, settings panel, memory management UI, responsive design

## 📁 Project Structure

```
ALICE0/
├── index.html              # Main entry point
├── css/
│   └── styles.css          # All styling
├── js/
│   ├── app.js              # Main application controller
│   ├── config.js           # Configuration & constants
│   ├── state.js            # State management
│   ├── auth.js             # Authentication
│   ├── boot.js             # Boot sequence
│   ├── hud.js              # HUD controller
│   ├── memory.js           # Memory system
│   ├── skillManager.js     # Skill routing
│   ├── taskPlanner.js      # Task planner (Part 4)
│   ├── agent.js            # Agent execution loop (Part 4)
│   ├── permissions.js      # Confirmation/permission system (Part 4)
│   ├── taskDashboard.js    # Task dashboard renderer (Part 4)
│   ├── settings.js         # Settings manager (NEW — Part 5)
│   ├── notifications.js    # Notification toasts (NEW — Part 5)
│   ├── proactive.js        # Proactive suggestions (NEW — Part 5)
│   ├── integrations.js     # Device/API integration layer (NEW — Part 5)
│   ├── audio.js            # Audio manager
│   ├── wakeword.js         # Wake word detection
│   ├── stt.js              # Speech-to-text
│   ├── tts.js              # Text-to-speech
│   ├── conversation.js     # Conversation flow + agent routing
│   ├── utils.js            # Utilities (summarizeText, redact, escapeHtml)
│   └── skills/
│       ├── calculator.js   # Calculator skill
│       ├── websearch.js    # Web search (DuckDuckGo API)
│       ├── notes.js        # Notes management
│       ├── reminders.js    # Reminders & tasks
│       ├── datetime.js     # Date/time queries
│       ├── files.js        # File operations
│       ├── reader.js       # Document reading
│       ├── memory.js       # User memory
│       ├── vision.js       # Image/screen understanding (NEW — Part 5)
│       ├── browser.js      # Browser assistance (NEW — Part 5)
│       ├── dev.js          # Developer mode (NEW — Part 5)
│       └── iot.js          # IoT device control (NEW — Part 5)
├── tests/
│   ├── agent.test.mjs      # Planner/agent/permissions (Part 4)
│   ├── part5.test.mjs      # Part 5 feature tests
│   └── load.test.mjs       # Verifies all modules import cleanly
└── README.md
```

## 🛠️ Technologies

- **Vanilla JavaScript** (ES6 Modules) — zero build step, zero runtime dependencies
- **CSS3** (Custom Properties, Animations, Grid/Flexbox, Responsive breakpoints)
- **Google Fonts** (Orbitron, Rajdhani, Share Tech Mono)
- **HTML5 Canvas** (waveform visualization + local image analysis)
- **Web Speech API** (speech recognition + synthesis)
- **Web Audio API** (audio capture/analysis)
- **Screen Capture API** (screenshots, permission-gated)
- **localStorage** (memory, notes, reminders, settings persistence)
- **DuckDuckGo Instant Answer API** (free web search, no key)
- **Node.js** (headless test harness only)

## ⚙️ Configuration / Environment Variables

ALICE is fully client-side and requires **no environment variables** and **no
API keys** to run. All configuration lives in `js/config.js` (`CONFIG`) and is
frozen at runtime:

| Setting | Where | Purpose |
|---------|-------|---------|
| Default PIN (`1234`) | `CONFIG.auth.defaultPin` (prototype) | Auth gate — see SECURITY.md |
| Risk levels | `CONFIG.skills.riskLevels` | Safe vs. sensitive classification |
| Agent retries / pacing | `CONFIG.agent` | Execution loop tuning |
| Proactive frequency | `CONFIG.proactive` | Suggestion interval + level |
| Settings defaults | `CONFIG.settings.defaults` | Persisted user settings |
| Log redaction | `CONFIG.security.redactPatterns` | Strips secrets from logs |

Runtime user settings (proactive level, feature toggles, per-skill enable/disable)
are persisted in `localStorage` under `alice_settings`; memory/notes/reminders
under `alice_memory`.

> ⚠️ If you later add an LLM, search, or IoT provider that needs a key, keep it
> **server-side** (or in a local proxy) and never commit it — see SECURITY.md.

## 🎤 Voice Commands

### Memory Commands
- "Remember that my project is ALICE"
- "What is my project called?"
- "Recall my favorite color"
- "Forget that..."

### Calculator Commands
- "Calculate 25 percent of 800"
- "What is 150 plus 75?"
- "What's 50 times 12?"

### Reminder Commands
- "Remind me to call mom at 6 PM"
- "Remind me in 30 minutes"
- "Set a reminder for tomorrow at 9 AM"

### Note Commands
- "Take a note about the meeting"
- "Show my notes"
- "Search my notes"

### Web Search Commands
- "Search web for latest news about AI"
- "What is quantum computing?"
- "Who was Albert Einstein?"

### Date/Time Commands
- "What time is it?"
- "What's today's date?"
- "What day of the week is it?"

### Multi-step tasks (Part 4)
- "Research quantum computing, summarize the important information and create a document"
- "Research the history of AI then save a note"
- "Look up climate change and write a document"

### Confirmation
- "Delete my note" (ALICE asks you to approve/cancel before acting)
- Say "approve" or "cancel" — or use the buttons in the dialog

### Advanced (Part 5)
- "Analyze this image" / "Take a screenshot" (vision)
- "Open the website example.com" (browser — asks for confirmation)
- "Explain this code" / "Find bugs" (developer mode, after reading a code file)
- "List my devices" / "Turn on the desk lamp" (IoT — mock devices, confirmation-gated)
- Open **Settings** (top-left quick actions) to toggle skills, features, and proactive level
- Open **Memory** to view/edit/delete memories, preferences, facts, and task history

## 🖥️ Running the Application

```bash
cd ALICE0
python -m http.server 8080
# Open http://localhost:8080
```

**PIN**: `1234`

> Voice requires a Web Speech API-capable browser (Chrome/Edge) and microphone
> permission. Multi-step tasks can also be triggered from the **command input**
> under the orb, or via the **Agent Demos** buttons in the debug panel (bottom-right).

### Running the tests (Node)

```bash
node tests/agent.test.mjs   # planner, agent loop, failure recovery, permissions (32 checks)
node tests/part5.test.mjs   # Part 5: plugins, memory, settings, IoT, dev, security (34 checks)
node tests/load.test.mjs    # verifies all 34 modules import without errors
```

## 🧠 How the Agent Works (Part 4)

At a high level, multi-step requests flow through a controlled loop:

```
PLAN → EXECUTE → OBSERVE RESULT → DECIDE NEXT STEP → COMPLETE
```

1. **PLAN** — `taskPlanner` recognizes the goal and composes an ordered list of
   high-level steps, each bound to an existing Part 3 skill (e.g. research →
   process information → create document). Only this high-level plan is shown;
   no internal reasoning is exposed.
2. **EXECUTE** — `agent` runs each step through `skillManager` (reusing the
   same skills, never duplicating them). Results are shared between steps via a
   blackboard so later steps can consume earlier output.
3. **OBSERVE / DECIDE** — each result is checked. On failure the agent retries
   (bounded), then falls back to an alternative tool when one is defined, and
   finally reports clearly if it cannot continue.
4. **CONFIRM** — sensitive steps (delete/forget, external send, account changes)
   pause the loop and ask the user via the HUD dialog and/or voice.
5. **COMPLETE** — a final result is produced, shown in the Task Dashboard, and
   spoken aloud.

**Permissions** are deny-by-default for sensitive actions. `permissions.js`
classifies a step as safe vs. sensitive (planner hints + keyword rules), and
`agent`/`conversation` block execution until the user approves. There is no
unrestricted autonomy — nothing sensitive runs without an explicit yes.

## 📊 Available Skills

| Skill | Description | Example |
|-------|-------------|---------|
| Calculator | Math operations | "25 percent of 800" |
| Web Search | DuckDuckGo API | "Search for weather" |
| Notes | Save/search notes | "Take a note about..." |
| Reminders | Time-based alerts | "Remind me at 6 PM" |
| DateTime | Current time/date | "What time is it?" |
| Files | File read/write | "Create a file" |
| Reader | Document parsing | "Read this document" |
| Memory | User memories | "Remember my name is..." |
| Vision | Image/screen analysis | "Analyze this image" |
| Browser | Open/read sites | "Open the website ..." |
| Developer | Code help, bug finding | "Find bugs" |
| IoT | Device control | "Turn on the desk lamp" |

## 🔮 Recommended Future Improvements

- Upgrade vision from local colour/brightness heuristics to real OCR/object
  recognition (e.g. Tesseract.js or a self-hosted model) behind the same skill
- Add a browser companion extension to unlock true multi-tab automation while
  keeping the confirmation/permission layer
- Replace the simulated dev command runner with a gated, sandboxed execution
  backend (e.g. a local WASM shell or an opt-in local agent) — never auto-run
- Add real IoT provider adapters (Home Assistant REST, MQTT) using the existing
  `integrations.js` interface
- Swap deterministic planner for a local LLM (e.g. WebLLM) while keeping the
  high-level-plan-only disclosure rule
- Move authentication to a real backend (see SECURITY.md)
- Add wake-word ML model to replace energy-based detection

## ⚠️ Known Limitations

- Wake word uses simple energy detection (can improve with ML)
- Web search limited to DuckDuckGo Instant Answer API
- The task planner is deterministic (rule/recipe based) — it recognizes a
  curated set of goal patterns plus connector-split commands, not arbitrary
  free-form reasoning
- Vision analyzes image *properties* (size, dominant colour, brightness) locally;
  it does not read text or recognize objects
- Browser assistance is limited to opening a site (new tab) and reading the
  *current* page — no cross-tab clicking (needs an extension)
- "Run command" in Developer Mode is simulated (safe dry-run); ALICE never
  executes real shell commands
- IoT ships with virtual (mock) devices only; real hardware needs a provider adapter
- "Create document"/scaffold download local files (browser sandbox); no server store
- No server backend: auth is a client-side prototype and API keys must stay
  server-side in a real deployment
- Browser must support Web Speech API (voice path); text input works everywhere

## 🔐 Security

See **[SECURITY.md](./SECURITY.md)** for the complete security review, threat
model, and known gaps.

## 📄 License

This project is for educational and development purposes.

---

**Built with care for the future of AI interfaces.**
