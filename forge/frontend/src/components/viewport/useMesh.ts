// Lazy mesh loader. Fetches /api/v1/assets/mesh/{stem}, parses by suffix,
// returns a three.js Object3D. Cache is keyed by stem so repeated visuals
// pointing at the same mesh share buffers.

import { useEffect, useState } from "react";
import { BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, Object3D } from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

interface MeshListing {
  [stem: string]: { suffix: string; size_bytes: number };
}

interface CacheEntry {
  promise: Promise<Object3D | BufferGeometry>;
}

const cache = new Map<string, CacheEntry>();
let listingPromise: Promise<MeshListing> | null = null;
let listingCacheBuster = 0;

function getListing(): Promise<MeshListing> {
  if (!listingPromise) {
    listingPromise = fetch(`/api/v1/assets/meshes?_=${listingCacheBuster}`)
      .then((r) => (r.ok ? r.json() : ({} as MeshListing)))
      .catch(() => ({} as MeshListing));
  }
  return listingPromise;
}

export function invalidateMeshCache(): void {
  cache.clear();
  listingPromise = null;
  listingCacheBuster++;
}

async function loadMesh(stem: string, suffix: string): Promise<Object3D | BufferGeometry> {
  const url = `/api/v1/assets/mesh/${encodeURIComponent(stem)}`;
  const sfx = suffix.toLowerCase();

  if (sfx === ".stl") {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    return new STLLoader().parse(buf);
  }
  if (sfx === ".obj") {
    const text = await fetch(url).then((r) => r.text());
    return new OBJLoader().parse(text);
  }
  if (sfx === ".glb" || sfx === ".gltf") {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    return new Promise<Object3D>((resolve, reject) => {
      new GLTFLoader().parse(buf, "", (gltf) => resolve(gltf.scene), (err) => reject(err));
    });
  }
  throw new Error(`unsupported mesh suffix: ${suffix}`);
}

interface MeshState {
  loading: boolean;
  error: Error | null;
  object: Object3D | null;
  geometry: BufferGeometry | null;
}

export function useMesh(stem: string | null | undefined): MeshState {
  const [state, setState] = useState<MeshState>({
    loading: true,
    error: null,
    object: null,
    geometry: null,
  });

  useEffect(() => {
    if (!stem) {
      setState({ loading: false, error: null, object: null, geometry: null });
      return;
    }
    let cancelled = false;
    setState({ loading: true, error: null, object: null, geometry: null });

    (async () => {
      const listing = await getListing();
      const entry = listing[stem];
      if (!entry) {
        if (!cancelled) {
          setState({
            loading: false,
            error: new Error(`mesh '${stem}' not in project`),
            object: null,
            geometry: null,
          });
        }
        return;
      }

      let cached = cache.get(stem);
      if (!cached) {
        cached = { promise: loadMesh(stem, entry.suffix) };
        cache.set(stem, cached);
      }

      try {
        const result = await cached.promise;
        if (cancelled) return;
        if (result instanceof BufferGeometry) {
          setState({ loading: false, error: null, geometry: result, object: null });
        } else {
          setState({ loading: false, error: null, geometry: null, object: result });
        }
      } catch (e) {
        if (!cancelled) {
          setState({
            loading: false,
            error: e instanceof Error ? e : new Error(String(e)),
            object: null,
            geometry: null,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stem]);

  return state;
}

export function defaultMaterial(selected: boolean, tint?: string): MeshStandardMaterial {
  const base = selected ? "#2dd4bf" : tint ?? "#a1a1aa";
  return new MeshStandardMaterial({
    color: new Color(base),
    roughness: 0.6,
    metalness: selected ? 0.4 : 0.15,
  });
}

export function meshToObject(
  geometry: BufferGeometry | null,
  object: Object3D | null,
  selected: boolean,
  tint?: string,
): Object3D | null {
  if (geometry) {
    const m = new Mesh(geometry, defaultMaterial(selected, tint));
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
  if (object) {
    // Don't mutate the cached object; clone it and override / tint each
    // mesh's material per the current selection + category.
    const clone = object.clone(true);
    const tintColor = tint ? new Color(tint) : null;
    clone.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      if (selected) {
        mesh.material = defaultMaterial(true);
      } else if (tintColor) {
        // Clone the material so we don't write through to the cached source.
        const src = mesh.material as MeshStandardMaterial | undefined;
        const m = src ? src.clone() : new MeshStandardMaterial();
        // Mix tint with original color (lerp 60% toward tint) so PBR-painted
        // imports stay distinguishable but show the category.
        const original = m.color ? m.color.clone() : new Color("#a1a1aa");
        m.color = original.lerp(tintColor, 0.6);
        mesh.material = m;
      }
    });
    return clone;
  }
  return null;
}

// Shut up the unused `Group` import warning while keeping it as a clear type
// reference for future extension (group-style meshes for OBJ/glTF).
void Group;
