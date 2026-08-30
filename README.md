# ALICE - Advanced Intelligence & Learning Interactive Companion Engine

A futuristic browser-based AI assistant interface with voice interaction, memory, and modular skills.

![ALICE Interface](https://img.shields.io/badge/Version-0.3.0--gamma-blue)
![Status](https://img.shields.io/badge/Status-Development-yellow)

## 🎯 Project Overview

ALICE is a 5-part development project:

- **Part 1** (Complete): Foundation & Futuristic HUD ✅
- **Part 2** (Complete): Voice Recognition + Natural Speech ✅
- **Part 3** (Current): Memory, Tools & Skills ✅
- **Part 4**: Advanced Tools & Integrations
- **Part 5**: Autonomous Agent Capabilities

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

### Part 3 - Memory & Skills (NEW)
- **Memory System**: Short-term context + user-controlled long-term memory
- **8 Modular Skills**: Calculator, Web Search, Notes, Reminders, DateTime, Files, Reader, Memory
- **Natural Commands**: Voice commands for all features
- **Skill Status Panel**: Visual feedback during skill execution
- **localStorage Persistence**: Memories and notes persist across sessions

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
│   ├── memory.js           # Memory system (NEW)
│   ├── skillManager.js     # Skill routing (NEW)
│   ├── audio.js            # Audio manager
│   ├── wakeword.js         # Wake word detection
│   ├── stt.js              # Speech-to-text
│   ├── tts.js              # Text-to-speech
│   ├── conversation.js      # Conversation flow
│   ├── utils.js            # Utilities
│   └── skills/
│       ├── calculator.js   # Calculator skill
│       ├── websearch.js    # Web search (DuckDuckGo API)
│       ├── notes.js        # Notes management
│       ├── reminders.js    # Reminders & tasks
│       ├── datetime.js     # Date/time queries
│       ├── files.js        # File operations
│       ├── reader.js       # Document reading
│       └── memory.js       # User memory
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

## 🖥️ Running the Application

```bash
cd ALICE0
python -m http.server 8080
# Open http://localhost:8080
```

**PIN**: `1234`

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

### Part 4
- Calendar integration
- Weather API
- Smart home control
- Advanced calculations

### Part 5
- Task planning
- Self-improvement
- Multi-modal interactions
- Autonomous behavior

## ⚠️ Limitations

- Wake word uses simple energy detection (can improve with ML)
- Web search limited to DuckDuckGo Instant Answer API
- No advanced AI processing (pattern matching)
- No vision/multimodal input
- Browser must support Web Speech API

## 📄 License

This project is for educational and development purposes.

---

**Built with care for the future of AI interfaces.**
