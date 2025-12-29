import { FluidSimulator } from './fluid-sim.js';
import { ExportManager } from './export-manager.js';

class App {
  constructor() {
    this.canvas = document.getElementById('fluid-canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    
    this.overlayCanvas = document.getElementById('overlay-canvas');
    this.overlayCtx = this.overlayCanvas.getContext('2d');
    
    this.simulator = null;
    this.exportManager = null;
    this.isSpawning = false;
    this.spawnPosition = { x: 0, y: 0 };
    
    // Viewport transform
    this.view = { scale: 1, x: 0, y: 0 };
    this.isPanning = false;
    this.lastMouse = { x: 0, y: 0 };
    
    // Shape Drawing State
    this.isDrawingShape = false;
    this.drawModeActive = false;

    // Recording / Event Log
    this.eventLog = [];
    this.simulationTime = 0;
    this.isRecording = false;
    
    this.init();
  }

  init() {
    // Initial size 1024x1024 (default)
    this.canvas.width = 1024;
    this.canvas.height = 1024;
    
    this.overlayCanvas.width = 1024;
    this.overlayCanvas.height = 1024;
    
    this.simulator = new FluidSimulator(1024, 1024);
    this.exportManager = new ExportManager(this.simulator);
    
    // Start Log
    this.resetLog();
    
    this.resizeViewport();
    window.addEventListener('resize', () => this.resizeViewport());
    this.centerView();
    
    this.setupControls();
    this.setupInput();
    this.start();
  }

  resetLog() {
    this.eventLog = [];
    this.simulationTime = 0;
    // Log full initial configuration state
    this.logEvent('init', this.simulator.getState());
  }

  logEvent(type, data) {
    this.eventLog.push({
        time: this.simulationTime,
        type: type,
        data: data
    });
  }

  resizeViewport() {
    // Just handle container sizing if needed, canvas size is explicit now
    this.updateTransform();
  }

  updateTransform() {
    const wrapper = document.getElementById('canvas-wrapper');
    wrapper.style.width = this.canvas.width + 'px';
    wrapper.style.height = this.canvas.height + 'px';
    wrapper.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.scale})`;
  }
  
  centerView() {
    const container = document.getElementById('canvas-container');
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    
    // Fit to screen with padding
    const padding = 40;
    const scaleX = (cw - padding) / this.canvas.width;
    const scaleY = (ch - padding) / this.canvas.height;
    const scale = Math.min(scaleX, scaleY, 1); // Don't zoom in by default, just fit
    
    this.view.scale = scale;
    this.view.x = 0; 
    this.view.y = 0;
    
    this.updateTransform();
  }

  setupControls() {
    // Toggle controls
    const toggleBtn = document.getElementById('toggle-controls');
    const controlsContent = document.getElementById('controls-content');
    
    toggleBtn.addEventListener('click', () => {
      controlsContent.classList.toggle('collapsed');
    });

    // Mode selector
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        this.simulator.setMode(mode);
        this.logEvent('setMode', mode);
        
        // Toggle Shape Controls
        const shapeControls = document.getElementById('pool-shape-controls');
        if (mode === 'one-click' || mode === 'smart' || mode === 'experimental') {
            shapeControls.classList.remove('hidden');
        } else {
            shapeControls.classList.add('hidden');
            this.setDrawMode(false);
        }
      });
    });
    
    // Shape Draw Controls
    const drawBtn = document.getElementById('draw-shape-btn');
    drawBtn.addEventListener('click', () => {
        this.setDrawMode(!this.drawModeActive);
    });
    
    document.getElementById('clear-shape-btn').addEventListener('click', () => {
        this.simulator.clearMask();
        this.logEvent('clearMask', {});
    });

    const uploadBtn = document.getElementById('upload-shape-btn');
    const fileInput = document.getElementById('mask-upload');
    
    uploadBtn.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (evt) => {
            const dataUrl = evt.target.result;
            const img = new Image();
            img.onload = () => {
                this.simulator.setMaskFromImage(img);
                // Log the full data URL to allow replay (might be large, but necessary for exact replay)
                this.logEvent('setMaskFromImage', dataUrl);
            };
            img.src = dataUrl;
        };
        reader.readAsDataURL(file);
        
        // Reset input so same file can be selected again
        fileInput.value = '';
    });

    // Range inputs
    this.setupRangeInput('viscosity', (val) => {
        const v = val / 100;
        this.simulator.setViscosity(v);
        this.logEvent('setViscosity', v);
    });
    this.setupRangeInput('density', (val) => {
        this.simulator.setDensity(val);
        this.logEvent('setDensity', val);
    });
    this.setupRangeInput('gravity', (val) => {
        const v = val / 100;
        this.simulator.setGravity(v);
        this.logEvent('setGravity', v);
    });
    this.setupRangeInput('surface-tension', (val) => {
        const v = val / 100;
        this.simulator.setSurfaceTension(v);
        this.logEvent('setSurfaceTension', v);
    });
    this.setupRangeInput('turbulence', (val) => {
        const v = val / 100; // 0 to 1
        this.simulator.setTurbulence(v);
        this.logEvent('setTurbulence', v);
    });
    this.setupRangeInput('pooling-randomness', (val) => {
        const v = val / 100;
        this.simulator.setPoolingRandomness(v);
        this.logEvent('setPoolingRandomness', v);
    });
    this.setupRangeInput('spawn-rate', (val) => {
        this.simulator.setSpawnRate(val);
        this.logEvent('setSpawnRate', val);
    });
    this.setupRangeInput('spawn-velocity', (val) => {
        this.simulator.setSpawnVelocity(val);
        this.logEvent('setSpawnVelocity', val);
    });
    this.setupRangeInput('spread-angle', (val) => {
        this.simulator.setSpreadAngle(val);
        this.logEvent('setSpreadAngle', val);
    });
    this.setupRangeInput('particle-size', (val) => {
        this.simulator.setParticleSize(val);
        this.logEvent('setParticleSize', val);
    });
    this.setupRangeInput('size-randomness', (val) => {
        const v = val / 100;
        this.simulator.setSizeRandomness(v);
        this.logEvent('setSizeRandomness', v);
    });
    this.setupRangeInput('opacity', (val) => {
        const v = val / 100;
        this.simulator.setOpacity(v);
        this.logEvent('setOpacity', v);
    });
    this.setupRangeInput('time-scale', (val) => {
        const v = val / 100;
        this.simulator.setTimeScale(v);
        this.logEvent('setTimeScale', v);
    });
    this.setupRangeInput('substeps', (val) => {
        this.simulator.setSubsteps(val);
        this.logEvent('setSubsteps', val);
    });
    
    // Lifetime Controls
    this.setupRangeInput('particle-lifetime', (val) => {
        this.simulator.setParticleLifetime(val);
        this.logEvent('setParticleLifetime', val);
    });
    const infLifetime = document.getElementById('infinite-lifetime');
    infLifetime.addEventListener('change', (e) => {
        this.simulator.setInfiniteLifetime(e.target.checked);
        this.logEvent('setInfiniteLifetime', e.target.checked);
    });

    // Spawn Mode
    document.querySelectorAll('.spawn-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.spawn-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.spawn;
        this.simulator.setSpawnMode(mode);
        this.logEvent('setSpawnMode', mode);
      });
    });

    // Material Select
    const matSelect = document.getElementById('material-select');
    matSelect.addEventListener('change', (e) => {
      const mat = e.target.value;
      const settings = this.simulator.applyMaterial(mat);
      this.logEvent('applyMaterial', mat);
      
      if (settings) {
        // Update UI controls to match preset
        this.updateRangeDisplay('viscosity', settings.viscosity * 100);
        this.updateRangeDisplay('density', settings.density);
        document.getElementById('fluid-color').value = settings.color;
        this.updateRangeDisplay('opacity', settings.opacity * 100);
        if (settings.tension !== undefined) {
             this.updateRangeDisplay('surface-tension', settings.tension * 100);
        }
        if (settings.turbulence !== undefined) {
             this.updateRangeDisplay('turbulence', settings.turbulence * 100);
        } else {
             this.updateRangeDisplay('turbulence', 0);
        }
      }
      this.updateMatrixFilter();
    });

    // Color input
    document.getElementById('fluid-color').addEventListener('input', (e) => {
      const color = e.target.value;
      this.simulator.setColor(color);
      this.logEvent('setColor', color);
      // If custom color, set material to custom
      matSelect.value = 'custom';
    });
    
    // Compass
    this.setupCompass();

    // Pause button
    const pauseBtn = document.getElementById('pause-btn');
    pauseBtn.addEventListener('click', () => {
      const isPaused = this.simulator.togglePause();
      pauseBtn.textContent = isPaused ? "Resume" : "Pause";
      pauseBtn.style.background = isPaused ? "#fff" : "";
      pauseBtn.style.color = isPaused ? "#000" : "";
    });

    // Reset button
    document.getElementById('reset-btn').addEventListener('click', () => {
      this.simulator.reset();
      this.resetLog();
      // Ensure we unpause on reset if paused
      if (this.simulator.paused) {
        this.simulator.togglePause();
        pauseBtn.textContent = "Pause";
        pauseBtn.style.background = "";
        pauseBtn.style.color = "";
      }
    });

    // Center View
    document.getElementById('center-view-btn').addEventListener('click', () => {
        this.centerView();
    });
    
    // Canvas Size Inputs
    const wInput = document.getElementById('canvas-width');
    const hInput = document.getElementById('canvas-height');
    const updateSize = () => {
        const w = parseInt(wInput.value) || 1024;
        const h = parseInt(hInput.value) || 1024;
        this.canvas.width = w;
        this.canvas.height = h;
        this.overlayCanvas.width = w;
        this.overlayCanvas.height = h;
        this.simulator.resize(w, h);
        this.logEvent('resize', { width: w, height: h });
        this.centerView();
    };
    wInput.addEventListener('change', updateSize);
    hInput.addEventListener('change', updateSize);

    // Export button
    document.getElementById('export-btn').addEventListener('click', () => {
      this.showExportModal();
    });



    // Export modal
    this.setupExportModal();

    // Instructions Modal
    const instructionsModal = document.getElementById('instructions-modal');
    const closeInstructions = () => instructionsModal.classList.remove('active');
    document.getElementById('close-instructions').addEventListener('click', closeInstructions);
    document.getElementById('start-btn').addEventListener('click', closeInstructions);
  }

  setupRangeInput(id, callback) {
    const input = document.getElementById(id);
    const valueSpan = input.parentElement.querySelector('.value');
    
    input.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      callback(val);
      
      let displayValue = val;
      if (id === 'spread-angle') displayValue = val + '°';
      else if (id === 'opacity') displayValue = val + '%';
      else if (id === 'time-scale') displayValue = (val / 100).toFixed(2) + 'x';
      
      valueSpan.textContent = displayValue;
    });
  }

  setDrawMode(active) {
      this.drawModeActive = active;
      const btn = document.getElementById('draw-shape-btn');
      if (active) {
          btn.classList.add('active');
          btn.textContent = '✅ Done Drawing';
      } else {
          btn.classList.remove('active');
          btn.textContent = '✏️ Draw Area';
      }
  }

  setupCompass() {
    const container = document.getElementById('compass-container');
    const arrow = document.getElementById('compass-arrow');
    let isDragging = false;

    const updateAngle = (clientX, clientY) => {
      const rect = container.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const angle = Math.atan2(clientY - cy, clientX - cx);
      
      arrow.style.transform = `rotate(${angle}rad)`;
      this.simulator.setSpawnDirection(angle);
      this.logEvent('setSpawnDirection', angle);
    };

    container.addEventListener('mousedown', (e) => {
      isDragging = true;
      updateAngle(e.clientX, e.clientY);
    });
    
    window.addEventListener('mousemove', (e) => {
      if (isDragging) updateAngle(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', () => isDragging = false);
  }

  updateMatrixFilter() {
    // Tweak the goo matrix based on material if needed
    // For now simple pass-through or color adjustments could happen here
    // But we are doing color in Canvas. 
  }
  
  updateRangeDisplay(id, val) {
    const input = document.getElementById(id);
    if (!input) return;
    input.value = val;
    input.dispatchEvent(new Event('input'));
  }

  setupExportModal() {
    const modal = document.getElementById('export-modal');
    const closeBtn = modal.querySelector('.close-btn');
    const cancelBtn = document.getElementById('cancel-export');
    const confirmBtn = document.getElementById('confirm-export');
    const previewBtn = document.getElementById('preview-flipbook-btn');

    const closeModal = () => {
        modal.classList.remove('active');
        this.stopPreview();
    };

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);

    // Export type selector
    document.querySelectorAll('.export-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.export-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const type = btn.dataset.type;
        document.getElementById('texture-options').classList.toggle('hidden', type !== 'texture');
        document.getElementById('flipbook-options').classList.toggle('hidden', type !== 'flipbook');
        
        // Hide preview when switching modes
        document.getElementById('flipbook-preview-container').classList.add('hidden');
        this.stopPreview();
      });
    });

    // Blend strength
    this.setupRangeInput('blend-strength', () => {});

    // Confirm export
    confirmBtn.addEventListener('click', async () => {
      const activeType = document.querySelector('.export-type-btn.active').dataset.type;
      
      if (activeType === 'texture') {
        await this.exportTexture();
      } else {
        // Replay/Flipbook Export
        await this.exportFlipbookReplay();
      }
    });
  }

  showExportModal() {
    document.getElementById('export-modal').classList.add('active');
  }

  async exportFlipbookReplay() {
    const resolution = parseInt(document.getElementById('flipbook-resolution').value);
    const frameCount = parseInt(document.getElementById('frame-count').value);
    const includeDepth = document.getElementById('flipbook-depth').checked;
    const includeNormal = document.getElementById('flipbook-normal').checked;
    
    // We export the entire session duration
    const duration = this.simulationTime;
    
    // UI Feedback
    const modal = document.getElementById('export-modal');
    document.querySelector('.export-type-selector').style.display = 'none';
    document.getElementById('flipbook-options').classList.add('hidden');
    const progressContainer = document.getElementById('export-progress');
    progressContainer.classList.remove('hidden');
    
    // Trigger Export Manager
    await this.exportManager.generateReplayFlipbook(
        this.eventLog,
        duration,
        frameCount,
        resolution,
        includeDepth,
        includeNormal,
        (progress) => {
            const progressFill = progressContainer.querySelector('.progress-fill');
            const progressText = progressContainer.querySelector('.progress-text');
            progressFill.style.width = progress + '%';
            progressText.textContent = `Rendering Flipbook... ${Math.round(progress)}%`;
        }
    );
    
    // Reset UI
    progressContainer.classList.add('hidden');
    modal.classList.remove('active');
    document.querySelector('.export-type-selector').style.display = 'grid';
    document.getElementById('flipbook-options').classList.remove('hidden');
  }

  async exportTexture() {
    const resolution = parseInt(document.getElementById('texture-resolution').value);
    const includeDepth = document.getElementById('export-depth').checked;
    const includeNormal = document.getElementById('export-normal').checked;
    const progressContainer = document.getElementById('export-progress');
    
    progressContainer.classList.remove('hidden');
    
    await this.exportManager.exportTexture(resolution, includeDepth, includeNormal, (progress) => {
      const progressFill = progressContainer.querySelector('.progress-fill');
      const progressText = progressContainer.querySelector('.progress-text');
      progressFill.style.width = progress + '%';
      progressText.textContent = `Exporting... ${Math.round(progress)}%`;
    });
    
    progressContainer.classList.add('hidden');
    document.getElementById('export-modal').classList.remove('active');
  }

  // Legacy recording methods removed

  setupInput() {
    const container = document.getElementById('canvas-container');
    
    const getCanvasPos = (clientX, clientY) => {
       const rect = container.getBoundingClientRect();
       // Center of container
       const cx = rect.left + rect.width / 2;
       const cy = rect.top + rect.height / 2;
       
       // Position relative to center
       const dx = clientX - cx;
       const dy = clientY - cy;
       
       // Apply inverse transform
       // View transform is translate then scale. Inverse is scale then translate?
       // CSS: transform: translate(vx, vy) scale(vs)
       // So screen = (world * scale) + trans
       // world = (screen - trans) / scale
       
       const worldX = (dx - this.view.x) / this.view.scale;
       const worldY = (dy - this.view.y) / this.view.scale;
       
       // Now map world (which is centered around 0,0 relative to canvas center) to canvas coords
       // Canvas origin (0,0) is at top-left.
       // The canvas-wrapper is centered in container.
       // So world 0,0 corresponds to canvas width/2, height/2
       
       const canvasX = worldX + this.canvas.width / 2;
       const canvasY = worldY + this.canvas.height / 2;
       
       return { x: canvasX, y: canvasY };
    };

    // Mouse/Touch Handlers
    const handleStart = (e) => {
      // Check for middle mouse or spacebar for panning
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
          this.isPanning = true;
          this.lastMouse = { x: e.clientX, y: e.clientY };
          e.preventDefault();
          return;
      }
      
      const pos = getCanvasPos(e.clientX, e.clientY);

      // Drawing Shape
      if (this.drawModeActive && e.button === 0) {
          this.isDrawingShape = true;
          this.simulator.updateMask(pos.x, pos.y, 40, false);
          this.logEvent('drawShape', { x: pos.x, y: pos.y, radius: 40, erase: false });
          return;
      }
      
      // Spawning
      if (e.button === 0) {
          this.spawnPosition = pos;
          
          if (this.simulator.mode === 'one-click') {
             this.simulator.spawnPool(pos.x, pos.y);
             this.logEvent('spawnPool', { x: pos.x, y: pos.y }); 
          } else if (this.simulator.mode === 'experimental') {
             this.simulator.spawnExperimental(pos.x, pos.y);
             this.logEvent('spawnExperimental', { x: pos.x, y: pos.y });
          } else if (this.simulator.mode === 'smart') {
             this.simulator.spawn(pos.x, pos.y);
             this.logEvent('spawn', { x: pos.x, y: pos.y, mode: 'smart' });
          } else if (this.simulator.spawnMode === 'drop') {
             this.simulator.spawn(pos.x, pos.y);
             this.logEvent('spawn', { x: pos.x, y: pos.y, mode: 'drop' });
          } else {
             this.isSpawning = true;
          }
      }
    };
    
    const handleMove = (e) => {
        if (this.isPanning) {
            const dx = e.clientX - this.lastMouse.x;
            const dy = e.clientY - this.lastMouse.y;
            this.view.x += dx;
            this.view.y += dy;
            this.lastMouse = { x: e.clientX, y: e.clientY };
            this.updateTransform();
            return;
        }

        const pos = getCanvasPos(e.clientX, e.clientY);
        
        if (this.isDrawingShape) {
            this.simulator.updateMask(pos.x, pos.y, 40, false);
            // Throttle logging if needed, but for now log all
            this.logEvent('drawShape', { x: pos.x, y: pos.y, radius: 40, erase: false });
        } else if (this.isSpawning) {
            this.spawnPosition = pos;
        }
    };
    
    const handleEnd = () => {
        this.isPanning = false;
        this.isSpawning = false;
        this.isDrawingShape = false;
    };
    
    container.addEventListener('mousedown', handleStart);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);
    
    // Touch
    container.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            this.isPanning = true;
            this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else {
            const t = e.touches[0];
            const pos = getCanvasPos(t.clientX, t.clientY);
            
            if (this.drawModeActive) {
                this.isDrawingShape = true;
                this.simulator.updateMask(pos.x, pos.y, 40, false);
                this.logEvent('drawShape', { x: pos.x, y: pos.y, radius: 40, erase: false });
                return;
            }

            this.spawnPosition = pos;
            if (this.simulator.mode === 'one-click') {
                 this.simulator.spawnPool(pos.x, pos.y);
                 this.logEvent('spawnPool', { x: pos.x, y: pos.y });
            } else if (this.simulator.mode === 'experimental') {
                 this.simulator.spawnExperimental(pos.x, pos.y);
                 this.logEvent('spawnExperimental', { x: pos.x, y: pos.y });
            } else if (this.simulator.mode === 'smart') {
                 this.simulator.spawn(pos.x, pos.y);
                 this.logEvent('spawn', { x: pos.x, y: pos.y, mode: 'smart' });
            } else if (this.simulator.spawnMode === 'drop') {
                 this.simulator.spawn(pos.x, pos.y);
                 this.logEvent('spawn', { x: pos.x, y: pos.y, mode: 'drop' });
            } else {
                 this.isSpawning = true;
            }
        }
    });
    
    container.addEventListener('touchmove', (e) => {
        e.preventDefault(); // prevent scroll
        if (this.isPanning && e.touches.length > 0) {
            const t = e.touches[0];
            const dx = t.clientX - this.lastMouse.x;
            const dy = t.clientY - this.lastMouse.y;
            this.view.x += dx;
            this.view.y += dy;
            this.lastMouse = { x: t.clientX, y: t.clientY };
            this.updateTransform();
        } else if (this.isDrawingShape) {
            const t = e.touches[0];
            const pos = getCanvasPos(t.clientX, t.clientY);
            this.simulator.updateMask(pos.x, pos.y, 40, false);
            this.logEvent('drawShape', { x: pos.x, y: pos.y, radius: 40, erase: false });
        } else if (this.isSpawning) {
            const t = e.touches[0];
            const pos = getCanvasPos(t.clientX, t.clientY);
            this.spawnPosition = pos;
        }
    });
    
    container.addEventListener('touchend', (e) => {
        handleEnd(); // Reuse mouse end handler
    });
    
    container.addEventListener('touchend', handleEnd);

    // Zoom
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomSpeed = 0.001;
        const delta = -e.deltaY * zoomSpeed;
        const newScale = Math.max(0.1, Math.min(5, this.view.scale + delta));
        this.view.scale = newScale;
        this.updateTransform();
    }, { passive: false });
  }

  updateSpawnPosition(e) {
      // Deprecated, logic moved to getCanvasPos inside setupInput
  }

  update(dt) {
    if (this.isSpawning) {
      this.simulator.spawn(this.spawnPosition.x, this.spawnPosition.y);
      // Log spawn stream (throttle if needed? No, frames are low enough)
      this.logEvent('spawn', { x: this.spawnPosition.x, y: this.spawnPosition.y, mode: 'spray' });
    }
    
    this.simulator.update(dt);
  }

  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.simulator.render(this.ctx);
    
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.simulator.renderOverlay(this.overlayCtx);
  }

  start() {
    let lastTime = performance.now();
    let accumulator = 0;
    const FIXED_STEP = 1 / 60;
    
    const loop = (currentTime) => {
      let frameTime = (currentTime - lastTime) / 1000;
      lastTime = currentTime;
      
      // Prevent spiral of death
      if (frameTime > 0.25) frameTime = 0.25;
      
      accumulator += frameTime;

      while (accumulator >= FIXED_STEP) {
        this.update(FIXED_STEP);
        this.simulationTime += FIXED_STEP;
        accumulator -= FIXED_STEP;
      }
      
      this.render();
      
      requestAnimationFrame(loop);
    };
    
    requestAnimationFrame(loop);
  }
}

new App();