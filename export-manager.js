import { FluidSimulator } from './fluid-sim.js';

export class ExportManager {
  constructor(simulator) {
    this.simulator = simulator;
  }

  async exportTexture(resolution, includeDepth, onProgress) {
    onProgress(0);
    
    const canvas = document.createElement('canvas');
    canvas.width = resolution;
    canvas.height = resolution;
    const ctx = canvas.getContext('2d');
    
    // Render Fluid
    this.renderToContext(ctx, resolution);
    
    onProgress(50);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    this.downloadBlob(blob, 'fluid-texture.png');
    
    // Render Depth if requested
    if (includeDepth) {
      const depthCanvas = document.createElement('canvas');
      depthCanvas.width = resolution;
      depthCanvas.height = resolution;
      const depthCtx = depthCanvas.getContext('2d');
      
      this.renderDepthToContext(depthCtx, resolution);
      
      onProgress(80);
      const depthBlob = await new Promise(resolve => depthCanvas.toBlob(resolve, 'image/png'));
      this.downloadBlob(depthBlob, 'fluid-depth.png');
    }
    
    onProgress(100);
  }
  
  renderToContext(ctx, resolution) {
    const scaleFactor = resolution / this.simulator.width;
    // Tighter blur for more detail in floor mode (TLOU2 style puddles)
    const isPoolMode = this.simulator.mode === 'floor' || this.simulator.mode === 'one-click';
    const blurAmt = isPoolMode ? 4 * scaleFactor : 8 * scaleFactor;
    // Higher contrast for sharper edges
    const contrast = isPoolMode ? 35 : 20;
    
    ctx.filter = `blur(${blurAmt}px) contrast(${contrast})`;

    ctx.clearRect(0, 0, resolution, resolution);
    
    const scaleX = resolution / this.simulator.width;
    const scaleY = resolution / this.simulator.height;
    
    // Draw Surface (Wall streaks or Floor stains)
    ctx.drawImage(this.simulator.surfaceCanvas, 0, 0, resolution, resolution);

    // Only draw particles if NOT in floor mode/pool mode
    // For floor/pool mode, user wants "what is left behind"
    if (!isPoolMode) {
      for (const p of this.simulator.particles) {
        const radius = p.mass * scaleX; 
        const x = p.x * scaleX;
        const y = p.y * scaleY;
        
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  renderDepthToContext(ctx, resolution) {
    ctx.clearRect(0, 0, resolution, resolution);
    const scaleX = resolution / this.simulator.width;
    const scaleY = resolution / this.simulator.height;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, resolution, resolution);
    
    // Draw surface stain for all modes
    ctx.filter = 'grayscale(100%) brightness(200%)';
    ctx.drawImage(this.simulator.surfaceCanvas, 0, 0, resolution, resolution);
    ctx.filter = 'none';

    for (const p of this.simulator.particles) {
      const x = p.x * scaleX;
      const y = p.y * scaleY;
      const radius = p.mass * scaleX;
      
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, 'rgba(255, 255, 255, 1)');
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
      
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  async generateReplayFlipbook(events, totalDuration, frameCount, resolution, includeDepth, onProgress) {
    // 1. Setup Ghost Simulator
    const sim = new FluidSimulator(1024, 1024);
    sim.setSeed(1337); // Ensure deterministic replay
    
    // Canvas for frame capturing
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = resolution;
    frameCanvas.height = resolution;
    const ctx = frameCanvas.getContext('2d');
    
    // Output Sheet
    const cols = Math.ceil(Math.sqrt(frameCount));
    const rows = Math.ceil(frameCount / cols);
    const sheetWidth = cols * resolution;
    const sheetHeight = rows * resolution;
    
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = sheetWidth;
    outputCanvas.height = sheetHeight;
    const outputCtx = outputCanvas.getContext('2d');
    
    let depthOutputCanvas = null;
    let depthOutputCtx = null;
    if (includeDepth) {
        depthOutputCanvas = document.createElement('canvas');
        depthOutputCanvas.width = sheetWidth;
        depthOutputCanvas.height = sheetHeight;
        depthOutputCtx = depthOutputCanvas.getContext('2d');
    }

    // 2. Simulation Loop
    const dt = 16; // Physics step (ms)
    let simTime = 0;
    let nextEventIndex = 0;
    
    for (let f = 0; f < frameCount; f++) {
        // Target time for this frame
        const targetTime = (f / (frameCount - 1)) * totalDuration;
        
        // Catch up physics
        while (simTime < targetTime) {
            // Apply events happening in this window
            while (nextEventIndex < events.length && events[nextEventIndex].time <= simTime) {
                this.applyEvent(sim, events[nextEventIndex]);
                nextEventIndex++;
            }
            
            // Step physics
            // Convert ms to seconds
            sim.update(dt / 1000);
            simTime += dt;
        }
        
        // Render Frame
        // Note: we use the renderToContext method to ensure consistent look (scaling, particles etc)
        // But we want to apply the Goo filter which renderToContext does using blur/contrast
        
        // Temporarily swap simulator reference to use the helper methods
        const originalSim = this.simulator;
        this.simulator = sim;
        
        this.renderToContext(ctx, resolution);
        // Copy to sheet
        const col = f % cols;
        const row = Math.floor(f / cols);
        outputCtx.drawImage(frameCanvas, col * resolution, row * resolution);
        
        if (includeDepth) {
            this.renderDepthToContext(ctx, resolution);
            depthOutputCtx.drawImage(frameCanvas, col * resolution, row * resolution);
        }
        
        this.simulator = originalSim;
        
        onProgress((f / frameCount) * 100);
        await new Promise(r => setTimeout(r, 0)); // Yield
    }
    
    // Download
    const blob = await new Promise(resolve => outputCanvas.toBlob(resolve, 'image/png'));
    this.downloadBlob(blob, 'flipbook-color.png');
    
    if (includeDepth) {
        const dBlob = await new Promise(resolve => depthOutputCanvas.toBlob(resolve, 'image/png'));
        this.downloadBlob(dBlob, 'flipbook-depth.png');
    }
  }

  applyEvent(sim, event) {
    const { type, data } = event;
    switch(type) {
        case 'init': 
            sim.setState(data);
            break;
        case 'spawn':
            sim.spawn(data.x, data.y);
            break;
        case 'setViscosity': sim.setViscosity(data); break;
        case 'setDensity': sim.setDensity(data); break;
        case 'setGravity': sim.setGravity(data); break;
        case 'setSurfaceTension': sim.setSurfaceTension(data); break;
        case 'setSpawnRate': sim.setSpawnRate(data); break;
        case 'setSpawnVelocity': sim.setSpawnVelocity(data); break;
        case 'setSpreadAngle': sim.setSpreadAngle(data); break;
        case 'setParticleSize': sim.setParticleSize(data); break;
        case 'setOpacity': sim.setOpacity(data); break;
        case 'setColor': sim.setColor(data); break;
        case 'setMode': sim.setMode(data); break;
        case 'setSpawnMode': sim.setSpawnMode(data); break;
        case 'setSpawnDirection': sim.setSpawnDirection(data); break;
        case 'applyMaterial': sim.applyMaterial(data); break;
        case 'setTurbulence': sim.setTurbulence(data); break;
        case 'spawnPool': sim.spawnPool(data.x, data.y); break;
        case 'drawShape': sim.updateMask(data.x, data.y, data.radius, data.erase); break;
        case 'clearMask': sim.clearMask(); break;
    }
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}