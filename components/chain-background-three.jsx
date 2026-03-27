'use client';

import { useEffect, useRef } from 'react';

const NODE_COUNT = 72;
const LINK_DISTANCE = 0.42;
const PACKET_COUNT = 38;
const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.min.js';

function startCanvasFallback(mount) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    return () => {};
  }

  const nodes = Array.from({ length: 42 }, () => ({
    x: Math.random(),
    y: Math.random() * 0.9,
    vx: (Math.random() - 0.5) * 0.0015,
    vy: (Math.random() - 0.5) * 0.0012,
  }));

  const packets = Array.from({ length: 22 }, () => ({
    from: Math.floor(Math.random() * nodes.length),
    to: Math.floor(Math.random() * nodes.length),
    progress: Math.random(),
    speed: 0.004 + (Math.random() * 0.005),
  }));

  const resize = () => {
    canvas.width = mount.clientWidth;
    canvas.height = mount.clientHeight;
  };

  resize();
  mount.appendChild(canvas);
  window.addEventListener('resize', resize);

  let frame;
  const draw = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);

    for (const node of nodes) {
      node.x += node.vx;
      node.y += node.vy;
      if (node.x < 0 || node.x > 1) node.vx *= -1;
      if (node.y < 0 || node.y > 1) node.vy *= -1;
    }

    context.strokeStyle = 'rgba(255, 158, 196, 0.45)';
    context.lineWidth = 1;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt((dx * dx) + (dy * dy));
        if (dist < 0.18) {
          context.beginPath();
          context.moveTo(nodes[i].x * canvas.width, nodes[i].y * canvas.height);
          context.lineTo(nodes[j].x * canvas.width, nodes[j].y * canvas.height);
          context.stroke();
        }
      }
    }

    for (const packet of packets) {
      packet.progress += packet.speed;
      if (packet.progress >= 1) {
        packet.from = packet.to;
        packet.to = (packet.from + 1 + Math.floor(Math.random() * 5)) % nodes.length;
        packet.progress = 0;
      }

      const from = nodes[packet.from];
      const to = nodes[packet.to];
      const x = from.x + ((to.x - from.x) * packet.progress);
      const y = from.y + ((to.y - from.y) * packet.progress);

      context.strokeStyle = 'rgba(255, 241, 228, 0.95)';
      context.beginPath();
      context.moveTo(from.x * canvas.width, from.y * canvas.height);
      context.lineTo(x * canvas.width, y * canvas.height);
      context.stroke();
    }

    context.fillStyle = 'rgba(255, 182, 156, 0.95)';
    for (const node of nodes) {
      context.beginPath();
      context.arc(node.x * canvas.width, node.y * canvas.height, 2.1, 0, Math.PI * 2);
      context.fill();
    }

    frame = window.requestAnimationFrame(draw);
  };

  draw();

  return () => {
    window.cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    if (mount.contains(canvas)) {
      mount.removeChild(canvas);
    }
  };
}

function loadThreeGlobal() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('No window available'));
  }

  if (window.THREE) {
    return Promise.resolve(window.THREE);
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-three-cdn="true"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.THREE), { once: true });
      existing.addEventListener('error', () => reject(new Error('Could not load Three.js')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = THREE_CDN;
    script.async = true;
    script.defer = true;
    script.dataset.threeCdn = 'true';
    script.onload = () => resolve(window.THREE);
    script.onerror = () => reject(new Error('Could not load Three.js'));
    document.head.appendChild(script);
  });
}

export function ChainBackgroundThree() {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return undefined;
    }

    let animationFrame;
    let mounted = true;
    let cleanup = () => {};

    loadThreeGlobal().then((THREE) => {
      if (!mounted || !THREE) {
        return;
      }

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
      camera.position.z = 2.8;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      renderer.setClearColor(0x000000, 0);
      mount.appendChild(renderer.domElement);

      const pointsGeometry = new THREE.BufferGeometry();
      const positions = new Float32Array(NODE_COUNT * 3);
      const velocities = new Float32Array(NODE_COUNT * 3);

      for (let index = 0; index < NODE_COUNT; index += 1) {
        const pointIndex = index * 3;
        positions[pointIndex] = (Math.random() - 0.5) * 2;
        positions[pointIndex + 1] = (Math.random() - 0.5) * 1.2;
        positions[pointIndex + 2] = (Math.random() - 0.5) * 0.8;

        velocities[pointIndex] = (Math.random() - 0.5) * 0.0014;
        velocities[pointIndex + 1] = (Math.random() - 0.5) * 0.0012;
        velocities[pointIndex + 2] = (Math.random() - 0.5) * 0.0008;
      }

      pointsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const pointsMaterial = new THREE.PointsMaterial({
        size: 0.018,
        color: '#ffb089',
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: true,
      });
      const particles = new THREE.Points(pointsGeometry, pointsMaterial);
      scene.add(particles);

      const linePositions = new Float32Array(NODE_COUNT * NODE_COUNT * 3);
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
      lineGeometry.setDrawRange(0, 0);
      const lineMaterial = new THREE.LineBasicMaterial({ color: '#ff8fbf', transparent: true, opacity: 0.58 });
      const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
      scene.add(lines);

      const packetPositions = new Float32Array(PACKET_COUNT * 2 * 3);
      const packetGeometry = new THREE.BufferGeometry();
      packetGeometry.setAttribute('position', new THREE.BufferAttribute(packetPositions, 3));
      packetGeometry.setDrawRange(0, PACKET_COUNT * 2);
      const packetMaterial = new THREE.LineBasicMaterial({ color: '#fff0de', transparent: true, opacity: 0.98 });
      const packets = new THREE.LineSegments(packetGeometry, packetMaterial);
      scene.add(packets);

      const packetState = Array.from({ length: PACKET_COUNT }, () => ({
        from: Math.floor(Math.random() * NODE_COUNT),
        to: Math.floor(Math.random() * NODE_COUNT),
        progress: Math.random(),
        speed: 0.003 + (Math.random() * 0.004),
      }));

      const pickNextTarget = (fromNode) => {
        const fromOffset = fromNode * 3;
        let candidate = -1;
        let candidateDistance = Number.POSITIVE_INFINITY;

        for (let index = 0; index < NODE_COUNT; index += 1) {
          if (index === fromNode) {
            continue;
          }

          const offset = index * 3;
          const dx = positions[fromOffset] - positions[offset];
          const dy = positions[fromOffset + 1] - positions[offset + 1];
          const dz = positions[fromOffset + 2] - positions[offset + 2];
          const distance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));

          if (distance < candidateDistance) {
            candidate = index;
            candidateDistance = distance;
          }
        }

        return candidate >= 0 ? candidate : ((fromNode + 1) % NODE_COUNT);
      };

      packetState.forEach((packet) => {
        packet.to = pickNextTarget(packet.from);
      });

      const updateSize = () => {
        camera.aspect = mount.clientWidth / Math.max(mount.clientHeight, 1);
        camera.updateProjectionMatrix();
        renderer.setSize(mount.clientWidth, mount.clientHeight);
      };

      const handleResize = () => updateSize();
      window.addEventListener('resize', handleResize);
      updateSize();

      const animate = () => {
        if (!mounted) {
          return;
        }

        let drawCount = 0;
        for (let index = 0; index < NODE_COUNT; index += 1) {
          const pointIndex = index * 3;
          positions[pointIndex] += velocities[pointIndex];
          positions[pointIndex + 1] += velocities[pointIndex + 1];
          positions[pointIndex + 2] += velocities[pointIndex + 2];

          if (Math.abs(positions[pointIndex]) > 1) velocities[pointIndex] *= -1;
          if (Math.abs(positions[pointIndex + 1]) > 0.62) velocities[pointIndex + 1] *= -1;
          if (Math.abs(positions[pointIndex + 2]) > 0.42) velocities[pointIndex + 2] *= -1;
        }

        for (let left = 0; left < NODE_COUNT; left += 1) {
          const leftIndex = left * 3;
          for (let right = left + 1; right < NODE_COUNT; right += 1) {
            const rightIndex = right * 3;
            const dx = positions[leftIndex] - positions[rightIndex];
            const dy = positions[leftIndex + 1] - positions[rightIndex + 1];
            const dz = positions[leftIndex + 2] - positions[rightIndex + 2];
            const distance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));

            if (distance < LINK_DISTANCE) {
              linePositions[drawCount * 3] = positions[leftIndex];
              linePositions[(drawCount * 3) + 1] = positions[leftIndex + 1];
              linePositions[(drawCount * 3) + 2] = positions[leftIndex + 2];
              drawCount += 1;

              linePositions[drawCount * 3] = positions[rightIndex];
              linePositions[(drawCount * 3) + 1] = positions[rightIndex + 1];
              linePositions[(drawCount * 3) + 2] = positions[rightIndex + 2];
              drawCount += 1;
            }
          }
        }

        for (let packetIndex = 0; packetIndex < PACKET_COUNT; packetIndex += 1) {
          const packet = packetState[packetIndex];
          if (packet.to === packet.from) {
            packet.to = (packet.to + 1) % NODE_COUNT;
          }

          packet.progress += packet.speed;
          if (packet.progress >= 1) {
            packet.from = packet.to;
            packet.to = pickNextTarget(packet.from);
            packet.progress = 0;
            packet.speed = 0.003 + (Math.random() * 0.004);
          }

          const fromIndex = packet.from * 3;
          const toIndex = packet.to * 3;

          const startX = positions[fromIndex];
          const startY = positions[fromIndex + 1];
          const startZ = positions[fromIndex + 2];
          const targetX = positions[toIndex];
          const targetY = positions[toIndex + 1];
          const targetZ = positions[toIndex + 2];

          const headX = startX + ((targetX - startX) * packet.progress);
          const headY = startY + ((targetY - startY) * packet.progress);
          const headZ = startZ + ((targetZ - startZ) * packet.progress);

          const base = packetIndex * 6;
          packetPositions[base] = startX;
          packetPositions[base + 1] = startY;
          packetPositions[base + 2] = startZ;
          packetPositions[base + 3] = headX;
          packetPositions[base + 4] = headY;
          packetPositions[base + 5] = headZ;
        }

        pointsGeometry.attributes.position.needsUpdate = true;
        lineGeometry.attributes.position.needsUpdate = true;
        packetGeometry.attributes.position.needsUpdate = true;
        lineGeometry.setDrawRange(0, drawCount);

        particles.rotation.y += 0.00045;
        particles.rotation.x += 0.0002;
        lines.rotation.y += 0.00045;
        lines.rotation.x += 0.0002;
        packets.rotation.y += 0.00045;
        packets.rotation.x += 0.0002;
        renderer.render(scene, camera);
        animationFrame = window.requestAnimationFrame(animate);
      };

      animate();

      cleanup = () => {
        window.removeEventListener('resize', handleResize);
        window.cancelAnimationFrame(animationFrame);
        lineGeometry.dispose();
        lineMaterial.dispose();
        packetGeometry.dispose();
        packetMaterial.dispose();
        pointsGeometry.dispose();
        pointsMaterial.dispose();
        renderer.dispose();
        if (mount.contains(renderer.domElement)) {
          mount.removeChild(renderer.domElement);
        }
      };
    }).catch(() => {
      cleanup = startCanvasFallback(mount);
    });

    return () => {
      mounted = false;
      cleanup();
    };
  }, []);

  return <div className="chainThreeBackdrop" ref={mountRef} aria-hidden="true" />;
}
