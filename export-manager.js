import { FluidSimulator } from './fluid-sim.js';

export class ExportManager {
  constructor(simulator) {
    this.simulator = simulator;
  }

  async exportTexture(resolution, includeDepth, includeNormal, onProgress) {
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
      
      onProgress(75);
      const depthBlob = await new Promise(resolve => depthCanvas.toBlob(resolve, 'image/png'));
      this.downloadBlob(depthBlob, 'fluid-depth.png');
    }

    // Render Normal if requested
    if (includeNormal) {
      // Need a transparent depth map for accurate normals calculation at edges
      const depthCanvas = document.createElement('canvas');
      depthCanvas.width = resolution;
      depthCanvas.height = resolution;
      const depthCtx = depthCanvas.getContext('2d');
      this.renderDepthToContext(depthCtx, resolution, true); // true = transparent bg

      const normalCanvas = this.generateNormalMap(depthCanvas);
      
      onProgress(90);
      const normalBlob = await new Promise(resolve => normalCanvas.toBlob(resolve, 'image/png'));
      this.downloadBlob(normalBlob, 'fluid-normal.png');
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
    if (this.simulator.mode === 'tlou' || this.simulator.mode === 'smart' || this.simulator.mode === 'experimental') {
         // Render the grid-based modes
         const tempC = document.createElement('canvas');
         tempC.width = this.simulator.width;
         tempC.height = this.simulator.height;
         const tempCtx = tempC.getContext('2d');
         
         if (this.simulator.mode === 'tlou') this.simulator.renderTLOU(tempCtx);
         else if (this.simulator.mode === 'experimental') this.simulator.renderExperimental(tempCtx);
         else this.simulator.renderSmartExpansion(tempCtx);
         
         ctx.drawImage(tempC, 0, 0, resolution, resolution);
    } else {
         ctx.drawImage(this.simulator.surfaceCanvas, 0, 0, resolution, resolution);
    }

    // Only draw particles if NOT in floor mode/pool mode
    // For floor/pool mode, user wants "what is left behind"
    const isGridMode = this.simulator.mode === 'tlou' || this.simulator.mode === 'smart' || this.simulator.mode === 'experimental';
    if (!isPoolMode && !isGridMode) {
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

  renderDepthToContext(ctx, resolution, transparent = false) {
    ctx.clearRect(0, 0, resolution, resolution);
    const scaleX = resolution / this.simulator.width;
    const scaleY = resolution / this.simulator.height;

    if (!transparent) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, resolution, resolution);
    }
    
    if (this.simulator.mode === 'tlou' || this.simulator.mode === 'smart' || this.simulator.mode === 'experimental') {
        // Grid modes depth
        const tempC = document.createElement('canvas');
        tempC.width = this.simulator.width;
        tempC.height = this.simulator.height;
        const tempCtx = tempC.getContext('2d');
        this.simulator.renderDepth(tempCtx); 
        ctx.drawImage(tempC, 0, 0, resolution, resolution);
    } else {
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
  }

  async generateReplayFlipbook(events, totalDuration, frameCount, resolution, includeDepth, includeNormal, onProgress) {
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

    let normalOutputCanvas = null;
    let normalOutputCtx = null;
    if (includeNormal) {
        normalOutputCanvas = document.createElement('canvas');
        normalOutputCanvas.width = sheetWidth;
        normalOutputCanvas.height = sheetHeight;
        normalOutputCtx = normalOutputCanvas.getContext('2d');
    }

    // 2. Simulation Loop
    const STEP = 1/60; // Physics step (seconds)
    let simTime = 0;
    let nextEventIndex = 0;
    
    // Safety break to prevent infinite loops if duration is 0
    if (totalDuration <= 0.001) totalDuration = 0.1;

    for (let f = 0; f < frameCount; f++) {
        // Target time for this frame
        const targetTime = (f / (frameCount - 1)) * totalDuration;
        
        // Catch up physics with aggressively robust yielding
        let stepsSinceYield = 0;
        while (simTime < targetTime + 0.0001) {
            // Apply events happening in this window
            while (nextEventIndex < events.length && events[nextEventIndex].time <= simTime) {
                await this.applyEvent(sim, events[nextEventIndex]);
                nextEventIndex++;
            }
            
            // Step physics
            sim.update(STEP);
            simTime += STEP;
            
            // Yield frequently to keep browser responsive
            stepsSinceYield++;
            if (stepsSinceYield >= 5) { 
                await new Promise(r => setTimeout(r, 0));
                stepsSinceYield = 0;
            }
        }
        
        // Render Frame
        const originalSim = this.simulator;
        this.simulator = sim;
        
        this.renderToContext(ctx, resolution);
        const col = f % cols;
        const row = Math.floor(f / cols);
        outputCtx.drawImage(frameCanvas, col * resolution, row * resolution);
        
        if (includeDepth) {
            this.renderDepthToContext(ctx, resolution);
            depthOutputCtx.drawImage(frameCanvas, col * resolution, row * resolution);
        }

        if (includeNormal) {
            this.renderDepthToContext(ctx, resolution, true);
            const nCanvas = this.generateNormalMap(frameCanvas);
            normalOutputCtx.drawImage(nCanvas, col * resolution, row * resolution);
        }
        
        this.simulator = originalSim;
        
        onProgress(((f + 1) / frameCount) * 100);
        
        // Yield after each frame
        await new Promise(r => setTimeout(r, 0));
    }
    
    // Download with proper async handling
    onProgress(100);
    await new Promise(r => setTimeout(r, 100)); // Small delay before blob creation
    
    const blob = await new Promise(resolve => outputCanvas.toBlob(resolve, 'image/png'));
    this.downloadBlob(blob, 'flipbook-color.png');
    
    if (includeDepth) {
        const dBlob = await new Promise(resolve => depthOutputCanvas.toBlob(resolve, 'image/png'));
        this.downloadBlob(dBlob, 'flipbook-depth.png');
    }

    if (includeNormal) {
        const nBlob = await new Promise(resolve => normalOutputCanvas.toBlob(resolve, 'image/png'));
        this.downloadBlob(nBlob, 'flipbook-normal.png');
    }
  }

  generateNormalMap(depthCanvas) {
    const width = depthCanvas.width;
    const height = depthCanvas.height;
    const ctx = depthCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    
    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = width;
    normalCanvas.height = height;
    const normalCtx = normalCanvas.getContext('2d');
    const normalData = normalCtx.createImageData(width, height);
    const nd = normalData.data;

    const strength = 3.0; 

    // Helper to get height (0-1) from red channel
    const getH = (x, y) => {
        // Clamp
        const nx = Math.max(0, Math.min(width-1, x));
        const ny = Math.max(0, Math.min(height-1, y));
        const idx = (ny * width + nx) * 4;
        return data[idx] / 255.0;
    };

    for(let y=0; y<height; y++) {
      for(let x=0; x<width; x++) {
        const idx = (y * width + x) * 4;
        const alpha = data[idx+3];
        
        if (alpha < 10) {
            // Background / Transparent
            nd[idx] = 128;
            nd[idx+1] = 128;
            nd[idx+2] = 255;
            nd[idx+3] = 0;
            continue;
        }

        // Sobel-ish filter
        const hL = getH(x-1, y);
        const hR = getH(x+1, y);
        const hT = getH(x, y-1);
        const hB = getH(x, y+1);
        
        // Derivatives
        const dx = (hL - hR) * strength; 
        const dy = (hT - hB) * strength;
        
        let nz = 1.0;
        
        // Normalize
        const len = Math.sqrt(dx*dx + dy*dy + nz*nz);
        const nx = dx / len;
        const ny = dy / len; 
        const n_z = nz / len;
        
        // Pack to 0..255
        nd[idx] = Math.floor((nx + 1) * 127.5);
        nd[idx+1] = Math.floor((ny + 1) * 127.5);
        nd[idx+2] = Math.floor((n_z + 1) * 127.5);
        nd[idx+3] = alpha; 
      }
    }
    
    normalCtx.putImageData(normalData, 0, 0);
    return normalCanvas;
  }

  async applyEvent(sim, event) {
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
        case 'setPoolingRandomness': sim.setPoolingRandomness(data); break;
        case 'setParticleLifetime': sim.setParticleLifetime(data); break;
        case 'setInfiniteLifetime': sim.setInfiniteLifetime(data); break;
        case 'setSizeRandomness': sim.setSizeRandomness(data); break;
        case 'setTimeScale': sim.setTimeScale(data); break;
        case 'setSubsteps': sim.setSubsteps(data); break;
        case 'spawnPool': sim.spawnPool(data.x, data.y); break;
        case 'spawnTLOU': sim.spawnTLOU(data.x, data.y); break;
        case 'spawnBallistic': 
             if(data.caliber) sim.setCaliber(data.caliber);
             sim.spawnBallistic(data.x, data.y, data.angle, data.distance); 
             break;
        case 'spawnExperimental': sim.spawnExperimental(data.x, data.y); break;
        case 'resize': sim.resize(data.width, data.height); break;
        case 'drawShape': sim.updateMask(data.x, data.y, data.radius, data.erase); break;
        case 'clearMask': sim.clearMask(); break;
        case 'setMaskFromImage':
            await new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                    sim.setMaskFromImage(img);
                    resolve();
                };
                img.onerror = resolve; // Continue even if image fails
                img.src = data;
            });
            break;
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