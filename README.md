# ALICE - Advanced Intelligence & Learning Interactive Companion Engine

A futuristic browser-based AI assistant interface with voice interaction, memory, modular skills, and multi-step agentic task planning.

![ALICE Interface](https://img.shields.io/badge/Version-0.4.0--delta-blue)
![Status](https://img.shields.io/badge/Status-Development-yellow)

## 🎯 Project Overview

ALICE is a 5-part development project:

- **Part 1** (Complete): Foundation & Futuristic HUD ✅
- **Part 2** (Complete): Voice Recognition + Natural Speech ✅
- **Part 3** (Complete): Memory, Tools & Skills ✅
- **Part 4** (Complete): Agentic Intelligence — Task Planner, Execution Loop, Permissions ✅
- **Part 5**: Advanced Integrations

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
│   ├── taskPlanner.js      # Task planner (NEW — Part 4)
│   ├── agent.js            # Agent execution loop (NEW — Part 4)
│   ├── permissions.js      # Confirmation/permission system (NEW — Part 4)
│   ├── taskDashboard.js    # Task dashboard renderer (NEW — Part 4)
│   ├── audio.js            # Audio manager
│   ├── wakeword.js         # Wake word detection
│   ├── stt.js              # Speech-to-text
│   ├── tts.js              # Text-to-speech
│   ├── conversation.js     # Conversation flow + agent routing
│   ├── utils.js            # Utilities (incl. summarizeText)
│   └── skills/
│       ├── calculator.js   # Calculator skill
│       ├── websearch.js    # Web search (DuckDuckGo API)
│       ├── notes.js        # Notes management
│       ├── reminders.js    # Reminders & tasks
│       ├── datetime.js     # Date/time queries
│       ├── files.js        # File operations
│       ├── reader.js       # Document reading
│       └── memory.js       # User memory
├── tests/
│   ├── agent.test.mjs      # Planner/agent/permissions smoke tests (node)
│   └── load.test.mjs       # Verifies all 26 modules import cleanly
└── README.md
```

## 🛠️ Technologies

- **Vanilla JavaScript** (ES6 Modules)
- **CSS3** (Custom Properties, Animations)
- **Google Fonts** (Orbitron, Rajdhani, Share Tech Mono)
- **HTML5 Canvas** (Waveform visualization)
- **Web Speech API** (Voice interaction)
- **Web Audio API** (Audio analysis)
- **localStorage** (Memory persistence)
- **DuckDuckGo API** (Free web search)

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
node tests/agent.test.mjs   # planner, agent loop, failure recovery, permissions
node tests/load.test.mjs    # verifies all modules import without errors
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

## 🔮 Future Development

### Part 5
- Calendar integration, Weather API, Smart home control
- Self-improvement
- Multi-modal interactions
- Expanding the recipe library and alternative-tool fallbacks

## ⚠️ Limitations

- Wake word uses simple energy detection (can improve with ML)
- Web search limited to DuckDuckGo Instant Answer API
- The task planner is deterministic (rule/recipe based) — it recognizes a
  curated set of goal patterns plus connector-split commands, not arbitrary
  free-form reasoning
- "Create document" downloads a local `.txt` file (browser sandbox); there is
  no server-side file store
- No vision/multimodal input
- Browser must support Web Speech API (voice path); text input works everywhere

## 📄 License

This project is for educational and development purposes.

---

**Built with care for the future of AI interfaces.**
