# Arsenals 2D Fluid Exporter V3

**A professional web-based physics sandbox for generating production-ready 2D fluid assets for game development.**

Arsenals V3 is a major update that introduces advanced simulation environments, a deterministic recording engine for flipbooks, and a completely overhauled UI. Create seamless textures, realistic splash sprites, and animated liquid flipbooks directly in your browser.

![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

## 🌟 V3 Highlights

- **Ballistic Velocity Mode**: A new physics environment where you aim and shoot a target block with various calibers (9mm, .45 ACP, Shotgun, Rifle) to generate high-velocity impact splatters and mist.
- **Deterministic Flipbook Engine**: The exporter now records your entire session's event history and re-simulates it frame-by-frame during export. This ensures high-resolution, lag-free sprite sheets regardless of real-time performance.
- **Depth & Normal Maps**: Automatically generate matching Depth (Height) and Normal maps for your fluid textures to use in modern game lighting shaders.
- **Smart Expansion**: A cellular automata-based mode for simulating viscous fingering, alien creep, and filling complex shapes.
- **UI Overhaul**: A prioritized interface with Dark/Light themes, mobile optimization, and detailed built-in documentation.

## 🎨 Simulation Environments

### 1. Wall Splatter
Simulates liquid hitting a vertical surface. Gravity pulls particles down, creating realistic streaks and drips based on viscosity and accumulation. Perfect for blood hits, runny paint, or leaking pipes.

### 2. Floor Splatter / Pools
Simulates liquid pooling on a horizontal surface using a height-field simulation. Particles repel each other to fill volume, creating organic, irregular puddles that spread naturally.

### 3. Ballistic Velocity
Aim a target cube and fire projectiles to create dynamic impact patterns.
- **Calibers**: Choose from .22LR, 9mm, .45 ACP, 5.56mm (Rifle), and 12 Gauge.
- **Physics**: Simulates the difference between high-speed mist and heavy droplets.
- **Interactive**: Drag the target cube to position the impact zone.

### 4. One Click Pool
Instantly generates a settled, realistic liquid pool with a single click. Uses multi-layer rendering to create depth (darker centers, lighter edges).

### 5. Smart Expansion
An algorithmic flow mode that "fills" space intelligently. Uses logic similar to biological growth or viscous fluid expansion to fill masks or grow organically.

### 6. Vector Drip
Generates clean, stylized drips with branching paths.

## 💾 Export Pipeline

Arsenals V3 is designed to get assets *out* of the browser and into your game engine (Unity, Unreal, Godot).

- **Static Textures**: Export the current frame as a high-resolution PNG (up to 4096px).
- **Flipbooks**: Export animated sprite sheets with frame blending.
- **Auxiliary Maps**:
  - **Depth Map**: Grayscale height map.
  - **Normal Map**: Tangent space normal map generated from the depth data.

## 🛠️ Controls

- **Left Click / Touch**: Spawn fluid or interact.
- **Middle Mouse / Space + Drag**: Pan the viewport.
- **Scroll Wheel**: Zoom.
- **Substeps**: The most critical quality setting. Increase this (3-5) for accurate collisions and smoother flow at the cost of performance.

## 📦 Installation & Usage

No build process required. This project uses vanilla JavaScript with ES6 modules.

1. Clone the repository:
   ```bash
   git clone https://github.com/Arsenals/fluid-exporter-v3.git