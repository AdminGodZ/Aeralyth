"use client";

import { type ComponentProps, useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import * as THREE from "three";

import { cn } from "@/lib/utils";

type DottedSurfaceProps = Omit<ComponentProps<"div">, "ref">;

export function DottedSurface({ className, ...props }: DottedSurfaceProps) {
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const separation = 150;
    const amountX = 40;
    const amountY = 60;
    const primaryColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--primary")
        .trim() || "#3088f0";

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xffffff, 2000, 10000);

    const camera = new THREE.PerspectiveCamera(60, 1, 1, 10000);
    camera.position.set(0, 355, 1220);

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(scene.fog.color, 0);
    renderer.domElement.style.display = "block";

    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];

    for (let ix = 0; ix < amountX; ix += 1) {
      for (let iy = 0; iy < amountY; iy += 1) {
        positions.push(
          ix * separation - (amountX * separation) / 2,
          0,
          iy * separation - (amountY * separation) / 2,
        );
      }
    }

    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );

    const material = new THREE.PointsMaterial({
      color: primaryColor,
      opacity: 0.78,
      size: 8,
      sizeAttenuation: true,
      transparent: true,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);
    container.appendChild(renderer.domElement);

    const resize = () => {
      const width = container.clientWidth || window.innerWidth;
      const height = container.clientHeight || window.innerHeight;

      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };

    let count = 0;
    let animationId = 0;
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const renderFrame = () => {
      const positionAttribute = geometry.attributes.position;
      const positionArray = positionAttribute.array as Float32Array;

      let particleIndex = 0;

      for (let ix = 0; ix < amountX; ix += 1) {
        for (let iy = 0; iy < amountY; iy += 1) {
          const index = particleIndex * 3;

          positionArray[index + 1] =
            Math.sin((ix + count) * 0.3) * 50 +
            Math.sin((iy + count) * 0.5) * 50;

          particleIndex += 1;
        }
      }

      positionAttribute.needsUpdate = true;
      renderer.render(scene, camera);
      count += 0.05;
    };

    const animate = () => {
      renderFrame();

      if (!prefersReducedMotion) {
        animationId = window.requestAnimationFrame(animate);
      }
    };

    resize();
    animate();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(animationId);
      geometry.dispose();
      material.dispose();
      renderer.dispose();

      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [resolvedTheme]);

  return (
    <div
      ref={containerRef}
      className={cn("pointer-events-none absolute inset-0 z-0", className)}
      aria-hidden="true"
      {...props}
    />
  );
}
