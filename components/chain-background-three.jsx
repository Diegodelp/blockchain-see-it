'use client';

import { useEffect, useRef } from 'react';

const NODE_COUNT = 72;
const LINK_DISTANCE = 0.26;
const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.min.js';

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
      const lineMaterial = new THREE.LineBasicMaterial({ color: '#ff5d9e', transparent: true, opacity: 0.24 });
      const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
      scene.add(lines);

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

        pointsGeometry.attributes.position.needsUpdate = true;
        lineGeometry.attributes.position.needsUpdate = true;
        lineGeometry.setDrawRange(0, drawCount);

        particles.rotation.y += 0.00045;
        particles.rotation.x += 0.0002;
        lines.rotation.y += 0.00045;
        lines.rotation.x += 0.0002;
        renderer.render(scene, camera);
        animationFrame = window.requestAnimationFrame(animate);
      };

      animate();

      cleanup = () => {
        window.removeEventListener('resize', handleResize);
        window.cancelAnimationFrame(animationFrame);
        lineGeometry.dispose();
        lineMaterial.dispose();
        pointsGeometry.dispose();
        pointsMaterial.dispose();
        renderer.dispose();
        if (mount.contains(renderer.domElement)) {
          mount.removeChild(renderer.domElement);
        }
      };
    }).catch(() => {});

    return () => {
      mounted = false;
      cleanup();
    };
  }, []);

  return <div className="chainThreeBackdrop" ref={mountRef} aria-hidden="true" />;
}
