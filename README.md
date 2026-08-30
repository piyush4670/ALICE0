# ALICE - Advanced Intelligence & Learning Interactive Companion Engine

A futuristic browser-based AI assistant interface inspired by JARVIS, with its own unique identity and design.

![ALICE Interface](https://img.shields.io/badge/Version-0.2.0--beta-blue)
![Status](https://img.shields.io/badge/Status-Development-yellow)

## 🎯 Project Overview

ALICE is a 5-part development project:

- **Part 1** (Complete): Foundation & Futuristic HUD ✅
- **Part 2** (Current): Voice Recognition + Natural Speech ✅
- **Part 3**: AI Brain & Memory System
- **Part 4**: Tools & Integrations
- **Part 5**: Autonomous Agent Capabilities

## 🚀 Features

### Part 1 - Foundation
- **Authentication Screen**: Futuristic login with PIN entry
- **Boot Sequence**: Cinematic system initialization animation
- **Main HUD**: Full AI command center interface
- **State System**: Visual states (IDLE, LISTENING, PROCESSING, SPEAKING, EXECUTING)
- **Reactive Orb**: Animated central AI core with particle effects
- **Waveform Visualizer**: Real-time audio waveform display
- **System Metrics**: Simulated CPU, Memory, Network indicators
- **Activity Log**: Real-time event logging

### Part 2 - Voice System
- **Wake Word Detection**: "Hey Alice" wake phrase recognition
- **Speech Recognition**: Real-time speech-to-text using Web Speech API
- **Natural TTS**: Human-like text-to-speech with voice selection
- **Conversation Flow**: Complete wake → listen → process → speak cycle
- **Voice Controls**: Manual wake, stop, and microphone toggle buttons
- **Visual Feedback**: Waveform reacts to actual audio input
- **Error Handling**: Graceful handling of microphone permission issues

### Placeholders for Future Parts
- AI Brain (Part 3)
- Memory system (Part 3)
- Tool execution (Part 4)
- Autonomous agent (Part 5)

## 📁 Project Structure

```
ALICE0/
├── index.html          # Main entry point
├── css/
│   └── styles.css      # All styling (Part 1 & 2)
├── js/
│   ├── app.js          # Main application controller
│   ├── config.js       # Configuration & constants
│   ├── state.js        # State management
│   ├── auth.js         # Authentication module
│   ├── boot.js         # Boot sequence
│   ├── hud.js          # HUD controller
│   ├── utils.js        # Utility functions
│   ├── audio.js        # Audio/microphone manager
│   ├── wakeword.js     # Wake word detection
│   ├── stt.js          # Speech-to-text adapter
│   ├── tts.js          # Text-to-speech adapter
│   └── conversation.js # Conversation flow manager
└── README.md
```

## 🛠️ Technologies

- **Vanilla JavaScript** (ES6 Modules)
- **CSS3** (Custom Properties, Grid, Flexbox, Animations)
- **Google Fonts** (Orbitron, Rajdhani, Share Tech Mono, Exo 2)
- **HTML5 Canvas** (Waveform visualization)
- **Web Speech API** (Speech Recognition & Synthesis)
- **Web Audio API** (Audio analysis for wake word)
- **No external dependencies** (pure vanilla implementation)

## 🎨 Design Philosophy

- **Dark futuristic aesthetic** inspired by advanced AI interfaces
- **Glass morphism** for panel elements
- **Cyan/Teal primary** with Magenta accents
- **Smooth CSS animations** for all transitions
- **Modular architecture** for easy extension

## 🔐 Authentication

**Default PIN**: `1234`

## 🎤 Voice Features

### Wake Word
Say **"Hey Alice"** to activate voice interaction. ALICE will respond with an acknowledgment and start listening.

### Supported Commands (Demo)
- "Hello" / "Hi" - Greeting
- "How are you?" - Response
- "What is your name?" - Introduction
- "What time is it?" - Current time
- "What is the capital of [country]?" - Geographic info
- "Thank you" / "Goodbye" - Closing
- And more natural conversation patterns

### Voice Controls
- **Wake Button**: Manually trigger wake word
- **Stop Button**: Interrupt current speech
- **Mic Toggle**: Enable/disable voice system

## 🖥️ Running the Application

### Option 1: Local Server (Recommended)

```bash
cd ALICE0
python -m http.server 8080
# Open http://localhost:8080
```

### Option 2: Node.js

```bash
cd ALICE0
npx serve
# Open http://localhost:3000
```

### Option 3: VS Code Live Server
1. Install the "Live Server" extension
2. Right-click on `index.html`
3. Select "Open with Live Server"

> **Note**: Voice features require HTTPS in production or localhost for microphone access.

## 📱 Usage Flow

1. **Authentication**: Enter PIN (default: 1234)
2. **Boot Sequence**: Watch the cinematic initialization
3. **HUD**: Wait for "Say Hey Alice" prompt
4. **Voice Interaction**: Say "Hey Alice" to begin
5. **Speak**: Ask questions or give commands
6. **Listen**: Hear ALICE's natural voice response

## ⌨️ Keyboard Shortcuts

- **Enter**: Submit PIN on auth screen
- **Space**: Manual wake (when focused on HUD)

## 🔮 Future Development

### Part 3: AI Brain & Memory
- OpenAI/Gemini API integration
- Conversation context and memory
- User preferences learning
- Long-term memory storage

### Part 4: Tools & Integrations
- Web search capability
- Calculator functions
- Calendar integration
- Smart home control
- Weather information

### Part 5: Autonomous Agent
- Goal-oriented behavior
- Task planning and execution
- Self-improvement capabilities
- Multi-modal interactions

## ⚠️ Current Limitations

- Wake word detection uses simple energy-based detection (can be improved)
- Responses are pattern-matched (Part 3 will add AI)
- No memory persistence (Part 3)
- Microphone must be allowed for voice features
- Some browsers may not support Web Speech API fully
- TTS voice quality depends on system availability

## 🔧 Configuration

Edit `js/config.js` to customize:

```javascript
export const CONFIG = {
    auth: {
        defaultPin: '1234',
    },
    voice: {
        wakeWordEnabled: true,
        autoWakeAfterSpeaking: true,
        wakeWordCooldown: 3000,
        ttsRate: 0.95,
        ttsPitch: 1.0,
        ttsVolume: 1.0
    },
    visuals: {
        primaryColor: '#00f0ff',
        // ...
    }
};
```

## 🌐 Browser Support

- **Chrome/Edge**: Full support (recommended)
- **Firefox**: Partial support (Speech Recognition may vary)
- **Safari**: Partial support (Speech Synthesis only)
- **Mobile**: Works but voice features require user interaction

## 📄 License

This project is for educational and development purposes.

---

**Built with care for the future of AI interfaces.**
