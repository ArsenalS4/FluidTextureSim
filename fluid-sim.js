export class FluidSimulator {
  constructor(width, height) {
    this.width = width;
    this.height = height;

    // Pseudo Random State
    this.seed = 1337;

    // Persistent Surface (the texture)
    this.surfaceCanvas = document.createElement('canvas');
    this.surfaceCanvas.width = width;
    this.surfaceCanvas.height = height;
    this.surfaceCtx = this.surfaceCanvas.getContext('2d');
    
    // Wet Map for accumulation (0 = dry, >0 = wet)
    this.wetMap = new Uint8Array(width * height);
    
    // Particles
    this.particles = [];
    this.maxParticles = 4000; // Increased for better pools
    
    // Properties
    this.mode = 'wall';
    this.spawnMode = 'spray'; // 'spray' or 'drop'
    this.viscosity = 0.2; 
    this.density = 50; 
    this.gravityStrength = 0.5;
    this.spawnRate = 30;
    this.spawnVelocity = 50;
    this.spawnDirection = Math.PI / 2; // Down by default
    this.spreadAngle = 30;
    this.particleSize = 10; 
    this.color = '#ff0000';
    this.opacity = 0.9;
    
    // Turbulence for floor pools
    this.turbulence = 0;
    this.noiseOffset = Math.random() * 1000;
    
    // Active Emitters (for slow pool formation)
    this.emitters = [];
    
    // Shape Mask (Constraint)
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;
    this.maskCtx = this.maskCanvas.getContext('2d');
    this.maskData = new Uint8Array(width * height); // 0 = blocked, 1 = open
    this.hasMask = false;

    // Shader/Material Props
    this.material = 'custom';
  }

  // PRNG
  random() {
    const x = Math.sin(this.seed++) * 10000;
    return x - Math.floor(x);
  }

  // Coherent noise for organic group movement
  noise(x, y) {
    const s = 0.005; // Low frequency for large structures
    const o = this.noiseOffset;
    return Math.sin(x * s + o) * Math.cos(y * s * 0.8 + o) + 
           Math.sin(x * s * 0.5 - o) * Math.cos(y * s * 0.3 + o) * 0.5;
  }
  
  setSeed(s) { this.seed = s; }

  // Setters
  setTurbulence(val) { this.turbulence = val; }
  setMode(mode) { 
    this.mode = mode; 
    this.reset();
    // Also clear mask when switching modes to avoid confusion
    this.clearMask();
  }
  setSpawnMode(mode) { this.spawnMode = mode; }
  setSpawnDirection(rad) { this.spawnDirection = rad; }
  setViscosity(val) { this.viscosity = val; } 
  setDensity(val) { this.density = val; }
  setGravity(val) { this.gravityStrength = val; }
  setSurfaceTension(val) { /* Legacy hook */ }
  setSpawnRate(val) { this.spawnRate = val; }
  setSpawnVelocity(val) { this.spawnVelocity = val; }
  setSpreadAngle(val) { this.spreadAngle = val; }
  setParticleSize(val) { this.particleSize = 4 + val * 2; }
  setOpacity(val) { this.opacity = val; }
  setColor(val) { this.color = val; }
  
  applyMaterial(mat) {
    this.material = mat;
    const presets = {
      water: { color: '#2b95ff', viscosity: 0.1, density: 40, opacity: 0.6 },
      blood: { color: '#7a0000', viscosity: 0.5, density: 80, opacity: 0.95 },
      oil: { color: '#1a1a1a', viscosity: 0.4, density: 55, opacity: 0.98 },
      honey: { color: '#dca600', viscosity: 0.8, density: 80, opacity: 0.9 },
      slime: { color: '#52ff00', viscosity: 0.6, density: 65, opacity: 0.8 },
      chocolate: { color: '#3e2723', viscosity: 0.7, density: 70, opacity: 1.0 }
    };
    
    if (presets[mat]) {
      const p = presets[mat];
      this.color = p.color;
      this.viscosity = p.viscosity;
      this.density = p.density;
      this.opacity = p.opacity;
      
      // Return values to UI
      return p;
    }
    return null;
  }

  resize(width, height) {
    // Save current content
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    tempCanvas.getContext('2d').drawImage(this.surfaceCanvas, 0, 0);

    this.width = width;
    this.height = height;
    this.surfaceCanvas.width = width;
    this.surfaceCanvas.height = height;
    
    // Resize wetmap
    this.wetMap = new Uint8Array(width * height);
    
    // Resize mask
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;
    this.maskCtx = this.maskCanvas.getContext('2d'); // Context resets on resize
    this.maskData = new Uint8Array(width * height);
    this.hasMask = false;
    
    // Restore content
    this.surfaceCtx.drawImage(tempCanvas, 0, 0, width, height);
  }

  reset() {
    this.particles = [];
    this.emitters = [];
    this.surfaceCtx.clearRect(0, 0, this.width, this.height);
    this.wetMap.fill(0);
    this.seed = 1337; 
    this.noiseOffset = Math.random() * 1000;
  }
  
  clearMask() {
    this.hasMask = false;
    this.maskData.fill(0);
    this.maskCtx.clearRect(0, 0, this.width, this.height);
  }

  updateMask(x, y, radius, isErasing) {
    this.hasMask = true;
    
    // Draw visual feedback
    this.maskCtx.globalCompositeOperation = isErasing ? 'destination-out' : 'source-over';
    this.maskCtx.fillStyle = 'rgba(255, 255, 255, 1)';
    this.maskCtx.beginPath();
    this.maskCtx.arc(x, y, radius, 0, Math.PI * 2);
    this.maskCtx.fill();
    
    // Update logic map
    const r = Math.ceil(radius);
    const r2 = r * r;
    const minX = Math.max(0, Math.floor(x - r));
    const maxX = Math.min(this.width, Math.ceil(x + r));
    const minY = Math.max(0, Math.floor(y - r));
    const maxY = Math.min(this.height, Math.ceil(y + r));
    
    const val = isErasing ? 0 : 1;
    
    for(let j=minY; j<maxY; j++) {
        for(let i=minX; i<maxX; i++) {
            const dx = i - x;
            const dy = j - y;
            if (dx*dx + dy*dy <= r2) {
                this.maskData[j * this.width + i] = val;
            }
        }
    }
  }

  spawn(x, y) {
    // If single drop, spawn one big blob
    if (this.spawnMode === 'drop') {
      this.spawnBlob(x, y);
      return;
    }

    const count = Math.ceil(this.spawnRate / 2); 
    const rgb = this.hexToRgb(this.color);
    const colorStr = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1)`;
    const baseSpeed = this.spawnVelocity * 20;

    for(let i=0; i<count; i++) {
      if (this.particles.length >= this.maxParticles) {
        if (this.mode === 'wall') this.particles.shift(); 
        else if (this.random() > 0.5) this.particles.shift(); // Recycle faster in floor mode to leave stains
      }

      let mass = this.particleSize * (0.5 + this.random() * 0.5) * (this.density / 50);
      let vx, vy;

      if (this.mode === 'wall') {
        const spread = (this.spreadAngle * Math.PI / 180);
        const angle = this.spawnDirection + (this.random() - 0.5) * spread;
        const speedVar = 0.5 + this.random() * 1.0; 
        const speed = baseSpeed * speedVar;

        vx = Math.cos(angle) * speed;
        vy = Math.sin(angle) * speed;
      } else {
        // Floor Pool - Oozing Source
        // Spawn tighter, let repulsion do the work
        const angle = (this.random() * Math.PI * 2);
        
        // Very slow initial velocity, relies on internal pressure (repulsion)
        const speed = baseSpeed * 0.1 * this.random();

        vx = Math.cos(angle) * speed;
        vy = Math.sin(angle) * speed;
        
        // Tight cluster
        x += (this.random() - 0.5) * 5;
        y += (this.random() - 0.5) * 5;
      }

      this.particles.push({
        x: x,
        y: y,
        prevX: x,
        prevY: y,
        vx: vx,
        vy: vy,
        mass: mass,
        initialMass: mass,
        color: colorStr,
        active: true,
        life: 1.0 // for floor mode fading
      });
    }
  }

  spawnPool(x, y) {
    // Create an emitter for organic slow growth
    // Duration allows for "bleed out" effect
    const isBlood = this.material === 'blood';
    const duration = isBlood ? 12.0 : 6.0; // Blood bleeds longer
    
    this.emitters.push({
        x: x, 
        y: y,
        active: true,
        age: 0,
        duration: duration,
        type: this.material,
        wanderAngle: this.random() * Math.PI * 2, // For directional bias
        pulsePhase: 0
    });
  }

  spawnBlob(x, y) {
    const particleCount = 20 + Math.floor(this.particleSize * 5);
    const rgb = this.hexToRgb(this.color);
    const colorStr = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1)`;
    const impactForce = this.spawnVelocity * 10; 

    for (let i = 0; i < particleCount; i++) {
      if (this.particles.length >= this.maxParticles) this.particles.shift();

      const angle = this.random() * Math.PI * 2;
      const r = this.random() * this.particleSize * 2;
      
      const px = x + Math.cos(angle) * r;
      const py = y + Math.sin(angle) * r;
      
      let vx = 0, vy = 0;
      
      if (this.mode === 'floor') {
        // Floor Drops: Tight blob that spreads organically
        const speed = this.random() * impactForce * 0.2; 
        vx = Math.cos(angle) * speed;
        vy = Math.sin(angle) * speed;
      } else {
        vx = (this.random() - 0.5) * impactForce;
        vy = Math.abs(this.random()) * impactForce; 
      }

      this.particles.push({
        x: px, y: py, prevX: px, prevY: py,
        vx: vx, vy: vy,
        mass: this.particleSize * (0.5 + this.random()),
        initialMass: this.particleSize,
        color: colorStr,
        active: true,
        life: 1.0
      });
    }
  }

  update(dt) {
    // 1. Process Emitters (One Click Pool Mode)
    for (let i = this.emitters.length - 1; i >= 0; i--) {
        const e = this.emitters[i];
        e.age += dt;
        
        if (e.age > e.duration) {
            this.emitters.splice(i, 1);
            continue;
        }

        // Determine spawn parameters based on material
        let rate = 0;
        let speed = 0;
        let pulseFactor = 0; // 0 to 1

        if (e.type === 'blood') {
            // Heartbeat Pulse: 70 BPM ~ 1.16 Hz -> Period ~0.86s
            // We want a sharp systolic ejection
            const period = 0.8; 
            const phase = (e.age % period) / period;
            // Sharp peak at start of phase
            pulseFactor = Math.pow(Math.exp(-8 * phase), 2); // Quick decay
            
            // "Pumping" effect: Burst of particles + High Velocity
            rate = 10 + 400 * pulseFactor; 
            speed = 5 + 60 * pulseFactor;
            
            // Slight wander of the source direction to create lobes (TLOU2 style)
            // Change direction every few seconds
            e.wanderAngle += (this.random() - 0.5) * 2.0 * dt;
        } else {
            // Steady flow for others (Honey, Oil, etc)
            rate = 60;
            speed = 10;
            e.wanderAngle += (this.random() - 0.5) * 5.0 * dt;
        }

        // Spawn particles
        const count = rate * dt;
        const whole = Math.floor(count);
        const frac = count - whole;
        const numToSpawn = whole + (this.random() < frac ? 1 : 0);
        
        const rgb = this.hexToRgb(this.color);
        const colorStr = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1)`;
        
        for(let k=0; k<numToSpawn; k++) {
            if (this.particles.length >= this.maxParticles) {
                // Steal from oldest? Or random?
                // Random avoids flickering of new particles
                const idx = Math.floor(this.random() * this.particles.length);
                this.particles.splice(idx, 1);
            }

            // Direction: Bias towards wanderAngle but with spread
            const spread = (e.type === 'blood' ? 0.5 : 1.0); // Blood flows more directionally per pump
            const angle = e.wanderAngle + (this.random() - 0.5) * spread;
            
            // Spawn slightly offset to simulate source volume
            const r = this.random() * 2;
            const px = e.x + Math.cos(angle) * r;
            const py = e.y + Math.sin(angle) * r;
            
            const v = speed * (0.5 + this.random() * 0.5);
            
            this.particles.push({
                x: px, y: py, prevX: px, prevY: py,
                vx: Math.cos(angle) * v, 
                vy: Math.sin(angle) * v,
                mass: this.particleSize * (0.6 + this.random() * 0.4),
                initialMass: this.particleSize,
                color: colorStr,
                active: true,
                life: 10.0, // Long life for pools
                pool: true
            });
        }
    }

    // Optimize: Spatial hashing could be used here for repulsion, 
    // but O(N^2) for N=1000 is acceptable in JS on modern machines if logic is simple.
    // We only repulse in floor mode for the "Volume" effect.
    
    if (this.mode === 'floor' || this.mode === 'one-click') {
      this.applyRepulsion(dt);
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.prevX = p.x;
      p.prevY = p.y;
      
      const speed = Math.sqrt(p.vx*p.vx + p.vy*p.vy);

      if (this.mode === 'wall') {
        // Check wet map at particle position
        const ix = Math.floor(p.x);
        const iy = Math.floor(p.y);
        let isWet = false;
        
        // Simple bounds check
        if (ix >= 0 && ix < this.width && iy >= 0 && iy < this.height) {
            isWet = this.wetMap[iy * this.width + ix] > 0;
        }

        const gravity = 2000 * this.gravityStrength;
        p.vy += gravity * dt;
        
        const viscosityFactor = Math.max(0.1, this.viscosity);
        let friction = Math.exp(-viscosityFactor * 5 * dt);
        
        // If sliding on existing liquid, reduce friction (slide further)
        if (isWet) {
             friction = Math.pow(friction, 0.2); 
             // Also prevent X deviation when sliding down a stream
             p.vx *= 0.9; 
        }

        if (speed > 500) friction = Math.pow(friction, 0.5); 
        p.vx *= friction;
        p.vy *= friction;

        // Mass Loss on Wall = Streaks
        const dist = speed * dt;
        let lossRate = 0.05 * (1.0 - this.viscosity * 0.5);
        
        // If wet, barely lose mass (accumulation/combining effect)
        if (isWet) lossRate *= 0.05;

        p.mass -= dist * lossRate * 0.1;
        
        // Random deviation only if not moving fast in a stream
        if (!isWet && speed < 200 && speed > 10) {
           p.vx += (this.random() - 0.5) * 100 * (1-this.viscosity) * dt;
        }

        // Draw Trails Immediately for Wall Mode
        if (p.active && p.mass > 0.5) {
          this.surfaceCtx.fillStyle = p.color;
          this.surfaceCtx.strokeStyle = p.color;
          const width = p.mass * 2;
          this.surfaceCtx.lineWidth = width;
          this.surfaceCtx.lineCap = 'round';
          this.surfaceCtx.lineJoin = 'round';
          this.surfaceCtx.beginPath();
          this.surfaceCtx.moveTo(p.prevX, p.prevY);
          this.surfaceCtx.lineTo(p.x, p.y);
          this.surfaceCtx.stroke();
          this.surfaceCtx.beginPath();
          this.surfaceCtx.arc(p.x, p.y, p.mass, 0, Math.PI * 2);
          this.surfaceCtx.fill();

          // Update WetMap
          if (ix >= 0 && ix < this.width && iy >= 0 && iy < this.height) {
             const idx = iy * this.width + ix;
             this.wetMap[idx] = 255;
             if (ix+1 < this.width) this.wetMap[idx+1] = 255;
             if (ix-1 >= 0) this.wetMap[idx-1] = 255;
             if (iy+1 < this.height) this.wetMap[idx+this.width] = 255;
          }
        }

      } else if (this.mode === 'floor' || this.mode === 'one-click') {
        // FLOOR / POOL MODE - Organic Pool Growth
        const viscosityFactor = Math.max(0.1, this.viscosity);
        // Base friction
        let friction = Math.exp(-viscosityFactor * 2.0 * dt); 
        
        // Coherent Terrain/Noise Influence for "Fingering"
        const nVal = this.noise(p.x, p.y);
        
        // 1. Group Movement (Turbulence)
        // Follow noise gradient - Organic flow
        const angle = nVal * Math.PI * 4; // Higher frequency direction changes
        
        // Base turbulence + extra for organic irregularity
        const turbStrength = (this.turbulence * 50 + 10); 
        
        // Add noise-based force (Simulates uneven floor)
        p.vx += Math.cos(angle) * turbStrength * dt;
        p.vy += Math.sin(angle) * turbStrength * dt;
        
        // Mask Constraint
        if (this.hasMask) {
            const ix = Math.floor(p.x);
            const iy = Math.floor(p.y);
            // Check bounds
            if (ix >= 0 && ix < this.width && iy >= 0 && iy < this.height) {
                if (this.maskData[iy * this.width + ix] === 0) {
                    // Outside valid area: Strong push back / Stop
                    // We simply reflect position to keep them inside
                    p.x = p.prevX;
                    p.y = p.prevY;
                    p.vx *= -0.5;
                    p.vy *= -0.5;
                }
            }
        }

        // 2. Variable Friction (Channeling)
        // Stronger contrast for TLOU2 "finger" style
        // If noise is high, friction is high (rough spot). If low, friction low (channel)
        if (nVal > 0.2) {
             friction *= 0.99; // Flow very easily in channels
        } else {
             friction *= 0.80; // Stuck on rough patches
        }

        p.vx *= friction;
        p.vy *= friction;
        
        // 3. Stain / Pool Accumulation
        if (p.active) {
          const speedFactor = Math.min(1, speed / 50);
          
          // Slight oscillation in radius for rough edges
          // Use particle ID or coordinate hash for consistent jaggedness
          const jagged = Math.sin(p.x * 0.5) * Math.cos(p.y * 0.5);
          const r = p.mass * (1.0 + jagged * 0.3);
          
          this.surfaceCtx.beginPath();
          this.surfaceCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
          this.surfaceCtx.fillStyle = p.color;
          
          // Accumulation Logic
          // We want the center to get dark/opaque.
          // Use the preset opacity as a base.
          let baseAlpha = this.opacity > 0.9 ? 0.05 : 0.02; // Very low per-frame add for dark liquids to allow gradient build up
          
          if (this.mode === 'one-click') {
             // For one-click, we want heavy accumulation
             baseAlpha = 0.1;
             // If very slow, paint heavier (settling)
             if (speed < 5) baseAlpha = 0.2;
          }
          
          this.surfaceCtx.globalAlpha = baseAlpha;
          this.surfaceCtx.fill();
          this.surfaceCtx.globalAlpha = 1.0;
        }
        
        // Kill logic - settle down
        if (speed < 2.0) {
            p.life -= dt * 2.0; 
        } else {
            // For one-click, allow them to live longer while moving to form bigger pools
            const lifeDecay = this.mode === 'one-click' ? 0.05 : 0.1;
            p.life -= dt * lifeDecay; 
        }
        
        if (p.life <= 0) p.mass = 0;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Kill logic
      const outOfBounds = p.y > this.height + 100 || p.x < -100 || p.x > this.width + 100;
      if (p.mass <= 0.2 || outOfBounds) {
        this.particles.splice(i, 1);
      }
    }
  }

  applyRepulsion(dt) {
    // Repulsion drives the spreading of the pool (Volume preservation)
    // Reduce strength for one-click to allow "piling up" and slower spread
    let mult = 1.0;
    if (this.mode === 'one-click') mult = 0.3;

    const repulsionStrength = 1500 * (this.density / 50) * mult; 
    const radius = this.particleSize * 3.0; 
    
    for (let i = 0; i < this.particles.length; i++) {
      const p1 = this.particles[i];
      if (p1.mass <= 0) continue;
      
      for (let j = i + 1; j < this.particles.length; j++) {
        const p2 = this.particles[j];
        
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const distSq = dx*dx + dy*dy;
        
        if (distSq < radius * radius && distSq > 0.1) {
          const dist = Math.sqrt(distSq);
          const force = (1 - dist / radius) * repulsionStrength;
          
          const nx = dx / dist;
          const ny = dy / dist;
          
          // Apply force
          const fx = nx * force * dt;
          const fy = ny * force * dt;
          
          p1.vx += fx;
          p1.vy += fy;
          p2.vx -= fx;
          p2.vy -= fy;
        }
      }
    }
  }

  render(ctx) {
    // If Floor Mode, we DON'T draw the surface canvas (streaks), we only draw particles.
    // If Wall Mode, we draw surface (streaks) + particles.
    
    // Always draw surface (stains/streaks)
    ctx.drawImage(this.surfaceCanvas, 0, 0);
    
    // Draw Particles
    for (const p of this.particles) {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      // Wall mode particles are smaller as they are just the "wet" tips
      // Floor mode particles ARE the liquid, so they are full size
      ctx.arc(p.x, p.y, p.mass, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  renderOverlay(ctx) {
    if (this.hasMask) {
        ctx.save();
        ctx.globalAlpha = 0.3; 
        ctx.drawImage(this.maskCanvas, 0, 0);
        ctx.restore();
    }
  }

  renderDepth(ctx) {
    // Renders a grayscale heightmap
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);
    
    // Draw streaks/stains as gray
    ctx.filter = 'grayscale(100%) brightness(200%)'; 
    ctx.drawImage(this.surfaceCanvas, 0, 0);
    ctx.filter = 'none';
    
    for (const p of this.particles) {
      // Center is white, edge is transparent/gray
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.mass);
      g.addColorStop(0, 'rgba(255, 255, 255, 1)');
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.mass, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 255, g: 0, b: 0 };
  }
  
  // For export manager compatibility
  getState() { 
    return {
        width: this.width,
        height: this.height,
        mode: this.mode,
        spawnMode: this.spawnMode,
        viscosity: this.viscosity,
        density: this.density,
        gravityStrength: this.gravityStrength,
        spawnRate: this.spawnRate,
        spawnVelocity: this.spawnVelocity,
        spawnDirection: this.spawnDirection,
        spreadAngle: this.spreadAngle,
        particleSize: (this.particleSize - 4) / 2, // Inverse of setter formula
        color: this.color,
        opacity: this.opacity,
        turbulence: this.turbulence,
        material: this.material
    }; 
  } 
  
  setState(s) {
    if (!s) return;
    if (s.width) this.resize(s.width, s.height);
    if (s.mode) this.setMode(s.mode);
    if (s.spawnMode) this.setSpawnMode(s.spawnMode);
    if (s.viscosity !== undefined) this.setViscosity(s.viscosity);
    if (s.density !== undefined) this.setDensity(s.density);
    if (s.gravityStrength !== undefined) this.setGravity(s.gravityStrength);
    if (s.spawnRate !== undefined) this.setSpawnRate(s.spawnRate);
    if (s.spawnVelocity !== undefined) this.setSpawnVelocity(s.spawnVelocity);
    if (s.spawnDirection !== undefined) this.setSpawnDirection(s.spawnDirection);
    if (s.spreadAngle !== undefined) this.setSpreadAngle(s.spreadAngle);
    if (s.particleSize !== undefined) this.setParticleSize(s.particleSize);
    if (s.color) this.setColor(s.color);
    if (s.opacity !== undefined) this.setOpacity(s.opacity);
    if (s.turbulence !== undefined) this.setTurbulence(s.turbulence);
    if (s.material) this.applyMaterial(s.material);
  }
}