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
    this.maxParticles = 6000; // Increased for better pools
    
    // Properties
    this.mode = 'wall';
    this.activeCaliber = '9mm';
    this.spawnMode = 'spray'; // 'spray' or 'drop'
    this.viscosity = 0.2; 
    this.density = 50; 
    this.gravityStrength = 1.0;
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

    // Vector Drip Heads
    this.dripHeads = [];
    
    // Shape Mask (Constraint)
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;
    this.maskCtx = this.maskCanvas.getContext('2d');
    this.maskData = new Uint8Array(width * height); // 0 = blocked, 1 = open
    this.hasMask = false;

    // Shader/Material Props
    this.material = 'custom';
    this.surfaceTension = 0.3;

    // Time & Accuracy
    this.timeScale = 1.0;
    this.substeps = 3;
    this.paused = false;

    // New Properties
    this.particleLifetime = 10.0;
    this.infiniteLifetime = false;
    this.sizeRandomness = 0.5;
    this.poolingRandomness = 0.2;

    // Smart Expansion Mode Props - High Fidelity
    this.gridScale = 0.25; // Optimized for performance (was 0.5)
    this.gridWidth = Math.ceil(width * this.gridScale);
    this.gridHeight = Math.ceil(height * this.gridScale);
    this.grid = new Float32Array(this.gridWidth * this.gridHeight);
    // Static maps
    this.roughnessMap = new Float32Array(this.gridWidth * this.gridHeight);
    this.permeabilityMap = new Float32Array(this.gridWidth * this.gridHeight);
    this.initRoughness();
    this.gridCanvas = document.createElement('canvas');
    this.gridCanvas.width = this.gridWidth;
    this.gridCanvas.height = this.gridHeight;
    this.gridCtx = this.gridCanvas.getContext('2d');
    this.gridImgData = this.gridCtx.createImageData(this.gridWidth, this.gridHeight);
    
    // Pre-allocate for performance
    this.nextGrid = new Float32Array(this.gridWidth * this.gridHeight);

    // Spatial Hashing for Performance
    this.gridCellSize = 20; 
    // Enough buckets for 1024x1024 with 20px cells (approx 52x52 = 2704)
    this.buckets = Array.from({ length: 3000 }, () => []);

    // Realistic Formation Asset
    this.formationData = null;
    this.formationWidth = 0;
    this.formationHeight = 0;
    
    // Fallback generation in case image fails
    this.createFallbackFormationData();

    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
        try {
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            this.formationData = ctx.getImageData(0, 0, img.width, img.height).data;
            this.formationWidth = img.width;
            this.formationHeight = img.height;
        } catch(e) {
            console.warn("Could not read image data (CORS?), keeping fallback.");
        }
    };
    img.onerror = () => {
        console.warn("Flipbook asset failed to load, using fallback.");
    };
    img.src = 't_puddle_06_alpha_subUV.png';
  }

  createFallbackFormationData() {
    // Generate a simple 6x6 grid of blobs as fallback
    const frameSize = 64;
    const cols = 6;
    const w = frameSize * cols;
    const h = frameSize * cols;
    this.formationWidth = w;
    this.formationHeight = h;
    this.formationData = new Uint8ClampedArray(w * h * 4);
    
    for(let fy=0; fy<cols; fy++) {
        for(let fx=0; fx<cols; fx++) {
             const cx = fx * frameSize + frameSize/2;
             const cy = fy * frameSize + frameSize/2;
             // Growth: frames 0 to 35, radius increases
             const frameIdx = fy * cols + fx;
             const progress = frameIdx / 36;
             const radius = (frameSize * 0.45) * progress;
             const r2 = radius * radius;
             
             for(let y=0; y<frameSize; y++) {
                 for(let x=0; x<frameSize; x++) {
                     const px = fx * frameSize + x;
                     const py = fy * frameSize + y;
                     const dx = px - cx;
                     const dy = py - cy;
                     if (dx*dx + dy*dy < r2) {
                         const idx = (py*w + px) * 4;
                         this.formationData[idx] = 255; // simple white
                         this.formationData[idx+1] = 255;
                         this.formationData[idx+2] = 255;
                         this.formationData[idx+3] = 255;
                     }
                 }
             }
        }
    }
  }

  initRoughness() {
    // Generate static surface roughness and permeability
    for(let y=0; y<this.gridHeight; y++) {
        for(let x=0; x<this.gridWidth; x++) {
            const idx = y * this.gridWidth + x;
            
            // Roughness
            const nx = x * 0.05;
            const ny = y * 0.05;
            let val = this.noise(nx, ny);
            val += this.noise(nx*2, ny*2) * 0.5;
            val += this.noise(nx*4, ny*4) * 0.25;
            this.roughnessMap[idx] = val / 1.75;

            // Permeability Cache (replaces costly fbm in loop)
            this.permeabilityMap[idx] = this.fbm(x * 2, y * 2, 2) * 0.5 + 0.5;
        }
    }
  }

  // PRNG
  random() {
    const x = Math.sin(this.seed++) * 10000;
    return x - Math.floor(x);
  }

  // Improved Noise (Simplex-ish approximation)
  noise(x, y) {
    const s = Math.sin(x * 12.9898 + y * 78.233 + this.noiseOffset) * 43758.5453;
    return s - Math.floor(s);
  }

  // Fractal Brownian Motion for Organic Detail
  fbm(x, y, octaves = 4) {
    let t = 0;
    let amp = 0.5;
    let freq = 0.02; // Base frequency
    const shift = 100.0;
    
    // Add randomness influence
    const randomFreq = 1.0 + this.poolingRandomness * 2.0;

    for(let i = 0; i < octaves; i++) {
        // Simple composition of sines for organic look
        const n = Math.sin(x * freq + this.noiseOffset) * Math.cos(y * freq * 1.3 + this.noiseOffset * 0.5);
        t += n * amp;
        
        amp *= 0.5;
        freq *= 2.0 * randomFreq;
        x += shift;
        y += shift;
    }
    return t; // Returns roughly -1 to 1
  }
  
  setSeed(s) { this.seed = s; }

  // Setters
  setTurbulence(val) { this.turbulence = val; }
  setPoolingRandomness(val) { this.poolingRandomness = val; }
  setParticleLifetime(val) { this.particleLifetime = val; }
  setInfiniteLifetime(val) { this.infiniteLifetime = val; }
  setSizeRandomness(val) { this.sizeRandomness = val; }
  setTimeScale(val) { this.timeScale = val; }
  togglePause() {
    this.paused = !this.paused;
    return this.paused;
  }

  setSubsteps(val) { this.substeps = Math.max(1, val); }
  setMode(mode) { 
    this.mode = mode; 
    this.reset();
    if (mode === 'experimental') {
        this.initRoughness();
    }
    // Also clear mask when switching modes to avoid confusion
    this.clearMask();
  }

  setCaliber(cal) {
      this.activeCaliber = cal;
  }
  setSpawnMode(mode) { this.spawnMode = mode; }
  setSpawnDirection(rad) { this.spawnDirection = rad; }
  setViscosity(val) { this.viscosity = val; } 
  setDensity(val) { this.density = val; }
  setGravity(val) { this.gravityStrength = val; }
  setSurfaceTension(val) { this.surfaceTension = val; }
  setSpawnRate(val) { this.spawnRate = val; }
  setSpawnVelocity(val) { this.spawnVelocity = val; }
  setSpreadAngle(val) { this.spreadAngle = val; }
  setParticleSize(val) { this.particleSize = 4 + val * 2; }
  setOpacity(val) { this.opacity = val; }
  setColor(val) { this.color = val; }
  
  applyMaterial(mat) {
    this.material = mat;
    const presets = {
      water: { color: '#2b95ff', viscosity: 0.1, density: 40, opacity: 0.6, tension: 0.4 },
      blood: { color: '#7a0000', viscosity: 0.5, density: 80, opacity: 0.95, tension: 0.6, turbulence: 0.4 },
      oil: { color: '#1a1a1a', viscosity: 0.4, density: 55, opacity: 0.98, tension: 0.5 },
      honey: { color: '#dca600', viscosity: 0.8, density: 80, opacity: 0.9, tension: 0.8 },
      slime: { color: '#52ff00', viscosity: 0.6, density: 65, opacity: 0.8, tension: 0.6 },
      chocolate: { color: '#3e2723', viscosity: 0.7, density: 70, opacity: 1.0, tension: 0.6 }
    };
    
    if (presets[mat]) {
      const p = presets[mat];
      this.color = p.color;
      this.viscosity = p.viscosity;
      this.density = p.density;
      this.opacity = p.opacity;
      this.surfaceTension = p.tension || 0.3;
      this.turbulence = p.turbulence !== undefined ? p.turbulence : 0;
      
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
    
    // Resize Grid
    this.gridWidth = Math.ceil(width * this.gridScale);
    this.gridHeight = Math.ceil(height * this.gridScale);
    this.grid = new Float32Array(this.gridWidth * this.gridHeight);
    this.nextGrid = new Float32Array(this.gridWidth * this.gridHeight);
    
    this.roughnessMap = new Float32Array(this.gridWidth * this.gridHeight);
    this.permeabilityMap = new Float32Array(this.gridWidth * this.gridHeight);
    this.initRoughness();

    this.gridCanvas.width = this.gridWidth;
    this.gridCanvas.height = this.gridHeight;
    this.gridCtx = this.gridCanvas.getContext('2d');
    this.gridImgData = this.gridCtx.createImageData(this.gridWidth, this.gridHeight);
    
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
    this.dripHeads = [];
    this.surfaceCtx.clearRect(0, 0, this.width, this.height);
    this.wetMap.fill(0);
    this.grid.fill(0);
    this.seed = 1337; 
    this.noiseOffset = Math.random() * 1000;
    this.initRoughness();
  }
  
  clearMask() {
    this.hasMask = false;
    this.maskData.fill(0);
    this.maskCtx.clearRect(0, 0, this.width, this.height);
  }

  setMaskFromImage(img) {
    this.hasMask = true;
    this.maskCtx.globalCompositeOperation = 'source-over';
    this.maskCtx.clearRect(0, 0, this.width, this.height);
    // Draw stretched to fit canvas
    this.maskCtx.drawImage(img, 0, 0, this.width, this.height);
    
    // Update logic map
    const imgData = this.maskCtx.getImageData(0, 0, this.width, this.height);
    const data = imgData.data;
    
    for(let i=0; i<this.width * this.height; i++) {
        // Use Alpha channel (3). Visible = Allowed (1). Transparent = Blocked (0).
        // Using threshold of 50 to avoid semi-transparent artifacts acting as walls
        const alpha = data[i * 4 + 3];
        this.maskData[i] = alpha > 50 ? 1 : 0;
    }
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
    if (this.mode === 'experimental') {
        this.spawnExperimental(x, y);
        return;
    }
    if (this.mode === 'smart') {
        this.spawnSmart(x, y);
        return;
    }
    if (this.mode === 'vector-drip') {
        this.spawnVectorDrip(x, y);
        return;
    }
    if (this.mode === 'tlou') {
        this.spawnTLOU(x, y);
        return;
    }

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

      // Size Randomness: 0 = uniform, 1 = huge variance
      // Base is 1.0. Random factor is (1 +/- randomness)
      const variance = (this.random() - 0.5) * 2.0 * this.sizeRandomness;
      let mass = this.particleSize * (1.0 + variance) * (this.density / 50);
      
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
        life: this.particleLifetime // for floor mode fading
      });
    }
  }

  spawnExperimental(x, y) {
      // Check mask at spawn point
      if (this.hasMask) {
          const mx = Math.floor(x);
          const my = Math.floor(y);
          if (mx >= 0 && mx < this.width && my >= 0 && my < this.height) {
              if (this.maskData[my * this.width + mx] === 0) return; // Don't spawn in walls
          }
      }

      this.emitters.push({
          x: x, y: y,
          type: 'experimental',
          duration: 99999,
          active: true,
          age: 0,
          pulsePhase: 0
      });
  }

  spawnSmart(x, y) {
      this.emitters.push({
          x: x, y: y,
          type: 'smart',
          duration: 99999,
          active: true,
          age: 0
      });
  }

  spawnVectorDrip(x, y) {
      // 1. Initial Impact Splash (Static)
      const count = 10;
      const r = this.particleSize * 3;
      
      this.surfaceCtx.fillStyle = this.color;
      this.surfaceCtx.beginPath();
      this.surfaceCtx.arc(x, y, r, 0, Math.PI*2);
      this.surfaceCtx.fill();
      
      // Add some random droplets around
      for(let i=0; i<count; i++) {
          const angle = this.random() * Math.PI * 2;
          const dist = this.random() * r * 1.5;
          const size = this.random() * r * 0.4;
          this.surfaceCtx.beginPath();
          this.surfaceCtx.arc(x + Math.cos(angle)*dist, y + Math.sin(angle)*dist, size, 0, Math.PI*2);
          this.surfaceCtx.fill();
      }

      // 2. Spawn Active Drip Heads
      // Number of drips depends on size
      const dripCount = 3 + Math.floor(this.random() * 3);
      
      for(let i=0; i<dripCount; i++) {
          const w = 4 + this.random() * 6; // Width
          const speed = 50 + this.random() * 50;
          
          this.dripHeads.push({
              x: x + (this.random() - 0.5) * r,
              y: y + (this.random() - 0.5) * r,
              prevX: x, 
              prevY: y,
              vx: 0,
              vy: speed,
              width: w,
              active: true
          });
      }
  }

  spawnTLOU(x, y) {
      // Pick random sub-UV frame from 6x6 grid
      // Frame indices 0 to 35
      const frameIdx = Math.floor(this.random() * 36);
      const row = Math.floor(frameIdx / 6);
      const col = frameIdx % 6;
      
      this.emitters.push({
          x: x, y: y,
          type: 'tlou',
          duration: 300.0,
          active: true,
          age: 0,
          frameRow: row,
          frameCol: col,
          rotation: this.random() * Math.PI * 2,
          scale: 1.0 + this.random() * 0.5
      });
  }

  spawnBallistic(x, y, angle, distance = 0.3) {
    const calibers = {
        '22lr': { count: 20, speed: 120, spread: 0.10, size: 0.8, mist: 0.1 },
        '9mm': { count: 45, speed: 150, spread: 0.20, size: 1.1, mist: 0.25 },
        '45acp': { count: 40, speed: 130, spread: 0.25, size: 1.6, mist: 0.2 },
        '556': { count: 180, speed: 280, spread: 0.40, size: 0.7, mist: 0.85 }, // Rifle = High velocity
        '12ga': { count: 250, speed: 220, spread: 0.70, size: 1.0, mist: 0.6 }
    };

    const stats = calibers[this.activeCaliber] || calibers['9mm'];
    const rgb = this.hexToRgb(this.color);
    const colorStr = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1)`;
    
    // Scale Spread based on Distance
    // Farther (1.0) = More Spread
    const distanceSpreadMod = 1.0 + distance * 1.5;
    const baseSpread = stats.spread * distanceSpreadMod;
    
    // Scale count based on spread (fill the area)
    const count = Math.floor(stats.count * (1.0 + distance * 0.5));

    // High Velocity Impact Splatter Particles
    // If distance is low, we want sharp, fast streaks.
    // If distance is high, maybe slightly slower due to air?
    // Let's just make them fast to satisfy "high velocity" request.
    const velocityScale = 30.0; // Significant boost from previous 15

    for(let i=0; i<count; i++) {
        if (this.particles.length >= this.maxParticles) this.particles.shift();

        // 1. Determine type: Splatter (Super fast), Mist (fast, small), or Drop (heavier)
        const r = this.random();
        let type = 'drop';
        if (r < 0.2) type = 'splatter'; // 20% high velocity core
        else if (r < stats.mist + 0.2) type = 'mist';

        // 2. Spread Angle
        // Splatter is tighter core, Mist is wider
        let spreadMult = 1.0;
        if (type === 'splatter') spreadMult = 0.5;
        if (type === 'mist') spreadMult = 1.2;
        
        const spreadVar = (this.random() - 0.5) * baseSpread * spreadMult; 
        const theta = angle + spreadVar;
        
        // 3. Speed
        const speedVar = 0.8 + this.random() * 0.6;
        let speed = stats.speed * speedVar * velocityScale; 
        
        // Splatter particles are extremely fast
        if (type === 'splatter') speed *= 2.0; 
        if (type === 'mist') speed *= 1.2;

        // 4. Size/Mass
        let sizeBase = stats.size;
        if (type === 'mist') sizeBase *= 0.5;
        if (type === 'splatter') sizeBase *= 0.4; // Tiny droplets

        const mass = this.particleSize * sizeBase * (type === 'drop' ? 1.0 : 0.4);
        
        // Spawn slightly along the vector so they don't all clump at 0
        const spawnOffset = this.random() * 20.0;
        const sx = x + Math.cos(theta) * spawnOffset;
        const sy = y + Math.sin(theta) * spawnOffset;

        this.particles.push({
            x: sx, y: sy, prevX: sx, prevY: sy,
            vx: Math.cos(theta) * speed, 
            vy: Math.sin(theta) * speed,
            mass: mass,
            initialMass: mass,
            color: colorStr,
            active: true,
            life: this.particleLifetime,
            isMist: (type === 'mist'),
            isSplatter: (type === 'splatter') // New flag for low friction
        });
    }
  }

  spawnPool(x, y) {
    // Check mask
    if (this.hasMask) {
        const mx = Math.floor(x);
        const my = Math.floor(y);
        if (mx>=0 && mx<this.width && my>=0 && my<this.height) {
            if (this.maskData[my * this.width + mx] === 0) return;
        }
    }

    // Optimization: Use larger particles for one-click mode to fill volume efficiently
    if (this.mode === 'one-click') {
        this.setParticleSize(6); // Base size 6 (roughly 16px visual)
    }

    // Create an emitter 
    // We want constant expansion, so duration is long
    const duration = 600.0; 
    
    this.emitters.push({
        x: x, 
        y: y,
        originX: x, // Track origin for outward bias
        originY: y,
        active: true,
        age: 0,
        duration: duration,
        type: 'pool', // Simplified type
        wanderAngle: this.random() * Math.PI * 2,
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
      
      const variance = (this.random() - 0.5) * 2.0 * this.sizeRandomness;
      const mass = this.particleSize * (1.0 + variance);

      this.particles.push({
        x: px, y: py, prevX: px, prevY: py,
        vx: vx, vy: vy,
        mass: mass,
        initialMass: this.particleSize,
        color: colorStr,
        active: true,
        life: this.particleLifetime
      });
    }
  }

  update(dt) {
    if (this.paused) return;

    const finalDt = dt * this.timeScale;
    const steps = Math.floor(this.substeps);
    const stepDt = finalDt / steps;
    
    for(let i=0; i<steps; i++) {
        this.step(stepDt);
    }
  }

  step(dt) {
    // 1. Process Emitters (Particle Spawning)
    // NOTE: Smart and TLOU emitters are processed in their respective update functions
    for (let i = this.emitters.length - 1; i >= 0; i--) {
        const e = this.emitters[i];
        
        // Skip grid-based emitters in this loop to avoid double-processing or invalid particle spawning
        if (e.type === 'smart' || e.type === 'tlou' || e.type === 'experimental') continue;

        e.age += dt;
        
        if (e.age > e.duration) {
            this.emitters.splice(i, 1);
            continue;
        }

        // Determine spawn parameters based on material
        let rate = 0;
        let speed = 0;
        let pulseFactor = 0; // 0 to 1

        // Apply Pooling Randomness to wander behavior
        const wanderSpeed = 2.0 + this.poolingRandomness * 10.0;
        
        // Organic Wander
        const wanderNoise = this.fbm(e.age * 20, 0, 2);
        const turnRate = 5.0 * (1.0 + this.poolingRandomness * 3.0);
        e.wanderAngle += wanderNoise * turnRate * dt;

        const sourceSpeed = 10.0 * this.poolingRandomness;
        e.x += Math.cos(e.wanderAngle) * sourceSpeed * dt;
        e.y += Math.sin(e.wanderAngle) * sourceSpeed * dt;

        // "One Click" constant expansion logic
        if (this.mode === 'one-click') {
             // Optimized rate for performance (larger particles = less rate needed)
             rate = 80; 
             speed = 30;
        } else if (e.type === 'blood') {
            const period = 0.8; 
            const phase = (e.age % period) / period;
            pulseFactor = Math.pow(Math.exp(-8 * phase), 2);
            rate = 20 + 400 * pulseFactor; 
            speed = 12 + 80 * pulseFactor;
        } else {
            rate = 150;
            speed = 20;
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
            
            const variance = (this.random() - 0.5) * 2.0 * this.sizeRandomness;
            const mass = this.particleSize * (1.0 + variance);

            // Jitter position to prevent stacking (explosions)
            const jitter = 5.0;
            const jx = (this.random() - 0.5) * jitter;
            const jy = (this.random() - 0.5) * jitter;

            this.particles.push({
                x: px + jx, y: py + jy, prevX: px, prevY: py,
                vx: Math.cos(angle) * v, 
                vy: Math.sin(angle) * v,
                originX: e.originX !== undefined ? e.originX : e.x,
                originY: e.originY !== undefined ? e.originY : e.y,
                mass: mass,
                initialMass: this.particleSize,
                color: colorStr,
                active: true,
                life: this.particleLifetime, 
                pool: true
            });
        }
    }

    // Optimize: Spatial hashing could be used here for repulsion, 
    // but O(N^2) for N=1000 is acceptable in JS on modern machines if logic is simple.
    // We only repulse in floor mode for the "Volume" effect.
    
    if (this.mode === 'experimental') {
        this.updateExperimental(dt);
        return;
    }

    if (this.mode === 'smart') {
        this.updateSmartExpansion(dt);
        return; 
    }

    if (this.mode === 'vector-drip') {
        this.updateVectorDrip(dt);
        return;
    }
    
    if (this.mode === 'tlou') {
        this.updateTLOU(dt);
        return;
    }

    if (this.mode === 'floor' || this.mode === 'one-click') {
      this.applyRepulsion(dt);
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.prevX = p.x;
      p.prevY = p.y;
      
      const speed = Math.sqrt(p.vx*p.vx + p.vy*p.vy);

      if (this.mode === 'wall' || this.mode === 'ballistic') {
        // Check wet map at particle position
        const ix = Math.floor(p.x);
        const iy = Math.floor(p.y);
        let wetVal = 0;
        
        // Simple bounds check
        if (ix >= 0 && ix < this.width && iy >= 0 && iy < this.height) {
            wetVal = this.wetMap[iy * this.width + ix];
        }

        const gravity = 2500 * this.gravityStrength;
        p.vy += gravity * dt;
        
        // Simplified friction for classic drip behavior
        const viscosityFactor = Math.max(0.1, this.viscosity);
        let friction = 1.0 - (viscosityFactor * 2.0 * dt);
        
        // BALLISTIC MODES
        if (this.mode === 'ballistic') {
             if (p.isSplatter) {
                 // High friction to simulate impact "splat" on the wall plane
                 // This prevents them from flying across the canvas like bullets
                 friction = 1.0 - (20.0 * dt); 
             } else if (p.isMist) {
                 friction = 1.0 - (25.0 * dt); 
                 if (speed < 100) p.mass -= dt * 10.0; 
             }
        }

        // Mild slip on wet surfaces, creates paths but less restrictive
        if (wetVal > 20) {
             friction = 1.0 - (viscosityFactor * 0.5 * dt);
        }
        if (friction < 0) friction = 0;

        p.vx *= friction;
        p.vy *= friction;

        // Mass Loss on Wall = Streaks
        const dist = speed * dt;
        // Lower loss rate allows drips to flow much further
        let lossRate = 0.01 * (1.0 - this.viscosity * 0.5);
        
        // Streak / Trail Logic
        // Only streak if there is enough mass (buildup) or the surface is already wet.
        const massThreshold = this.particleSize * 0.8; 
        const wetThreshold = 5; 
        const canStreak = (p.mass > massThreshold) || (wetVal > wetThreshold);

        if (canStreak) {
            // Reduce loss on existing liquid (re-wetting)
            if (wetVal > 0) {
                lossRate *= 0.4;
            }
            p.mass -= dist * lossRate; 
        } else {
             // Minimal loss for non-streaking drops
             p.mass -= dist * (lossRate * 0.1);
        }
        
        // Random deviation / Meandering
        if (speed > 10) {
           p.vx += (this.random() - 0.5) * 150 * (1-this.viscosity) * dt;
        }

        // Draw Trails Immediately for Wall Mode
        // Only draw streak if we determined it can streak
        if (p.active && p.mass > 0.5 && canStreak) {
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

          // Update WetMap (Accumulate)
          if (ix >= 0 && ix < this.width && iy >= 0 && iy < this.height) {
             const idx = iy * this.width + ix;
             const increase = 20;
             if (this.wetMap[idx] < 255 - increase) this.wetMap[idx] += increase; else this.wetMap[idx] = 255;
             
             // Spread wetness slightly to neighbors to create paths
             if (ix+1 < this.width && this.wetMap[idx+1] < 255) this.wetMap[idx+1] = Math.min(255, this.wetMap[idx+1] + 10);
             if (ix-1 >= 0 && this.wetMap[idx-1] < 255) this.wetMap[idx-1] = Math.min(255, this.wetMap[idx-1] + 10);
             if (iy+1 < this.height && this.wetMap[idx+this.width] < 255) this.wetMap[idx+this.width] = Math.min(255, this.wetMap[idx+this.width] + 10);
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
        const angle = nVal * Math.PI * 4;
        
        if (this.turbulence > 0) {
           const turbStrength = this.turbulence * 80; 
           
           p.vx += Math.cos(angle) * turbStrength * dt;
           p.vy += Math.sin(angle) * turbStrength * dt;
           
           if (this.turbulence > 0.5) {
                p.vx += (this.random() - 0.5) * this.turbulence * 20 * dt;
                p.vy += (this.random() - 0.5) * this.turbulence * 20 * dt;
           }
        }
        
        // Stronger base flow for one-click pools
        if (this.mode === 'one-click') {
            // REDUCED drastically to prevent explosion. 
            // Now acts as a gentle nudge rather than an accelerator.
            const flowBoost = 200 * dt * dt; 
            p.vx += Math.cos(angle) * flowBoost;
            p.vy += Math.sin(angle) * flowBoost;
        }
        
        // Mask Constraint
        if (this.hasMask) {
            const ix = Math.floor(p.x);
            const iy = Math.floor(p.y);
            // Check bounds
            if (ix >= 0 && ix < this.width && iy >= 0 && iy < this.height) {
                if (this.maskData[iy * this.width + ix] === 0) {
                    // STRICT BOUNDS:
                    // If current position is invalid, revert to previous.
                    p.x = p.prevX;
                    p.y = p.prevY;
                    
                    // Kill velocity completely to prevent tunnel/sticking
                    p.vx = 0;
                    p.vy = 0;
                    
                    // Extra check: if prev is also invalid, kill particle
                    const pIx = Math.floor(p.prevX);
                    const pIy = Math.floor(p.prevY);
                    if (pIx >= 0 && pIx < this.width && pIy >= 0 && pIy < this.height) {
                        if (this.maskData[pIy * this.width + pIx] === 0) {
                             p.mass = 0; // Kill it
                        }
                    }
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
        
        // EXTRA DAMPING for One-Click
        if (this.mode === 'one-click') {
            // Strong damping to stop particles from flying off
            p.vx *= 0.85;
            p.vy *= 0.85;
            
            // Constant Outward Expansion Force (Non-Explosive)
            // Push particles away from origin gently
            if (p.originX !== undefined) {
                 const dx = p.x - p.originX;
                 const dy = p.y - p.originY;
                 const dist = Math.sqrt(dx*dx + dy*dy);
                 if (dist > 1) {
                     // Normalize
                     const nx = dx / dist;
                     const ny = dy / dist;
                     // Expansion force decreases with distance? Or constant?
                     // Constant ensures it keeps growing.
                     const expansion = 200.0 * dt; 
                     p.vx += nx * expansion;
                     p.vy += ny * expansion;
                 }
            }
        } else {
            p.vx *= friction;
            p.vy *= friction;
        }
        
        // 3. Stain / Pool Accumulation - TLOU2 Style
        if (p.active) {
          const speedFactor = Math.min(1, speed / 50);
          
          // Organic edge variation
          const jagged = Math.sin(p.x * 0.5) * Math.cos(p.y * 0.5);
          const r = p.mass * (1.0 + jagged * 0.3);
          
          const isBlood = this.material === 'blood';
          const rgb = this.hexToRgb(this.color);
          
          if (this.mode === 'one-click' && isBlood) {
              // TLOU2 Blood Pools: Multi-layer rendering for depth
              
              // Base layer: Very dark, almost black in centers
              if (speed < 8) {
                  this.surfaceCtx.beginPath();
                  this.surfaceCtx.arc(p.x, p.y, r * 1.2, 0, Math.PI * 2);
                  
                  const coreDark = speed < 2 ? 0.08 : 0.15;
                  this.surfaceCtx.fillStyle = `rgba(${rgb.r * coreDark}, 0, 0, 1)`;
                  this.surfaceCtx.globalAlpha = 0.18 / this.substeps;
                  this.surfaceCtx.fill();
              }
              
              // Mid layer: Reddish-brown
              this.surfaceCtx.beginPath();
              this.surfaceCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
              this.surfaceCtx.fillStyle = `rgba(${rgb.r * 0.4}, ${rgb.g * 0.15}, ${rgb.b * 0.1}, 1)`;
              this.surfaceCtx.globalAlpha = 0.15 / this.substeps;
              this.surfaceCtx.fill();
              
              // Edge layer: Brighter red
              this.surfaceCtx.beginPath();
              this.surfaceCtx.arc(p.x, p.y, r * 0.7, 0, Math.PI * 2);
              this.surfaceCtx.fillStyle = p.color;
              this.surfaceCtx.globalAlpha = 0.08 / this.substeps;
              this.surfaceCtx.fill();
              
              this.surfaceCtx.globalAlpha = 1.0;
          } else {
              // Standard rendering for other modes/materials
              this.surfaceCtx.beginPath();
              this.surfaceCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
              
              let baseAlpha = this.opacity > 0.9 ? 0.05 : 0.02;
              if (this.mode === 'one-click') {
                 baseAlpha = 0.12;
                 if (speed < 5) baseAlpha = 0.20;
              }
              
              this.surfaceCtx.fillStyle = p.color;
              this.surfaceCtx.globalAlpha = baseAlpha / this.substeps;
              this.surfaceCtx.fill();
              this.surfaceCtx.globalAlpha = 1.0;
          }
        }
        
        // Kill logic - settle down
        // In one-click mode, we disable despawning completely for pool particles
        const disableDecay = this.infiniteLifetime || (this.mode === 'one-click' && p.pool);

        if (!disableDecay) {
            if (speed < 2.0) {
                p.life -= dt * 2.0; 
            } else {
                p.life -= dt;
            }
            if (p.life <= 0) p.mass = 0;
        }
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
    // Spatial Hash Implementation for O(N) performance
    // Clear buckets
    for (const b of this.buckets) b.length = 0;

    const cellSize = this.gridCellSize;
    const cols = Math.ceil(this.width / cellSize);
    
    // Bucket particles
    for (const p of this.particles) {
        if (p.mass <= 0) continue;
        const cx = Math.floor(p.x / cellSize);
        const cy = Math.floor(p.y / cellSize);
        const idx = cy * cols + cx;
        if (this.buckets[idx]) {
            this.buckets[idx].push(p);
        }
    }

    let interactMult = 1.0;
    const pressureStrength = 2000 * (this.density / 50); 
    const tensionStrength = 1500 * this.surfaceTension; 
    const restDist = this.particleSize * 1.5;
    
    // For one-click, we want soft repulsion to avoid explosion
    // Expansion is handled by "Outward Bias" in step()
    if (this.mode === 'one-click') {
        interactMult = 0.05; 
    }
    
    const interactionDist = this.particleSize * 4.0; 
    const interactionDistSq = interactionDist * interactionDist;

    // Check neighbors
    const maxInteractions = 20; // Performance optimization cap

    for (const p1 of this.particles) {
        if (p1.mass <= 0) continue;

        const cx = Math.floor(p1.x / cellSize);
        const cy = Math.floor(p1.y / cellSize);
        
        let interactionCount = 0;

        // Check 3x3 grid around cell
        neighborLoop:
        for(let j=cy-1; j<=cy+1; j++) {
            for(let i=cx-1; i<=cx+1; i++) {
                const idx = j * cols + i;
                if (!this.buckets[idx]) continue;
                
                for(const p2 of this.buckets[idx]) {
                    if (p1 === p2) continue; // Skip self

                    const dx = p1.x - p2.x;
                    const dy = p1.y - p2.y;
                    const distSq = dx*dx + dy*dy;

                    if (distSq < interactionDistSq && distSq > 0.01) {
                        interactionCount++;
                        if (interactionCount > maxInteractions) break neighborLoop;

                        const dist = Math.sqrt(distSq);
                        const nx = dx / dist;
                        const ny = dy / dist;
                        
                        let force = 0;

                        if (dist < restDist) {
                            // Repulsion
                            const u = 1 - (dist / restDist);
                            force = pressureStrength * u * interactMult;
                            // Clamp max force to prevent explosion
                            if (force > 500) force = 500;
                        } else {
                            // Attraction
                            const u = (dist - restDist) / (interactionDist - restDist);
                            const pull = (1 - u) * tensionStrength * interactMult;
                            force = -pull;
                        }

                        // Apply
                        const fx = nx * force * dt;
                        const fy = ny * force * dt;
                        
                        p1.vx += fx;
                        p1.vy += fy;
                    }
                }
            }
        }
    }
  }

  render(ctx) {
    if (this.mode === 'experimental') {
        this.renderExperimental(ctx);
        return;
    }

    if (this.mode === 'smart') {
        this.renderSmartExpansion(ctx);
        return;
    }
    
    if (this.mode === 'tlou') {
        this.renderTLOU(ctx);
        return;
    }

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
    if (this.mode === 'smart' || this.mode === 'tlou' || this.mode === 'experimental') {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, this.width, this.height);
        
        // Draw grid as grayscale
        const w = this.gridWidth;
        const h = this.gridHeight;
        // Create temp buffer
        const buffer = new Uint8ClampedArray(w * h * 4);
        
        for(let i=0; i<w*h; i++) {
            const val = this.grid[i];
            const c = Math.floor(val * 255);
            buffer[i*4] = c;
            buffer[i*4+1] = c;
            buffer[i*4+2] = c;
            buffer[i*4+3] = 255;
        }
        
        const tempC = document.createElement('canvas');
        tempC.width = w;
        tempC.height = h;
        tempC.getContext('2d').putImageData(new ImageData(buffer, w, h), 0, 0);
        
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tempC, 0, 0, this.width, this.height);
        ctx.restore();
        return;
    }

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
        material: this.material,
        surfaceTension: this.surfaceTension,
        timeScale: this.timeScale,
        substeps: this.substeps
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
    if (s.surfaceTension !== undefined) this.setSurfaceTension(s.surfaceTension);
    if (s.timeScale !== undefined) this.setTimeScale(s.timeScale);
    if (s.substeps !== undefined) this.setSubsteps(s.substeps);
    if (s.particleLifetime !== undefined) this.setParticleLifetime(s.particleLifetime);
    if (s.infiniteLifetime !== undefined) this.setInfiniteLifetime(s.infiniteLifetime);
    if (s.sizeRandomness !== undefined) this.setSizeRandomness(s.sizeRandomness);
    if (s.poolingRandomness !== undefined) this.setPoolingRandomness(s.poolingRandomness);
  }

  updateTLOU(dt) {
      // Realistic Formation: Uses Flipbook Asset as Growth Mask
      const w = this.gridWidth;
      const h = this.gridHeight;
      const scale = 1 / this.gridScale;
      
      // 1. Emitters (Texture Projection)
      if (this.formationData) {
          const fW = this.formationWidth;
          const fH = this.formationHeight;
          const subW = fW / 6; // Assume 6x6 grid
          const subH = fH / 6;

          for (let i = this.emitters.length - 1; i >= 0; i--) {
              const e = this.emitters[i];
              if (!e.active || e.type !== 'tlou') continue;
              
              e.age += dt;
              if (e.age > e.duration) continue;

              // Project texture into grid
              // Iterate over a bounding box in grid space relative to emitter
              // Texture size approx 200px -> grid size 50
              const radius = 40 * e.scale; // Grid cells
              
              const gx = Math.floor(e.x * this.gridScale);
              const gy = Math.floor(e.y * this.gridScale);
              
              const cosR = Math.cos(e.rotation);
              const sinR = Math.sin(e.rotation);

              for(let dy=-radius; dy<=radius; dy++) {
                  for(let dx=-radius; dx<=radius; dx++) {
                       const gridIdx = (gy+dy)*w + (gx+dx);
                       if (gridIdx < 0 || gridIdx >= w*h) continue;
                       
                       // Check mask
                       if (this.hasMask) {
                            const mx = Math.floor((gx+dx) * scale);
                            const my = Math.floor((gy+dy) * scale);
                            const mIdx = my * this.width + mx;
                            if (mIdx < this.maskData.length && this.maskData[mIdx] === 0) continue;
                       }

                       // Inverse transform to find UV in texture
                       // Rotate back
                       const lx = dx / radius; // -1 to 1
                       const ly = dy / radius;
                       
                       // Rotate
                       const rx = lx * cosR - ly * sinR;
                       const ry = lx * sinR + ly * cosR;
                       
                       if (rx < -1 || rx > 1 || ry < -1 || ry > 1) continue;
                       
                       // Map to UV in sub-frame
                       const u = (rx * 0.5 + 0.5);
                       const v = (ry * 0.5 + 0.5);
                       
                       // Animate frames: 0 -> 35
                       const animSpeed = 15.0; // Frames per second
                       const totalFrames = 36;
                       const currentFrame = Math.min(totalFrames-1, Math.floor(e.age * animSpeed));
                       const fRow = Math.floor(currentFrame / 6);
                       const fCol = currentFrame % 6;
                       
                       // Clamp coordinates to prevent index out of bounds errors
                       const animTexX = Math.min(fW - 1, Math.max(0, Math.floor((fCol + u) * subW)));
                       const animTexY = Math.min(fH - 1, Math.max(0, Math.floor((fRow + v) * subH)));
                       
                       const animPIdx = (animTexY * fW + animTexX) * 4;
                       
                       // Safety check for formationData availability
                       if (animPIdx < this.formationData.length) {
                           const shapeVal = this.formationData[animPIdx] / 255.0;
                           
                           // Add fluid if shape value is high
                           if (shapeVal > 0.1) {
                               const targetHeight = shapeVal * 2.5; // Max depth
                               // Lerp towards target - make it snappy
                               const current = this.grid[gridIdx];
                               if (current < targetHeight) {
                                   this.grid[gridIdx] += (targetHeight - current) * 10.0 * dt;
                               }
                           }
                       }
                  }
              }
          }
      }
  }

  renderTLOU(ctx) {
      const w = this.gridWidth;
      const h = this.gridHeight;
      const data = this.gridImgData.data;
      
      // Force TLOU blood colors for this mode regardless of picker to ensure style match
      const deepRed = { r: 60, g: 0, b: 0 };
      const brightRed = { r: 180, g: 10, b: 10 };
      
      for(let i=0; i<w*h; i++) {
          const val = this.grid[i];
          const offset = i * 4;
          
          if (val > 0.001) {
              // Alpha ramp: Visible very quickly
              let alpha = val * 10.0; 
              if (alpha > 1) alpha = 1;
              
              // Thickness ramp for color
              // 0.0 -> Bright Red (Edge)
              // 1.0 -> Deep Red (Center)
              let t = Math.min(1.0, val * 2.0);
              
              // Simple Lerp
              const r = brightRed.r * (1-t) + deepRed.r * t;
              const g = brightRed.g * (1-t) + deepRed.g * t;
              const b = brightRed.b * (1-t) + deepRed.b * t;
              
              data[offset] = r;
              data[offset + 1] = g;
              data[offset + 2] = b;
              data[offset + 3] = alpha * 255;
          } else {
              data[offset + 3] = 0;
          }
      }
      
      this.gridCtx.putImageData(this.gridImgData, 0, 0);
      
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.gridCanvas, 0, 0, this.width, this.height);
      ctx.restore();
  }

  updateSmartExpansion(dt) {
      const w = this.gridWidth;
      const h = this.gridHeight;
      const scale = 1 / this.gridScale;
      const mw = this.width;

      // Swap buffers
      this.nextGrid.set(this.grid);

      // 1. Process Emitters (Source Injection)
      for (let i = this.emitters.length - 1; i >= 0; i--) {
          const e = this.emitters[i];
          if (!e.active || e.type !== 'smart') continue;
          
          e.age += dt;

          // Emitters wander in smart mode too for irregularity
          const wander = this.fbm(e.age * 5, 100);
          const wanderR = 10.0;
          const ex = e.x + Math.cos(wander * Math.PI) * wanderR;
          const ey = e.y + Math.sin(wander * Math.PI) * wanderR;

          const gx = Math.floor(ex * this.gridScale);
          const gy = Math.floor(ey * this.gridScale);
          
          // Radius varies by pulse
          let radiusBase = 12 * this.gridScale; 
          let pumpRate = 30.0;

          if (this.material === 'blood') {
              const period = 0.8;
              const phase = (e.age % period) / period;
              const pulse = Math.pow(Math.exp(-8 * phase), 2);
              pumpRate = 200.0 + 1000.0 * pulse; 
              radiusBase *= (1.0 + pulse * 0.5);
          } else {
              pumpRate = 500.0; // Aggressive source for constant expansion
          }

          const r = Math.ceil(radiusBase);

          for(let j=-r; j<=r; j++) {
              for(let i=-r; i<=r; i++) {
                 const distSq = i*i+j*j;
                 if (distSq <= r*r) {
                     const idx = (gy+j)*w + (gx+i);
                     if (idx>=0 && idx<this.grid.length) {
                         // Infinite Source logic: Always try to keep source at max height
                         // This ensures constant pressure for the expansion
                         if (this.nextGrid[idx] < 2.5) {
                            this.nextGrid[idx] += dt * pumpRate;
                            if (this.nextGrid[idx] > 2.5) this.nextGrid[idx] = 2.5;
                         }
                     }
                 }
              }
          }
      }

      // 2. Viscous Fingering Simulation (Smart Expansion)
      // "Constant Rate" Expansion Logic
      
      const minThreshold = 0.005;
      const randomness = this.poolingRandomness;
      const permPower = 3.0 * (1.1 - randomness);

      // Speed Factor - High base speed
      let baseSpeed = 40.0 * dt; 
      
      for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
              const idx = y * w + x;
              const val = this.grid[idx];
              
              if (val > minThreshold) {
                  // Mask Check (Source)
                  if (this.hasMask) {
                      const mx = Math.floor(x * scale);
                      const my = Math.floor(y * scale);
                      if (this.maskData[my * mw + mx] === 0) {
                          this.nextGrid[idx] = 0; 
                          continue;
                      }
                  }

                  // 4 Neighbors
                  const neighbors = [idx - w, idx + w, idx - 1, idx + 1];
                  
                  let totalFlux = 0;
                  const fluxes = [0,0,0,0];

                  for(let i=0; i<4; i++) {
                      const nIdx = neighbors[i];
                      const nVal = this.grid[nIdx];
                      
                      // Only flow to lower
                      if (val > nVal) {
                          // Check mask for target
                          if (this.hasMask) {
                              let nx = x, ny = y;
                              if (i===0) ny--; else if(i===1) ny++; else if(i===2) nx--; else nx++;
                              
                              const nmx = Math.floor(nx * scale);
                              const nmy = Math.floor(ny * scale);
                              if (this.maskData[nmy * mw + nmx] === 0) continue;
                          }

                          const noiseVal = this.permeabilityMap[nIdx];
                          const perm = Math.pow(noiseVal, permPower); 
                          
                          // Reduced Tension Barrier for "fill everything" request
                          const tensionLimit = (this.surfaceTension * 0.01); 
                          if (nVal < 0.001 && val < tensionLimit && perm < 0.3) continue;

                          // CONSTANT EXPANSION LOGIC
                          // If we have fluid, we push it out at a constant rate relative to permeability,
                          // not dependent on the diminishing height difference.
                          
                          let flowAmount = 0;
                          
                          if (nVal < val * 0.95) {
                              // Active Expansion
                              // Use a fixed push that ignores gradient falloff
                              flowAmount = baseSpeed * (0.2 + perm * 1.5);
                              
                              // Boost leading edge
                              if (nVal < 0.05) flowAmount *= 2.5;
                          } else {
                              // Equalization
                              flowAmount = (val - nVal) * baseSpeed;
                          }
                          
                          fluxes[i] = flowAmount;
                          totalFlux += flowAmount;
                      }
                  }

                  // Scale down if trying to give more than we have
                  let scaleF = 1.0;
                  if (totalFlux > val) scaleF = val / totalFlux;
                  
                  // Apply
                  for(let i=0; i<4; i++) {
                      if (fluxes[i] > 0) {
                          const amount = fluxes[i] * scaleF;
                          this.nextGrid[neighbors[i]] += amount;
                          this.nextGrid[idx] -= amount;
                      }
                  }
              }
          }
      }
      
      // Copy back
      this.grid.set(this.nextGrid);
  }

  updateVectorDrip(dt) {
      this.surfaceCtx.lineCap = 'round';
      this.surfaceCtx.lineJoin = 'round';
      this.surfaceCtx.strokeStyle = this.color;
      this.surfaceCtx.fillStyle = this.color;

      for (let i = this.dripHeads.length - 1; i >= 0; i--) {
          const head = this.dripHeads[i];
          
          if (!head.active) {
              this.dripHeads.splice(i, 1);
              continue;
          }

          head.prevX = head.x;
          head.prevY = head.y;

          // Physics
          // Gravity acceleration
          head.vy += this.gravityStrength * 10.0 * dt; 
          
          // Meandering (Noise)
          // Use fixed seed offset so path is consistent if we re-simulated (though we aren't here)
          const n = this.noise(head.x * 0.05, head.y * 0.05 + this.seed);
          const meanderForce = (n - 0.5) * 500 * (1.0 - this.viscosity);
          head.vx += meanderForce * dt;
          
          // Damping
          head.vx *= 0.9;
          
          // Move
          head.x += head.vx * dt;
          head.y += head.vy * dt;
          
          // Shrink width over time
          // Loss correlates to speed (longer streak = more mass lost)
          const speed = Math.sqrt(head.vx*head.vx + head.vy*head.vy);
          const loss = (5.0 + speed * 0.05) * dt * 0.8;
          head.width -= loss;

          // Mask Check
          if (this.hasMask) {
              const mx = Math.floor(head.x);
              const my = Math.floor(head.y);
              if (mx >= 0 && mx < this.width && my >= 0 && my < this.height) {
                  if (this.maskData[my * this.width + mx] === 0) {
                      head.active = false;
                  }
              }
          }

          // Render Trail
          if (head.width > 0.5) {
              this.surfaceCtx.lineWidth = head.width;
              this.surfaceCtx.beginPath();
              this.surfaceCtx.moveTo(head.prevX, head.prevY);
              this.surfaceCtx.lineTo(head.x, head.y);
              this.surfaceCtx.stroke();
              
              // Draw head cap to smooth joints
              this.surfaceCtx.beginPath();
              this.surfaceCtx.arc(head.x, head.y, head.width/2, 0, Math.PI*2);
              this.surfaceCtx.fill();
          } else {
              head.active = false;
          }
          
          // Branching
          if (head.width > 3 && this.random() < 0.02) {
              const newW = head.width * 0.6;
              head.width *= 0.7; 
              
              this.dripHeads.push({
                  x: head.x,
                  y: head.y,
                  prevX: head.x,
                  prevY: head.y,
                  vx: head.vx + (this.random() - 0.5) * 50, 
                  vy: head.vy * 0.8,
                  width: newW,
                  active: true
              });
          }
          
          if (head.y > this.height) head.active = false;
      }
  }

  updateExperimental(dt) {
      const w = this.gridWidth;
      const h = this.gridHeight;
      const scale = 1 / this.gridScale;
      const mw = this.width;

      // Copy current state to next state buffer
      this.nextGrid.set(this.grid);

      // 1. Emitter Logic
      for (let i = this.emitters.length - 1; i >= 0; i--) {
          const e = this.emitters[i];
          if (!e.active || e.type !== 'experimental') continue;
          
          e.age += dt;
          
          let flowRate = 120.0; // Higher flow rate
          
          const gx = Math.floor(e.x * this.gridScale);
          const gy = Math.floor(e.y * this.gridScale);
          const r = 3; // Smaller, tighter emitter
          
          for(let dy=-r; dy<=r; dy++) {
              for(let dx=-r; dx<=r; dx++) {
                  if(dx*dx+dy*dy <= r*r) {
                      const idx = (gy+dy)*w + (gx+dx);
                      if(idx>=0 && idx<this.grid.length) {
                          if (this.hasMask) {
                              const mx = Math.floor((gx+dx) * scale);
                              const my = Math.floor((gy+dy) * scale);
                              const midx = my * mw + mx;
                              if (midx < this.maskData.length && this.maskData[midx] === 0) continue;
                          }
                          this.nextGrid[idx] = Math.min(3.0, this.nextGrid[idx] + flowRate * dt * 0.2);
                      }
                  }
              }
          }
      }

      // 2. Simplified Cellular Automata Flow
      const flowSpeed = 200.0 * dt * (1.0 - this.viscosity * 0.5);
      
      // Iterate with randomness to avoid bias? 
      // Simple scanline is efficient. We can do forward/backward pass if needed, but single pass usually ok for this density.
      
      for(let y=1; y<h-1; y++) {
          for(let x=1; x<w-1; x++) {
              const idx = y*w + x;
              const val = this.grid[idx];
              
              if (val <= 0.001) continue;

              // Mask Self Check
              if (this.hasMask) {
                   const mx = Math.floor(x * scale);
                   const my = Math.floor(y * scale);
                   if (this.maskData[my * mw + mx] === 0) {
                       this.nextGrid[idx] = 0;
                       continue;
                   }
              }
              
              const neighbors = [idx-1, idx+1, idx-w, idx+w];
              const coords = [[x-1,y], [x+1,y], [x,y-1], [x,y+1]];
              
              let totalFlow = 0;
              const flows = [0,0,0,0];

              for(let i=0; i<4; i++) {
                  const nIdx = neighbors[i];
                  const nVal = this.grid[nIdx];
                  
                  // Mask Target Check
                  if (this.hasMask) {
                      const [nx, ny] = coords[i];
                      const nmx = Math.floor(nx * scale);
                      const nmy = Math.floor(ny * scale);
                      if (this.maskData[nmy * mw + nmx] === 0) continue; 
                  }

                  const diff = val - nVal;
                  if (diff > 0) {
                      const flow = diff * flowSpeed;
                      flows[i] = flow;
                      totalFlow += flow;
                  }
              }

              if (totalFlow > 0) {
                  // Conserve mass
                  if (totalFlow > val) {
                      const f = val / totalFlow;
                      for(let i=0; i<4; i++) flows[i] *= f;
                      totalFlow = val;
                  }

                  this.nextGrid[idx] -= totalFlow;
                  for(let i=0; i<4; i++) {
                      if (flows[i] > 0) {
                           this.nextGrid[neighbors[i]] += flows[i];
                      }
                  }
              }
          }
      }

      this.grid.set(this.nextGrid);
  }

  renderExperimental(ctx) {
      // Re-use smart expansion renderer but with tweaked parameters for maximum realism
      this.renderSmartExpansion(ctx);
  }

  renderSmartExpansion(ctx) {
      // High Fidelity Software Rendering
      // Calculates per-pixel lighting based on grid gradients
      
      const w = this.gridWidth;
      const h = this.gridHeight;
      const data = this.gridImgData.data;
      const rgb = this.hexToRgb(this.color);
      
      // Light Dir (Top Left)
      const lx = 0.5, ly = -0.5, lz = 0.7;
      const invL = 1.0 / Math.sqrt(lx*lx + ly*ly + lz*lz);
      const LnX = lx*invL, LnY = ly*invL, LnZ = lz*invL;

      // Halfway vector (View is 0,0,1)
      // H = L + V = (LnX, LnY, LnZ + 1) normalized
      const hLen = Math.sqrt(LnX*LnX + LnY*LnY + (LnZ+1)*(LnZ+1));
      const Hx = LnX/hLen, Hy = LnY/hLen, Hz = (LnZ+1)/hLen;

      const isBlood = this.material === 'blood';
      
      for (let y = 0; y < h; y++) {
          const rowOffset = y * w;
          // Optimization: Check if row is empty? (Requires optimization structure, skip for now)
          
          for (let x = 0; x < w; x++) {
              const idx = rowOffset + x;
              const val = this.grid[idx];
              const offset = idx * 4;
              
              if (val > 0.005) {
                  // Gradient Calculation (Sobel-ish)
                  // Clamped
                  const vL = x>0 ? this.grid[idx-1] : val;
                  const vR = x<w-1 ? this.grid[idx+1] : val;
                  const vT = y>0 ? this.grid[idx-w] : val;
                  const vB = y<h-1 ? this.grid[idx+w] : val;
                  
                  const dX = (vL - vR) * 2.0; // Height scale
                  const dY = (vT - vB) * 2.0;
                  
                  // Normal
                  const nLen = Math.sqrt(dX*dX + dY*dY + 1.0);
                  const nx = dX / nLen;
                  const ny = dY / nLen;
                  const nz = 1.0 / nLen;
                  
                  // Lighting
                  // Diffuse (N dot L)
                  const diff = Math.max(0, nx*LnX + ny*LnY + nz*LnZ);
                  
                  // Specular (N dot H)
                  let spec = Math.max(0, nx*Hx + ny*Hy + nz*Hz);
                  spec = Math.pow(spec, 60.0); // High shininess for wetness
                  
                  // Base Color & Depth Absorption (Beer's Law)
                  // Deep liquid is darker
                  let r, g, b, alpha;
                  
                  if (isBlood) {
                      // TLOU2 Style:
                      // Deep = Black/Dark Red. Shallow = Bright Red.
                      // Edge = Semi-transparent
                      
                      const depth = Math.min(1.0, val * 1.5);
                      
                      // Transmittance (how much light gets through/out)
                      const trans = Math.exp(-depth * 4.0); 
                      
                      // Base albedo
                      const baseR = rgb.r / 255;
                      const baseG = rgb.g / 255;
                      const baseB = rgb.b / 255;
                      
                      // Scatter color (shallow) vs Absorb (deep)
                      const colR = baseR * (trans * 0.8 + 0.1); 
                      const colG = baseG * (trans * 0.8 + 0.05);
                      const colB = baseB * (trans * 0.8 + 0.05);

                      // Add Diffuse
                      const lightIntensity = 1.0;
                      let finalR = colR * (0.2 + 0.8 * diff) * lightIntensity;
                      let finalG = colG * (0.2 + 0.8 * diff) * lightIntensity;
                      let finalB = colB * (0.2 + 0.8 * diff) * lightIntensity;
                      
                      // Add Specular (White)
                      finalR += spec * 0.8;
                      finalG += spec * 0.8;
                      finalB += spec * 0.8;
                      
                      r = Math.min(255, finalR * 255);
                      g = Math.min(255, finalG * 255);
                      b = Math.min(255, finalB * 255);
                      
                      // Soft Alpha Edge
                      alpha = Math.min(255, val * 800); 
                  } else {
                      // Generic Liquid
                      // ... (Simplified for brevity, similar logic)
                      const depth = Math.min(1.0, val);
                      const brightness = 0.5 + 0.5 * diff;
                      
                      r = Math.min(255, rgb.r * brightness + spec * 255);
                      g = Math.min(255, rgb.g * brightness + spec * 255);
                      b = Math.min(255, rgb.b * brightness + spec * 255);
                      alpha = Math.min(255, val * 500);
                  }

                  data[offset] = r;
                  data[offset + 1] = g;
                  data[offset + 2] = b;
                  data[offset + 3] = alpha;
              } else {
                  data[offset + 3] = 0;
              }
          }
      }
      
      this.gridCtx.putImageData(this.gridImgData, 0, 0);
      
      ctx.save();
      // Draw grid scaled up
      ctx.drawImage(this.gridCanvas, 0, 0, this.width, this.height);
      ctx.restore();
  }
}