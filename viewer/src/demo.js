import * as THREE from 'three';
export function makeDemo() {
  const group = new THREE.Group();
  const box = (name, size, position, color) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    mesh.name = name; mesh.position.set(...position); group.add(mesh); return mesh;
  };
  box('Floor', [10, 0.2, 8], [0, -0.1, 0], '#cfc9ba');
  box('Back wall', [10, 2.8, 0.15], [0, 1.4, -4], '#e8e4d9');
  box('Left wall', [0.15, 2.8, 8], [-5, 1.4, 0], '#c4d4cd');
  box('Right wall', [0.15, 2.8, 8], [5, 1.4, 0], '#e8e4d9');
  box('Desk', [2.4, 0.9, 1.5], [0, 0.45, 0], '#997a57');
  box('Storage', [1.6, 1.7, 0.65], [-3, 0.85, -3.2], '#60766a');
  box('Seat', [1.8, 0.6, 0.8], [3, 0.3, -2.5], '#bd795f');
  return group;
}
