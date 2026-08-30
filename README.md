# ALICE - Advanced Intelligence & Learning Interactive Companion Engine

A futuristic browser-based AI assistant interface inspired by JARVIS, with its own unique identity and design.

![ALICE Interface](https://img.shields.io/badge/Version-0.1.0--alpha-blue)
![Status](https://img.shields.io/badge/Status-Development-yellow)

## 🎯 Project Overview

ALICE is a 5-part development project:

- **Part 1** (Current): Foundation & Futuristic HUD ✅
- **Part 2**: Voice Recognition + AI Brain
- **Part 3**: Memory System
- **Part 4**: Tools & Integrations
- **Part 5**: Autonomous Agent Capabilities

## 🚀 Features (Part 1)

### Implemented
- **Authentication Screen**: Futuristic login with PIN entry
- **Boot Sequence**: Cinematic system initialization animation
- **Main HUD**: Full AI command center interface
- **State System**: Visual states (IDLE, LISTENING, PROCESSING, SPEAKING, EXECUTING)
- **Reactive Orb**: Animated central AI core with particle effects
- **Waveform Visualizer**: Real-time audio waveform display
- **System Metrics**: Simulated CPU, Memory, Network indicators
- **Activity Log**: Real-time event logging
- **Debug Controls**: State simulation for testing
- **Responsive Design**: Works on desktop, tablet, and mobile

### Placeholders for Part 2+
- Speech Recognition interface
- Text-to-Speech interface
- AI Brain connection
- Memory system
- Tool execution

## 📁 Project Structure

```
ALICE0/
├── index.html          # Main entry point
├── css/
│   └── styles.css      # All styling
├── js/
│   ├── app.js          # Main application controller
│   ├── config.js       # Configuration & constants
│   ├── state.js        # State management
│   ├── auth.js         # Authentication module
│   ├── boot.js         # Boot sequence
│   ├── hud.js          # HUD controller
│   └── utils.js        # Utility functions
├── assets/             # Future assets folder
└── README.md
```

## 🛠️ Technologies

- **Vanilla JavaScript** (ES6 Modules)
- **CSS3** (Custom Properties, Grid, Flexbox, Animations)
- **Google Fonts** (Orbitron, Rajdhani, Share Tech Mono, Exo 2)
- **HTML5 Canvas** (Waveform visualization)
- **No external dependencies** (pure vanilla implementation)

## 🎨 Design Philosophy

- **Dark futuristic aesthetic** inspired by advanced AI interfaces
- **Glass morphism** for panel elements
- **Cyan/Teal primary** with Magenta accents
- **Smooth CSS animations** for all transitions
- **Modular architecture** for easy extension

## 🔐 Authentication

**Default PIN**: `1234` (for prototype)

The authentication system:
- Validates PIN input
- Shows visual feedback (pin dots)
- Supports lockout after 5 failed attempts
- Clean transition to boot sequence

**Note**: This is a prototype authentication. Production should use proper server-side validation.

## 🖥️ Running the Application

### Option 1: Direct File Access
Open `index.html` directly in a modern browser (Chrome, Firefox, Edge, Safari).

> **Note**: Some browsers may block ES6 modules from file:// protocol. Use Option 2 or 3 if you encounter issues.

### Option 2: Local Server (Recommended)

Using Python:
```bash
cd ALICE0
python -m http.server 8080
# Open http://localhost:8080
```

Using Node.js:
```bash
cd ALICE0
npx serve
# Open http://localhost:3000
```

Using PHP:
```bash
cd ALICE0
php -S localhost:8080
# Open http://localhost:8080
```

### Option 3: VS Code Live Server
1. Install the "Live Server" extension
2. Right-click on `index.html`
3. Select "Open with Live Server"

## 📱 Usage Flow

1. **Authentication**: Enter PIN (default: 1234)
2. **Boot Sequence**: Watch the cinematic initialization
3. **HUD**: Interact with the main interface
4. **Debug Panel**: Use buttons to simulate different AI states

## ⌨️ Keyboard Shortcuts

- **Enter**: Submit PIN on auth screen
- **ESC**: Toggle debug panel (when open)

## 🔮 Future Development

### Part 2: Voice + AI Brain
- Web Speech API for voice recognition
- Speech synthesis for responses
- OpenAI/Gemini API integration
- Natural language processing

### Part 3: Memory System
- Conversation history
- User preferences storage
- Long-term memory
- Context awareness

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

## ⚠️ Limitations (Part 1)

- No actual voice recognition (UI placeholder only)
- No AI processing (responses are not implemented)
- No memory persistence (data resets on reload)
- No real system metrics (simulated values)
- Authentication is client-side only (not secure for production)

## 🔧 Configuration

Edit `js/config.js` to customize:

```javascript
export const CONFIG = {
    auth: {
        defaultPin: '1234',  // Change default PIN
        maxAttempts: 5,      // Max login attempts
        lockoutDuration: 30000
    },
    visuals: {
        primaryColor: '#00f0ff',
        secondaryColor: '#ff00aa',
        accentColor: '#00ff88'
    }
    // ... more options
};
```

## 📄 License

This project is for educational and development purposes.

## 🤝 Contributing

This is a development session. Contributions would be welcome in future versions.

---

**Built with care for the future of AI interfaces.**
