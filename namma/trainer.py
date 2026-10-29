"""Gaussian Splatting training on gsplat (Apache-2.0), resumable.

Follows gsplat's examples/simple_trainer.py recipe (MCMC densification with a fixed Gaussian budget,
L1 + SSIM, opacity/scale regularisation, SH degree warm-up) and adds:
  * per-frame affine colour correction for video exposure / white-balance drift (training only; the
    exported model keeps the uncorrected colours),
  * log-depth and normal-consistency losses against the aligned MoGe priors (namma.priors),
  * non-finite loss/gradient guards and full-state checkpoints for resuming after a Molab shutdown.
"""
import math
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Optional

import cv2
import numpy as np
import pycolmap
import torch
import torch.nn.functional as F

from namma.sfm import cam_from_world
from namma.workspace import sha256_file, write_json

SH_C0 = 0.28209479177387814
OUTLIER_FACTOR = 6.0  # same rule as namma.sfm.outlier_cameras
BACKEND = None  # tests may install a stand-in renderer here


def backend():
    global BACKEND
    if BACKEND is None:
        from gsplat.losses import ssim_loss
        from gsplat.rendering import rasterization
        from gsplat.strategy import DefaultStrategy, MCMCStrategy
        from gsplat.utils import depth_to_normal
        BACKEND = SimpleNamespace(rasterization=rasterization, DefaultStrategy=DefaultStrategy, MCMCStrategy=MCMCStrategy,
                                  ssim_loss=ssim_loss, depth_to_normal=depth_to_normal)
    return BACKEND


@dataclass
class Frame:
    name: str
    K: torch.Tensor          # [3, 3]
    c2w: torch.Tensor        # [4, 4] OpenCV convention
    width: int
    height: int
    image: torch.Tensor      # [H, W, 3] uint8 (CPU)
    depth: Optional[torch.Tensor] = None    # [H, W] float16 metres (0 = invalid)
    normal: Optional[torch.Tensor] = None   # [H, W, 3] float16, camera frame, facing the camera


def load_dataset(ws, with_priors=True):
    rec = pycolmap.Reconstruction(ws.dataset / "sparse")
    images = sorted((img for img in rec.images.values() if img.has_pose), key=lambda img: img.name)

    def load(img):
        cam = rec.cameras[img.camera_id]
        fx, fy, cx, cy = cam.params[:4] if cam.model_name == "PINHOLE" else (cam.params[0],) * 2 + tuple(cam.params[1:3])
        pose = cam_from_world(img)
        w2c = np.eye(4)
        w2c[:3, :3] = np.asarray(pose.rotation.matrix())
        w2c[:3, 3] = np.asarray(pose.translation)
        rgb = cv2.cvtColor(cv2.imread(str(ws.dataset / "images" / img.name)), cv2.COLOR_BGR2RGB)
        frame = Frame(img.name, torch.tensor([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=torch.float32),
                      torch.from_numpy(np.linalg.inv(w2c)).float(), rgb.shape[1], rgb.shape[0], torch.from_numpy(rgb))
        prior = ws.priors / f"{img.name}.npz"
        if with_priors and prior.exists():
            data = np.load(prior)
            frame.depth = torch.from_numpy(data["depth"])
            if "normal" in data:
                frame.normal = torch.from_numpy(data["normal"])
        return frame

    # A few cameras (and points) placed absurdly far away by SfM would set the scene scale, learning rates
    # and initial Gaussians for the whole room: leave them out.
    centers = np.array([np.asarray(cam_from_world(img).rotation.matrix()).T @ -np.asarray(cam_from_world(img).translation)
                        for img in images])
    middle = np.median(centers, axis=0)
    dist = np.linalg.norm(centers - middle, axis=1)
    keep = dist <= OUTLIER_FACTOR * max(float(np.median(dist)), 1e-9)
    images = [img for img, k in zip(images, keep) if k]
    with ThreadPoolExecutor(8) as pool:
        frames = list(pool.map(load, images))
    reach = 4 * max(float(dist[keep].max()), 1e-6) + 20 * max(float(np.median(dist)), 1e-6)
    xyz, rgb = [], []
    for point in rec.points3D.values():
        if point.track.length() >= 2 and np.linalg.norm(point.xyz - middle) <= reach:
            xyz.append(point.xyz)
            rgb.append(point.color)
    if (~keep).any():
        print(f"load_dataset: ignored {int((~keep).sum())} outlier cameras", flush=True)
    return frames, np.array(xyz, np.float32), np.array(rgb, np.float32) / 255.0


def split(frames, test_every):
    test = list(range(0, len(frames), test_every)) if len(frames) >= 3 * test_every else []
    train = [i for i in range(len(frames)) if i not in set(test)]
    return train, test


def scene_scale(frames):
    centers = torch.stack([f.c2w[:3, 3] for f in frames])
    return float((centers - centers.median(0).values).norm(dim=1).max()) * 1.1 + 1e-6


def normalise(frames, xyz):
    """Move and scale the scene in place so the median camera distance from the median camera centre is 1,
    as gsplat's simple_trainer does (normalize_world_space). Its MCMC position noise is covariance times the
    means learning rate, so in a metric room it would grow with the square of the room's size."""
    centers = torch.stack([f.c2w[:3, 3] for f in frames])
    center = centers.median(0).values
    norm = float((centers - center).norm(dim=1).median().clamp_min(1e-6))
    for f in frames:
        f.c2w = f.c2w.clone()
        f.c2w[:3, 3] = (f.c2w[:3, 3] - center) / norm
        if f.depth is not None:
            f.depth = f.depth / norm
    xyz -= center.numpy()
    xyz /= norm
    return center, norm


def init_splats(xyz, rgb, tc, scale, device):
    from scipy.spatial import cKDTree
    points = torch.from_numpy(xyz)
    dist, _ = cKDTree(xyz).query(xyz, k=4)
    dist_avg = torch.from_numpy(np.sqrt((dist[:, 1:] ** 2).mean(1))).float().clamp_min(1e-7)
    n = len(points)
    shs = torch.zeros(n, (tc.sh_degree + 1) ** 2, 3)
    shs[:, 0] = (torch.from_numpy(rgb) - 0.5) / SH_C0
    params = {
        "means": (points, 1.6e-4 * scale),
        "scales": (torch.log(dist_avg * tc.value("init_scale"))[:, None].repeat(1, 3), 5e-3),
        "quats": (F.normalize(torch.rand(n, 4), dim=-1), 1e-3),
        "opacities": (torch.logit(torch.full((n,), tc.value("init_opacity"))), 5e-2),
        "sh0": (shs[:, :1], 2.5e-3),
        "shN": (shs[:, 1:], 2.5e-3 / 20),
    }
    return {k: v for k, (v, _) in params.items()}, {k: lr for k, (_, lr) in params.items()}


def make_optimizers(splats, lrs):
    return {k: torch.optim.Adam([{"params": splats[k], "lr": lrs[k], "name": k}], eps=1e-15) for k in splats}


def render(splats, frame, sh_degree, device, mode="RGB+ED"):
    viewmat = torch.linalg.inv(frame.c2w).to(device)[None]
    colors = torch.cat([splats["sh0"], splats["shN"]], 1)
    renders, alphas, info = backend().rasterization(
        means=splats["means"], quats=splats["quats"], scales=torch.exp(splats["scales"]),
        opacities=torch.sigmoid(splats["opacities"]), colors=colors, viewmats=viewmat, Ks=frame.K.to(device)[None],
        width=frame.width, height=frame.height, sh_degree=sh_degree, render_mode=mode, packed=False,
        rasterize_mode="classic")
    return renders, alphas, info


def _fit(prior, frame):
    """[h, w, c] prior map -> [H, W, c] at the frame's size (nearest, so invalid zeros do not smear)."""
    if prior.shape[:2] == (frame.height, frame.width):
        return prior
    return F.interpolate(prior.permute(2, 0, 1)[None], size=(frame.height, frame.width), mode="nearest")[0].permute(1, 2, 0)


def lambda_at(step, steps, start, end):
    t = min(max(step / max(steps, 1), 0.0), 1.0)
    return start * (end / start) ** t if start > 0 and end > 0 else start


def ssim_value(a, b):
    return 1.0 - float(backend().ssim_loss(a.permute(0, 3, 1, 2), b.permute(0, 3, 1, 2)))


class Trainer:
    def __init__(self, ws, cfg, device="cuda"):
        self.ws, self.cfg, self.tc, self.device = ws, cfg, cfg.train, device
        self.ckpt_dir = ws.train / "ckpt"
        sparse = ws.dataset / "sparse"
        fingerprint = "".join(sha256_file(p) for p in sorted(sparse.glob("*.bin")))
        self.settings = cfg.stage_hash("frames", "sfm", "priors", "train") + ":" + fingerprint[:32]
        self.ckpt_dir.mkdir(parents=True, exist_ok=True)
        self.frames, xyz, rgb = load_dataset(ws)
        if len(xyz) < 100:
            raise RuntimeError(f"Only {len(xyz)} sparse points to initialise from")
        self.center, self.norm = normalise(self.frames, xyz) if self.tc.normalize_world else (torch.zeros(3), 1.0)
        self.train_ids, self.test_ids = split(self.frames, self.tc.test_every)
        self.scale = scene_scale(self.frames)
        self.has_priors = any(f.depth is not None for f in self.frames)
        params, self.lrs = init_splats(xyz, rgb, self.tc, self.scale, device)
        self._set_params(params)
        n = len(self.frames)
        self.app_A = torch.nn.Parameter(torch.eye(3, device=device).repeat(n, 1, 1))
        self.app_b = torch.nn.Parameter(torch.zeros(n, 3, device=device))
        self.app_opt = torch.optim.Adam([self.app_A, self.app_b], lr=1e-3)
        start = min(500, self.tc.steps // 10)
        if self.tc.strategy == "mcmc":
            self.strategy = backend().MCMCStrategy(cap_max=self.tc.cap_max, refine_stop_iter=int(self.tc.steps * 0.83),
                                                   refine_start_iter=start)
            self.strategy_state = self.strategy.initialize_state()
        else:  # the original 3DGS split/clone/prune schedule, at gsplat simple_trainer's settings
            self.strategy = backend().DefaultStrategy(refine_start_iter=start, refine_stop_iter=self.tc.steps // 2)
            self.strategy_state = self.strategy.initialize_state(scene_scale=self.scale)
        self.strategy.check_sanity(self.splats, self.optimizers)
        self.step = 0
        self.order, self.cursor = [], 0
        self.rng = np.random.default_rng(0)
        self.bad_steps = 0

    def _set_params(self, tensors):
        self.splats = torch.nn.ParameterDict({k: torch.nn.Parameter(v.to(self.device).contiguous()) for k, v in tensors.items()})
        self.optimizers = make_optimizers(self.splats, self.lrs)
        self.scheduler = torch.optim.lr_scheduler.ExponentialLR(self.optimizers["means"], gamma=0.01 ** (1.0 / self.tc.steps))

    # ---- checkpoints ----------------------------------------------------------------------
    def save(self):
        path = self.ckpt_dir / f"step_{self.step:06d}.pt"
        state = {"step": self.step, "splats": {k: v.detach().cpu() for k, v in self.splats.items()},
                 "optimizers": {k: o.state_dict() for k, o in self.optimizers.items()},
                 "scheduler": self.scheduler.state_dict(), "strategy_state": self.strategy_state,
                 "app": {"A": self.app_A.detach().cpu(), "b": self.app_b.detach().cpu(), "opt": self.app_opt.state_dict()},
                 "order": self.order, "cursor": self.cursor, "rng": self.rng.bit_generator.state,
                 "torch_rng": torch.get_rng_state(), "cuda_rng": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None,
                 "frames": [f.name for f in self.frames], "settings": self.settings}
        tmp = path.with_suffix(".tmp")
        torch.save(state, tmp)
        tmp.replace(path)
        older = sorted(p for p in self.ckpt_dir.glob("step_*.pt") if p != path and int(p.stem[5:]) < self.step)
        for old in older[:-1]:  # keep this one and the previous one
            old.unlink(missing_ok=True)
        return path

    def resume(self):
        ckpts = sorted(self.ckpt_dir.glob("step_*.pt"))
        for path in reversed(ckpts):
            try:
                state = torch.load(path, map_location="cpu", weights_only=False)
            except Exception as error:  # a checkpoint cut off by a shutdown
                self.ws.log(f"Skipping unreadable checkpoint {path.name}: {error}")
                continue
            if state.get("frames") != [f.name for f in self.frames] or state.get("settings") != self.settings:
                self.ws.log(f"Removing checkpoint {path.name}: it belongs to different frames/settings")
                path.unlink(missing_ok=True)
                continue
            self._set_params(state["splats"])
            for k, opt in self.optimizers.items():
                opt.load_state_dict(state["optimizers"][k])
            self.scheduler.load_state_dict(state["scheduler"])
            self.strategy_state = {k: (v.to(self.device) if torch.is_tensor(v) else v) for k, v in state["strategy_state"].items()}
            with torch.no_grad():
                self.app_A.copy_(state["app"]["A"])
                self.app_b.copy_(state["app"]["b"])
            self.app_opt.load_state_dict(state["app"]["opt"])
            self.order, self.cursor = state["order"], state["cursor"]
            self.rng.bit_generator.state = state["rng"]
            torch.set_rng_state(state["torch_rng"])
            if state.get("cuda_rng") is not None and torch.cuda.is_available():
                torch.cuda.set_rng_state_all(state["cuda_rng"])
            self.step = state["step"]
            self.ws.log(f"Resumed training at step {self.step} from {path.name} ({len(self.splats['means'])} Gaussians)")
            return True
        return False

    # ---- one optimisation step ---------------------------------------------------------------
    def _next_frame(self):
        if self.cursor >= len(self.order):
            self.order = [int(i) for i in self.rng.permutation(self.train_ids)]
            self.cursor = 0
        index = self.order[self.cursor]
        self.cursor += 1
        return index

    def train_step(self):
        tc, step = self.tc, self.step
        index = self._next_frame()
        frame = self.frames[index]
        gt = frame.image.to(self.device, non_blocking=True).float()[None] / 255.0
        sh_degree = min(step // tc.sh_degree_interval, tc.sh_degree)
        renders, alphas, info = render(self.splats, frame, sh_degree, self.device)
        if self.tc.strategy != "mcmc":
            self.strategy.step_pre_backward(self.splats, self.optimizers, self.strategy_state, step, info)
        rgb, depth = renders[..., :3], renders[..., 3:4]
        if tc.appearance and step >= 1000:
            rgb = torch.einsum("bhwc,dc->bhwd", rgb, self.app_A[index]) + self.app_b[index]
        rgb_c = rgb.clamp(0, 1)
        l1 = (rgb - gt).abs().mean()
        loss = (1 - tc.ssim_lambda) * l1 + tc.ssim_lambda * backend().ssim_loss(rgb_c.permute(0, 3, 1, 2), gt.permute(0, 3, 1, 2))
        terms = {"l1": l1.item()}
        if frame.depth is not None:
            prior = _fit(frame.depth.to(self.device).float()[..., None], frame)[None]
            valid = (prior > 0) & (depth > 1e-4) & (alphas > 0.5)
            if valid.sum() > 100:
                depth_loss = (torch.log(depth[valid]) - torch.log(prior[valid])).abs().mean()
                loss = loss + lambda_at(step, tc.steps, tc.depth_lambda, tc.depth_lambda_end) * depth_loss
                terms["depth"] = depth_loss.item()
            if frame.normal is not None and step >= tc.normal_start:
                normal_world = backend().depth_to_normal(depth, frame.c2w.to(self.device)[None], frame.K.to(self.device)[None])
                prior_n = _fit(frame.normal.to(self.device).float(), frame) @ frame.c2w[:3, :3].to(self.device).T
                h, w = normal_world.shape[1:3]
                if (h, w) != prior_n.shape[:2]:  # some depth_to_normal versions crop the border
                    dy, dx = (prior_n.shape[0] - h) // 2, (prior_n.shape[1] - w) // 2
                    prior_n = prior_n[dy:dy + h, dx:dx + w]
                    valid_n = valid[0, dy:dy + h, dx:dx + w, 0]
                else:
                    valid_n = valid[0, ..., 0]
                if valid_n.sum() > 100:
                    cos = (F.normalize(normal_world[0], dim=-1) * prior_n).sum(-1).abs()
                    normal_loss = (1 - cos[valid_n]).mean()
                    loss = loss + tc.normal_lambda * normal_loss
                    terms["normal"] = normal_loss.item()
        if tc.value("opacity_reg"):
            loss = loss + tc.value("opacity_reg") * torch.sigmoid(self.splats["opacities"]).mean()
        if tc.value("scale_reg"):
            loss = loss + tc.value("scale_reg") * torch.exp(self.splats["scales"]).mean()
        if tc.appearance and step >= 1000:
            loss = loss + 1e-2 * ((self.app_A[index] - torch.eye(3, device=self.device)).square().mean() + self.app_b[index].square().mean())

        if not torch.isfinite(loss):
            return self._skip(f"non-finite loss {terms}")
        loss.backward()
        bad = [k for k, p in self.splats.items() if p.grad is not None and not torch.isfinite(p.grad).all()]
        if bad:
            return self._skip(f"non-finite gradients in {bad}")
        for opt in self.optimizers.values():
            opt.step()
            opt.zero_grad(set_to_none=True)
        if tc.appearance and step >= 1000:
            self.app_opt.step()
        self.app_opt.zero_grad(set_to_none=True)
        self.scheduler.step()
        if tc.strategy == "mcmc":
            self.strategy.step_post_backward(self.splats, self.optimizers, self.strategy_state, step, info,
                                             lr=self.scheduler.get_last_lr()[0])
        else:
            self.strategy.step_post_backward(self.splats, self.optimizers, self.strategy_state, step, info, packed=False)
            if len(self.splats["means"]) > tc.max_gaussians and self.strategy.refine_stop_iter > step:
                self.strategy.refine_stop_iter = step
                self.ws.log(f"step {step}: {len(self.splats['means']):,} Gaussians, densification stopped (max_gaussians)")
        self.bad_steps = 0
        self.step += 1
        terms["loss"] = loss.item()
        terms["psnr"] = (-10 * torch.log10(F.mse_loss(rgb_c.detach(), gt).clamp_min(1e-10))).item()
        return terms

    def _skip(self, reason):
        for opt in list(self.optimizers.values()) + [self.app_opt]:
            opt.zero_grad(set_to_none=True)
        self.bad_steps += 1
        self.ws.log(f"step {self.step}: skipped, {reason}")
        if self.bad_steps >= self.tc.max_bad_steps:
            raise RuntimeError(f"{self.bad_steps} consecutive non-finite steps at step {self.step}: {reason}")
        self.step += 1
        return None

    # ---- evaluation / previews ------------------------------------------------------------------
    @torch.no_grad()
    def evaluate(self):
        ids = self.test_ids or self.train_ids[:: max(1, len(self.train_ids) // 20)]
        psnr, ssim = [], []
        for i in ids:
            frame = self.frames[i]
            renders, _, _ = render(self.splats, frame, self.tc.sh_degree, self.device, mode="RGB")
            rgb = renders[..., :3].clamp(0, 1)
            gt = frame.image.to(self.device).float()[None] / 255.0
            psnr.append(float(-10 * torch.log10(F.mse_loss(rgb, gt).clamp_min(1e-10))))
            ssim.append(ssim_value(rgb, gt))
        return {"views": len(ids), "held_out": bool(self.test_ids), "psnr": float(np.mean(psnr)), "ssim": float(np.mean(ssim))}

    @torch.no_grad()
    def preview(self):
        frame = self.frames[(self.test_ids or self.train_ids)[0]]
        renders, alphas, _ = render(self.splats, frame, self.tc.sh_degree, self.device)
        rgb = (renders[0, ..., :3].clamp(0, 1) * 255).byte().cpu().numpy()
        depth = renders[0, ..., 3].cpu().numpy()
        valid = alphas[0, ..., 0].cpu().numpy() > 0.5
        lo, hi = np.percentile(depth[valid], [2, 98]) if valid.any() else (0, 1)
        depth_img = cv2.applyColorMap((np.clip((depth - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8), cv2.COLORMAP_TURBO)
        canvas = np.concatenate([frame.image.numpy()[..., ::-1], rgb[..., ::-1], depth_img], axis=1)
        scale = min(1.0, 2400 / canvas.shape[1])
        canvas = cv2.resize(canvas, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        path = self.ws.train / "previews" / f"step_{self.step:06d}.jpg"
        path.parent.mkdir(exist_ok=True)
        cv2.imwrite(str(path), canvas, [cv2.IMWRITE_JPEG_QUALITY, 88])
        return path

    def snapshot(self):
        return {k: v.detach().cpu().clone() for k, v in self.splats.items()}

    def restore(self, splats):
        with torch.no_grad():
            for k, v in splats.items():
                self.splats[k].data = v.to(self.device)

    def export_final(self):
        """final.pt is in the dataset's (metric) world, whatever the training normalisation."""
        splats = self.snapshot()
        splats["means"] = splats["means"] * self.norm + self.center
        splats["scales"] = splats["scales"] + math.log(self.norm)
        path = self.ws.train / "final.pt"
        torch.save({"splats": splats, "sh_degree": self.tc.sh_degree}, path)
        return path


def run(ws, cfg, on_checkpoint=None):
    torch.manual_seed(0)
    trainer = Trainer(ws, cfg)
    trainer.resume()
    tc = cfg.train
    log_path = ws.train / "metrics.jsonl"
    started, last_report = time.time(), time.time()
    window, history, best = [], [], None  # best = (held-out PSNR, step, splats on CPU)
    while trainer.step < tc.steps:
        terms = trainer.train_step()
        if terms:
            window.append(terms)
        step = trainer.step
        if step % 100 == 0 or step == tc.steps:
            if window:
                mean = {k: float(np.mean([t[k] for t in window if k in t])) for k in window[-1]}
                elapsed = time.time() - last_report
                record = {"step": step, "gaussians": len(trainer.splats["means"]), **mean,
                          "steps_per_s": round(len(window) / max(elapsed, 1e-6), 2)}
                with open(log_path, "a") as f:
                    f.write(__import__("json").dumps(record) + "\n")
                remaining = (tc.steps - step) / max(record["steps_per_s"], 1e-6)
                ws.status(stage="train", progress=step / tc.steps,
                          message=f"step {step}/{tc.steps}, {record['gaussians']:,} Gaussians, PSNR {mean.get('psnr', 0):.2f}, "
                                  f"~{remaining / 60:.0f} min left")
                window, last_report = [], time.time()
        if step % tc.preview_every == 0 and step < tc.steps:
            trainer.preview()
        if step % tc.checkpoint_every == 0 and step < tc.steps:
            path = trainer.save()
            if on_checkpoint:
                on_checkpoint(path, step)
            score = trainer.evaluate()
            history.append({"step": step, "psnr": round(score["psnr"], 2), "ssim": round(score["ssim"], 4)})
            with open(log_path, "a") as f:
                f.write(__import__("json").dumps({"eval": history[-1]}) + "\n")
            if best is None or score["psnr"] > best[0]:
                best = (score["psnr"], step, trainer.snapshot())
            elif score["psnr"] < best[0] - 3:
                ws.log(f"WARNING held-out PSNR fell from {best[0]:.1f} dB (step {best[1]}) to {score['psnr']:.1f} dB at step {step}")
    trainer.preview()
    metrics = trainer.evaluate()
    if best is not None and best[0] > metrics["psnr"] + 0.5:
        ws.log(f"Exporting the step {best[1]} model (held-out PSNR {best[0]:.1f} dB) instead of the final one ({metrics['psnr']:.1f} dB)")
        trainer.restore(best[2])
        metrics = {**trainer.evaluate(), "exported_step": best[1]}
    final = trainer.export_final()
    if metrics["psnr"] < tc.min_psnr:
        raise RuntimeError(f"Training did not converge (held-out PSNR {metrics['psnr']:.1f} dB, scene scale "
                           f"{trainer.scale:.3g}). Check the camera reconstruction (outlier cameras, pose error).")
    metrics.update(gaussians=len(trainer.splats["means"]), steps=tc.steps, minutes=round((time.time() - started) / 60, 1),
                   priors=trainer.has_priors, scene_scale=trainer.scale, world_scale=trainer.norm, eval_history=history)
    write_json(ws.train / "eval.json", metrics)
    return metrics, [final, ws.train / "eval.json", log_path]
