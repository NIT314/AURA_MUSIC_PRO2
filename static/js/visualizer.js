/*
  AURA ∞ MUSIC - Interactive Canvas Visualizers
  Includes AURA Wave (linear frequencies) and AURA Sphere (3D projected rotating core)
*/

let waveCanvas = null;
let waveCtx = null;
let sphereCanvas = null;
let sphereCtx = null;
let animationId = null;
let isVisualizerRequested = false; // Track karega ki gaana chal raha hai ya nahi

// Visualizer State
let spherePoints = [];
const NUM_SPHERE_POINTS = 85;
let rotationX = 0.005;
let rotationY = 0.008;
let sphereAngleX = 0;
let sphereAngleY = 0;

// Particles list for visual backgrounds
let particlesList = [];

function initVisualizers() {
    waveCanvas = document.getElementById("aura-wave-canvas");
    if (waveCanvas) waveCtx = waveCanvas.getContext("2d");
    
    sphereCanvas = document.getElementById("aura-sphere-canvas");
    if (sphereCanvas) sphereCtx = sphereCanvas.getContext("2d");
    
    // Generate static 3D coordinates for AURA Sphere
    // Distributed evenly on a sphere using Fibonacci lattice
    spherePoints = [];
    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden ratio angle
    
    for (let i = 0; i < NUM_SPHERE_POINTS; i++) {
        const y = 1 - (i / (NUM_SPHERE_POINTS - 1)) * 2; // y goes from 1 to -1
        const radius = Math.sqrt(1 - y * y); // radius at y
        
        const theta = phi * i; // golden angle increment
        
        const x = Math.cos(theta) * radius;
        const z = Math.sin(theta) * radius;
        
        spherePoints.push({ x, y, z });
    }

    // Setup resize handlers
    window.addEventListener("resize", resizeVisualizerCanvases);
    resizeVisualizerCanvases();

    // 🔥 BATTERY SAVER: Page Visibility API
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            // App background mein hai -> Visualizer Pause karo
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
        } else {
            // App wapas screen par aaya -> Agar gaana chal raha tha toh Resume karo
            if (isVisualizerRequested) {
                startVisualizerLoop();
            }
        }
    });
}

function resizeVisualizerCanvases() {
    if (waveCanvas) {
        waveCanvas.width = waveCanvas.parentElement.clientWidth;
        waveCanvas.height = waveCanvas.parentElement.clientHeight;
    }
}

function startVisualizerLoop() {
    isVisualizerRequested = true;
    if (document.hidden) return; // Agar app hidden hai toh draw mat karo

    if (animationId) cancelAnimationFrame(animationId);
    
    function draw() {
        animationId = requestAnimationFrame(draw);
        
        const analyser = window.getAnalyser ? window.getAnalyser() : null;
        let dataArray = [];
        
        if (analyser) {
            dataArray = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(dataArray);
        } else {
            // Mock frequency data if audio context isn't initialized yet
            dataArray = new Uint8Array(128).map(() => Math.sin(Date.now() / 200) * 20 + 30);
        }
        
        // Render Visuals
        drawAuraWave(dataArray);
        drawAuraSphere(dataArray);
    }
    
    draw();
}

function stopVisualizerLoop() {
    isVisualizerRequested = false;
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
}

function drawAuraWave(dataArray) {
    if (!waveCtx || !waveCanvas) return;
    
    const width = waveCanvas.width;
    const height = waveCanvas.height;
    waveCtx.clearRect(0, 0, width, height);
    
    // Draw smooth bezier audio waves
    waveCtx.beginPath();
    waveCtx.lineWidth = 3;
    
    // Gradient outline
    const gradient = waveCtx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, 'rgba(155, 93, 229, 0.8)');
    gradient.addColorStop(0.5, 'rgba(223, 193, 93, 0.9)');
    gradient.addColorStop(1, 'rgba(0, 180, 216, 0.8)');
    waveCtx.strokeStyle = gradient;
    
    // Glow effect
    waveCtx.shadowBlur = 10;
    waveCtx.shadowColor = 'rgba(223, 193, 93, 0.5)';
    
    const sliceWidth = width / 12;
    waveCtx.moveTo(0, height / 2);
    
    // We sample 12 points across the spectrum
    for (let i = 0; i <= 12; i++) {
        // Sample frequencies (prefer low to mid ranges)
        const sampleIdx = Math.floor((i / 12) * (dataArray.length * 0.6));
        const amplitude = (dataArray[sampleIdx] || 0) / 255;
        
        const x = i * sliceWidth;
        // Pulse wave height based on amplitude
        const offset = amplitude * (height * 0.7) * (i % 2 === 0 ? 1 : -1);
        const y = height / 2 + offset;
        
        if (i === 0) {
            waveCtx.moveTo(x, y);
        } else {
            const prevX = (i - 1) * sliceWidth;
            const prevAmp = (dataArray[Math.floor(((i - 1) / 12) * (dataArray.length * 0.6))] || 0) / 255;
            const prevOffset = prevAmp * (height * 0.7) * ((i - 1) % 2 === 0 ? 1 : -1);
            const prevY = height / 2 + prevOffset;
            
            // Draw smooth bezier curve between points
            const cpX1 = prevX + sliceWidth / 2;
            const cpY1 = prevY;
            const cpX2 = prevX + sliceWidth / 2;
            const cpY2 = y;
            
            waveCtx.bezierCurveTo(cpX1, cpY1, cpX2, cpY2, x, y);
        }
    }
    
    waveCtx.stroke();
    
    // Clear shadow configurations for future drawings
    waveCtx.shadowBlur = 0;
}

function drawAuraSphere(dataArray) {
    if (!sphereCtx || !sphereCanvas) return;
    
    const width = sphereCanvas.width;
    const height = sphereCanvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    
    sphereCtx.clearRect(0, 0, width, height);
    
    // Read bass values for sphere size scaling
    let bassSum = 0;
    for (let idx = 0; idx < 10; idx++) {
        bassSum += dataArray[idx] || 0;
    }
    const bassNormalized = (bassSum / 10) / 255;
    
    // Core expansion multiplier
    const baseRadius = 80;
    const radiusMultiplier = 1 + (bassNormalized * 0.45);
    const radius = baseRadius * radiusMultiplier;
    
    // Apply 3D Rotations
    sphereAngleX += rotationX;
    sphereAngleY += rotationY;
    
    const cosX = Math.cos(sphereAngleX);
    const sinX = Math.sin(sphereAngleX);
    const cosY = Math.cos(sphereAngleY);
    const sinY = Math.sin(sphereAngleY);
    
    // Project and Render Points
    const projectedPoints = [];
    const distance = 3; // perspective depth factor
    
    spherePoints.forEach((point) => {
        // Rotate X
        let y1 = point.y * cosX - point.z * sinX;
        let z1 = point.z * cosX + point.y * sinX;
        
        // Rotate Y
        let x2 = point.x * cosY - z1 * sinY;
        let z2 = z1 * cosY + point.x * sinY;
        
        // Perspective Projection
        const scale = 250 / (z2 + distance);
        const px = x2 * radius * scale + centerX;
        const py = y1 * radius * scale + centerY;
        
        projectedPoints.push({ x: px, y: py, depth: z2 });
    });
    
    // Draw connections between nearby depth-based coordinates (Sphere mesh layout)
    sphereCtx.lineWidth = 0.5;
    sphereCtx.strokeStyle = 'rgba(223, 193, 93, 0.08)';
    
    for (let i = 0; i < projectedPoints.length; i++) {
        for (let j = i + 1; j < projectedPoints.length; j++) {
            const dx = projectedPoints[i].x - projectedPoints[j].x;
            const dy = projectedPoints[i].y - projectedPoints[j].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            // Connect only if they are close on the projected canvas
            if (dist < 45) {
                sphereCtx.beginPath();
                sphereCtx.moveTo(projectedPoints[i].x, projectedPoints[i].y);
                sphereCtx.lineTo(projectedPoints[j].x, projectedPoints[j].y);
                sphereCtx.stroke();
            }
        }
    }
    
    // Draw sphere points
    projectedPoints.forEach((p) => {
        // Color shifts from violet to gold based on audio energy
        const hue = 280 - (bassNormalized * 60); // Shifts violet(280) towards yellow/gold(220)
        
        // Point diameter based on depth perspective
        const size = Math.max(1.5, (p.depth + 2.0) * 1.5);
        
        sphereCtx.beginPath();
        sphereCtx.fillStyle = `hsla(${hue}, 85%, 65%, ${Math.max(0.25, (p.depth + 1.5) / 3)})`;
        sphereCtx.arc(p.x, p.y, size, 0, Math.PI * 2);
        sphereCtx.fill();
    });
}

// Global visualizer particle background (AURA Atmos)
function runAuraAtmosParticles() {
    const parent = document.getElementById("aura-particles");
    if (!parent) return;
    
    // We manipulate styling directly for simple performance
    let particleCount = 20;
    parent.innerHTML = '';
    
    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement("div");
        particle.className = "atmos-particle";
        
        // Random placement parameters
        const x = Math.random() * 100;
        const y = Math.random() * 100;
        const size = Math.random() * 4 + 2;
        const duration = Math.random() * 10 + 10;
        const delay = Math.random() * -10;
        
        particle.style.cssText = `
            position: absolute;
            left: ${x}%;
            top: ${y}%;
            width: ${size}px;
            height: ${size}px;
            border-radius: 50%;
            background: rgba(255, 255, 255, ${Math.random() * 0.15 + 0.05});
            pointer-events: none;
            animation: move-particle ${duration}s infinite linear;
            animation-delay: ${delay}s;
        `;
        parent.appendChild(particle);
    }
    
    // Append animations style directly
    const styleSheet = document.createElement("style");
    styleSheet.innerText = `
        @keyframes move-particle {
            0% { transform: translateY(0) translateX(0); opacity: 0.1; }
            50% { transform: translateY(-80px) translateX(30px); opacity: 0.6; }
            100% { transform: translateY(-160px) translateX(0); opacity: 0; }
        }
    `;
    document.head.appendChild(styleSheet);
}

// Export global symbols
window.initVisualizers = initVisualizers;
window.startVisualizerLoop = startVisualizerLoop;
window.stopVisualizerLoop = stopVisualizerLoop;
window.runAuraAtmosParticles = runAuraAtmosParticles;
