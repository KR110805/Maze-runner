# 🏆 ACM Maze Quest

<p align="center">
  <strong>A turnkey, Kahoot-style real-time multiplayer labyrinth game engineered for interactive events, hackathons, and classroom competitions.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Deployment-Vercel%20Ready-black?style=for-the-badge&logo=vercel" alt="Vercel Ready" />
  <img src="https://img.shields.io/badge/Sync-Serverless%20%2B%20Redis-00e599?style=for-the-badge&logo=redis" alt="Upstash Redis" />
  <img src="https://img.shields.io/badge/Graphics-Canvas%202D%20Engine-38bdf8?style=for-the-badge&logo=html5" alt="HTML5 Canvas 2D" />
  <img src="https://img.shields.io/badge/Audio-Web%20Audio%20API-a855f7?style=for-the-badge" alt="Web Audio API" />
  <img src="https://img.shields.io/badge/License-MIT-amber?style=for-the-badge" alt="MIT License" />
</p>

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [Graphics & Atmospheric Engine](#-graphics--atmospheric-engine)
- [How the Game Works](#-how-the-game-works)
- [System Architecture](#-system-architecture)
- [Deployment Guide](#-deployment-guide)
  - [Deploy to Vercel (Recommended)](#1-deploy-to-vercel-recommended)
  - [Environment Variables](#2-environment-variables-optional)
  - [Local Development](#3-local-development)
- [Game Rules & Mechanics](#-game-rules--mechanics)
- [Repository Structure](#-repository-structure)
- [Configuration & Customization](#-configuration--customization)
- [Browser & Device Support](#-browser--device-support)
- [License](#-license)

---

## 🌟 Overview

**ACM Maze Quest** brings the thrilling, high-energy audience experience of **Kahoot** to procedural dungeon exploration. Designed specifically for audience engagement at tech events, ACM student chapter meetups, workshops, and conferences:

1. **Host opens the Big Screen**: Displays an automatic live QR code tailored for projector screens without sensitive configuration banners.
2. **Up to 300 players scan and join instantly**: Works across disparate cellular networks (4G/5G), guest Wi-Fi networks, and desktop browsers without requiring identical local subnets.
3. **Players wait in the live lobby**: Nicknames are validated in real-time with live player count updates.
4. **Host triggers synchronized countdown**: A cinematic **3... 2... 1... GO!** sequence flashes across all participant screens simultaneously.
5. **The Race Begins**: Players guide their 3D operative through a dark 25×25 low-poly labyrinth to find hidden **A**, **C**, and **N** runes before the 2-minute timer expires.
6. **Grand Podium & Leaderboard**: As soon as all players finish or time runs out, an animated podium reveals the top 3 champions and complete participant rankings.

---

## ⚡ Key Features

- **🎮 3D Follow-Camera Viewport (v2)**: Slanted top-down follow camera locked onto the player avatar (Hunter Assassin perspective) turning mobile displays into localized exploration windows.
- **🕯️ Real-Time Line-of-Sight & Soft Shadows**: Dynamic character torch and directional spotlight casting real-time soft shadows against 3D maze geometry to hide corridors around corners.
- **✨ 3D Low-Poly Collectibles**: Rotating, floating, glowing 3D extruded rune glyphs for target letters **A**, **C**, and **N**.
- **🕹️ Smooth 360° Touch Joystick & Slide Physics**: Auto-detecting virtual floating joystick, touch-drag pathing, on-screen D-Pad, and desktop keyboard with clean wall-sliding collision physics.
- **🌐 Cross-Network Multiplayer**: Uses cloud persistence via Upstash Redis and Vercel Serverless Functions to eliminate split-brain issues across different mobile networks.
- **📱 Instant Zero-Install Access**: Players scan the host screen QR code with standard phone cameras; no downloads, account registrations, or app installations required.
- **🏁 Automatic Round Conclusion**: Concludes immediately when all players finish or when timer hits 00:00, revealing the podium and leaderboard.
- **🔊 Procedural Web Audio Engine**: Zero-asset audio powered entirely by native Web Audio API oscillators—footsteps, wall bumps, countdown beeps, rune collection chords, and victory fanfare.

---

## 🎨 3D Graphics & Visibility Engine (v2)

The game features a high-performance **Three.js WebGL 3D engine** delivering a stylized dark dungeon aesthetic at a silky 60 FPS:

| Component | Visual Implementation |
| :--- | :--- |
| **🧱 3D Modeled Walls** | Low-poly beveled masonry blocks with height, casting real-time soft shadows into adjacent corridors. |
| **🪨 Flagstone Floor** | Textured dark slate flagstone corridors receiving dynamic character shadows. |
| **🔦 Dynamic Torch & Vision Cone** | Real-time PointLight torch + directional forward SpotLight sweeping around corners to reveal corridors. |
| **👤 3D Operative Avatar** | Stylized operative character with illuminated neon visor, walking sway, and smooth rotation physics. |
| **🔮 3D Floating Runes (A, C, N)** | Extruded 3D geometric letters floating, rotating, and bobbing over concentric shockwave floor medallions. |
| **✨ 3D Collection Bursts** | Radiant 3D particle fountains exploding outward upon rune pickup. |
| **🌌 Viewport Fog of War** | Exponential dungeon fog shrouding distant corridors beyond the immediate line of sight. |

---

## 🕹️ How the Game Works

```mermaid
sequenceDiagram
    autonumber
    actor Host as Host (Projector)
    actor Cloud as Vercel / Redis API
    actor Player as Players (Mobile / 4G)

    Host->>Cloud: Create Room (e.g. ACM2026)
    Host->>Host: Display Auto-Generated QR Code
    Player->>Host: Scan QR Code with Phone Camera
    Player->>Cloud: Join with Unique Nickname
    Cloud-->>Host: Update Live Player Counter & Roster
    Player->>Player: Enter Kahoot-Style Waiting Room
    Host->>Cloud: Click "Start Game" (2 Min Round)
    Cloud-->>Host: Trigger 3-Second Countdown
    Cloud-->>Player: Trigger 3-Second Countdown
    Note over Host,Player: 3... 2... 1... GO!
    Host->>Host: Display Live Finisher Tracker
    Player->>Player: Explore Fog-of-War Maze (Collect A, C, M)
    Player->>Cloud: Submit Completion Timestamp
    Note over Host,Player: Timer Hits 00:00 or All Finished
    Cloud-->>Host: Broadcast Final Rankings
    Cloud-->>Player: Broadcast Final Rankings
    Host->>Host: Render Grand 3D Podium & Full Leaderboard
    Player->>Player: Render Rank & Placement Card
```

---

## 🏗️ System Architecture

```
acm-maze-game/
├── api/
│   └── room.js          # Serverless room controller (State, Sync, Poll, Finish)
├── audio.js             # Web Audio API procedural sound synthesizer
├── config.js            # Optional Firebase fallback configuration
├── game.js              # High-fidelity Canvas 2D engine & game loop
├── host.html            # Kahoot-style Big Screen host dashboard
├── index.html           # Player responsive client (Lobby, Game, Podium)
├── maze.js              # Recursive backtracker maze generator & rune spawner
├── package.json         # Node metadata & local scripts
├── player.js            # Player controller & multiplayer state management
├── qrcode.min.js        # Standalone client-side QR generator
├── style.css            # Dark mode design system & Kahoot UI components
├── sync.js              # Network synchronization adapter (API / Local)
└── vercel.json          # Vercel deployment routing & CORS headers
```

---

## 🚀 Deployment Guide

### 1. Deploy to Vercel (Recommended)

Because this repository already contains pre-configured [`vercel.json`](vercel.json), [`package.json`](package.json), and serverless API endpoints in [`api/room.js`](api/room.js), deployment takes less than two minutes:

#### Step A: Push to GitHub
```bash
# Initialize and push to your GitHub account
git remote add origin https://github.com/<your-username>/acm-maze-game.git
git branch -M main
git push -u origin main
```

#### Step B: Import into Vercel
1. Navigate to [Vercel Dashboard](https://vercel.com/dashboard) and click **Add New... > Project**.
2. Select your imported `acm-maze-game` repository.
3. Leave default build configurations untouched (Static HTML + Serverless Functions).
4. Click **Deploy**.
5. Your game is immediately live at `https://<your-project>.vercel.app`.

---

### 2. Environment Variables (Optional)

The application includes built-in cloud persistence defaults. For custom isolated production setups, you can connect your own free [Upstash Redis](https://upstash.com/) instance:

In your **Vercel Project Settings > Environment Variables**, add:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint | Pre-configured fallback |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST authorization token | Pre-configured fallback |

---

### 3. Local Development

You can run the full environment locally with any static web server:

#### Using Node.js
```bash
# Clone the repository
git clone https://github.com/<your-username>/acm-maze-game.git
cd acm-maze-game

# Serve locally
npx serve .
```

#### Using PowerShell (Windows)
```powershell
# Run the included lightweight PowerShell server script
.\server.ps1
```

Open `http://localhost:3000/host.html` for the host dashboard and `http://localhost:3000/index.html` for player sessions.

---

## 📜 Game Rules & Mechanics

| Rule | Specification |
| :--- | :--- |
| **Grid Dimensions** | 25 × 25 grid generated with Randomized Depth-First Search with subtle navigation loops for medium difficulty. |
| **Letters (A, C, M)** | Spawned at random path coordinates with significant distance constraints; completely invisible until the player physically reaches their tile. |
| **Collection Order** | Players may collect **A**, **C**, and **M** in **any sequence** (e.g., M ➔ A ➔ C). |
| **Fog of War** | Unvisited corridors remain enshrouded in darkness; floor flagstones are revealed only as they are traversed. |
| **Wall Visibility** | Walls maintain faint, spectral visibility (`~48%` opacity) allowing navigation planning without spoiling rune locations. |
| **Round Duration** | Strictly 2 Minutes (`02:00` ➔ `00:00`). When the timer concludes, unfinished runs auto-submit current progress. |

---

## ⚙️ Configuration & Customization

### Room Parameters
To adjust default room behavior or round duration, inspect [`api/room.js`](api/room.js):
```javascript
function getDefaultRoom(id) {
    return {
        id,
        status: "LOBBY",
        timeLimit: 120, // Duration in seconds (2 minutes)
        // ...
    };
}
```

### Visual Styling & Theme
Theme accents and branding can be customized in [`style.css`](style.css):
```css
:root {
    --bg-dark: #060913;
    --card-bg: rgba(15, 23, 42, 0.85);
    --border-color: rgba(56, 189, 248, 0.2);
    --accent-blue: #38bdf8;
    --color-a: #ffb703; /* Gold for Rune 'A' */
    --color-c: #00f5d4; /* Cyan for Rune 'C' */
    --color-m: #ff006e; /* Magenta for Rune 'M' */
}
```

---

## 🌐 Browser & Device Support

| Platform | Recommended Browsers | Controls |
| :--- | :--- | :--- |
| **Mobile (iOS & Android)** | Safari, Chrome, Firefox, Edge, Samsung Internet | On-Screen Responsive D-Pad & Touch Gestures |
| **Desktop / Laptop** | Chrome, Firefox, Safari, Edge, Brave, Opera | Arrow Keys, WASD, or On-Screen Controls |
| **Host / Projector Displays** | Any modern chromium or webkit browser (1080p / 4K) | Mouse & Standard UI Navigation |

---


## 👥 Team

- **Atharv Sherkar** -
- **Pranit Khndade** -
- **Vaibhav Patil Dhumal* -

---

## 📄 License

This project is licensed under the [MIT License](LICENSE)—free for educational, chapter, and commercial hackathon use.

<p align="center">
  Made with ❤️ for ACM Student Chapters & Tech Communities worldwide.
</p>
# Maze-runner
