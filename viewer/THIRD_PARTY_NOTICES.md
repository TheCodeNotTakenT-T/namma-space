# Third-party components in the Namma Space viewer

The browser viewer, importer and demo packager build on these open-source components. Each keeps its own
licence; the demo packager copies the licence files of every runtime package into `licenses/`.

| Component | Role | Licence |
| --- | --- | --- |
| [Aholo Viewer](https://github.com/manycoretech/aholo-viewer) 1.10.0 (vendored in `vendor/`) | Gaussian splat rendering in the browser | MIT, copyright 2026 MANYCORE, INC. |
| [Three.js](https://github.com/mrdoob/three.js) 0.186 | Scene graph, cameras, GLB loading | MIT, three.js authors |
| [recast-navigation](https://github.com/isaac-mason/recast-navigation-js) 0.43 | Navigation mesh and collision for walking | MIT, Isaac Mason; upstream Recast/Detour: zlib |
| [PlayCanvas splat-transform](https://github.com/playcanvas/splat-transform) 3.10.1 (import only) | Converts the trained PLY to the compressed web format | MIT, PlayCanvas Ltd.; its dependencies include @adobe/spz (MIT) and meshoptimizer (MIT) |
| [Vite](https://github.com/vitejs/vite) 6 (build only) | Development server and production build | MIT |

Scenes (captured rooms) are not covered by these licences; they belong to whoever captured them.
