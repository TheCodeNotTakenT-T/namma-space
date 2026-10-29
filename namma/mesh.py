"""Collision mesh: TSDF fusion of depth rendered from the trained splats (Open3D 0.19, MIT).

The mesh is built in exactly the splat's coordinate frame (no transform), cleaned of small floating
pieces, decimated to the viewer's triangle budget and written as GLB (trimesh, MIT).
"""
import numpy as np
import open3d as o3d
import torch
import trimesh

from namma import trainer as T
from namma.workspace import read_json


def load_splats(ws, device="cuda"):
    state = torch.load(ws.train / "final.pt", map_location="cpu", weights_only=False)
    return {k: v.to(device) for k, v in state["splats"].items()}, state["sh_degree"]


def scaled(frame, long_side):
    s = min(1.0, long_side / max(frame.width, frame.height))
    K = frame.K.clone()
    K[:2] *= s
    return T.Frame(frame.name, K, frame.c2w, max(1, round(frame.width * s)), max(1, round(frame.height * s)), frame.image)


def run(ws, cfg, device="cuda"):
    mc = cfg.mesh
    splats, sh_degree = load_splats(ws, device)
    frames, _, _ = T.load_dataset(ws, with_priors=False)
    metric = bool((ws.receipt("priors") or {}).get("metrics", {}).get("metric_scale"))
    # Without metric priors the scene unit is arbitrary: size the voxel from the camera spread instead.
    voxel = mc.voxel if metric else T.scene_scale(frames) / 300
    max_depth = mc.max_depth if metric else T.scene_scale(frames) * 4
    volume = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=voxel, sdf_trunc=voxel * mc.trunc_voxels, color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8)
    picks = np.unique(np.linspace(0, len(frames) - 1, min(mc.max_views, len(frames))).round().astype(int))
    # Depth range from what the model actually renders, not from assumptions about the scene.
    sample = []
    with torch.no_grad():
        for i in picks[:: max(1, len(picks) // 12)]:
            renders, alphas, _ = T.render(splats, scaled(frames[i], mc.render_long_side), sh_degree, device)
            covered = alphas[0, ..., 0] > mc.min_alpha
            sample.append((float(covered.float().mean()), renders[0, ..., 3][covered].float().cpu().numpy()))
    coverage = float(np.mean([c for c, _ in sample]))
    depths = np.concatenate([d for _, d in sample]) if sample else np.zeros(0)
    if coverage < 0.05 or depths.size == 0:
        raise RuntimeError(f"Rendered views are almost empty (coverage {coverage:.1%}); the trained model is unusable")
    max_depth = min(max_depth, float(np.percentile(depths, 99)) * 1.5)
    with torch.no_grad():
        for k, i in enumerate(picks):
            ws.status(stage="mesh", message=f"Fusing rendered depth {k + 1}/{len(picks)}", progress=k / len(picks))
            frame = scaled(frames[i], mc.render_long_side)
            renders, alphas, _ = T.render(splats, frame, sh_degree, device)
            rgb = np.ascontiguousarray((renders[0, ..., :3].clamp(0, 1) * 255).byte().cpu().numpy())
            depth = renders[0, ..., 3].float().cpu().numpy()
            depth[(alphas[0, ..., 0].cpu().numpy() < mc.min_alpha) | ~np.isfinite(depth) | (depth > max_depth)] = 0
            rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
                o3d.geometry.Image(rgb), o3d.geometry.Image(np.ascontiguousarray(depth, dtype=np.float32)),
                depth_scale=1.0, depth_trunc=max_depth, convert_rgb_to_intensity=False)
            K = frame.K.numpy().astype(np.float64)
            intrinsic = o3d.camera.PinholeCameraIntrinsic(frame.width, frame.height, K[0, 0], K[1, 1], K[0, 2], K[1, 2])
            volume.integrate(rgbd, intrinsic, np.linalg.inv(frame.c2w.numpy().astype(np.float64)))
    ws.status(message="Extracting and cleaning the mesh", progress=None)
    mesh = volume.extract_triangle_mesh()
    raw_triangles = len(mesh.triangles)
    if raw_triangles == 0:
        raise RuntimeError("TSDF fusion produced an empty mesh (check rendered depth / Open3D version)")
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    clusters, counts, _ = mesh.cluster_connected_triangles()
    clusters, counts = np.asarray(clusters), np.asarray(counts)
    keep = counts >= max(100, mc.min_component_fraction * counts.sum())
    mesh.remove_triangles_by_mask(~keep[clusters])
    mesh.remove_unreferenced_vertices()
    if len(mesh.triangles) > mc.target_triangles:
        mesh = mesh.simplify_quadric_decimation(mc.target_triangles)
        mesh.remove_degenerate_triangles()
        mesh.remove_unreferenced_vertices()
    vertices = np.asarray(mesh.vertices, dtype=np.float32)
    faces = np.asarray(mesh.triangles, dtype=np.uint32)
    colors = (np.asarray(mesh.vertex_colors) * 255).astype(np.uint8) if mesh.has_vertex_colors() else None
    glb = ws.mesh / "room.glb"
    trimesh.Trimesh(vertices, faces, vertex_colors=colors, process=False).export(glb, file_type="glb")
    floor = estimate_floor(vertices, faces)
    return {"voxel": voxel, "metric": metric, "views": len(picks), "raw_triangles": raw_triangles,
            "triangles": len(faces), "vertices": len(vertices), "components_kept": int(keep.sum()),
            "components_dropped": int((~keep).sum()), "floor": floor,
            "bounds_min": vertices.min(0).tolist(), "bounds_max": vertices.max(0).tolist()}, [glb]


def estimate_floor(vertices, faces):
    """Lowest large horizontal surface (world up is -Y after namma.sfm.level_and_center)."""
    tri = vertices[faces]
    normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area = np.linalg.norm(normals, axis=1)
    up = np.abs(normals[:, 1]) > 0.9 * np.maximum(area, 1e-12)
    if area[up].sum() <= 0:
        return None
    heights = tri[up].mean(1)[:, 1]  # larger y = lower (y points down)
    hist, edges = np.histogram(heights, bins=100, weights=area[up])
    lowest_big = [i for i in range(len(hist)) if hist[i] > 0.05 * hist.sum()]
    if not lowest_big:
        return None
    i = max(lowest_big)
    return {"y": float((edges[i] + edges[i + 1]) / 2), "up": [0.0, -1.0, 0.0],
            "area_fraction": float(hist[i] / hist.sum())}
